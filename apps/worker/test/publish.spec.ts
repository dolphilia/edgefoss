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

import type {
  PublishArtifactInput,
  PublishArtifactResult,
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
  ref: PublishArtifactInput["ref"],
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
  const signatureBytes = encodeSignatureRecord({
    actorKey: identity.actorKey,
    artifact: id,
    signature,
  });
  return {
    artifactBytes: copyBuffer(bytes),
    artifactId: id,
    expectedPolicyEpoch,
    operationId,
    principalId: "owner",
    ref,
    signatureBytes: copyBuffer(signatureBytes),
  };
}

async function initializeProject(
  repository: RepositoryStub,
  identity: SigningIdentity,
  operationId: string,
): Promise<string> {
  const bytes = encodeProjectGenesis({
    actorKey: identity.actorKey,
    createdAt: "2026-08-25T00:00:00Z",
    name: "P4c test project",
    nonce: new Uint8Array(32).fill(0x44),
  });
  const input = await publishInput(bytes, identity, operationId, null);
  const result = await repository.publishArtifact(input);
  expect(result).toMatchObject({
    artifactId: input.artifactId,
    kind: "project.genesis",
    repoSequence: 1,
    status: "accepted",
  });
  return input.artifactId;
}

async function finalizedBlob(
  repository: RepositoryStub,
  realm: "public" | "members",
  bytes: Uint8Array,
  operationId: string,
): Promise<string> {
  const id = await artifactId(bytes);
  const declaration = await repository.beginUpload({
    blobId: id,
    byteSize: bytes.byteLength,
    operationId,
    principalId: "owner",
    realm,
  });
  if (declaration.status !== "ok") throw new Error("unexpected conflict");
  await repository.stageUpload(
    "owner",
    declaration.upload.uploadId,
    copyBuffer(bytes),
  );
  const finalized = await repository.finalizeUpload(
    "owner",
    declaration.upload.uploadId,
  );
  expect(finalized.state).toBe("finalized");
  return id;
}

