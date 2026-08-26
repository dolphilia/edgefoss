import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import rawVector from "../../../spec/vectors/public-clone-v0.json";
import type { PublishArtifactInput, RepositoryDO } from "../src/index";

interface PushVector {
  project_id: string;
  head_artifact_id: string;
  files: Record<string, string>;
  fresh_push_plan: {
    snapshot: {
      accepted_sequence: number;
      missing_artifact_ids: string[];
      missing_blob_ids: string[];
      policy_epoch: number;
      project_id: null;
      ref_generation: null;
      ref_target: null;
    };
    blobs: Array<{
      blob_id: string;
      byte_size: number;
      object_path: string;
      operation_id: string;
    }>;
    artifacts: Array<{
      artifact_id: string;
      artifact_path: string;
      expected_policy_epoch: number;
      kind: "project.genesis" | "tree" | "change";
      operation_id: string;
      ref: { expected_generation: number; name: "heads/main" } | null;
      signature_path: string;
    }>;
  };
  incremental_push: {
    head_artifact_id: string;
    files: Record<string, string>;
    plan: {
      snapshot: {
        accepted_sequence: number;
        missing_artifact_ids: string[];
        missing_blob_ids: string[];
        policy_epoch: number;
        project_id: string;
        ref_generation: number;
        ref_target: string;
      };
      blobs: [];
      artifacts: Array<{
        artifact_id: string;
        artifact_path: string;
        expected_policy_epoch: number;
        kind: "change";
        operation_id: string;
        ref: { expected_generation: number; name: "heads/main" };
        signature_path: string;
      }>;
    };
  };
}

const vector = rawVector as PushVector;

