import {
  artifactId,
  artifactSignatureMessage,
  encodeProjectGenesis,
  encodeSignatureRecord,
  encodeTree,
} from "@edgefoss/protocol";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type {
  AdvancePolicyEpochInput,
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

async function signedInput(
  bytes: Uint8Array,
  identity: SigningIdentity,
  operationId: string,
  expectedPolicyEpoch: number,
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
  const input = await signedInput(
    encodeProjectGenesis({
      actorKey: identity.actorKey,
      createdAt: "2026-08-25T00:00:00Z",
      name: "P4e policy test project",
      nonce: new Uint8Array(32).fill(0x50),
    }),
    identity,
    operationId,
    0,
  );
  await expect(repository.publishArtifact(input)).resolves.toMatchObject({
    repoSequence: 1,
    status: "accepted",
  });
  return input.artifactId;
}

function policyInput(
  operationId: string,
  expectedPolicyEpoch: number,
): AdvancePolicyEpochInput {
  return { expectedPolicyEpoch, operationId, principalId: "owner" };
}

describe("RepositoryDO policy epoch linearization", () => {
  it("deduplicates an epoch advance and preserves earlier canonical state", async () => {
    const repository = env.REPOSITORY.getByName("policy-idempotency");
    const identity = await signingIdentity();
    const genesisOperationId = "60000000-0000-4000-8000-000000000001";
    const projectId = await initializeProject(
      repository,
      identity,
      genesisOperationId,
    );
    const mutation = policyInput("60000000-0000-4000-8000-000000000002", 0);
    const accepted = await repository.advancePolicyEpoch(mutation);
    expect(accepted).toEqual({
      newPolicyEpoch: 1,
      previousPolicyEpoch: 0,
      status: "accepted",
    });
    for (let retry = 0; retry < 100; retry += 1) {
      await expect(repository.advancePolicyEpoch(mutation)).resolves.toEqual(
        accepted,
      );
    }
    await expect(
      repository.advancePolicyEpoch({ ...mutation, expectedPolicyEpoch: 1 }),
    ).resolves.toEqual({ code: "operation_conflict", status: "conflict" });
    await expect(
      repository.beginUpload({
        blobId: `sha256:${"0".repeat(64)}`,
        byteSize: 0,
        operationId: mutation.operationId,
        principalId: "owner",
        realm: "public",
      }),
    ).resolves.toEqual({ code: "operation_conflict", status: "conflict" });
    await expect(
      repository.advancePolicyEpoch(policyInput(genesisOperationId, 1)),
    ).resolves.toEqual({ code: "operation_conflict", status: "conflict" });
    const crossKindPublish = await signedInput(
      encodeTree({
        actorKey: identity.actorKey,
        createdAt: "2026-08-25T00:00:01Z",
        entries: [],
        logicalClock: 1n,
        parents: [],
        project: projectId,
        realm: "public",
      }),
      identity,
      mutation.operationId,
      1,
    );
    await expect(repository.publishArtifact(crossKindPublish)).resolves.toEqual(
      { code: "operation_conflict", status: "conflict" },
    );

    await runInDurableObject(repository, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM edgefoss_meta WHERE key = 'policy_epoch'",
          )
          .one().value,
      ).toBe("1");
      expect(
        state.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM artifacts")
          .one().count,
      ).toBe(1);
      expect(
        state.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM receipts")
          .one().count,
      ).toBe(1);
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM authority_outbox",
          )
          .one().count,
      ).toBe(1);
    });
  });

  it("stores a stable stale-epoch result across later policy advances", async () => {
    const repository = env.REPOSITORY.getByName("policy-stale-replay");
    const first = policyInput("61000000-0000-4000-8000-000000000001", 0);
    await expect(repository.advancePolicyEpoch(first)).resolves.toEqual({
      code: "project_not_initialized",
      status: "rejected",
    });
    await initializeProject(
      repository,
      await signingIdentity(),
      "61000000-0000-4000-8000-000000000002",
    );
    await expect(repository.advancePolicyEpoch(first)).resolves.toMatchObject({
      newPolicyEpoch: 1,
      status: "accepted",
    });
    const stale = policyInput("61000000-0000-4000-8000-000000000003", 0);
    const staleResult = {
      code: "policy_conflict" as const,
      currentPolicyEpoch: 1,
      status: "policy_conflict" as const,
    };
    await expect(repository.advancePolicyEpoch(stale)).resolves.toEqual(
      staleResult,
    );
    await expect(
      repository.advancePolicyEpoch(
        policyInput("61000000-0000-4000-8000-000000000004", 1),
      ),
    ).resolves.toMatchObject({ newPolicyEpoch: 2, status: "accepted" });
    await expect(repository.advancePolicyEpoch(stale)).resolves.toEqual(
      staleResult,
    );
  });

  it("linearizes a concurrent publish and revocation fence", async () => {
    const repository = env.REPOSITORY.getByName("policy-publish-race");
    const identity = await signingIdentity();
    const projectId = await initializeProject(
      repository,
      identity,
      "62000000-0000-4000-8000-000000000001",
    );
    const publication = await signedInput(
      encodeTree({
        actorKey: identity.actorKey,
        createdAt: "2026-08-25T00:00:01Z",
        entries: [],
        logicalClock: 1n,
        parents: [],
        project: projectId,
        realm: "public",
      }),
      identity,
      "62000000-0000-4000-8000-000000000002",
      0,
    );
    const mutation = policyInput("62000000-0000-4000-8000-000000000003", 0);

    const [publishResult, policyResult] = await Promise.all([
      repository.publishArtifact(publication),
      repository.advancePolicyEpoch(mutation),
    ]);
    expect(policyResult).toEqual({
      newPolicyEpoch: 1,
      previousPolicyEpoch: 0,
      status: "accepted",
    });
    expect(["accepted", "policy_conflict"]).toContain(publishResult.status);
    if (publishResult.status === "accepted") {
      expect(publishResult.policyEpoch).toBe(0);
    } else {
      expect(publishResult).toEqual({
        code: "policy_conflict",
        currentPolicyEpoch: 1,
        status: "policy_conflict",
      });
    }
    await expect(repository.publishArtifact(publication)).resolves.toEqual(
      publishResult,
    );
    await expect(repository.advancePolicyEpoch(mutation)).resolves.toEqual(
      policyResult,
    );

    await runInDurableObject(repository, (_instance, state) => {
      const artifactCount = state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM artifacts")
        .one().count;
      const receiptCount = state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM receipts")
        .one().count;
      const outboxCount = state.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM authority_outbox",
        )
        .one().count;
      const expectedCount = publishResult.status === "accepted" ? 2 : 1;
      expect(artifactCount).toBe(expectedCount);
      expect(receiptCount).toBe(expectedCount);
      expect(outboxCount).toBe(expectedCount);
    });
  });

  it("rejects a publish prepared with the epoch before the fence", async () => {
    const repository = env.REPOSITORY.getByName("policy-before-publish");
    const identity = await signingIdentity();
    const projectId = await initializeProject(
      repository,
      identity,
      "63000000-0000-4000-8000-000000000001",
    );
    const stalePublication = await signedInput(
      encodeTree({
        actorKey: identity.actorKey,
        createdAt: "2026-08-25T00:00:01Z",
        entries: [],
        logicalClock: 1n,
        parents: [],
        project: projectId,
        realm: "public",
      }),
      identity,
      "63000000-0000-4000-8000-000000000002",
      0,
    );
    await repository.advancePolicyEpoch(
      policyInput("63000000-0000-4000-8000-000000000003", 0),
    );
    await expect(repository.publishArtifact(stalePublication)).resolves.toEqual(
      {
        code: "policy_conflict",
        currentPolicyEpoch: 1,
        status: "policy_conflict",
      },
    );
  });
});

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}
