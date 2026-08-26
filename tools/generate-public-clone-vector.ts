import {
  artifactId,
  artifactSignatureMessage,
  computeSemanticRoot,
  encodeBundleManifest,
  encodeChange,
  encodeProjectGenesis,
  encodeSignatureRecord,
  encodeTree,
} from "@edgefoss/protocol";
import { readFile } from "node:fs/promises";

const fromHex = (value: string) =>
  Uint8Array.from(
    value.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
const toHex = (value: Uint8Array) =>
  [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function operationId(fields: string[]): Promise<string> {
  const bytes = new TextEncoder().encode(
    `edgefoss:push-operation:v0\0${fields.join("\0")}`,
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const id = digest.slice(0, 16);
  id[6] = (id[6]! & 0x0f) | 0x50;
  id[8] = (id[8]! & 0x3f) | 0x80;
  const hex = toHex(id);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function main(): Promise<void> {
  // RFC 8032 test key 1. This key is public test data and must never be used
  // outside deterministic protocol fixtures.
  const actorKey = fromHex(
    "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  );
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    {
      crv: "Ed25519",
      d: Buffer.from(
        fromHex(
          "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
        ),
      ).toString("base64url"),
      ext: true,
      key_ops: ["sign"],
      kty: "OKP",
      x: Buffer.from(actorKey).toString("base64url"),
    },
    "Ed25519",
    false,
    ["sign"],
  );
  const signed = async (body: Uint8Array) => {
    const id = await artifactId(body);
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        privateKey,
        artifactSignatureMessage(id),
      ),
    );
    const record = encodeSignatureRecord({
      actorKey,
      artifact: id,
      signature,
    });
    return { body, id, record, signatureId: await artifactId(record) };
  };

  const genesis = await signed(
    encodeProjectGenesis({
      actorKey,
      createdAt: "2026-08-26T12:00:00Z",
      name: "P5a2b cross-runtime clone",
      nonce: Uint8Array.from({ length: 32 }, (_, index) => index),
    }),
  );
  const blob = new TextEncoder().encode("P5a2b cross-runtime blob\n");
  const blobId = await artifactId(blob);
  const tree = await signed(
    encodeTree({
      actorKey,
      createdAt: "2026-08-26T12:00:01Z",
      entries: [{ mode: "file", name: "README.txt", target: blobId }],
      logicalClock: 0n,
      parents: [],
      project: genesis.id,
      realm: "public",
    }),
  );
  const change = await signed(
    encodeChange({
      actorKey,
      createdAt: "2026-08-26T12:00:02Z",
      logicalClock: 0n,
      message: "cross-runtime clone fixture",
      parents: [],
      project: genesis.id,
      realm: "public",
      root: tree.id,
    }),
  );
  const artifacts = [genesis, tree, change];
  const artifactIds = artifacts.map(({ id }) => id).sort();
  const signatureIds = artifacts.map(({ signatureId }) => signatureId).sort();
  const semantic = await computeSemanticRoot({
    artifacts: artifactIds.map((id) => ({ id, realm: "public" })),
    policyVersion: 0n,
    project: genesis.id,
    realm: "public",
    refs: [{ name: "heads/main", realm: "public", target: change.id }],
  });
  const manifest = await encodeBundleManifest({
    artifacts: artifactIds,
    baseRoots: new Map(),
    blobs: [blobId],
    policyVersion: 0n,
    project: genesis.id,
    realm: "public",
    refs: new Map([["heads/main", change.id]]),
    semanticRoot: semantic.semanticRoot,
    signatures: signatureIds,
  });
  const files = Object.fromEntries(
    [
      ...artifacts.map(({ body, id }) => [
        `artifacts/${id.slice(7)}.cbor`,
        toHex(body),
      ]),
      [`blobs/${blobId.slice(7)}.bin`, toHex(blob)],
      ...artifacts.map(({ record, signatureId }) => [
        `signatures/${signatureId.slice(7)}.cbor`,
        toHex(record),
      ]),
    ].sort(([left], [right]) => left.localeCompare(right)),
  );
  const freshPushArtifacts = await Promise.all(
    [
      { artifact: genesis, expectedGeneration: null, kind: "project.genesis" },
      { artifact: tree, expectedGeneration: null, kind: "tree" },
      { artifact: change, expectedGeneration: 0, kind: "change" },
    ].map(async ({ artifact, expectedGeneration, kind }) => ({
      artifact_id: artifact.id,
      artifact_path: `artifacts/${artifact.id.slice(7)}.cbor`,
      expected_policy_epoch: 0,
      kind,
      operation_id: await operationId([
        "publish",
        genesis.id,
        "public",
        artifact.id,
        "0",
        expectedGeneration === null ? "-" : String(expectedGeneration),
      ]),
      ref:
        expectedGeneration === null
          ? null
          : { expected_generation: expectedGeneration, name: "heads/main" },
      signature_path: `signatures/${artifact.signatureId.slice(7)}.cbor`,
    })),
  );
  const freshPushPlan = {
    snapshot: {
      accepted_sequence: 0,
      missing_artifact_ids: artifactIds,
      missing_blob_ids: [blobId],
      policy_epoch: 0,
      project_id: null,
      ref_generation: null,
      ref_target: null,
    },
    blobs: [
      {
        blob_id: blobId,
        byte_size: blob.byteLength,
        object_path: `blobs/${blobId.slice(7)}.bin`,
        operation_id: await operationId([
          "upload",
          genesis.id,
          "public",
          blobId,
          String(blob.byteLength),
          "0",
        ]),
      },
    ],
    artifacts: freshPushArtifacts,
  };
  const output = `${JSON.stringify(
    {
      profile: "edgefossil-public-clone-v0",
      actor_key_hex: toHex(actorKey),
      project_id: genesis.id,
      head_artifact_id: change.id,
      ref_generation: 1,
      publish_order: artifacts.map(({ id }) => id),
      fresh_push_plan: freshPushPlan,
      manifest_cbor_hex: toHex(manifest),
      files,
    },
    null,
    2,
  )}\n`;
  if (process.argv.includes("--check")) {
    const committed = await readFile(
      new URL("../spec/vectors/public-clone-v0.json", import.meta.url),
      "utf8",
    );
    if (committed !== output) {
      throw new Error("public clone vector differs from deterministic output");
    }
    process.stdout.write("Verified deterministic public clone vector.\n");
  } else {
    process.stdout.write(output);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