function bytes(
  path: string,
  files: Record<string, string> = vector.files,
): Uint8Array {
  const hex = files[path];
  if (hex === undefined || hex.length % 2 !== 0) {
    throw new Error(`invalid vector object ${path}`);
  }
  return Uint8Array.from(
    hex.match(/../gu)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
}

function copyBuffer(value: Uint8Array): ArrayBuffer {
  const result = new Uint8Array(value.byteLength);
  result.set(value);
  return result.buffer;
}

describe("fresh public push cross-runtime plan", () => {
  it("executes the Rust-compatible deterministic plan and converges on retry", async () => {
    const repository: DurableObjectStub<RepositoryDO> =
      env.REPOSITORY.getByName("public-push-vector");
    const plan = vector.fresh_push_plan;
    const preflight = await repository.preflightPublicPush({
      artifactIds: plan.snapshot.missing_artifact_ids,
      blobIds: plan.snapshot.missing_blob_ids,
      principalId: "owner",
      projectId: vector.project_id,
      protocolVersion: 0,
      realm: "public",
    });
    expect(preflight).toEqual({
      limits: { maxArtifactIds: 256, maxBlobIds: 256 },
      missingArtifactIds: plan.snapshot.missing_artifact_ids,
      missingBlobIds: plan.snapshot.missing_blob_ids,
      snapshot: {
        acceptedSequence: plan.snapshot.accepted_sequence,
        policyEpoch: plan.snapshot.policy_epoch,
        projectId: plan.snapshot.project_id,
        ref: null,
      },
      status: "ok",
    });

    for (const step of plan.blobs) {
      const input = {
        blobId: step.blob_id,
        byteSize: step.byte_size,
        operationId: step.operation_id,
        principalId: "owner",
        realm: "public" as const,
      };
      const first = await repository.beginUpload(input);
      await expect(repository.beginUpload(input)).resolves.toEqual(first);
      if (first.status !== "ok") throw new Error("unexpected upload conflict");
      await repository.stageUpload(
        "owner",
        first.upload.uploadId,
        copyBuffer(bytes(step.object_path)),
      );
      const finalized = await repository.finalizeUpload(
        "owner",
        first.upload.uploadId,
      );
      expect(finalized.state).toBe("finalized");
      await expect(
        repository.finalizeUpload("owner", first.upload.uploadId),
      ).resolves.toEqual(finalized);
    }

    let expectedSequence = 1;
    for (const step of plan.artifacts) {
      const input: PublishArtifactInput = {
        artifactBytes: copyBuffer(bytes(step.artifact_path)),
        artifactId: step.artifact_id,
        expectedPolicyEpoch: step.expected_policy_epoch,
        operationId: step.operation_id,
        principalId: "owner",
        ref:
          step.ref === null
            ? null
            : {
                expectedGeneration: step.ref.expected_generation,
                name: step.ref.name,
              },
        signatureBytes: copyBuffer(bytes(step.signature_path)),
      };
      const first = await repository.publishArtifact(input);
      expect(first).toMatchObject({
        artifactId: step.artifact_id,
        kind: step.kind,
        repoSequence: expectedSequence,
        status: "accepted",
      });
      await expect(repository.publishArtifact(input)).resolves.toEqual(first);
      expectedSequence += 1;
    }

    await expect(
      repository.preflightPublicPush({
        artifactIds: plan.snapshot.missing_artifact_ids,
        blobIds: plan.snapshot.missing_blob_ids,
        principalId: "owner",
        projectId: vector.project_id,
        protocolVersion: 0,
        realm: "public",
      }),
    ).resolves.toEqual({
      limits: { maxArtifactIds: 256, maxBlobIds: 256 },
      missingArtifactIds: [],
      missingBlobIds: [],
      snapshot: {
        acceptedSequence: 3,
        policyEpoch: 0,
        projectId: vector.project_id,
        ref: {
          generation: 1,
          name: "heads/main",
          targetArtifactId: vector.head_artifact_id,
        },
      },
      status: "ok",
    });

    const incremental = vector.incremental_push;
    await expect(
      repository.preflightPublicPush({
        artifactIds: incremental.plan.snapshot.missing_artifact_ids,
        blobIds: incremental.plan.snapshot.missing_blob_ids,
        principalId: "owner",
        projectId: vector.project_id,
        protocolVersion: 0,
        realm: "public",
      }),
    ).resolves.toEqual({
      limits: { maxArtifactIds: 256, maxBlobIds: 256 },
      missingArtifactIds: incremental.plan.snapshot.missing_artifact_ids,
      missingBlobIds: [],
      snapshot: {
        acceptedSequence: incremental.plan.snapshot.accepted_sequence,
        policyEpoch: incremental.plan.snapshot.policy_epoch,
        projectId: incremental.plan.snapshot.project_id,
        ref: {
          generation: incremental.plan.snapshot.ref_generation,
          name: "heads/main",
          targetArtifactId: incremental.plan.snapshot.ref_target,
        },
      },
      status: "ok",
    });

    for (const step of incremental.plan.artifacts) {
      const input: PublishArtifactInput = {
        artifactBytes: copyBuffer(bytes(step.artifact_path, incremental.files)),
        artifactId: step.artifact_id,
        expectedPolicyEpoch: step.expected_policy_epoch,
        operationId: step.operation_id,
        principalId: "owner",
        ref: {
          expectedGeneration: step.ref.expected_generation,
          name: step.ref.name,
        },
        signatureBytes: copyBuffer(
          bytes(step.signature_path, incremental.files),
        ),
      };
      const first = await repository.publishArtifact(input);
      expect(first).toMatchObject({
        artifactId: step.artifact_id,
        kind: step.kind,
        repoSequence: 4,
        status: "accepted",
      });
      await expect(repository.publishArtifact(input)).resolves.toEqual(first);
    }

    await expect(
      repository.preflightPublicPush({
        artifactIds: incremental.plan.snapshot.missing_artifact_ids,
        blobIds: incremental.plan.snapshot.missing_blob_ids,
        principalId: "owner",
        projectId: vector.project_id,
        protocolVersion: 0,
        realm: "public",
      }),
    ).resolves.toEqual({
      limits: { maxArtifactIds: 256, maxBlobIds: 256 },
      missingArtifactIds: [],
      missingBlobIds: [],
      snapshot: {
        acceptedSequence: 4,
        policyEpoch: 0,
        projectId: vector.project_id,
        ref: {
          generation: 2,
          name: "heads/main",
          targetArtifactId: incremental.head_artifact_id,
        },
      },
      status: "ok",
    });
  });
});
