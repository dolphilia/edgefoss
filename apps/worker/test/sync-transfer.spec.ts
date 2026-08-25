import {
  artifactId,
  artifactSignatureMessage,
  decodeSignatureRecord,
  encodeProjectGenesis,
  encodeSignatureRecord,
  encodeTree,
  verifyArtifactSignature,
} from "@edgefoss/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type {
  PublicArtifactTransferInput,
  PublishArtifactInput,
  RepositoryDO,
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
    ref: null,
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
  operationId: string,
): Promise<string> {
  const input = await publishInput(
    encodeProjectGenesis({
      actorKey: identity.actorKey,
      createdAt: "2026-08-25T00:00:00Z",
      name: "P5a2 transfer test project",
      nonce: new Uint8Array(32).fill(0x5c),
    }),
    identity,
    operationId,
  );
  await expect(repository.publishArtifact(input)).resolves.toMatchObject({
    status: "accepted",
  });
  return input.artifactId;
}

async function publishTree(
  repository: RepositoryStub,
  identity: SigningIdentity,
  projectId: string,
  realm: "members" | "public",
  logicalClock: bigint,
  operationId: string,
): Promise<string> {
  const input = await publishInput(
    encodeTree({
      actorKey: identity.actorKey,
      createdAt: `2026-08-25T00:00:${logicalClock.toString().padStart(2, "0")}Z`,
      entries: [],
      logicalClock,
      parents: [],
      project: projectId,
      realm,
    }),
    identity,
    operationId,
  );
  await expect(repository.publishArtifact(input)).resolves.toMatchObject({
    status: "accepted",
  });
  return input.artifactId;
}

function beginInput(projectId: string) {
  return {
    principalId: "anonymous" as const,
    projectId,
    protocolVersion: 0 as const,
    view: "public" as const,
  };
}

function byteText(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].join(",");
}

describe("RepositoryDO public artifact transfer", () => {
  it("replays a bounded verified public snapshot without leaking unavailable IDs", async () => {
    const repository = env.REPOSITORY.getByName("sync-transfer-public");
    const identity = await signingIdentity();
    const projectId = await initializeProject(
      repository,
      identity,
      "76000000-0000-4000-8000-000000000001",
    );
    const publicId = await publishTree(
      repository,
      identity,
      projectId,
      "public",
      1n,
      "76000000-0000-4000-8000-000000000002",
    );
    const membersId = await publishTree(
      repository,
      identity,
      projectId,
      "members",
      2n,
      "76000000-0000-4000-8000-000000000003",
    );
    const begun = await repository.beginPublicTransfer(beginInput(projectId));
    expect(begun.status).toBe("ok");
    if (begun.status !== "ok") throw new Error("unexpected rejection");
    expect(begun.snapshot.afterArtifactId).toBe("");

    const inventory = await repository.publicInventory({
      anchor: begun.snapshot,
      limit: 100,
      principalId: "anonymous",
      projectId,
      protocolVersion: 0,
      view: "public",
    });
    expect(inventory.status).toBe("ok");
    if (inventory.status !== "ok") throw new Error("unexpected rejection");
    const artifactIds = inventory.items.map((item) => item.artifactId);
    expect(artifactIds).toEqual([projectId, publicId].sort());

    const lateId = await publishTree(
      repository,
      identity,
      projectId,
      "public",
      3n,
      "76000000-0000-4000-8000-000000000004",
    );
    const request = { artifactIds, snapshot: begun.snapshot };
    const first = await repository.publicArtifactTransfer(request);
    expect(first.status).toBe("ok");
    if (first.status !== "ok") throw new Error("unexpected rejection");
    expect(first.items.map((item) => item.artifactId)).toEqual(artifactIds);
    for (const item of first.items) {
      expect(await artifactId(new Uint8Array(item.artifactBytes))).toBe(
        item.artifactId,
      );
      const signature = decodeSignatureRecord(
        new Uint8Array(item.signatureBytes),
      );
      await expect(
        verifyArtifactSignature(signature, item.artifactId, identity.actorKey),
      ).resolves.toBeUndefined();
      expect(Object.keys(item).sort()).toEqual([
        "artifactBytes",
        "artifactId",
        "kind",
        "signatureBytes",
      ]);
    }

    const replay = await repository.publicArtifactTransfer(request);
    expect(replay.status).toBe("ok");
    if (replay.status !== "ok") throw new Error("unexpected rejection");
    expect(
      replay.items.map((item) => ({
        artifact: byteText(item.artifactBytes),
        id: item.artifactId,
        signature: byteText(item.signatureBytes),
      })),
    ).toEqual(
      first.items.map((item) => ({
        artifact: byteText(item.artifactBytes),
        id: item.artifactId,
        signature: byteText(item.signatureBytes),
      })),
    );

    const unavailable = async (artifactId: string) =>
      repository.publicArtifactTransfer({
        artifactIds: [artifactId],
        snapshot: begun.snapshot,
      });
    const expectedUnavailable = {
      code: "artifact_unavailable",
      status: "rejected",
    };
    await expect(unavailable(membersId)).resolves.toEqual(expectedUnavailable);
    await expect(unavailable(lateId)).resolves.toEqual(expectedUnavailable);
    await expect(unavailable(`sha256:${"f".repeat(64)}`)).resolves.toEqual(
      expectedUnavailable,
    );
    await expect(repository.health()).resolves.toMatchObject({
      schemaVersion: 5,
    });
  });

  it("rejects malformed batches and a snapshot after the policy epoch advances", async () => {
    const repository = env.REPOSITORY.getByName("sync-transfer-validation");
    const identity = await signingIdentity();
    const projectId = await initializeProject(
      repository,
      identity,
      "77000000-0000-4000-8000-000000000001",
    );
    const begun = await repository.beginPublicTransfer(beginInput(projectId));
    if (begun.status !== "ok") throw new Error("unexpected rejection");
    const base: PublicArtifactTransferInput = {
      artifactIds: [projectId],
      snapshot: begun.snapshot,
    };
    await expect(
      repository.publicArtifactTransfer({ ...base, artifactIds: [] }),
    ).resolves.toEqual({ code: "request_invalid", status: "rejected" });
    await expect(
      repository.publicArtifactTransfer({
        ...base,
        artifactIds: [projectId, projectId],
      }),
    ).resolves.toEqual({ code: "request_invalid", status: "rejected" });
    const ascendingIds = Array.from(
      { length: 17 },
      (_, index) => `sha256:${index.toString(16).padStart(64, "0")}`,
    );
    await expect(
      repository.publicArtifactTransfer({
        ...base,
        artifactIds: ascendingIds,
      }),
    ).resolves.toEqual({ code: "request_invalid", status: "rejected" });
    await expect(
      repository.publicArtifactTransfer({
        ...base,
        artifactIds: [ascendingIds[1]!, ascendingIds[0]!],
      }),
    ).resolves.toEqual({ code: "request_invalid", status: "rejected" });
    await expect(
      repository.publicArtifactTransfer({
        ...base,
        snapshot: { ...begun.snapshot, afterArtifactId: projectId },
      }),
    ).resolves.toEqual({ code: "request_invalid", status: "rejected" });

    await expect(
      repository.advancePolicyEpoch({
        expectedPolicyEpoch: 0,
        operationId: "77000000-0000-4000-8000-000000000002",
        principalId: "owner",
      }),
    ).resolves.toMatchObject({ newPolicyEpoch: 1, status: "accepted" });
    await expect(repository.publicArtifactTransfer(base)).resolves.toEqual({
      code: "snapshot_stale",
      currentPolicyEpoch: 1,
      status: "rejected",
    });
  });
});

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}
