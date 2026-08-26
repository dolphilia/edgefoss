import {
  decodeSyncTokenBase64Url,
  encodeSyncTokenBase64Url,
  hasExactSyncTokenKeys,
  importSyncTokenKey,
  type PublicInventoryAnchorV0,
} from "./sync-inventory.js";
import type {
  PublicBlobChunkResult,
  PublicClonePlanResult,
} from "./sync-clone.js";
import type { PublicArtifactTransferResult } from "./sync-transfer.js";
import { validPublicTransferSnapshot } from "./sync-transfer.js";

export const PUBLIC_TRANSFER_GRANT_TTL_MILLISECONDS = 10 * 60 * 1_000;

const GRANT_PREFIX = "efoss_transfer_v0_";
const GRANT_NONCE_BYTES = 12;
const MAX_GRANT_TOKEN_CHARACTERS = 4_096;
const GRANT_AAD = new TextEncoder().encode("edgefoss:public-transfer:v0");

export interface PublicTransferGrantV0 {
  headArtifactId: string;
  profile: "complete";
  semanticRoot: string;
  snapshot: PublicInventoryAnchorV0;
}

interface PublicTransferGrantEnvelopeV0 {
  expiresAt: number;
  grant: PublicTransferGrantV0;
  version: 0;
}

export type OpenPublicTransferGrantResult =
  | {
      expiresAt: number;
      grant: PublicTransferGrantV0;
      status: "ok";
    }
  | { code: "transfer_grant_expired"; status: "rejected" }
  | { code: "transfer_grant_invalid"; status: "rejected" };

export type PublicTransferPlanResult =
  | {
      expiresAt: number;
      grant: string;
      plan: Extract<PublicClonePlanResult, { status: "ok" }>["plan"];
      status: "ok";
    }
  | Exclude<PublicClonePlanResult, { status: "ok" }>;

export type GrantedArtifactTransferResult =
  | PublicArtifactTransferResult
  | Exclude<OpenPublicTransferGrantResult, { status: "ok" }>;

export type GrantedBlobChunkResult =
  | PublicBlobChunkResult
  | Exclude<OpenPublicTransferGrantResult, { status: "ok" }>;

export async function sealPublicTransferGrant(
  sql: SqlStorage,
  grant: PublicTransferGrantV0,
  now = Date.now(),
): Promise<{ expiresAt: number; token: string }> {
  if (!validGrant(grant) || !Number.isSafeInteger(now) || now < 0) {
    throw new Error("transfer_grant_state_invalid");
  }
  const expiresAt = now + PUBLIC_TRANSFER_GRANT_TTL_MILLISECONDS;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error("transfer_grant_expiry_invalid");
  }
  const key = await importSyncTokenKey(sql, true);
  if (key === null) throw new Error("transfer_grant_key_unavailable");
  const nonce = crypto.getRandomValues(new Uint8Array(GRANT_NONCE_BYTES));
  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      expiresAt,
      grant,
      version: 0,
    } satisfies PublicTransferGrantEnvelopeV0),
  );
  const ciphertext = await crypto.subtle.encrypt(
    { additionalData: GRANT_AAD, iv: nonce, name: "AES-GCM" },
    key,
    plaintext,
  );
  const sealed = new Uint8Array(nonce.byteLength + ciphertext.byteLength);
  sealed.set(nonce);
  sealed.set(new Uint8Array(ciphertext), nonce.byteLength);
  return {
    expiresAt,
    token: `${GRANT_PREFIX}${encodeSyncTokenBase64Url(sealed)}`,
  };
}

export async function openPublicTransferGrant(
  sql: SqlStorage,
  token: string,
  now = Date.now(),
): Promise<OpenPublicTransferGrantResult> {
  const encoded = token.startsWith(GRANT_PREFIX)
    ? token.slice(GRANT_PREFIX.length)
    : "";
  if (token.length > MAX_GRANT_TOKEN_CHARACTERS || encoded.length === 0) {
    return { code: "transfer_grant_invalid", status: "rejected" };
  }
  const sealed = decodeSyncTokenBase64Url(encoded);
  if (sealed === null || sealed.byteLength <= GRANT_NONCE_BYTES + 16) {
    return { code: "transfer_grant_invalid", status: "rejected" };
  }
  const key = await importSyncTokenKey(sql, false);
  if (key === null) {
    return { code: "transfer_grant_invalid", status: "rejected" };
  }
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        additionalData: GRANT_AAD,
        iv: sealed.slice(0, GRANT_NONCE_BYTES),
        name: "AES-GCM",
      },
      key,
      sealed.slice(GRANT_NONCE_BYTES),
    );
  } catch {
    return { code: "transfer_grant_invalid", status: "rejected" };
  }
  const envelope = parseEnvelope(plaintext);
  if (envelope === null) {
    return { code: "transfer_grant_invalid", status: "rejected" };
  }
  if (!Number.isSafeInteger(now) || now < 0 || now >= envelope.expiresAt) {
    return { code: "transfer_grant_expired", status: "rejected" };
  }
  return {
    expiresAt: envelope.expiresAt,
    grant: envelope.grant,
    status: "ok",
  };
}

function parseEnvelope(
  bytes: ArrayBuffer,
): PublicTransferGrantEnvelopeV0 | null {
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
    !hasExactSyncTokenKeys(envelope, ["expiresAt", "grant", "version"]) ||
    envelope.version !== 0 ||
    !Number.isSafeInteger(envelope.expiresAt) ||
    (envelope.expiresAt as number) < 0 ||
    !validGrant(envelope.grant)
  ) {
    return null;
  }
  return {
    expiresAt: envelope.expiresAt as number,
    grant: envelope.grant,
    version: 0,
  };
}

function validGrant(value: unknown): value is PublicTransferGrantV0 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const grant = value as Record<string, unknown>;
  return (
    hasExactSyncTokenKeys(grant, [
      "headArtifactId",
      "profile",
      "semanticRoot",
      "snapshot",
    ]) &&
    typeof grant.headArtifactId === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(grant.headArtifactId) &&
    grant.profile === "complete" &&
    typeof grant.semanticRoot === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(grant.semanticRoot) &&
    validPublicTransferSnapshot(grant.snapshot as PublicInventoryAnchorV0) &&
    (grant.snapshot as PublicInventoryAnchorV0).afterArtifactId === ""
  );
}
