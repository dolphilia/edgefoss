import type { PublishArtifactKind } from "./artifact-publish.js";

export const SYNC_PROTOCOL_VERSION = 0 as const;
export const MAX_INVENTORY_PAGE_ITEMS = 1_000;
export const PUBLIC_CURSOR_TTL_MILLISECONDS = 10 * 60 * 1_000;

const CURSOR_KEY_META = "sync_cursor_key_v0";
const CURSOR_PREFIX = "efoss_cursor_v0_";
const CURSOR_NONCE_BYTES = 12;
const CURSOR_KEY_BYTES = 32;
const MAX_CURSOR_TOKEN_CHARACTERS = 1_024;
const CURSOR_AAD = new TextEncoder().encode("edgefoss:public-inventory:v0");

export interface SyncHelloInput {
  offeredProtocolVersions: number[];
  principalId: "anonymous";
  requestedView: "public";
}

export type SyncHelloResult =
  | {
      capabilities: {
        inventory: {
          cursor: "opaque";
          cursorTtlSeconds: number;
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

export interface PublicInventoryPageInput {
  cursor: string | null;
  limit: number;
  principalId: "anonymous";
  projectId: string;
  protocolVersion: 0;
  view: "public";
}

export type PublicInventoryPageResult =
  | {
      items: PublicInventoryItemV0[];
      nextCursor: string | null;
      status: "ok";
    }
  | Exclude<PublicInventoryResult, { status: "ok" }>
  | { code: "cursor_expired"; status: "rejected" };

type OpenCursorResult =
  | { anchor: PublicInventoryAnchorV0; status: "ok" }
  | { code: "cursor_expired" | "cursor_invalid"; status: "rejected" };

interface CursorEnvelopeV0 {
  anchor: PublicInventoryAnchorV0;
  expiresAt: number;
  version: 0;
}

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
        cursor: "opaque",
        cursorTtlSeconds: PUBLIC_CURSOR_TTL_MILLISECONDS / 1_000,
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

export async function openPublicInventoryCursor(
  sql: SqlStorage,
  token: string,
  now = Date.now(),
): Promise<OpenCursorResult> {
  const encoded = token.startsWith(CURSOR_PREFIX)
    ? token.slice(CURSOR_PREFIX.length)
    : "";
  if (token.length > MAX_CURSOR_TOKEN_CHARACTERS || encoded.length === 0) {
    return { code: "cursor_invalid", status: "rejected" };
  }
  const sealed = decodeCanonicalBase64Url(encoded);
  if (sealed === null || sealed.byteLength <= CURSOR_NONCE_BYTES + 16) {
    return { code: "cursor_invalid", status: "rejected" };
  }
  const key = await importCursorKey(sql, false);
  if (key === null) {
    return { code: "cursor_invalid", status: "rejected" };
  }

  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        additionalData: CURSOR_AAD,
        iv: sealed.slice(0, CURSOR_NONCE_BYTES),
        name: "AES-GCM",
      },
      key,
      sealed.slice(CURSOR_NONCE_BYTES),
    );
  } catch {
    return { code: "cursor_invalid", status: "rejected" };
  }

  const envelope = parseCursorEnvelope(plaintext);
  if (envelope === null) {
    return { code: "cursor_invalid", status: "rejected" };
  }
  if (!Number.isSafeInteger(now) || now < 0 || now >= envelope.expiresAt) {
    return { code: "cursor_expired", status: "rejected" };
  }
  return { anchor: envelope.anchor, status: "ok" };
}

export async function sealPublicInventoryCursor(
  sql: SqlStorage,
  anchor: PublicInventoryAnchorV0,
  now = Date.now(),
): Promise<string> {
  if (!validAnchor(anchor) || !Number.isSafeInteger(now) || now < 0) {
    throw new Error("cursor_state_invalid");
  }
  const expiresAt = now + PUBLIC_CURSOR_TTL_MILLISECONDS;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error("cursor_expiry_invalid");
  }
  const key = await importCursorKey(sql, true);
  if (key === null) throw new Error("cursor_key_unavailable");
  const nonce = crypto.getRandomValues(new Uint8Array(CURSOR_NONCE_BYTES));
  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      anchor,
      expiresAt,
      version: 0,
    } satisfies CursorEnvelopeV0),
  );
  const ciphertext = await crypto.subtle.encrypt(
    { additionalData: CURSOR_AAD, iv: nonce, name: "AES-GCM" },
    key,
    plaintext,
  );
  const sealed = new Uint8Array(nonce.byteLength + ciphertext.byteLength);
  sealed.set(nonce);
  sealed.set(new Uint8Array(ciphertext), nonce.byteLength);
  return `${CURSOR_PREFIX}${encodeBase64Url(sealed)}`;
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
    (anchor.afterArtifactId === "" ||
      /^sha256:[0-9a-f]{64}$/.test(anchor.afterArtifactId)) &&
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

function parseCursorEnvelope(bytes: ArrayBuffer): CursorEnvelopeV0 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    );
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const envelope = parsed as Record<string, unknown>;
  if (
    !hasExactKeys(envelope, ["anchor", "expiresAt", "version"]) ||
    envelope.version !== SYNC_PROTOCOL_VERSION ||
    !Number.isSafeInteger(envelope.expiresAt) ||
    (envelope.expiresAt as number) < 0 ||
    !validAnchor(envelope.anchor as PublicInventoryAnchorV0)
  ) {
    return null;
  }
  return {
    anchor: envelope.anchor as PublicInventoryAnchorV0,
    expiresAt: envelope.expiresAt as number,
    version: SYNC_PROTOCOL_VERSION,
  };
}

async function importCursorKey(
  sql: SqlStorage,
  create: boolean,
): Promise<CryptoKey | null> {
  let row = sql
    .exec<{ value: string }>(
      "SELECT value FROM edgefoss_meta WHERE key = ?",
      CURSOR_KEY_META,
    )
    .toArray()[0];
  if (row === undefined && create) {
    const bytes = crypto.getRandomValues(new Uint8Array(CURSOR_KEY_BYTES));
    sql.exec(
      "INSERT INTO edgefoss_meta (key, value) VALUES (?, ?)",
      CURSOR_KEY_META,
      encodeBase64Url(bytes),
    );
    row = { value: encodeBase64Url(bytes) };
  }
  if (row === undefined) return null;
  const bytes = decodeCanonicalBase64Url(row.value);
  if (bytes === null || bytes.byteLength !== CURSOR_KEY_BYTES) {
    throw new Error("cursor_key_corrupt");
  }
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "decrypt",
    "encrypt",
  ]);
}

function hasExactKeys(input: object, expected: readonly string[]): boolean {
  const actual = Object.keys(input).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCanonicalBase64Url(value: string): ArrayBuffer | null {
  if (
    value.length === 0 ||
    !/^[A-Za-z0-9_-]+$/u.test(value) ||
    value.length % 4 === 1
  ) {
    return null;
  }
  try {
    const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return encodeBase64Url(bytes) === value ? bytes.buffer : null;
  } catch {
    return null;
  }
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
