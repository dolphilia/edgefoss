import {
  artifactId,
  artifactSignatureMessage,
  encodeChange,
  encodeProjectGenesis,
  encodeSignatureRecord,
  encodeTree,
} from "@edgefoss/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  MAX_PUSH_PREFLIGHT_ARTIFACTS,
  type PublishArtifactInput,
  type RepositoryDO,
} from "../src/index";

type RepositoryStub = DurableObjectStub<RepositoryDO>;

interface Identity {
  actorKey: Uint8Array;
  privateKey: CryptoKey;
}

function id(byte: string): string {
  return `sha256:${byte.repeat(64)}`;
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function identity(): Promise<Identity> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  return {
    actorKey: new Uint8Array(
      await crypto.subtle.exportKey("raw", pair.publicKey),
    ),
    privateKey: pair.privateKey,
  };
}

async function publication(
  bytes: Uint8Array,
  signer: Identity,
  operationId: string,
  ref: PublishArtifactInput["ref"],
): Promise<PublishArtifactInput> {
  const artifact = await artifactId(bytes);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      signer.privateKey,
      copyBuffer(artifactSignatureMessage(artifact)),
    ),
  );
  return {
    artifactBytes: copyBuffer(bytes),
    artifactId: artifact,
    expectedPolicyEpoch: 0,
    operationId,
    principalId: "owner",
    ref,
    signatureBytes: copyBuffer(
      encodeSignatureRecord({
        actorKey: signer.actorKey,
        artifact,
        signature,
      }),
    ),
  };
}

describe("RepositoryDO public push preflight", () => {
  it("returns one bounded authority snapshot and only the missing IDs", async () => {
    const repository = env.REPOSITORY.getByName("push-preflight-snapshot");
    const signer = await identity();
    const genesis = await publication(
      encodeProjectGenesis({
        actorKey: signer.actorKey,
        createdAt: "2026-08-26T00:00:00Z",
        name: "P5b0 push preflight",
        nonce: new Uint8Array(32).fill(0x63),
      }),
      signer,
      "63000000-0000-4000-8000-000000000001",
      null,
    );
    const blobBytes = new TextEncoder().encode("P5b0 public blob");
    const blobId = await artifactId(blobBytes);

    await expect(
      repository.preflightPublicPush({
        artifactIds: [genesis.artifactId],
        blobIds: [blobId],
        principalId: "owner",
        projectId: genesis.artifactId,
        protocolVersion: 0,
        realm: "public",
      }),
    ).resolves.toEqual({
      limits: { maxArtifactIds: 256, maxBlobIds: 256 },
      missingArtifactIds: [genesis.artifactId],
      missingBlobIds: [blobId],
      snapshot: {
        acceptedSequence: 0,
        policyEpoch: 0,
        projectId: null,
        ref: null,
      },
      status: "ok",
    });

    await repository.publishArtifact(genesis);
    const upload = await repository.beginUpload({
      blobId,
      byteSize: blobBytes.byteLength,
      operationId: "63000000-0000-4000-8000-000000000002",
      principalId: "owner",
      realm: "public",
    });
    if (upload.status !== "ok") throw new Error("unexpected upload conflict");
    await repository.stageUpload(
      "owner",
      upload.upload.uploadId,
      copyBuffer(blobBytes),
    );
    await repository.finalizeUpload("owner", upload.upload.uploadId);

    const tree = await publication(
      encodeTree({
        actorKey: signer.actorKey,
        createdAt: "2026-08-26T00:00:01Z",
        entries: [{ mode: "file", name: "README.md", target: blobId }],
        logicalClock: 1n,
        parents: [],
        project: genesis.artifactId,
        realm: "public",
      }),
      signer,
      "63000000-0000-4000-8000-000000000003",
      null,
    );
    await repository.publishArtifact(tree);
    const change = await publication(
      encodeChange({
        actorKey: signer.actorKey,
        createdAt: "2026-08-26T00:00:02Z",
        logicalClock: 2n,
        message: "preflight snapshot",
        parents: [],
        project: genesis.artifactId,
        realm: "public",
        root: tree.artifactId,
      }),
      signer,
      "63000000-0000-4000-8000-000000000004",
      { expectedGeneration: 0, name: "heads/main" },
    );
    await repository.publishArtifact(change);

    const artifactIds = [
      genesis.artifactId,
      tree.artifactId,
      change.artifactId,
      id("f"),
    ].sort();
    const result = await repository.preflightPublicPush({
      artifactIds,
      blobIds: [blobId],
      principalId: "owner",
      projectId: genesis.artifactId,
      protocolVersion: 0,
      realm: "public",
    });
    expect(result).toEqual({
      limits: { maxArtifactIds: 256, maxBlobIds: 256 },
      missingArtifactIds: [id("f")],
      missingBlobIds: [],
      snapshot: {
        acceptedSequence: 3,
        policyEpoch: 0,
        projectId: genesis.artifactId,
        ref: {
          generation: 1,
          name: "heads/main",
          targetArtifactId: change.artifactId,
        },
      },
      status: "ok",
    });
    await expect(
      repository.preflightPublicPush({
        artifactIds,
        blobIds: [blobId],
        principalId: "owner",
        projectId: genesis.artifactId,
        protocolVersion: 0,
        realm: "public",
      }),
    ).resolves.toEqual(result);
  });

  it("rejects another project without returning authority inventory", async () => {
    const repository = env.REPOSITORY.getByName("push-preflight-project");
    const signer = await identity();
    const genesis = await publication(
      encodeProjectGenesis({
        actorKey: signer.actorKey,
        createdAt: "2026-08-26T00:00:00Z",
        name: "P5b0 project fence",
        nonce: new Uint8Array(32).fill(0x64),
      }),
      signer,
      "64000000-0000-4000-8000-000000000001",
      null,
    );
    await repository.publishArtifact(genesis);

    await expect(
      repository.preflightPublicPush({
        artifactIds: [],
        blobIds: [],
        principalId: "owner",
        projectId: id("e"),
        protocolVersion: 0,
        realm: "public",
      }),
    ).resolves.toEqual({ code: "project_conflict", status: "rejected" });
  });

  it("rejects duplicate, unsorted, malformed, and oversized inventories", async () => {
    const repository = env.REPOSITORY.getByName("push-preflight-invalid");
    const base = {
      blobIds: [],
      principalId: "owner" as const,
      projectId: id("a"),
      protocolVersion: 0 as const,
      realm: "public" as const,
    };
    const invalid = { code: "push_preflight_invalid", status: "rejected" };
    await expect(
      repository.preflightPublicPush({
        ...base,
        artifactIds: [id("b"), id("a")],
      }),
    ).resolves.toEqual(invalid);
    await expect(
      repository.preflightPublicPush({
        ...base,
        artifactIds: [id("a"), id("a")],
      }),
    ).resolves.toEqual(invalid);
    await expect(
      repository.preflightPublicPush({
        ...base,
        artifactIds: ["sha256:not-an-id"],
      }),
    ).resolves.toEqual(invalid);
    await expect(
      repository.preflightPublicPush({
        ...base,
        artifactIds: Array.from(
          { length: MAX_PUSH_PREFLIGHT_ARTIFACTS + 1 },
          (_, index) => `sha256:${index.toString(16).padStart(64, "0")}`,
        ),
      }),
    ).resolves.toEqual(invalid);
  });
});
