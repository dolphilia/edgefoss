export const MAX_PUSH_PREFLIGHT_ARTIFACTS = 256;
export const MAX_PUSH_PREFLIGHT_BLOBS = 256;

const ARTIFACT_ID = /^sha256:[0-9a-f]{64}$/u;

export interface PublicPushPreflightInput {
  artifactIds: string[];
  blobIds: string[];
  principalId: "owner";
  projectId: string;
  protocolVersion: 0;
  realm: "public";
}

export interface PublicPushSnapshotV0 {
  acceptedSequence: number;
  policyEpoch: number;
  projectId: string | null;
  ref: {
    generation: number;
    name: "heads/main";
    targetArtifactId: string;
  } | null;
}

export type PublicPushPreflightResult =
  | {
      code: "push_preflight_invalid";
      status: "rejected";
    }
  | {
      code: "project_conflict";
      status: "rejected";
    }
  | {
      limits: {
        maxArtifactIds: number;
        maxBlobIds: number;
      };
      missingArtifactIds: string[];
      missingBlobIds: string[];
      snapshot: PublicPushSnapshotV0;
      status: "ok";
    };

interface MetaRow {
  [key: string]: SqlStorageValue;
  value: string;
}

interface RefRow {
  [key: string]: SqlStorageValue;
  artifact_id: string;
  generation: number;
}

export function preflightPublicPush(
  sql: SqlStorage,
  input: PublicPushPreflightInput,
): PublicPushPreflightResult {
  try {
    validateInput(input);
  } catch (error) {
    if (error instanceof Error && error.message === "push_preflight_invalid") {
      return { code: "push_preflight_invalid", status: "rejected" };
    }
    throw error;
  }

  const storedProjectId = meta(sql, "project_id");
  if (storedProjectId !== "" && storedProjectId !== input.projectId) {
    return { code: "project_conflict", status: "rejected" };
  }

  const missingArtifactIds = input.artifactIds.filter(
    (artifactId) =>
      sql
        .exec<{ present: number }>(
          `SELECT 1 AS present
             FROM artifacts
            WHERE artifact_id = ? AND project_id = ? AND realm = 'public'`,
          artifactId,
          input.projectId,
        )
        .toArray()[0] === undefined,
  );
  const missingBlobIds = input.blobIds.filter(
    (blobId) =>
      sql
        .exec<{ present: number }>(
          `SELECT 1 AS present
             FROM blobs
            WHERE realm = 'public' AND blob_id = ? AND state = 'finalized'`,
          blobId,
        )
        .toArray()[0] === undefined,
  );
  const ref = sql
    .exec<RefRow>(
      `SELECT artifact_id, generation
         FROM realm_refs
        WHERE realm = 'public' AND ref_name = 'heads/main'`,
    )
    .toArray()[0];

  return {
    limits: {
      maxArtifactIds: MAX_PUSH_PREFLIGHT_ARTIFACTS,
      maxBlobIds: MAX_PUSH_PREFLIGHT_BLOBS,
    },
    missingArtifactIds,
    missingBlobIds,
    snapshot: {
      acceptedSequence: metaInteger(sql, "repo_seq"),
      policyEpoch: metaInteger(sql, "policy_epoch"),
      projectId: storedProjectId === "" ? null : storedProjectId,
      ref: ref
        ? {
            generation: ref.generation,
            name: "heads/main",
            targetArtifactId: ref.artifact_id,
          }
        : null,
    },
    status: "ok",
  };
}

function validateInput(input: PublicPushPreflightInput): void {
  if (
    input === null ||
    typeof input !== "object" ||
    input.principalId !== "owner" ||
    input.protocolVersion !== 0 ||
    input.realm !== "public" ||
    !ARTIFACT_ID.test(input.projectId)
  ) {
    throw new Error("push_preflight_invalid");
  }
  validateIds(input.artifactIds, MAX_PUSH_PREFLIGHT_ARTIFACTS);
  validateIds(input.blobIds, MAX_PUSH_PREFLIGHT_BLOBS);
}

function validateIds(ids: unknown, maximum: number): void {
  if (!Array.isArray(ids) || ids.length > maximum) {
    throw new Error("push_preflight_invalid");
  }
  let previous: string | undefined;
  for (const id of ids) {
    if (
      typeof id !== "string" ||
      !ARTIFACT_ID.test(id) ||
      (previous !== undefined && id <= previous)
    ) {
      throw new Error("push_preflight_invalid");
    }
    previous = id;
  }
}

function meta(sql: SqlStorage, key: string): string {
  return sql
    .exec<MetaRow>("SELECT value FROM edgefoss_meta WHERE key = ?", key)
    .one().value;
}

function metaInteger(sql: SqlStorage, key: string): number {
  const value = Number(meta(sql, key));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("push_snapshot_invalid");
  }
  return value;
}
