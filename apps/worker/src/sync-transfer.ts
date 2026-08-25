import {
  artifactId,
  encodeSignatureRecord,
  verifyArtifactSignature,
} from "@edgefoss/protocol";

import type { PublishArtifactKind } from "./artifact-publish.js";
import {
  SYNC_PROTOCOL_VERSION,
  type PublicInventoryAnchorV0,
} from "./sync-inventory.js";

export const MAX_PUBLIC_TRANSFER_ITEMS = 16;
export const MAX_PUBLIC_TRANSFER_BYTES = 2 * 1024 * 1024;

export interface BeginPublicTransferInput {
  principalId: "anonymous";
  projectId: string;
  protocolVersion: 0;
  view: "public";
}

export type BeginPublicTransferResult =
  | {
      snapshot: PublicInventoryAnchorV0;
      status: "ok";
    }
  | { code: "project_not_initialized"; status: "rejected" }
  | { code: "request_invalid"; status: "rejected" };

export interface PublicArtifactTransferInput {
  artifactIds: string[];
  snapshot: PublicInventoryAnchorV0;
}

export interface PublicArtifactTransferItemV0 {
  artifactBytes: ArrayBuffer;
  artifactId: string;
  kind: PublishArtifactKind;
  signatureBytes: ArrayBuffer;
}

export type PublicArtifactTransferResult =
  | { items: PublicArtifactTransferItemV0[]; status: "ok" }
  | { code: "artifact_unavailable"; status: "rejected" }
  | { code: "project_not_initialized"; status: "rejected" }
  | { code: "request_invalid"; status: "rejected" }
  | {
      code: "snapshot_stale";
      currentPolicyEpoch: number;
      status: "rejected";
    }
  | { code: "transfer_budget_exceeded"; status: "rejected" };

interface TransferRow extends Record<string, SqlStorageValue> {
  actor_key: ArrayBuffer;
  artifact_id: string;
  canonical_body: ArrayBuffer;
  kind: PublishArtifactKind;
  signature: ArrayBuffer;
}

/** Captures a public accepted-state boundary for internal inventory/transfer. */
export function beginPublicTransfer(
  sql: SqlStorage,
  input: BeginPublicTransferInput,
): BeginPublicTransferResult {
  if (!validBeginInput(input)) {
    return { code: "request_invalid", status: "rejected" };
  }
  const projectId = metaValue(sql, "project_id");
  if (projectId === "") {
    return { code: "project_not_initialized", status: "rejected" };
  }
  if (input.projectId !== projectId) {
    return { code: "request_invalid", status: "rejected" };
  }
  return {
    snapshot: {
      afterArtifactId: "",
      policyEpoch: metaInteger(sql, "policy_epoch"),
      principalId: "anonymous",
      projectId,
      protocolVersion: SYNC_PROTOCOL_VERSION,
      snapshotAcceptedSequence: publicSnapshotSequence(sql),
      view: "public",
    },
    status: "ok",
  };
}