describe("RepositoryDO canonical artifact publication", () => {
  it("atomically accepts signed artifacts, deduplicates retries, and CASes the realm head", async () => {
    const repository = env.REPOSITORY.getByName("publish-canonical");
    const identity = await signingIdentity();
    const projectId = await initializeProject(
      repository,
      identity,
      "10000000-0000-4000-8000-000000000001",
    );
    const blob = await finalizedBlob(
      repository,
      "public",
      new TextEncoder().encode("P4c public source"),
      "10000000-0000-4000-8000-000000000002",
    );
    const treeInput = await publishInput(
      encodeTree({
        actorKey: identity.actorKey,
        createdAt: "2026-08-25T00:00:01Z",
        entries: [
          { mode: "file", name: "COPY.md", target: blob },
          { mode: "file", name: "README.md", target: blob },
        ],
        logicalClock: 1n,
        parents: [],
        project: projectId,
        realm: "public",
      }),
      identity,
      "10000000-0000-4000-8000-000000000003",
      null,
    );
    await expect(repository.publishArtifact(treeInput)).resolves.toMatchObject({
      kind: "tree",
      repoSequence: 2,
      status: "accepted",
    });

    const changeInput = await publishInput(
      encodeChange({
        actorKey: identity.actorKey,
        createdAt: "2026-08-25T00:00:02Z",
        logicalClock: 2n,
        message: "initial",
        parents: [],
        project: projectId,
        realm: "public",
        root: treeInput.artifactId,
      }),
      identity,
      "10000000-0000-4000-8000-000000000004",
      { expectedGeneration: 0, name: "heads/main" },
    );
    const first = await repository.publishArtifact(changeInput);
    expect(first).toMatchObject({
      kind: "change",
      ref: {
        generation: 1,
        name: "heads/main",
        targetArtifactId: changeInput.artifactId,
      },
      repoSequence: 3,
      status: "accepted",
    });
    for (let retry = 0; retry < 100; retry += 1) {
      await expect(repository.publishArtifact(changeInput)).resolves.toEqual(
        first,
      );
    }

    await expect(
      repository.publishArtifact({
        ...changeInput,
        ref: { expectedGeneration: 1, name: "heads/main" },
      }),
    ).resolves.toEqual({ code: "operation_conflict", status: "conflict" });

    const stale = await publishInput(
      new Uint8Array(changeInput.artifactBytes),
      identity,
      "10000000-0000-4000-8000-000000000005",
      { expectedGeneration: 0, name: "heads/main" },
    );
    const staleResult = await repository.publishArtifact(stale);
    expect(staleResult).toEqual({
      code: "ref_conflict",
      currentGeneration: 1,
      currentTargetArtifactId: changeInput.artifactId,
      status: "ref_conflict",
    });
    await expect(repository.publishArtifact(stale)).resolves.toEqual(
      staleResult,
    );

    const stalePolicy = await publishInput(
      new Uint8Array(treeInput.artifactBytes),
      identity,
      "10000000-0000-4000-8000-000000000006",
      null,
      1,
    );
    const policyResult = await repository.publishArtifact(stalePolicy);
    expect(policyResult).toEqual({
      code: "policy_conflict",
      currentPolicyEpoch: 0,
      status: "policy_conflict",
    });
    await expect(repository.publishArtifact(stalePolicy)).resolves.toEqual(
      policyResult,
    );

    const untrustedIdentity = await signingIdentity();
    const untrustedTree = await publishInput(
      encodeTree({
        actorKey: untrustedIdentity.actorKey,
        createdAt: "2026-08-25T00:00:03Z",
        entries: [],
        logicalClock: 1n,
        parents: [],
        project: projectId,
        realm: "public",
      }),
      untrustedIdentity,
      "10000000-0000-4000-8000-000000000007",
      null,
    );
    await expect(repository.publishArtifact(untrustedTree)).resolves.toEqual({
      code: "artifact_actor_unauthorized",
      status: "rejected",
    });

    const invalidSignature = {
      ...treeInput,
      operationId: "10000000-0000-4000-8000-000000000008",
      signatureBytes: treeInput.signatureBytes.slice(0),
    };
    new Uint8Array(invalidSignature.signatureBytes).fill(0, 8);
    await expect(repository.publishArtifact(invalidSignature)).resolves.toEqual(
      { code: "artifact_invalid", status: "rejected" },
    );
  });

  it("rolls back a missing-blob attempt and prevents public-to-members reachability", async () => {
    const repository = env.REPOSITORY.getByName("publish-realm-rollback");
    const identity = await signingIdentity();
    const projectId = await initializeProject(
      repository,
      identity,
      "20000000-0000-4000-8000-000000000001",
    );
    const initiallyMissingBytes = new TextEncoder().encode(
      "eventually finalized public source",
    );
    const initiallyMissingBlobId = await artifactId(initiallyMissingBytes);
    const recoverableTreeInput = await publishInput(
      encodeTree({
        actorKey: identity.actorKey,
        createdAt: "2026-08-25T00:00:59Z",
        entries: [
          {
            mode: "file",
            name: "eventual.txt",
            target: initiallyMissingBlobId,
          },
        ],
        logicalClock: 1n,
        parents: [],
        project: projectId,
        realm: "public",
      }),
      identity,
      "20000000-0000-4000-8000-000000000002",
      null,
    );
    await expect(
      repository.publishArtifact(recoverableTreeInput),
    ).resolves.toEqual({
      code: "artifact_blob_missing",
      status: "rejected",
    });
    await finalizedBlob(
      repository,
      "public",
      initiallyMissingBytes,
      "20000000-0000-4000-8000-000000000003",
    );
    await expect(
      repository.publishArtifact(recoverableTreeInput),
    ).resolves.toMatchObject({ repoSequence: 2, status: "accepted" });

    const membersBytes = new TextEncoder().encode("members-only source");
    const membersBlobId = await artifactId(membersBytes);
    const publicTreeInput = await publishInput(
      encodeTree({
        actorKey: identity.actorKey,
        createdAt: "2026-08-25T00:01:00Z",
        entries: [{ mode: "file", name: "private.txt", target: membersBlobId }],
        logicalClock: 1n,
        parents: [],
        project: projectId,
        realm: "public",
      }),
      identity,
      "20000000-0000-4000-8000-000000000004",
      null,
    );
    await expect(repository.publishArtifact(publicTreeInput)).resolves.toEqual({
      code: "artifact_blob_missing",
      status: "rejected",
    });

    await finalizedBlob(
      repository,
      "members",
      membersBytes,
      "20000000-0000-4000-8000-000000000005",
    );
    await expect(repository.publishArtifact(publicTreeInput)).resolves.toEqual({
      code: "artifact_blob_missing",
      status: "rejected",
    });

    const membersTreeInput = await publishInput(
      encodeTree({
        actorKey: identity.actorKey,
        createdAt: "2026-08-25T00:01:01Z",
        entries: [{ mode: "file", name: "private.txt", target: membersBlobId }],
        logicalClock: 1n,
        parents: [],
        project: projectId,
        realm: "members",
      }),
      identity,
      "20000000-0000-4000-8000-000000000006",
      null,
    );
    await expect(
      repository.publishArtifact(membersTreeInput),
    ).resolves.toMatchObject({
      kind: "tree",
      realm: "members",
      repoSequence: 3,
      status: "accepted",
    });
  });

  it("linearizes concurrent ref updates and preserves each operation result", async () => {
    const repository = env.REPOSITORY.getByName("publish-concurrent-cas");
    const identity = await signingIdentity();
    const projectId = await initializeProject(
      repository,
      identity,
      "30000000-0000-4000-8000-000000000001",
    );
    const treeInput = await publishInput(
      encodeTree({
        actorKey: identity.actorKey,
        createdAt: "2026-08-25T00:02:00Z",
        entries: [],
        logicalClock: 1n,
        parents: [],
        project: projectId,
        realm: "public",
      }),
      identity,
      "30000000-0000-4000-8000-000000000002",
      null,
    );
    await repository.publishArtifact(treeInput);

    const firstChange = await publishInput(
      encodeChange({
        actorKey: identity.actorKey,
        createdAt: "2026-08-25T00:02:01Z",
        logicalClock: 2n,
        message: "base",
        parents: [],
        project: projectId,
        realm: "public",
        root: treeInput.artifactId,
      }),
      identity,
      "30000000-0000-4000-8000-000000000003",
      { expectedGeneration: 0, name: "heads/main" },
    );
    await repository.publishArtifact(firstChange);

    const candidates = await Promise.all(
      ["left", "right"].map(async (message, index) =>
        publishInput(
          encodeChange({
            actorKey: identity.actorKey,
            createdAt: `2026-08-25T00:02:0${index + 2}Z`,
            logicalClock: 3n,
            message,
            parents: [firstChange.artifactId],
            project: projectId,
            realm: "public",
            root: treeInput.artifactId,
          }),
          identity,
          `30000000-0000-4000-8000-00000000000${index + 4}`,
          { expectedGeneration: 1, name: "heads/main" },
        ),
      ),
    );
    const results = await Promise.all(
      candidates.map((candidate) => repository.publishArtifact(candidate)),
    );
    expect(results.map((result) => result.status).sort()).toEqual([
      "accepted",
      "ref_conflict",
    ]);
    const accepted = results.find(
      (
        result,
      ): result is Extract<PublishArtifactResult, { status: "accepted" }> =>
        result.status === "accepted",
    );
    const conflict = results.find(
      (
        result,
      ): result is Extract<PublishArtifactResult, { status: "ref_conflict" }> =>
        result.status === "ref_conflict",
    );
    expect(accepted?.ref?.generation).toBe(2);
    expect(conflict).toMatchObject({
      currentGeneration: 2,
      currentTargetArtifactId: accepted?.artifactId,
    });
    const conflictIndex = results.findIndex(
      (result) => result.status === "ref_conflict",
    );
    await expect(
      repository.publishArtifact(candidates[conflictIndex]!),
    ).resolves.toEqual(conflict);
  });
});

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}
