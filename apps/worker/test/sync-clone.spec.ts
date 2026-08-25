import {
  artifactId,
  artifactSignatureMessage,
  decodeBundleManifest,
  encodeChange,
  encodeProjectGenesis,
  encodeSignatureRecord,
  encodeTree,
  verifyBundleManifest,
  verifyBundleObjects,
} from "@edgefoss/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  MAX_PUBLIC_BLOB_CHUNK_BYTES,
  type PublishArtifactInput,
  type RepositoryDO,
} from "../src/index";

type RepositoryStub = DurableObjectStub<RepositoryDO>;

interface SigningIdentity {
  actorKey: Uint8Array;
  privateKey: CryptoKey;
}

async function signingIdentity(): Promise<SigningIdentity> {
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

async function publishInput(
  bytes: Uint8Array,
  identity: SigningIdentity,
  operationId: string,
  ref: PublishArtifactInput["ref"],
): Promise<PublishArtifactInput> {
  const id = await artifactId(bytes);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      identity.privateKey,
      copyBuffer(artifactSignatureMessage(id)),
    ),
  );
  return {
    artifactBytes: copyBuffer(bytes),
    artifactId: id,
    expectedPolicyEpoch: 0,
    operationId,
    principalId: "owner",
    ref,
    signatureBytes: copyBuffer(
      encodeSignatureRecord({
        actorKey: identity.actorKey,
        artifact: id,
        signature,
      }),
    ),
  };
}

async function initializeProject(
  repository: RepositoryStub,
  identity: SigningIdentity,
): Promise<string> {
  const input = await publishInput(
    encodeProjectGenesis({
      actorKey: identity.actorKey,
      createdAt: "2026-08-26T00:00:00Z",
      name: "P5a2b clone plan project",
      nonce: new Uint8Array(32).fill(0x5d),
    }),
    identity,
    "78000000-0000-4000-8000-000000000001",
    null,
  );
  await expect(repository.publishArtifact(input)).resolves.toMatchObject({
    status: "accepted",
  });
  return input.artifactId;
}

async function finalizeBlob(
  repository: RepositoryStub,
  bytes: Uint8Array,
  operationId: string,
  realm: "members" | "public" = "public",
): Promise<string> {
  const blobId = await artifactId(bytes);
  const begun = await repository.beginUpload({
    blobId,
    byteSize: bytes.byteLength,
    operationId,
    principalId: "owner",
    realm,
  });
  if (begun.status !== "ok") throw new Error("unexpected conflict");
  await repository.stageUpload(
    "owner",
    begun.upload.uploadId,
    copyBuffer(bytes),
  );
  await expect(
    repository.finalizeUpload("owner", begun.upload.uploadId),
  ).resolves.toMatchObject({ state: "finalized" });
  return blobId;
}

function beginInput(projectId: string) {
  return {
    principalId: "anonymous" as const,
    projectId,
    protocolVersion: 0 as const,
    view: "public" as const,
  };
}

function objectPath(kind: "artifacts" | "blobs" | "signatures", id: string) {
  return `${kind}/${id.slice(7)}.${kind === "blobs" ? "bin" : "cbor"}`;
}

