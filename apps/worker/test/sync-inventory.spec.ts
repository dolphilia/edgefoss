import {
  artifactId,
  artifactSignatureMessage,
  encodeProjectGenesis,
  encodeSignatureRecord,
  encodeTree,
} from "@edgefoss/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type {
  PublicInventoryAnchorV0,
  PublicInventoryInput,
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
  expectedPolicyEpoch = 0,
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
    expectedPolicyEpoch,
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
      name: "P5a inventory test project",
      nonce: new Uint8Array(32).fill(0x5a),
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
    artifactId: input.artifactId,
    realm,
    status: "accepted",
  });
  return input.artifactId;
}

function inventoryInput(
  projectId: string,
  anchor: PublicInventoryAnchorV0 | null,
  limit = 2,
): PublicInventoryInput {
  return {
    anchor,
    limit,
    principalId: "anonymous",
    projectId,
    protocolVersion: 0,
    view: "public",
  };
}

describe("RepositoryDO public sync inventory", () => {
  it("negotiates only the implemented public HELLO and INVENTORY phases", async () => {
    const repository = env.REPOSITORY.getByName("sync-hello");
    await expect(
      repository.syncHello({
        offeredProtocolVersions: [0],
        principalId: "anonymous",
        requestedView: "public",
      }),
    ).resolves.toEqual({
      code: "project_not_initialized",
      status: "rejected",
    });

    const identity = await signingIdentity();
    const projectId = await initializeProject(
      repository,
      identity,
      "70000000-0000-4000-8000-000000000001",
    );
    await expect(
      repository.syncHello({
        offeredProtocolVersions: [1, 0],
        principalId: "anonymous",
        requestedView: "public",
      }),
    ).resolves.toEqual({
      capabilities: {
        inventory: { maxPageItems: 1_000, ordering: "artifact_id_asc" },
        phases: ["HELLO", "INVENTORY"],
      },
      principalId: "anonymous",
      projectId,
      protocolVersion: 0,
      status: "accepted",
      view: { id: "public", realms: ["public"] },
    });
    await expect(
      repository.syncHello({
        offeredProtocolVersions: [1],
        principalId: "anonymous",
        requestedView: "public",
      }),
    ).resolves.toEqual({
      code: "protocol_not_supported",
      status: "rejected",
    });
  });

  it("pages a stable public-only snapshot without exposing receipt sequences", async () => {
    const repository = env.REPOSITORY.getByName("sync-public-page");
    const identity = await signingIdentity();
    const projectId = await initializeProject(
      repository,
      identity,
      "71000000-0000-4000-8000-000000000001",
    );
    const firstPublic = await publishTree(
      repository,
      identity,
      projectId,
      "public",
      1n,
      "71000000-0000-4000-8000-000000000002",
    );
    const hidden = await publishTree(
      repository,
      identity,
      projectId,
      "members",
      2n,
      "71000000-0000-4000-8000-000000000003",
    );
    const secondPublic = await publishTree(
      repository,
      identity,
      projectId,
      "public",
      3n,
      "71000000-0000-4000-8000-000000000004",
    );
    const expectedSnapshot = [projectId, firstPublic, secondPublic].sort();

    const firstPage = await repository.publicInventory(
      inventoryInput(projectId, null),
    );
    expect(firstPage.status).toBe("ok");
    if (firstPage.status !== "ok") throw new Error("unexpected rejection");
    expect(firstPage.items.map((item) => item.artifactId)).toEqual(
      expectedSnapshot.slice(0, 2),
    );
    expect(firstPage.items).not.toContainEqual(
      expect.objectContaining({ artifactId: hidden }),
    );
    for (const item of firstPage.items) {
      expect(Object.keys(item).sort()).toEqual(["artifactId", "kind"]);
    }
    expect(firstPage.nextAnchor).not.toBeNull();

    const latePublic = await publishTree(
      repository,
      identity,
      projectId,
      "public",
      4n,
      "71000000-0000-4000-8000-000000000005",
    );
    const secondPage = await repository.publicInventory(
      inventoryInput(projectId, firstPage.nextAnchor),
    );
    expect(secondPage).toEqual({
      items: expectedSnapshot.slice(2).map((artifactId) => ({
        artifactId,
        kind: artifactId === projectId ? "project.genesis" : "tree",
      })),
      nextAnchor: null,
      status: "ok",
    });
    if (secondPage.status !== "ok") throw new Error("unexpected rejection");
    expect(secondPage.items.map((item) => item.artifactId)).not.toContain(
      latePublic,
    );

    const fresh = await repository.publicInventory(
      inventoryInput(projectId, null, 10),
    );
    expect(fresh).toMatchObject({ status: "ok" });
    if (fresh.status !== "ok") throw new Error("unexpected rejection");
    expect(fresh.items.map((item) => item.artifactId)).toEqual(
      [...expectedSnapshot, latePublic].sort(),
    );
    expect(fresh.items.map((item) => item.artifactId)).not.toContain(hidden);
  });

  it("binds continuation state to project, principal, view, and policy epoch", async () => {
    const repository = env.REPOSITORY.getByName("sync-cursor-binding");
    const identity = await signingIdentity();
    const projectId = await initializeProject(
      repository,
      identity,
      "72000000-0000-4000-8000-000000000001",
    );
    await publishTree(
      repository,
      identity,
      projectId,
      "public",
      1n,
      "72000000-0000-4000-8000-000000000002",
    );
    const page = await repository.publicInventory(
      inventoryInput(projectId, null, 1),
    );
    expect(page.status).toBe("ok");
    if (page.status !== "ok" || page.nextAnchor === null) {
      throw new Error("expected continuation anchor");
    }

    await expect(
      repository.publicInventory({
        ...inventoryInput(projectId, page.nextAnchor, 1),
        projectId: `sha256:${"f".repeat(64)}`,
      }),
    ).resolves.toEqual({ code: "cursor_invalid", status: "rejected" });
    await expect(
      repository.publicInventory({
        ...inventoryInput(projectId, page.nextAnchor, 1),
        anchor: { ...page.nextAnchor, principalId: "owner" },
      } as unknown as PublicInventoryInput),
    ).resolves.toEqual({ code: "request_invalid", status: "rejected" });
    await expect(
      repository.publicInventory({
        ...inventoryInput(projectId, page.nextAnchor, 1),
        anchor: { ...page.nextAnchor, view: "members" },
      } as unknown as PublicInventoryInput),
    ).resolves.toEqual({ code: "request_invalid", status: "rejected" });

    await expect(
      repository.advancePolicyEpoch({
        expectedPolicyEpoch: 0,
        operationId: "72000000-0000-4000-8000-000000000003",
        principalId: "owner",
      }),
    ).resolves.toMatchObject({ newPolicyEpoch: 1, status: "accepted" });
    await expect(
      repository.publicInventory(inventoryInput(projectId, page.nextAnchor, 1)),
    ).resolves.toEqual({
      code: "cursor_stale",
      currentPolicyEpoch: 1,
      status: "rejected",
    });
  });

  it("rejects invalid bounds instead of issuing an unbounded query", async () => {
    const repository = env.REPOSITORY.getByName("sync-invalid-limit");
    const identity = await signingIdentity();
    const projectId = await initializeProject(
      repository,
      identity,
      "73000000-0000-4000-8000-000000000001",
    );
    await expect(
      repository.publicInventory(inventoryInput(projectId, null, 1_001)),
    ).resolves.toEqual({ code: "request_invalid", status: "rejected" });
  });
});

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}