/** Returns a bounded, verified artifact/signature batch from one public snapshot. */
export async function readPublicArtifactTransfer(
  sql: SqlStorage,
  input: PublicArtifactTransferInput,
): Promise<PublicArtifactTransferResult> {
  if (!validTransferInput(input)) {
    return { code: "request_invalid", status: "rejected" };
  }
  const projectId = metaValue(sql, "project_id");
  if (projectId === "") {
    return { code: "project_not_initialized", status: "rejected" };
  }
  if (input.snapshot.projectId !== projectId) {
    return { code: "request_invalid", status: "rejected" };
  }
  const currentPolicyEpoch = metaInteger(sql, "policy_epoch");
  if (input.snapshot.policyEpoch !== currentPolicyEpoch) {
    return {
      code: "snapshot_stale",
      currentPolicyEpoch,
      status: "rejected",
    };
  }
  if (input.snapshot.snapshotAcceptedSequence > publicSnapshotSequence(sql)) {
    return { code: "request_invalid", status: "rejected" };
  }

  const rows: TransferRow[] = [];
  for (const requestedId of input.artifactIds) {
    const row = sql
      .exec<TransferRow>(
        `SELECT a.artifact_id, a.kind, a.canonical_body, a.actor_key,
                t.signature
           FROM artifacts a
           JOIN attestations t
             ON t.artifact_id = a.artifact_id
            AND t.actor_key = a.actor_key
          WHERE a.artifact_id = ?
            AND a.project_id = ?
            AND a.realm = 'public'
            AND a.accepted_seq <= ?`,
        requestedId,
        projectId,
        input.snapshot.snapshotAcceptedSequence,
      )
      .toArray()[0];
    if (row === undefined) {
      return { code: "artifact_unavailable", status: "rejected" };
    }
    rows.push(row);
  }

  let transferredBytes = 0;
  const items: PublicArtifactTransferItemV0[] = [];
  for (const row of rows) {
    const artifactBytes = copyBuffer(row.canonical_body);
    const actorKey = new Uint8Array(row.actor_key);
    const signature = new Uint8Array(row.signature);
    if ((await artifactId(new Uint8Array(artifactBytes))) !== row.artifact_id) {
      throw new Error("public_transfer_corrupt");
    }
    const signatureRecord = { actorKey, artifact: row.artifact_id, signature };
    await verifyArtifactSignature(signatureRecord, row.artifact_id, actorKey);
    const signatureBytes = copyBuffer(encodeSignatureRecord(signatureRecord));
    transferredBytes += artifactBytes.byteLength + signatureBytes.byteLength;
    if (transferredBytes > MAX_PUBLIC_TRANSFER_BYTES) {
      return { code: "transfer_budget_exceeded", status: "rejected" };
    }
    items.push({
      artifactBytes,
      artifactId: row.artifact_id,
      kind: row.kind,
      signatureBytes,
    });
  }
  return { items, status: "ok" };
}

function validBeginInput(input: BeginPublicTransferInput): boolean {
  return (
    input !== null &&
    typeof input === "object" &&
    input.principalId === "anonymous" &&
    /^sha256:[0-9a-f]{64}$/u.test(input.projectId) &&
    input.protocolVersion === SYNC_PROTOCOL_VERSION &&
    input.view === "public"
  );
}

function validTransferInput(input: PublicArtifactTransferInput): boolean {
  if (
    input === null ||
    typeof input !== "object" ||
    !Array.isArray(input.artifactIds) ||
    input.artifactIds.length === 0 ||
    input.artifactIds.length > MAX_PUBLIC_TRANSFER_ITEMS ||
    !validSnapshot(input.snapshot)
  ) {
    return false;
  }
  let previous = "";
  for (const id of input.artifactIds) {
    if (!/^sha256:[0-9a-f]{64}$/u.test(id) || id <= previous) return false;
    previous = id;
  }
  return true;
}

function validSnapshot(snapshot: PublicInventoryAnchorV0): boolean {
  return (
    snapshot !== null &&
    typeof snapshot === "object" &&
    snapshot.afterArtifactId === "" &&
    snapshot.principalId === "anonymous" &&
    /^sha256:[0-9a-f]{64}$/u.test(snapshot.projectId) &&
    snapshot.protocolVersion === SYNC_PROTOCOL_VERSION &&
    snapshot.view === "public" &&
    Number.isSafeInteger(snapshot.policyEpoch) &&
    snapshot.policyEpoch >= 0 &&
    Number.isSafeInteger(snapshot.snapshotAcceptedSequence) &&
    snapshot.snapshotAcceptedSequence >= 0
  );
}

function metaValue(sql: SqlStorage, key: string): string {
  return (
    sql
      .exec<{ value: string }>(
        "SELECT value FROM edgefoss_meta WHERE key = ?",
        key,
      )
      .toArray()[0]?.value ?? ""
  );
}

function metaInteger(sql: SqlStorage, key: string): number {
  const value = Number(metaValue(sql, key));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid_${key}`);
  }
  return value;
}

function publicSnapshotSequence(sql: SqlStorage): number {
  return sql
    .exec<{ snapshot: number }>(
      `SELECT COALESCE(MAX(accepted_seq), 0) AS snapshot
         FROM artifacts
        WHERE realm = 'public'`,
    )
    .one().snapshot;
}

function copyBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const result = new ArrayBuffer(source.byteLength);
  new Uint8Array(result).set(source);
  return result;
}
