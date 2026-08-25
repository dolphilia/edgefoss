import {
  artifactId,
  decodeBundleManifest,
  decodeSignatureRecord,
  verifyBundleManifest,
  verifyBundleObjects,
} from "@edgefoss/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import vector from "../../../spec/vectors/public-clone-v0.json";
import type { PublishArtifactInput, RepositoryDO } from "../src/index";

type RepositoryStub = DurableObjectStub<RepositoryDO>;

const operationIds = [
  "79000000-0000-4000-8000-000000000001",
  "79000000-0000-4000-8000-000000000002",
  "79000000-0000-4000-8000-000000000003",
  "79000000-0000-4000-8000-000000000004",
];

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(
    hex.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
}

function objectId(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1, path.lastIndexOf("."));
  return `sha256:${name}`;
}

function vectorObjects(): Map<string, Uint8Array> {
  return new Map(
    Object.entries(vector.files).map(([path, body]) => [path, bytes(body)]),
  );
}

async function publishVectorArtifact(
  repository: RepositoryStub,
  artifactIdValue: string,
  operationId: string,
): Promise<void> {
  const objects = vectorObjects();
  const artifactPath = `artifacts/${artifactIdValue.slice(7)}.cbor`;
  const artifactBytes = objects.get(artifactPath);
  if (artifactBytes === undefined) throw new Error("vector artifact missing");
  const signatureBytes = [...objects.entries()]
    .filter(([path]) => path.startsWith("signatures/"))
    .map(([, body]) => body)
    .find((body) => decodeSignatureRecord(body).artifact === artifactIdValue);
  if (signatureBytes === undefined) throw new Error("vector signature missing");
  const input: PublishArtifactInput = {
    artifactBytes: copyBuffer(artifactBytes),
    artifactId: artifactIdValue,
    expectedPolicyEpoch: 0,
    operationId,
    principalId: "owner",
    ref:
      artifactIdValue === vector.head_artifact_id
        ? { expectedGeneration: 0, name: "heads/main" }
        : null,
    signatureBytes: copyBuffer(signatureBytes),
  };
  await expect(repository.publishArtifact(input)).resolves.toMatchObject({
    status: "accepted",
  });
}

describe("P5a2b public clone shared vector", () => {
  it("matches the exact Worker output consumed by the Rust importer", async () => {
    expect(vector.profile).toBe("edgefossil-public-clone-v0");
    const repository = env.REPOSITORY.getByName("public-clone-shared-vector");
    await publishVectorArtifact(
      repository,
      vector.publish_order[0]!,
      operationIds[0]!,
    );

    const objects = vectorObjects();
    const blobEntry = [...objects.entries()].find(([path]) =>
      path.startsWith("blobs/"),
    );
    if (blobEntry === undefined) throw new Error("vector blob missing");
    const [blobPath, blobBytes] = blobEntry;
    const blobId = objectId(blobPath);
    expect(await artifactId(blobBytes)).toBe(blobId);
    const begun = await repository.beginUpload({
      blobId,
      byteSize: blobBytes.byteLength,
      operationId: operationIds[1]!,
      principalId: "owner",
      realm: "public",
    });
    if (begun.status !== "ok") throw new Error("vector upload conflict");
    await repository.stageUpload(
      "owner",
      begun.upload.uploadId,
      copyBuffer(blobBytes),
    );
    await expect(
      repository.finalizeUpload("owner", begun.upload.uploadId),
    ).resolves.toMatchObject({ state: "finalized" });

    await publishVectorArtifact(
      repository,
      vector.publish_order[1]!,
      operationIds[2]!,
    );
    await publishVectorArtifact(
      repository,
      vector.publish_order[2]!,
      operationIds[3]!,
    );

    const planned = await repository.publicClonePlan({
      principalId: "anonymous",
      projectId: vector.project_id,
      protocolVersion: 0,
      view: "public",
    });
    if (planned.status !== "ok") throw new Error("vector plan rejected");
    expect(planned.plan.ref).toEqual({
      generation: vector.ref_generation,
      name: "heads/main",
      targetArtifactId: vector.head_artifact_id,
    });
    expect(new Uint8Array(planned.plan.manifestBytes)).toEqual(
      bytes(vector.manifest_cbor_hex),
    );

    const transferred = await repository.publicArtifactTransfer({
      artifactIds: planned.plan.artifactIds,
      snapshot: planned.plan.snapshot,
    });
    if (transferred.status !== "ok")
      throw new Error("vector transfer rejected");
    const actual = new Map<string, Uint8Array>();
    for (const item of transferred.items) {
      actual.set(
        `artifacts/${item.artifactId.slice(7)}.cbor`,
        new Uint8Array(item.artifactBytes),
      );
      const signatureBytes = new Uint8Array(item.signatureBytes);
      actual.set(
        `signatures/${(await artifactId(signatureBytes)).slice(7)}.cbor`,
        signatureBytes,
      );
    }
    const chunk = await repository.publicBlobChunk({
      blobId,
      headArtifactId: planned.plan.ref.targetArtifactId,
      length: blobBytes.byteLength,
      offset: 0,
      snapshot: planned.plan.snapshot,
    });
    if (chunk.status !== "ok") throw new Error("vector blob rejected");
    actual.set(blobPath, new Uint8Array(chunk.chunk.bytes));

    expect(actual).toEqual(objects);
    const manifest = decodeBundleManifest(
      new Uint8Array(planned.plan.manifestBytes),
    );
    await expect(verifyBundleManifest(manifest)).resolves.toBeUndefined();
    await expect(
      verifyBundleObjects(manifest, actual),
    ).resolves.toBeUndefined();
    await expect(repository.health()).resolves.toMatchObject({
      schemaVersion: 5,
    });
  });
});

function copyBuffer(value: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(value.byteLength);
  new Uint8Array(result).set(value);
  return result;
}