describe("RepositoryDO public clone plan", () => {
  it("assembles a complete verified portable bundle through bounded resumable reads", async () => {
    const repository = env.REPOSITORY.getByName("sync-clone-complete");
    const identity = await signingIdentity();
    const projectId = await initializeProject(repository, identity);
    const source = new Uint8Array(MAX_PUBLIC_BLOB_CHUNK_BYTES + 17);
    source.forEach((_, index) => {
      source[index] = index % 251;
    });
    const blobId = await finalizeBlob(
      repository,
      source,
      "78000000-0000-4000-8000-000000000002",
    );
    const emptyBlobId = await finalizeBlob(
      repository,
      new Uint8Array(),
      "78000000-0000-4000-8000-000000000011",
    );
    const tree = await publishInput(
      encodeTree({
        actorKey: identity.actorKey,
        createdAt: "2026-08-26T00:00:01Z",
        entries: [
          { mode: "file", name: "empty.bin", target: emptyBlobId },
          { mode: "file", name: "source.bin", target: blobId },
        ],
        logicalClock: 0n,
        parents: [],
        project: projectId,
        realm: "public",
      }),
      identity,
      "78000000-0000-4000-8000-000000000003",
      null,
    );
    await expect(repository.publishArtifact(tree)).resolves.toMatchObject({
      status: "accepted",
    });
    const change = await publishInput(
      encodeChange({
        actorKey: identity.actorKey,
        createdAt: "2026-08-26T00:00:02Z",
        logicalClock: 0n,
        message: "clone fixture",
        parents: [],
        project: projectId,
        realm: "public",
        root: tree.artifactId,
      }),
      identity,
      "78000000-0000-4000-8000-000000000004",
      { expectedGeneration: 0, name: "heads/main" },
    );
    await expect(repository.publishArtifact(change)).resolves.toMatchObject({
      status: "accepted",
    });

    const danglingBytes = new TextEncoder().encode("not reachable");
    const danglingBlob = await finalizeBlob(
      repository,
      danglingBytes,
      "78000000-0000-4000-8000-000000000005",
    );
    const membersBlob = await finalizeBlob(
      repository,
      new TextEncoder().encode("members only"),
      "78000000-0000-4000-8000-000000000006",
      "members",
    );

    const planned = await repository.publicClonePlan(beginInput(projectId));
    expect(planned.status).toBe("ok");
    if (planned.status !== "ok") throw new Error("unexpected rejection");
    const { plan } = planned;
    expect(plan.profile).toBe("complete");
    expect(plan.artifactIds).toEqual(
      [projectId, tree.artifactId, change.artifactId].sort(),
    );
    expect(plan.blobs).toEqual(
      [
        { blobId, byteSize: source.byteLength },
        { blobId: emptyBlobId, byteSize: 0 },
      ].sort((left, right) => left.blobId.localeCompare(right.blobId)),
    );
    expect(plan.signatureIds).toHaveLength(3);
    expect(plan.ref).toEqual({
      generation: 1,
      name: "heads/main",
      targetArtifactId: change.artifactId,
    });

    const manifest = decodeBundleManifest(new Uint8Array(plan.manifestBytes));
    expect(manifest.semanticRoot).toBe(plan.semanticRoot);
    await expect(verifyBundleManifest(manifest)).resolves.toBeUndefined();

    const transferred = await repository.publicArtifactTransfer({
      artifactIds: plan.artifactIds,
      snapshot: plan.snapshot,
    });
    if (transferred.status !== "ok") throw new Error("unexpected rejection");
    const objects = new Map<string, Uint8Array>();
    for (const item of transferred.items) {
      objects.set(
        objectPath("artifacts", item.artifactId),
        new Uint8Array(item.artifactBytes),
      );
      const signatureBytes = new Uint8Array(item.signatureBytes);
      objects.set(
        objectPath("signatures", await artifactId(signatureBytes)),
        signatureBytes,
      );
    }

    const first = await repository.publicBlobChunk({
      blobId,
      headArtifactId: plan.ref.targetArtifactId,
      length: MAX_PUBLIC_BLOB_CHUNK_BYTES,
      offset: 0,
      snapshot: plan.snapshot,
    });
    const second = await repository.publicBlobChunk({
      blobId,
      headArtifactId: plan.ref.targetArtifactId,
      length: 17,
      offset: MAX_PUBLIC_BLOB_CHUNK_BYTES,
      snapshot: plan.snapshot,
    });
    if (first.status !== "ok" || second.status !== "ok") {
      throw new Error("unexpected rejection");
    }
    expect(first.chunk.complete).toBe(false);
    expect(second.chunk.complete).toBe(true);
    const assembled = new Uint8Array(source.byteLength);
    assembled.set(new Uint8Array(first.chunk.bytes), first.chunk.offset);
    assembled.set(new Uint8Array(second.chunk.bytes), second.chunk.offset);
    expect(await artifactId(assembled)).toBe(blobId);
    objects.set(objectPath("blobs", blobId), assembled);
    const empty = await repository.publicBlobChunk({
      blobId: emptyBlobId,
      headArtifactId: plan.ref.targetArtifactId,
      length: 0,
      offset: 0,
      snapshot: plan.snapshot,
    });
    if (empty.status !== "ok") throw new Error("unexpected rejection");
    expect(empty.chunk.complete).toBe(true);
    expect(empty.chunk.bytes.byteLength).toBe(0);
    objects.set(objectPath("blobs", emptyBlobId), new Uint8Array());
    await expect(
      verifyBundleObjects(manifest, objects),
    ).resolves.toBeUndefined();

    const replay = await repository.publicClonePlan(beginInput(projectId));
    if (replay.status !== "ok") throw new Error("unexpected rejection");
    expect(new Uint8Array(replay.plan.manifestBytes)).toEqual(
      new Uint8Array(plan.manifestBytes),
    );

    const unavailable = async (candidate: string) =>
      repository.publicBlobChunk({
        blobId: candidate,
        headArtifactId: plan.ref.targetArtifactId,
        length: 1,
        offset: 0,
        snapshot: plan.snapshot,
      });
    await expect(unavailable(danglingBlob)).resolves.toEqual({
      code: "blob_unavailable",
      status: "rejected",
    });
    await expect(unavailable(membersBlob)).resolves.toEqual({
      code: "blob_unavailable",
      status: "rejected",
    });
    await expect(unavailable(`sha256:${"f".repeat(64)}`)).resolves.toEqual({
      code: "blob_unavailable",
      status: "rejected",
    });
    await expect(repository.health()).resolves.toMatchObject({
      schemaVersion: 5,
    });
  });

  it("requires a public head and invalidates blob resume after policy advance", async () => {
    const repository = env.REPOSITORY.getByName("sync-clone-stale");
    const identity = await signingIdentity();
    const projectId = await initializeProject(repository, identity);
    await expect(
      repository.publicClonePlan(beginInput(projectId)),
    ).resolves.toEqual({
      code: "public_ref_unavailable",
      status: "rejected",
    });

    const blobBytes = new TextEncoder().encode("stale blob");
    const blobId = await finalizeBlob(
      repository,
      blobBytes,
      "78000000-0000-4000-8000-000000000007",
    );
    const tree = await publishInput(
      encodeTree({
        actorKey: identity.actorKey,
        createdAt: "2026-08-26T00:00:03Z",
        entries: [{ mode: "file", name: "stale.txt", target: blobId }],
        logicalClock: 0n,
        parents: [],
        project: projectId,
        realm: "public",
      }),
      identity,
      "78000000-0000-4000-8000-000000000008",
      null,
    );
    await repository.publishArtifact(tree);
    const change = await publishInput(
      encodeChange({
        actorKey: identity.actorKey,
        createdAt: "2026-08-26T00:00:04Z",
        logicalClock: 0n,
        message: "stale",
        parents: [],
        project: projectId,
        realm: "public",
        root: tree.artifactId,
      }),
      identity,
      "78000000-0000-4000-8000-000000000009",
      { expectedGeneration: 0, name: "heads/main" },
    );
    await repository.publishArtifact(change);
    const planned = await repository.publicClonePlan(beginInput(projectId));
    if (planned.status !== "ok") throw new Error("unexpected rejection");
    await repository.advancePolicyEpoch({
      expectedPolicyEpoch: 0,
      operationId: "78000000-0000-4000-8000-000000000010",
      principalId: "owner",
    });
    await expect(
      repository.publicBlobChunk({
        blobId,
        headArtifactId: change.artifactId,
        length: blobBytes.byteLength,
        offset: 0,
        snapshot: planned.plan.snapshot,
      }),
    ).resolves.toEqual({
      code: "snapshot_stale",
      currentPolicyEpoch: 1,
      status: "rejected",
    });
  });

  it("rejects a complete profile that the Rust importer cannot reconstruct", async () => {
    const repository = env.REPOSITORY.getByName("sync-clone-unsupported-clock");
    const identity = await signingIdentity();
    const projectId = await initializeProject(repository, identity);
    const tree = await publishInput(
      encodeTree({
        actorKey: identity.actorKey,
        createdAt: "2026-08-26T00:00:05Z",
        entries: [],
        logicalClock: 1n,
        parents: [],
        project: projectId,
        realm: "public",
      }),
      identity,
      "78000000-0000-4000-8000-000000000012",
      null,
    );
    await repository.publishArtifact(tree);
    const change = await publishInput(
      encodeChange({
        actorKey: identity.actorKey,
        createdAt: "2026-08-26T00:00:06Z",
        logicalClock: 1n,
        message: "unsupported clock",
        parents: [],
        project: projectId,
        realm: "public",
        root: tree.artifactId,
      }),
      identity,
      "78000000-0000-4000-8000-000000000013",
      { expectedGeneration: 0, name: "heads/main" },
    );
    await repository.publishArtifact(change);

    await expect(
      repository.publicClonePlan(beginInput(projectId)),
    ).resolves.toEqual({
      code: "clone_profile_unsupported",
      status: "rejected",
    });
  });
});

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}
