import type { PublishArtifactKind } from "./artifact-publish.js";

export const SYNC_PROTOCOL_VERSION = 0 as const;
export const MAX_INVENTORY_PAGE_ITEMS = 1_000;

export interface SyncHelloInput {
  offeredProtocolVersions: number[];
  principalId: "anonymous";
  requestedView: "public";
}

export type SyncHelloResult =
  | {
      capabilities: {
        inventory: {
          ordering: "artifact_id_asc";
          maxPageItems: number;
        };
        phases: readonly ["HELLO", "INVENTORY"];
      };
      principalId: "anonymous";
      projectId: string;
      protocolVersion: 0;
      status: "accepted";
      view: {
        id: "public";
        realms: readonly ["public"];
      };
    }
  | { code: "project_not_initialized"; status: "rejected" }
  | { code: "protocol_not_supported"; status: "rejected" }
  | { code: "request_invalid"; status: "rejected" }
  | { code: "view_not_supported"; status: "rejected" };

/**
 * Authority-internal continuation state. An HTTP adapter must replace this with
 * an opaque, integrity-protected token and must never serialize these fields.
 */
export interface PublicInventoryAnchorV0 {
  afterArtifactId: string;
  policyEpoch: number;
  principalId: "anonymous";
  projectId: string;
  protocolVersion: 0;
  snapshotAcceptedSequence: number;
  view: "public";
}

export interface PublicInventoryInput {
  anchor: PublicInventoryAnchorV0 | null;
  limit: number;
  principalId: "anonymous";
  projectId: string;
  protocolVersion: 0;
  view: "public";
}

export interface PublicInventoryItemV0 {
  artifactId: string;
  kind: PublishArtifactKind;
}

export type PublicInventoryResult =
  | {
      items: PublicInventoryItemV0[];
      nextAnchor: PublicInventoryAnchorV0 | null;
      status: "ok";
    }
  | { code: "cursor_invalid"; status: "rejected" }
  | {
      code: "cursor_stale";
      currentPolicyEpoch: number;
      status: "rejected";
    }
  | { code: "project_not_initialized"; status: "rejected" }
  | { code: "request_invalid"; status: "rejected" };

interface InventoryRow extends Record<string, SqlStorageValue> {
  artifact_id: string;
  kind: PublishArtifactKind;
}

export function negotiatePublicSync(
  sql: SqlStorage,
  input: SyncHelloInput,
): SyncHelloResult {
  if (!validHelloInput(input)) {
    return { code: "request_invalid", status: "rejected" };
  }
  if (input.requestedView !== "public") {
    return { code: "view_not_supported", status: "rejected" };
  }
  if (!input.offeredProtocolVersions.includes(SYNC_PROTOCOL_VERSION)) {
    return { code: "protocol_not_supported", status: "rejected" };
  }

  const projectId = metaValue(sql, "project_id");
  if (projectId === "") {
    return { code: "project_not_initialized", status: "rejected" };
  }

  return {
    capabilities: {
      inventory: {
        maxPageItems: MAX_INVENTORY_PAGE_ITEMS,
        ordering: "artifact_id_asc",
      },
      phases: ["HELLO", "INVENTORY"],
    },
    principalId: "anonymous",
    projectId,
    protocolVersion: SYNC_PROTOCOL_VERSION,
    status: "accepted",
    view: { id: "public", realms: ["public"] },
  };
}

export function readPublicInventory(
  sql: SqlStorage,
  input: PublicInventoryInput,
): PublicInventoryResult {
  if (!validInventoryInput(input)) {
    return { code: "request_invalid", status: "rejected" };
  }

  const projectId = metaValue(sql, "project_id");
  if (projectId === "") {
    return { code: "project_not_initialized", status: "rejected" };
  }
  if (input.projectId !== projectId) {
    return { code: "cursor_invalid", status: "rejected" };
  }

  const policyEpoch = metaInteger(sql, "policy_epoch");
  const anchor = input.anchor;
  if (anchor !== null && !anchorMatchesRequest(anchor, input)) {
    return { code: "cursor_invalid", status: "rejected" };
  }
  if (anchor !== null && anchor.policyEpoch !== policyEpoch) {
    return {
      code: "cursor_stale",
      currentPolicyEpoch: policyEpoch,
      status: "rejected",
    };
  }

  const snapshotAcceptedSequence =
    anchor?.snapshotAcceptedSequence ?? publicSnapshotSequence(sql);
  const afterArtifactId = anchor?.afterArtifactId ?? "";
  const rows = sql
    .exec<InventoryRow>(
      `SELECT artifact_id, kind
         FROM artifacts
        WHERE realm = 'public'
          AND accepted_seq <= ?
          AND artifact_id > ?
        ORDER BY artifact_id ASC
        LIMIT ?`,
      snapshotAcceptedSequence,
      afterArtifactId,
      input.limit + 1,
    )
    .toArray();
  const hasNextPage = rows.length > input.limit;
  const pageRows = hasNextPage ? rows.slice(0, input.limit) : rows;
  const items = pageRows.map((row) => ({
    artifactId: row.artifact_id,
    kind: row.kind,
  }));
  const lastArtifactId = pageRows.at(-1)?.artifact_id;

  return {
    items,
    nextAnchor:
      hasNextPage && lastArtifactId !== undefined
        ? {
            afterArtifactId: lastArtifactId,
            policyEpoch,
            principalId: "anonymous",
            projectId,
            protocolVersion: SYNC_PROTOCOL_VERSION,
            snapshotAcceptedSequence,
            view: "public",
          }
        : null,
    status: "ok",
  };
}

function validHelloInput(input: SyncHelloInput): boolean {
  return (
    input !== null &&
    typeof input === "object" &&
    input.principalId === "anonymous" &&
    Array.isArray(input.offeredProtocolVersions) &&
    input.offeredProtocolVersions.length > 0 &&
    input.offeredProtocolVersions.length <= 8 &&
    input.offeredProtocolVersions.every(
      (version) => Number.isSafeInteger(version) && version >= 0,
    )
  );
}

function validInventoryInput(input: PublicInventoryInput): boolean {
  return (
    input !== null &&
    typeof input === "object" &&
    input.principalId === "anonymous" &&
    input.protocolVersion === SYNC_PROTOCOL_VERSION &&
    input.view === "public" &&
    typeof input.projectId === "string" &&
    input.projectId.length > 0 &&
    Number.isSafeInteger(input.limit) &&
    input.limit >= 1 &&
    input.limit <= MAX_INVENTORY_PAGE_ITEMS &&
    (input.anchor === null || validAnchor(input.anchor))
  );
}

function validAnchor(anchor: PublicInventoryAnchorV0): boolean {
  return (
    anchor !== null &&
    typeof anchor === "object" &&
    /^sha256:[0-9a-f]{64}$/.test(anchor.afterArtifactId) &&
    Number.isSafeInteger(anchor.policyEpoch) &&
    anchor.policyEpoch >= 0 &&
    anchor.principalId === "anonymous" &&
    typeof anchor.projectId === "string" &&
    anchor.projectId.length > 0 &&
    anchor.protocolVersion === SYNC_PROTOCOL_VERSION &&
    Number.isSafeInteger(anchor.snapshotAcceptedSequence) &&
    anchor.snapshotAcceptedSequence >= 0 &&
    anchor.view === "public"
  );
}

function anchorMatchesRequest(
  anchor: PublicInventoryAnchorV0,
  input: PublicInventoryInput,
): boolean {
  return (
    anchor.principalId === input.principalId &&
    anchor.projectId === input.projectId &&
    anchor.protocolVersion === input.protocolVersion &&
    anchor.view === input.view
  );
}

function publicSnapshotSequence(sql: SqlStorage): number {
  const value = sql
    .exec<{ value: number | null }>(
      "SELECT MAX(accepted_seq) AS value FROM artifacts WHERE realm = 'public'",
    )
    .one().value;
  if (value === null) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("repository_counter_invalid");
  }
  return value;
}

function metaValue(sql: SqlStorage, key: string): string {
  return sql
    .exec<{ value: string }>(
      "SELECT value FROM edgefoss_meta WHERE key = ?",
      key,
    )
    .one().value;
}

function metaInteger(sql: SqlStorage, key: string): number {
  const value = Number(metaValue(sql, key));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("repository_counter_invalid");
  }
  return value;
}
