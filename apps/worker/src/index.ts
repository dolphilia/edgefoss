import { DurableObject } from "cloudflare:workers";
import { FormatError, MAX_ARTIFACT_BYTES } from "@edgefoss/protocol";

import {
  preparePublishArtifact,
  type PreparedPublishArtifact,
  type PublishArtifactInput,
  type PublishArtifactKind,
} from "./artifact-publish.js";
import {
  authorityEvent,
  drainOutbox,
  insertOutboxEvent,
  readOutboxArtifactMatch,
  readOutboxObservation,
  readOutboxStatus,
  recordAuthorityEventDelivery,
  type AuthorityEventV0,
  type OutboxArtifactMatch,
  type OutboxObservation,
  type OutboxStatus,
} from "./outbox.js";
import { consumeAuthorityEventMessage } from "./queue-consumer.js";
import {
  negotiatePublicSync,
  openPublicInventoryCursor,
  readPublicInventory,
  sealPublicInventoryCursor,
  type PublicInventoryInput,
  type PublicInventoryPageInput,
  type PublicInventoryPageResult,
  type PublicInventoryResult,
  type SyncHelloInput,
  type SyncHelloResult,
} from "./sync-inventory.js";
import {
  planPublicClone,
  readPublicCloneArtifactTransfer,
  readPublicBlobChunk,
  type PublicBlobChunkInput,
  type PublicBlobChunkResult,
  type PublicClonePlanResult,
} from "./sync-clone.js";
import {
  openPublicTransferGrant,
  sealPublicTransferGrant,
  type GrantedArtifactTransferResult,
  type GrantedBlobChunkResult,
  type PublicTransferPlanResult,
} from "./sync-grant.js";
import {
  beginPublicTransfer,
  readPublicArtifactTransfer,
  type BeginPublicTransferInput,
  type BeginPublicTransferResult,
  type PublicArtifactTransferInput,
  type PublicArtifactTransferResult,
} from "./sync-transfer.js";
import {
  MAX_PUSH_PREFLIGHT_ARTIFACTS,
  MAX_PUSH_PREFLIGHT_BLOBS,
  preflightPublicPush,
  type PublicPushPreflightInput,
  type PublicPushPreflightResult,
} from "./sync-push.js";

export type {
  PublishArtifactInput,
  PublishRefInput,
} from "./artifact-publish.js";
export type {
  AuthorityEventV0,
  OutboxArtifactMatch,
  OutboxObservation,
  OutboxStatus,
} from "./outbox.js";
export type {
  PublicInventoryAnchorV0,
  PublicInventoryInput,
  PublicInventoryItemV0,
  PublicInventoryPageInput,
  PublicInventoryPageResult,
  PublicInventoryResult,
  SyncHelloInput,
  SyncHelloResult,
} from "./sync-inventory.js";
export type {
  PublicBlobChunkInput,
  PublicBlobChunkResult,
  PublicCloneBlobV0,
  PublicClonePlanResult,
  PublicClonePlanV0,
} from "./sync-clone.js";
export type {
  GrantedArtifactTransferResult,
  GrantedBlobChunkResult,
  PublicTransferGrantV0,
  PublicTransferPlanResult,
} from "./sync-grant.js";
export {
  MAX_PUBLIC_BLOB_CHUNK_BYTES,
  MAX_PUBLIC_CLONE_ARTIFACT_BYTES,
  MAX_PUBLIC_CLONE_ARTIFACTS,
  MAX_PUBLIC_CLONE_BLOBS,
} from "./sync-clone.js";
export type {
  BeginPublicTransferInput,
  BeginPublicTransferResult,
  PublicArtifactTransferInput,
  PublicArtifactTransferItemV0,
  PublicArtifactTransferResult,
} from "./sync-transfer.js";
export {
  MAX_PUSH_PREFLIGHT_ARTIFACTS,
  MAX_PUSH_PREFLIGHT_BLOBS,
} from "./sync-push.js";
export type {
  PublicPushPreflightInput,
  PublicPushPreflightResult,
  PublicPushSnapshotV0,
} from "./sync-push.js";

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
} as const;

const SINGLE_PROJECT_AUTHORITY = "edgefoss-single-project-v0";
const OWNER_PRINCIPAL = "owner";
const REPOSITORY_SCHEMA_VERSION = 5;
const MAX_SMALL_BLOB_BYTES = 16 * 1024 * 1024;
const MAX_JSON_BODY_BYTES = 16 * 1024;
const MAX_PUSH_PREFLIGHT_JSON_BODY_BYTES = 64 * 1024;
const MAX_PUBLISH_JSON_BODY_BYTES = 2 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 1024;
const MAX_OUTBOX_MATCH_BODY_BYTES = 256;
const OWNER_TOKEN_PATTERN = /^efoss_owner_v0_[A-Za-z0-9_-]{43}$/;

export type CloudRealm = "public" | "members";
export type UploadState =
  "declared" | "staged" | "verified" | "finalized" | "rejected";

export interface BeginUploadInput {
  blobId: string;
  byteSize: number;
  operationId: string;
  principalId: string;
  realm: CloudRealm;
}

export type BeginUploadResult =
  | { status: "ok"; upload: UploadResult }
  | { code: "operation_conflict"; status: "conflict" };

export interface UploadResult {
  blobId: string;
  byteSize: number;
  failure: "hash_mismatch" | "size_mismatch" | null;
  finalKey: string | null;
  operationId: string;
  realm: CloudRealm;
  stagingKey: string;
  state: UploadState;
  uploadId: string;
}

export interface AcceptedPublishResult {
  artifactId: string;
  kind: PublishArtifactKind;
  policyEpoch: number;
  realm: CloudRealm;
  ref: {
    generation: number;
    name: "heads/main";
    targetArtifactId: string;
  } | null;
  repoSequence: number;
  status: "accepted";
}

export interface AdvancePolicyEpochInput {
  expectedPolicyEpoch: number;
  operationId: string;
  principalId: string;
}

export type AdvancePolicyEpochResult =
  | {
      newPolicyEpoch: number;
      previousPolicyEpoch: number;
      status: "accepted";
    }
  | { code: "operation_conflict"; status: "conflict" }
  | { code: "project_not_initialized"; status: "rejected" }
  | {
      code: "policy_conflict";
      currentPolicyEpoch: number;
      status: "policy_conflict";
    };

export type PublishRejectionCode =
  | "artifact_blob_missing"
  | "artifact_actor_unauthorized"
  | "artifact_change_root_invalid"
  | "artifact_identity_conflict"
  | "artifact_invalid"
  | "artifact_logical_clock_invalid"
  | "artifact_parent_invalid"
  | "artifact_project_mismatch"
  | "artifact_reference_missing"
  | "artifact_tree_reference_invalid"
  | "project_already_initialized"
  | "project_not_initialized";

export type PublishArtifactResult =
  | AcceptedPublishResult
  | { code: "operation_conflict"; status: "conflict" }
  | { code: PublishRejectionCode; status: "rejected" }
  | {
      code: "policy_conflict";
      currentPolicyEpoch: number;
      status: "policy_conflict";
    }
  | {
      code: "ref_conflict";
      currentGeneration: number;
      currentTargetArtifactId: string | null;
      status: "ref_conflict";
    };

interface UploadRow extends Record<string, SqlStorageValue> {
  blob_id: string;
  byte_size: number;
  failure: "hash_mismatch" | "size_mismatch" | null;
  final_key: string | null;
  operation_id: string;
  principal_id: string;
  realm: CloudRealm;
  staging_key: string;
  state: UploadState;
  upload_id: string;
}

interface BlobRow extends Record<string, SqlStorageValue> {
  blob_id: string;
  byte_size: number;
  r2_key: string;
  realm: CloudRealm;
}

interface ArtifactRow extends Record<string, SqlStorageValue> {
  accepted_seq: number;
  actor_key: ArrayBuffer;
  artifact_id: string;
  kind: PublishArtifactKind;
  logical_clock: string;
  project_id: string;
  realm: CloudRealm;
}

interface ArtifactReferenceRow extends Record<string, SqlStorageValue> {
  actor_key: ArrayBuffer;
  artifact_id: string;
  kind: PublishArtifactKind;
  logical_clock: string;
  project_id: string;
  realm: CloudRealm;
}

interface OperationRow extends Record<string, SqlStorageValue> {
  principal_id: string;
  request_hash: string;
  result_json: string;
}

interface RefRow extends Record<string, SqlStorageValue> {
  artifact_id: string;
  generation: number;
}

interface StoredPolicyOperation {
  expectedPolicyEpoch: number;
  principalId: string;
  result: AdvancePolicyEpochResult;
}

export interface RepositoryHealth {
  schemaVersion: number;
  status: "ok";
  storage: "sqlite";
}

export class RepositoryDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.ctx.blockConcurrencyWhile(async () => this.#migrate());
  }

  #migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS edgefoss_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT
    `);
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO edgefoss_meta (key, value) VALUES (?, ?)",
      "schema_version",
      "0",
    );

    let schemaVersion = Number(
      this.ctx.storage.sql
        .exec<{ value: string }>(
          "SELECT value FROM edgefoss_meta WHERE key = ?",
          "schema_version",
        )
        .one().value,
    );

    if (schemaVersion === 0) {
      this.ctx.storage.sql.exec(
        "UPDATE edgefoss_meta SET value = ? WHERE key = ?",
        "1",
        "schema_version",
      );
      schemaVersion = 1;
    }

    if (schemaVersion === 1) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS upload_sessions (
          upload_id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL UNIQUE,
          realm TEXT NOT NULL CHECK (realm IN ('public', 'members')),
          blob_id TEXT NOT NULL,
          byte_size INTEGER NOT NULL
            CHECK (byte_size >= 0 AND byte_size <= ${MAX_SMALL_BLOB_BYTES}),
          staging_key TEXT NOT NULL UNIQUE,
          final_key TEXT,
          failure TEXT CHECK (failure IN ('hash_mismatch', 'size_mismatch')),
          state TEXT NOT NULL
            CHECK (state IN ('declared', 'staged', 'verified', 'finalized', 'rejected')),
          created_at INTEGER NOT NULL,
          finalized_at INTEGER
        ) STRICT;

        CREATE TABLE IF NOT EXISTS blobs (
          realm TEXT NOT NULL CHECK (realm IN ('public', 'members')),
          blob_id TEXT NOT NULL,
          byte_size INTEGER NOT NULL
            CHECK (byte_size >= 0 AND byte_size <= ${MAX_SMALL_BLOB_BYTES}),
          r2_key TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK (state = 'finalized'),
          verified_at INTEGER NOT NULL,
          PRIMARY KEY (realm, blob_id)
        ) STRICT;
      `);
      this.ctx.storage.sql.exec(
        "UPDATE edgefoss_meta SET value = ? WHERE key = ?",
        "2",
        "schema_version",
      );
      schemaVersion = 2;
    }

    if (schemaVersion === 2) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE upload_sessions ADD COLUMN principal_id TEXT NOT NULL DEFAULT 'owner'",
      );
      this.ctx.storage.sql.exec(
        "UPDATE edgefoss_meta SET value = ? WHERE key = ?",
        "3",
        "schema_version",
      );
      schemaVersion = 3;
    }

    if (schemaVersion === 3) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS artifacts (
          artifact_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('project.genesis', 'tree', 'change')),
          realm TEXT NOT NULL CHECK (realm IN ('public', 'members')),
          actor_key BLOB NOT NULL,
          logical_clock TEXT NOT NULL,
          created_at TEXT NOT NULL,
          canonical_body BLOB NOT NULL,
          accepted_seq INTEGER NOT NULL UNIQUE
        ) STRICT;

        CREATE TABLE IF NOT EXISTS artifact_edges (
          source_id TEXT NOT NULL,
          edge_kind TEXT NOT NULL CHECK (edge_kind IN ('blob', 'parent', 'tree')),
          target_id TEXT NOT NULL,
          PRIMARY KEY (source_id, edge_kind, target_id)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS attestations (
          artifact_id TEXT NOT NULL,
          actor_key BLOB NOT NULL,
          signature BLOB NOT NULL,
          PRIMARY KEY (artifact_id, actor_key)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS receipts (
          artifact_id TEXT PRIMARY KEY,
          authority_id TEXT NOT NULL,
          principal_id TEXT NOT NULL,
          repo_seq INTEGER NOT NULL UNIQUE,
          accepted_at INTEGER NOT NULL,
          policy_epoch INTEGER NOT NULL,
          operation_id TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS realm_refs (
          realm TEXT NOT NULL CHECK (realm IN ('public', 'members')),
          ref_name TEXT NOT NULL CHECK (ref_name = 'heads/main'),
          artifact_id TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK (generation > 0),
          updated_seq INTEGER NOT NULL,
          PRIMARY KEY (realm, ref_name)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS operations (
          operation_id TEXT PRIMARY KEY,
          operation_kind TEXT NOT NULL CHECK (operation_kind = 'publish'),
          principal_id TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          result_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;
      `);
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO edgefoss_meta (key, value) VALUES (?, ?)",
        "project_id",
        "",
      );
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO edgefoss_meta (key, value) VALUES (?, ?)",
        "policy_epoch",
        "0",
      );
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO edgefoss_meta (key, value) VALUES (?, ?)",
        "repo_seq",
        "0",
      );
      this.ctx.storage.sql.exec(
        "UPDATE edgefoss_meta SET value = ? WHERE key = ?",
        "4",
        "schema_version",
      );
      schemaVersion = 4;
    }

    if (schemaVersion === 4) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS authority_outbox (
          event_id TEXT PRIMARY KEY,
          repo_seq INTEGER NOT NULL UNIQUE,
          event_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending', 'enqueued')),
          attempts INTEGER NOT NULL CHECK (attempts >= 0),
          last_attempt_at INTEGER,
          enqueued_at INTEGER
        ) STRICT;

        CREATE TABLE IF NOT EXISTS authority_event_deliveries (
          event_id TEXT PRIMARY KEY,
          repo_seq INTEGER NOT NULL UNIQUE,
          delivered_at INTEGER NOT NULL
        ) STRICT;
      `);
      this.ctx.storage.sql.exec(
        "UPDATE edgefoss_meta SET value = ? WHERE key = ?",
        "5",
        "schema_version",
      );
      schemaVersion = 5;
    }

    if (schemaVersion !== REPOSITORY_SCHEMA_VERSION) {
      throw new Error("RepositoryDO schema version is unsupported.");
    }
  }

  beginUpload(input: BeginUploadInput): BeginUploadResult {
    validateBeginUpload(input);

    const publishOperation = this.ctx.storage.sql
      .exec<{ operation_id: string }>(
        "SELECT operation_id FROM operations WHERE operation_id = ?",
        input.operationId,
      )
      .toArray()[0];
    if (publishOperation) {
      return { code: "operation_conflict", status: "conflict" };
    }
    if (this.#readPolicyOperation(input.operationId) !== undefined) {
      return { code: "operation_conflict", status: "conflict" };
    }

    const existing = this.ctx.storage.sql
      .exec<UploadRow>(
        `SELECT upload_id, operation_id, realm, blob_id, byte_size,
                staging_key, final_key, failure, state, principal_id
           FROM upload_sessions
          WHERE operation_id = ?`,
        input.operationId,
      )
      .toArray()[0];
    if (existing) {
      if (
        existing.principal_id !== input.principalId ||
        existing.realm !== input.realm ||
        existing.blob_id !== input.blobId ||
        existing.byte_size !== input.byteSize
      ) {
        return { code: "operation_conflict", status: "conflict" };
      }
      return { status: "ok", upload: uploadResult(existing) };
    }

    const uploadId = crypto.randomUUID();
    const stagingKey = `staging/${SINGLE_PROJECT_AUTHORITY}/${input.realm}/${uploadId}`;
    this.ctx.storage.sql.exec(
      `INSERT INTO upload_sessions (
         upload_id, operation_id, realm, blob_id, byte_size, staging_key,
         final_key, failure, state, created_at, finalized_at, principal_id
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'declared', ?, NULL, ?)`,
      uploadId,
      input.operationId,
      input.realm,
      input.blobId,
      input.byteSize,
      stagingKey,
      Date.now(),
      input.principalId,
    );

    return {
      status: "ok",
      upload: {
        blobId: input.blobId,
        byteSize: input.byteSize,
        failure: null,
        finalKey: null,
        operationId: input.operationId,
        realm: input.realm,
        stagingKey,
        state: "declared",
        uploadId,
      },
    };
  }

  async stageUpload(
    principalId: string,
    uploadId: string,
    bytes: ArrayBuffer,
  ): Promise<UploadResult> {
    validatePrincipal(principalId);
    validateUuid(uploadId, "upload_id");
    let upload = this.#readUploadForPrincipal(uploadId, principalId);
    if (upload.state === "finalized") return uploadResult(upload);
    if (upload.state === "rejected") return uploadResult(upload);
    if (bytes.byteLength !== upload.byte_size) {
      return this.#rejectUpload(uploadId, "size_mismatch");
    }

    const digest = await crypto.subtle.digest("SHA-256", bytes);
    if (formatSha256(digest) !== upload.blob_id) {
      return this.#rejectUpload(uploadId, "hash_mismatch");
    }

    const bucket = this.#bucketForRealm(upload.realm);
    const stored = await bucket.put(upload.staging_key, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: digest,
    });
    if (stored === null) {
      await verifyExistingObject(
        bucket,
        upload.staging_key,
        upload,
        digest,
        "upload_staging_conflict",
      );
    }

    upload = this.#advanceUploadState(uploadId, "staged");
    return uploadResult(upload);
  }

  async finalizeUpload(
    principalId: string,
    uploadId: string,
  ): Promise<UploadResult> {
    validatePrincipal(principalId);
    validateUuid(uploadId, "upload_id");
    let upload = this.#readUploadForPrincipal(uploadId, principalId);
    if (upload.state === "finalized") return uploadResult(upload);
    if (upload.state === "rejected") return uploadResult(upload);

    const bucket = this.#bucketForRealm(upload.realm);
    const stagedHead = await bucket.head(upload.staging_key);
    if (stagedHead === null) throw new Error("upload_not_staged");
    if (stagedHead.size !== upload.byte_size) {
      return this.#rejectUpload(uploadId, "size_mismatch");
    }

    upload = this.#advanceUploadState(uploadId, "staged");
    if (upload.state === "rejected") return uploadResult(upload);
    const staged = await bucket.get(upload.staging_key, {
      onlyIf: { etagMatches: stagedHead.etag },
    });
    if (staged === null || !("body" in staged)) {
      throw new Error("upload_staging_changed");
    }
    const bytes = await staged.bytes();
    if (bytes.byteLength !== upload.byte_size) {
      return this.#rejectUpload(uploadId, "size_mismatch");
    }

    const digest = await crypto.subtle.digest("SHA-256", bytes);
    if (formatSha256(digest) !== upload.blob_id) {
      return this.#rejectUpload(uploadId, "hash_mismatch");
    }
    upload = this.#advanceUploadState(uploadId, "verified");
    if (upload.state === "rejected") return uploadResult(upload);

    const existingBlob = this.#readBlob(upload.realm, upload.blob_id);
    if (existingBlob) {
      if (existingBlob.byte_size !== upload.byte_size) {
        throw new Error("final_blob_conflict");
      }
      return this.#commitFinalized(uploadId, existingBlob.r2_key);
    }

    const finalKey = finalBlobKey(upload);
    const stored = await bucket.put(finalKey, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: digest,
    });
    if (stored === null) {
      await verifyExistingFinal(bucket, finalKey, upload, digest);
    }

    upload = this.#readUpload(uploadId);
    if (upload.state === "finalized") return uploadResult(upload);
    return this.#commitFinalized(uploadId, finalKey);
  }

  getUpload(principalId: string, uploadId: string): UploadResult {
    validatePrincipal(principalId);
    validateUuid(uploadId, "upload_id");
    return uploadResult(this.#readUploadForPrincipal(uploadId, principalId));
  }

  async publishArtifact(
    input: PublishArtifactInput,
  ): Promise<PublishArtifactResult> {
    try {
      validatePrincipal(input.principalId);
      validateUuid(input.operationId, "operation_id");
      const prepared = await preparePublishArtifact(input);
      const result = this.#commitPublishedArtifact(prepared);
      if (result.status === "accepted") await this.#ensureOutboxAlarm();
      return result;
    } catch (error) {
      const code = publishRejectionCode(error);
      if (code) return { code, status: "rejected" };
      throw error;
    }
  }

  preflightPublicPush(
    input: PublicPushPreflightInput,
  ): PublicPushPreflightResult {
    return this.ctx.storage.transactionSync(() =>
      preflightPublicPush(this.ctx.storage.sql, input),
    );
  }

  advancePolicyEpoch(input: AdvancePolicyEpochInput): AdvancePolicyEpochResult {
    validateAdvancePolicyEpoch(input);

    return this.ctx.storage.transactionSync(() => {
      const stored = this.#readPolicyOperation(input.operationId);
      if (stored !== undefined) {
        if (
          stored.principalId !== input.principalId ||
          stored.expectedPolicyEpoch !== input.expectedPolicyEpoch
        ) {
          return { code: "operation_conflict", status: "conflict" };
        }
        return stored.result;
      }

      const uploadOperation = this.ctx.storage.sql
        .exec<{ operation_id: string }>(
          "SELECT operation_id FROM upload_sessions WHERE operation_id = ?",
          input.operationId,
        )
        .toArray()[0];
      const publishOperation = this.ctx.storage.sql
        .exec<{ operation_id: string }>(
          "SELECT operation_id FROM operations WHERE operation_id = ?",
          input.operationId,
        )
        .toArray()[0];
      if (uploadOperation || publishOperation) {
        return { code: "operation_conflict", status: "conflict" };
      }

      if (this.#metaValue("project_id") === "") {
        return { code: "project_not_initialized", status: "rejected" };
      }

      const currentPolicyEpoch = this.#metaInteger("policy_epoch");
      if (input.expectedPolicyEpoch !== currentPolicyEpoch) {
        return this.#storePolicyOperation(input, {
          code: "policy_conflict",
          currentPolicyEpoch,
          status: "policy_conflict",
        });
      }
      if (currentPolicyEpoch === Number.MAX_SAFE_INTEGER) {
        throw new Error("policy_epoch_exhausted");
      }

      const newPolicyEpoch = currentPolicyEpoch + 1;
      this.#setMetaValue("policy_epoch", String(newPolicyEpoch));
      return this.#storePolicyOperation(input, {
        newPolicyEpoch,
        previousPolicyEpoch: currentPolicyEpoch,
        status: "accepted",
      });
    });
  }

  syncHello(input: SyncHelloInput): SyncHelloResult {
    return negotiatePublicSync(this.ctx.storage.sql, input);
  }

  publicInventory(input: PublicInventoryInput): PublicInventoryResult {
    return this.ctx.storage.transactionSync(() =>
      readPublicInventory(this.ctx.storage.sql, input),
    );
  }

  async publicInventoryPage(
    input: PublicInventoryPageInput,
  ): Promise<PublicInventoryPageResult> {
    const opened =
      input.cursor === null
        ? null
        : await openPublicInventoryCursor(this.ctx.storage.sql, input.cursor);
    if (opened !== null && opened.status === "rejected") return opened;
    const result = this.ctx.storage.transactionSync(() =>
      readPublicInventory(this.ctx.storage.sql, {
        anchor: opened?.anchor ?? null,
        limit: input.limit,
        principalId: input.principalId,
        projectId: input.projectId,
        protocolVersion: input.protocolVersion,
        view: input.view,
      }),
    );
    if (result.status === "rejected") return result;
    return {
      items: result.items,
      nextCursor:
        result.nextAnchor === null
          ? null
          : await sealPublicInventoryCursor(
              this.ctx.storage.sql,
              result.nextAnchor,
            ),
      status: "ok",
    };
  }

  beginPublicTransfer(
    input: BeginPublicTransferInput,
  ): BeginPublicTransferResult {
    return this.ctx.storage.transactionSync(() =>
      beginPublicTransfer(this.ctx.storage.sql, input),
    );
  }

  async publicArtifactTransfer(
    input: PublicArtifactTransferInput,
  ): Promise<PublicArtifactTransferResult> {
    return readPublicArtifactTransfer(this.ctx.storage.sql, input);
  }

  async publicClonePlan(
    input: BeginPublicTransferInput,
  ): Promise<PublicClonePlanResult> {
    return planPublicClone(this.ctx.storage.sql, input);
  }

  async publicBlobChunk(
    input: PublicBlobChunkInput,
  ): Promise<PublicBlobChunkResult> {
    return readPublicBlobChunk(
      this.ctx.storage.sql,
      this.env.PUBLIC_BLOBS,
      input,
    );
  }

  async publicTransferPlan(
    input: BeginPublicTransferInput,
  ): Promise<PublicTransferPlanResult> {
    const planned = await planPublicClone(this.ctx.storage.sql, input);
    if (planned.status === "rejected") return planned;
    const sealed = await sealPublicTransferGrant(this.ctx.storage.sql, {
      headArtifactId: planned.plan.ref.targetArtifactId,
      profile: "complete",
      semanticRoot: planned.plan.semanticRoot,
      snapshot: planned.plan.snapshot,
    });
    const current = beginPublicTransfer(this.ctx.storage.sql, input);
    if (current.status === "rejected") return current;
    if (current.snapshot.policyEpoch !== planned.plan.snapshot.policyEpoch) {
      return {
        code: "snapshot_stale",
        currentPolicyEpoch: current.snapshot.policyEpoch,
        status: "rejected",
      };
    }
    return {
      expiresAt: sealed.expiresAt,
      grant: sealed.token,
      plan: planned.plan,
      status: "ok",
    };
  }

  async publicGrantedArtifactTransfer(input: {
    artifactIds: string[];
    grant: string;
  }): Promise<GrantedArtifactTransferResult> {
    const opened = await openPublicTransferGrant(
      this.ctx.storage.sql,
      input.grant,
    );
    if (opened.status === "rejected") return opened;
    return readPublicCloneArtifactTransfer(this.ctx.storage.sql, {
      artifactIds: input.artifactIds,
      headArtifactId: opened.grant.headArtifactId,
      snapshot: opened.grant.snapshot,
    });
  }

  async publicGrantedBlobChunk(input: {
    blobId: string;
    grant: string;
    length: number;
    offset: number;
  }): Promise<GrantedBlobChunkResult> {
    const opened = await openPublicTransferGrant(
      this.ctx.storage.sql,
      input.grant,
    );
    if (opened.status === "rejected") return opened;
    return readPublicBlobChunk(this.ctx.storage.sql, this.env.PUBLIC_BLOBS, {
      blobId: input.blobId,
      headArtifactId: opened.grant.headArtifactId,
      length: input.length,
      offset: input.offset,
      snapshot: opened.grant.snapshot,
    });
  }

  #commitPublishedArtifact(
    prepared: PreparedPublishArtifact,
  ): PublishArtifactResult {
    return this.ctx.storage.transactionSync(() => {
      const uploadOperation = this.ctx.storage.sql
        .exec<{ operation_id: string }>(
          "SELECT operation_id FROM upload_sessions WHERE operation_id = ?",
          prepared.operationId,
        )
        .toArray()[0];
      if (uploadOperation) {
        return { code: "operation_conflict", status: "conflict" };
      }
      if (this.#readPolicyOperation(prepared.operationId) !== undefined) {
        return { code: "operation_conflict", status: "conflict" };
      }

      const existingOperation = this.ctx.storage.sql
        .exec<OperationRow>(
          `SELECT principal_id, request_hash, result_json
             FROM operations
            WHERE operation_id = ?`,
          prepared.operationId,
        )
        .toArray()[0];
      if (existingOperation) {
        if (
          existingOperation.principal_id !== prepared.principalId ||
          existingOperation.request_hash !== prepared.requestHash
        ) {
          return { code: "operation_conflict", status: "conflict" };
        }
        return parseStoredPublishResult(existingOperation.result_json);
      }

      const policyEpoch = this.#metaInteger("policy_epoch");
      if (prepared.expectedPolicyEpoch !== policyEpoch) {
        return this.#storePublishOperation(prepared, {
          code: "policy_conflict",
          currentPolicyEpoch: policyEpoch,
          status: "policy_conflict",
        });
      }

      const projectId = this.#metaValue("project_id");
      if (prepared.kind === "project.genesis") {
        if (projectId !== "" && projectId !== prepared.artifactId) {
          throw new Error("project_already_initialized");
        }
      } else if (projectId === "") {
        throw new Error("project_not_initialized");
      } else if (prepared.projectId !== projectId) {
        throw new Error("artifact_project_mismatch");
      }
      if (prepared.kind !== "project.genesis") {
        const genesis = this.#readArtifactReference(projectId);
        if (!genesis || genesis.kind !== "project.genesis") {
          throw new Error("repository_project_corrupt");
        }
        if (!sameBuffer(genesis.actor_key, prepared.actorKey)) {
          throw new Error("artifact_actor_unauthorized");
        }
      }

      this.#validateArtifactReferences(prepared);
      const currentRef = prepared.ref
        ? this.#readRef(prepared.realm, prepared.ref.name)
        : undefined;
      if (
        prepared.ref &&
        ((!currentRef && prepared.ref.expectedGeneration !== 0) ||
          (currentRef &&
            currentRef.generation !== prepared.ref.expectedGeneration))
      ) {
        return this.#storePublishOperation(prepared, {
          code: "ref_conflict",
          currentGeneration: currentRef?.generation ?? 0,
          currentTargetArtifactId: currentRef?.artifact_id ?? null,
          status: "ref_conflict",
        });
      }

      const existingArtifact = this.#readArtifact(prepared.artifactId);
      if (existingArtifact) {
        this.#assertExistingArtifact(existingArtifact, prepared);
      }
      if (existingArtifact && prepared.ref === null) {
        return this.#storePublishOperation(prepared, {
          artifactId: prepared.artifactId,
          kind: prepared.kind,
          policyEpoch,
          realm: prepared.realm,
          ref: null,
          repoSequence: existingArtifact.accepted_seq,
          status: "accepted",
        });
      }

      const repoSequence = this.#nextRepoSequence();
      if (!existingArtifact) {
        this.ctx.storage.sql.exec(
          `INSERT INTO artifacts (
             artifact_id, project_id, kind, realm, actor_key, logical_clock,
             created_at, canonical_body, accepted_seq
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          prepared.artifactId,
          prepared.projectId,
          prepared.kind,
          prepared.realm,
          prepared.actorKey,
          prepared.logicalClock,
          prepared.createdAt,
          prepared.artifactBytes,
          repoSequence,
        );
        for (const edge of prepared.edges) {
          this.ctx.storage.sql.exec(
            `INSERT OR IGNORE INTO artifact_edges (source_id, edge_kind, target_id)
             VALUES (?, ?, ?)`,
            prepared.artifactId,
            edge.kind,
            edge.targetId,
          );
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO attestations (artifact_id, actor_key, signature)
           VALUES (?, ?, ?)`,
          prepared.artifactId,
          prepared.actorKey,
          prepared.signature,
        );
        this.ctx.storage.sql.exec(
          `INSERT INTO receipts (
             artifact_id, authority_id, principal_id, repo_seq, accepted_at,
             policy_epoch, operation_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          prepared.artifactId,
          SINGLE_PROJECT_AUTHORITY,
          prepared.principalId,
          repoSequence,
          Date.now(),
          policyEpoch,
          prepared.operationId,
        );
        if (prepared.kind === "project.genesis") {
          this.#setMetaValue("project_id", prepared.artifactId);
        }
      }

      let acceptedRef: AcceptedPublishResult["ref"] = null;
      if (prepared.ref) {
        const generation = prepared.ref.expectedGeneration + 1;
        this.ctx.storage.sql.exec(
          `INSERT INTO realm_refs (
             realm, ref_name, artifact_id, generation, updated_seq
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (realm, ref_name) DO UPDATE SET
             artifact_id = excluded.artifact_id,
             generation = excluded.generation,
             updated_seq = excluded.updated_seq`,
          prepared.realm,
          prepared.ref.name,
          prepared.artifactId,
          generation,
          repoSequence,
        );
        acceptedRef = {
          generation,
          name: prepared.ref.name,
          targetArtifactId: prepared.artifactId,
        };
      }

      insertOutboxEvent(
        this.ctx.storage.sql,
        authorityEvent({
          artifactId: prepared.artifactId,
          kind: prepared.kind,
          policyEpoch,
          realm: prepared.realm,
          ref: acceptedRef,
          repoSequence,
        }),
      );

      return this.#storePublishOperation(prepared, {
        artifactId: prepared.artifactId,
        kind: prepared.kind,
        policyEpoch,
        realm: prepared.realm,
        ref: acceptedRef,
        repoSequence,
        status: "accepted",
      });
    });
  }

  outboxStatus(): OutboxStatus {
    return readOutboxStatus(this.ctx.storage);
  }

  outboxObservation(repoSequence: number): OutboxObservation {
    return readOutboxObservation(this.ctx.storage, repoSequence);
  }

  outboxArtifactMatch(
    repoSequence: number,
    artifactId: string,
  ): OutboxArtifactMatch {
    return readOutboxArtifactMatch(this.ctx.storage, repoSequence, artifactId);
  }

  async armOutbox(): Promise<OutboxStatus> {
    await this.#ensureOutboxAlarm();
    return this.outboxStatus();
  }

  recordEventDelivery(event: AuthorityEventV0): {
    status: "accepted" | "duplicate" | "unknown";
  } {
    return {
      status: recordAuthorityEventDelivery(this.ctx.storage, event, Date.now()),
    };
  }

  override async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    const queue = this.env.EVENTS;
    if (queue === undefined) return;
    try {
      const result = await drainOutbox(this.ctx.storage, queue, Date.now());
      if (result.remaining > 0) {
        await this.ctx.storage.setAlarm(Date.now() + 1_000);
      }
    } catch (error) {
      const retryCount = alarmInfo?.retryCount ?? 0;
      const delayMilliseconds = Math.min(60_000, 2_000 * 2 ** retryCount);
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.message : "unknown_error",
          message: "authority outbox drain failed",
          retryCount,
        }),
      );
      await this.ctx.storage.setAlarm(Date.now() + delayMilliseconds);
    }
  }

  async #ensureOutboxAlarm(): Promise<void> {
    if (this.env.EVENTS === undefined || this.outboxStatus().pending === 0) {
      return;
    }
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
    }
  }

  #validateArtifactReferences(prepared: PreparedPublishArtifact): void {
    for (const edge of prepared.edges) {
      if (edge.kind === "blob") {
        const realms =
          prepared.realm === "public" ? ["public"] : ["members", "public"];
        const placeholders = realms.map(() => "?").join(", ");
        const blob = this.ctx.storage.sql
          .exec<{ blob_id: string }>(
            `SELECT blob_id FROM blobs
              WHERE blob_id = ? AND realm IN (${placeholders})
              LIMIT 1`,
            edge.targetId,
            ...realms,
          )
          .toArray()[0];
        if (!blob) throw new Error("artifact_blob_missing");
        continue;
      }

      const target = this.#readArtifactReference(edge.targetId);
      if (!target || target.project_id !== prepared.projectId) {
        throw new Error("artifact_reference_missing");
      }
      if (edge.kind === "parent") {
        if (target.kind !== "change" || target.realm !== prepared.realm) {
          throw new Error("artifact_parent_invalid");
        }
        if (
          sameBuffer(target.actor_key, prepared.actorKey) &&
          BigInt(prepared.logicalClock) <= BigInt(target.logical_clock)
        ) {
          throw new Error("artifact_logical_clock_invalid");
        }
      } else {
        const realmAllowed =
          target.realm === prepared.realm ||
          (prepared.realm === "members" && target.realm === "public");
        if (target.kind !== "tree" || !realmAllowed) {
          throw new Error("artifact_tree_reference_invalid");
        }
        if (prepared.kind === "change" && target.realm !== prepared.realm) {
          throw new Error("artifact_change_root_invalid");
        }
      }
    }
  }

  #assertExistingArtifact(
    existing: ArtifactRow,
    prepared: PreparedPublishArtifact,
  ): void {
    if (
      existing.project_id !== prepared.projectId ||
      existing.kind !== prepared.kind ||
      existing.realm !== prepared.realm ||
      existing.logical_clock !== prepared.logicalClock ||
      !sameBuffer(existing.actor_key, prepared.actorKey)
    ) {
      throw new Error("artifact_identity_conflict");
    }
  }

  #readArtifact(artifactId: string): ArtifactRow | undefined {
    return this.ctx.storage.sql
      .exec<ArtifactRow>(
        `SELECT artifact_id, project_id, kind, realm, actor_key,
                logical_clock, accepted_seq
           FROM artifacts
          WHERE artifact_id = ?`,
        artifactId,
      )
      .toArray()[0];
  }

  #readArtifactReference(artifactId: string): ArtifactReferenceRow | undefined {
    return this.ctx.storage.sql
      .exec<ArtifactReferenceRow>(
        `SELECT artifact_id, project_id, kind, realm, actor_key, logical_clock
           FROM artifacts
          WHERE artifact_id = ?`,
        artifactId,
      )
      .toArray()[0];
  }

  #readRef(realm: CloudRealm, name: "heads/main"): RefRow | undefined {
    return this.ctx.storage.sql
      .exec<RefRow>(
        `SELECT artifact_id, generation
           FROM realm_refs
          WHERE realm = ? AND ref_name = ?`,
        realm,
        name,
      )
      .toArray()[0];
  }

  #storePublishOperation(
    prepared: PreparedPublishArtifact,
    result: PublishArtifactResult,
  ): PublishArtifactResult {
    this.ctx.storage.sql.exec(
      `INSERT INTO operations (
         operation_id, operation_kind, principal_id, request_hash,
         result_json, created_at
       ) VALUES (?, 'publish', ?, ?, ?, ?)`,
      prepared.operationId,
      prepared.principalId,
      prepared.requestHash,
      JSON.stringify(result),
      Date.now(),
    );
    return result;
  }

  #readPolicyOperation(operationId: string): StoredPolicyOperation | undefined {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM edgefoss_meta WHERE key = ?",
        policyOperationKey(operationId),
      )
      .toArray()[0];
    return row ? parseStoredPolicyOperation(row.value) : undefined;
  }

  #storePolicyOperation(
    input: AdvancePolicyEpochInput,
    result: AdvancePolicyEpochResult,
  ): AdvancePolicyEpochResult {
    this.ctx.storage.sql.exec(
      "INSERT INTO edgefoss_meta (key, value) VALUES (?, ?)",
      policyOperationKey(input.operationId),
      JSON.stringify({
        expectedPolicyEpoch: input.expectedPolicyEpoch,
        principalId: input.principalId,
        result,
      } satisfies StoredPolicyOperation),
    );
    return result;
  }

  #metaValue(key: string): string {
    return this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM edgefoss_meta WHERE key = ?",
        key,
      )
      .one().value;
  }

  #metaInteger(key: string): number {
    const value = Number(this.#metaValue(key));
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("repository_counter_invalid");
    }
    return value;
  }

  #setMetaValue(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE edgefoss_meta SET value = ? WHERE key = ?",
      value,
      key,
    );
  }

  #nextRepoSequence(): number {
    const current = this.#metaInteger("repo_seq");
    if (current === Number.MAX_SAFE_INTEGER) {
      throw new Error("repository_sequence_exhausted");
    }
    const next = current + 1;
    this.#setMetaValue("repo_seq", String(next));
    return next;
  }

  #bucketForRealm(realm: CloudRealm): R2Bucket {
    return realm === "public"
      ? this.env.PUBLIC_BLOBS
      : this.env.RESTRICTED_BLOBS;
  }

  #readUpload(uploadId: string): UploadRow {
    const upload = this.ctx.storage.sql
      .exec<UploadRow>(
        `SELECT upload_id, operation_id, realm, blob_id, byte_size,
                staging_key, final_key, failure, state, principal_id
           FROM upload_sessions
          WHERE upload_id = ?`,
        uploadId,
      )
      .toArray()[0];
    if (!upload) throw new Error("upload_not_found");
    return upload;
  }

  #readUploadForPrincipal(uploadId: string, principalId: string): UploadRow {
    const upload = this.#readUpload(uploadId);
    if (upload.principal_id !== principalId)
      throw new Error("upload_not_found");
    return upload;
  }

  #readBlob(realm: CloudRealm, blobId: string): BlobRow | undefined {
    return this.ctx.storage.sql
      .exec<BlobRow>(
        `SELECT realm, blob_id, byte_size, r2_key
           FROM blobs
          WHERE realm = ? AND blob_id = ?`,
        realm,
        blobId,
      )
      .toArray()[0];
  }

  #advanceUploadState(
    uploadId: string,
    state: "staged" | "verified",
  ): UploadRow {
    this.ctx.storage.sql.exec(
      `UPDATE upload_sessions
          SET state = ?
        WHERE upload_id = ?
          AND state IN ('declared', 'staged', 'verified')`,
      state,
      uploadId,
    );
    return this.#readUpload(uploadId);
  }

  #rejectUpload(
    uploadId: string,
    failure: "hash_mismatch" | "size_mismatch",
  ): UploadResult {
    this.ctx.storage.sql.exec(
      `UPDATE upload_sessions
          SET state = 'rejected', failure = ?
        WHERE upload_id = ? AND state != 'finalized'`,
      failure,
      uploadId,
    );
    return uploadResult(this.#readUpload(uploadId));
  }

  #commitFinalized(uploadId: string, candidateKey: string): UploadResult {
    return this.ctx.storage.transactionSync(() => {
      const upload = this.#readUpload(uploadId);
      if (upload.state === "finalized") return uploadResult(upload);
      if (upload.state === "rejected") return uploadResult(upload);

      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO blobs (
           realm, blob_id, byte_size, r2_key, state, verified_at
         ) VALUES (?, ?, ?, ?, 'finalized', ?)`,
        upload.realm,
        upload.blob_id,
        upload.byte_size,
        candidateKey,
        Date.now(),
      );
      const blob = this.#readBlob(upload.realm, upload.blob_id);
      if (!blob || blob.byte_size !== upload.byte_size) {
        throw new Error("final_blob_conflict");
      }
      this.ctx.storage.sql.exec(
        `UPDATE upload_sessions
            SET state = 'finalized', final_key = ?, failure = NULL, finalized_at = ?
          WHERE upload_id = ?`,
        blob.r2_key,
        Date.now(),
        uploadId,
      );
      return uploadResult(this.#readUpload(uploadId));
    });
  }

  health(): RepositoryHealth {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM edgefoss_meta WHERE key = ?",
        "schema_version",
      )
      .one();

    if (row.value !== String(REPOSITORY_SCHEMA_VERSION)) {
      throw new Error("RepositoryDO schema version is unsupported.");
    }

    return {
      schemaVersion: REPOSITORY_SCHEMA_VERSION,
      status: "ok",
      storage: "sqlite",
    };
  }
}

function validateBeginUpload(input: BeginUploadInput): void {
  validatePrincipal(input.principalId);
  validateUuid(input.operationId, "operation_id");
  if (input.realm !== "public" && input.realm !== "members") {
    throw new Error("upload_realm_invalid");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(input.blobId)) {
    throw new Error("upload_blob_id_invalid");
  }
  if (
    !Number.isSafeInteger(input.byteSize) ||
    input.byteSize < 0 ||
    input.byteSize > MAX_SMALL_BLOB_BYTES
  ) {
    throw new Error("upload_size_invalid");
  }
}

function validateAdvancePolicyEpoch(input: AdvancePolicyEpochInput): void {
  if (
    input === null ||
    typeof input !== "object" ||
    !hasExactKeys(input, [
      "expectedPolicyEpoch",
      "operationId",
      "principalId",
    ]) ||
    !Number.isSafeInteger(input.expectedPolicyEpoch) ||
    input.expectedPolicyEpoch < 0
  ) {
    throw new Error("policy_mutation_invalid");
  }
  validatePrincipal(input.principalId);
  validateUuid(input.operationId, "operation_id");
}

function policyOperationKey(operationId: string): string {
  return `policy_operation:${operationId}`;
}

function parseStoredPolicyOperation(value: string): StoredPolicyOperation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("policy_operation_result_corrupt");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("policy_operation_result_corrupt");
  }
  const operation = parsed as Record<string, unknown>;
  if (
    !hasExactKeys(operation, [
      "expectedPolicyEpoch",
      "principalId",
      "result",
    ]) ||
    !Number.isSafeInteger(operation.expectedPolicyEpoch) ||
    (operation.expectedPolicyEpoch as number) < 0 ||
    operation.principalId !== OWNER_PRINCIPAL ||
    !validStoredPolicyResult(operation.result)
  ) {
    throw new Error("policy_operation_result_corrupt");
  }
  return {
    expectedPolicyEpoch: operation.expectedPolicyEpoch as number,
    principalId: OWNER_PRINCIPAL,
    result: operation.result,
  };
}

function validStoredPolicyResult(
  value: unknown,
): value is AdvancePolicyEpochResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const result = value as Record<string, unknown>;
  if (result.status === "accepted") {
    return (
      hasExactKeys(result, [
        "newPolicyEpoch",
        "previousPolicyEpoch",
        "status",
      ]) &&
      Number.isSafeInteger(result.previousPolicyEpoch) &&
      (result.previousPolicyEpoch as number) >= 0 &&
      Number.isSafeInteger(result.newPolicyEpoch) &&
      result.newPolicyEpoch === (result.previousPolicyEpoch as number) + 1
    );
  }
  if (result.status === "conflict") {
    return (
      hasExactKeys(result, ["code", "status"]) &&
      result.code === "operation_conflict"
    );
  }
  if (result.status === "rejected") {
    return (
      hasExactKeys(result, ["code", "status"]) &&
      result.code === "project_not_initialized"
    );
  }
  return (
    result.status === "policy_conflict" &&
    hasExactKeys(result, ["code", "currentPolicyEpoch", "status"]) &&
    result.code === "policy_conflict" &&
    Number.isSafeInteger(result.currentPolicyEpoch) &&
    (result.currentPolicyEpoch as number) >= 0
  );
}

function parseStoredPublishResult(value: string): PublishArtifactResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("operation_result_corrupt");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("operation_result_corrupt");
  }
  const status = (parsed as Record<string, unknown>).status;
  if (
    status !== "accepted" &&
    status !== "conflict" &&
    status !== "rejected" &&
    status !== "policy_conflict" &&
    status !== "ref_conflict"
  ) {
    throw new Error("operation_result_corrupt");
  }
  return parsed as PublishArtifactResult;
}

function publishRejectionCode(error: unknown): PublishRejectionCode | null {
  if (error instanceof FormatError) return "artifact_invalid";
  if (!(error instanceof Error)) return null;
  const codes = new Set<PublishRejectionCode>([
    "artifact_actor_unauthorized",
    "artifact_blob_missing",
    "artifact_change_root_invalid",
    "artifact_identity_conflict",
    "artifact_logical_clock_invalid",
    "artifact_parent_invalid",
    "artifact_project_mismatch",
    "artifact_reference_missing",
    "artifact_tree_reference_invalid",
    "project_already_initialized",
    "project_not_initialized",
  ]);
  return codes.has(error.message as PublishRejectionCode)
    ? (error.message as PublishRejectionCode)
    : error.message.startsWith("artifact_") ||
        error.message.endsWith("_invalid")
      ? "artifact_invalid"
      : null;
}

function sameBuffer(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  return leftBytes.every((byte, index) => byte === rightBytes[index]);
}

function validatePrincipal(principalId: string): void {
  if (principalId !== OWNER_PRINCIPAL) {
    throw new Error("upload_principal_invalid");
  }
}

function validateUuid(value: string, field: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value,
    )
  ) {
    throw new Error(`${field}_invalid`);
  }
}

function uploadResult(row: UploadRow): UploadResult {
  return {
    blobId: row.blob_id,
    byteSize: row.byte_size,
    failure: row.failure,
    finalKey: row.final_key,
    operationId: row.operation_id,
    realm: row.realm,
    stagingKey: row.staging_key,
    state: row.state,
    uploadId: row.upload_id,
  };
}

function formatSha256(digest: ArrayBuffer): string {
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function finalBlobKey(upload: UploadRow): string {
  if (upload.realm === "public") {
    const hash = upload.blob_id.slice("sha256:".length);
    return `objects/${SINGLE_PROJECT_AUTHORITY}/public/sha256/${hash.slice(0, 2)}/${hash}`;
  }
  return `objects/${SINGLE_PROJECT_AUTHORITY}/members/${upload.upload_id}`;
}

async function verifyExistingFinal(
  bucket: R2Bucket,
  key: string,
  upload: UploadRow,
  expectedDigest: ArrayBuffer,
): Promise<void> {
  return verifyExistingObject(
    bucket,
    key,
    upload,
    expectedDigest,
    "final_blob_conflict",
  );
}

async function verifyExistingObject(
  bucket: R2Bucket,
  key: string,
  upload: UploadRow,
  expectedDigest: ArrayBuffer,
  conflictCode: string,
): Promise<void> {
  const existing = await bucket.head(key);
  if (existing === null || existing.size !== upload.byte_size) {
    throw new Error(conflictCode);
  }
  const checksum = existing.checksums.sha256;
  if (checksum && formatSha256(checksum) === formatSha256(expectedDigest)) {
    return;
  }

  const body = await bucket.get(key);
  if (body === null || body.size !== upload.byte_size) {
    throw new Error(conflictCode);
  }
  const digest = await crypto.subtle.digest("SHA-256", await body.bytes());
  if (formatSha256(digest) !== upload.blob_id) {
    throw new Error(conflictCode);
  }
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

function errorResponse(
  code: string,
  message: string,
  status: number,
  headers?: HeadersInit,
): Response {
  const responseHeaders = new Headers(JSON_HEADERS);
  if (headers) {
    new Headers(headers).forEach((value, name) =>
      responseHeaders.set(name, value),
    );
  }
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: responseHeaders,
  });
}

async function authorizeOwner(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const expected = env.EDGEFOSS_OWNER_TOKEN ?? "";
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = /^Bearer ([^\s]+)$/.exec(authorization)?.[1] ?? "";
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(bearer)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);

  if (!OWNER_TOKEN_PATTERN.test(expected)) {
    return errorResponse(
      "owner_auth_unavailable",
      "Owner authentication is not configured.",
      503,
    );
  }
  if (!crypto.subtle.timingSafeEqual(providedHash, expectedHash)) {
    return errorResponse(
      "unauthorized",
      "A valid owner bearer token is required.",
      401,
      { "www-authenticate": 'Bearer realm="edgefoss"' },
    );
  }
  return null;
}

async function readBoundedBody(
  request: Request,
  maximumBytes: number,
): Promise<ArrayBuffer> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength < 0 ||
      declaredLength > maximumBytes
    ) {
      throw new HttpRequestError(
        "request_body_too_large",
        "The request body exceeds the allowed size.",
        413,
      );
    }
  }

  if (request.body === null) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maximumBytes) {
      try {
        await reader.cancel("request body limit exceeded");
      } catch {
        // The size violation remains the client-visible error even if cancel fails.
      }
      throw new HttpRequestError(
        "request_body_too_large",
        "The request body exceeds the allowed size.",
        413,
      );
    }
    chunks.push(part.value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

async function readUploadDeclaration(
  request: Request,
): Promise<BeginUploadInput> {
  if (
    request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
  ) {
    throw new HttpRequestError(
      "content_type_invalid",
      "Content-Type must be application/json.",
      415,
    );
  }
  const body = await readBoundedBody(request, MAX_JSON_BODY_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new HttpRequestError(
      "request_json_invalid",
      "The request body must be valid JSON.",
      400,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpRequestError(
      "request_json_invalid",
      "The request body must be a JSON object.",
      400,
    );
  }
  const input = parsed as Record<string, unknown>;
  if (
    typeof input.blobId !== "string" ||
    typeof input.byteSize !== "number" ||
    typeof input.operationId !== "string" ||
    (input.realm !== "public" && input.realm !== "members")
  ) {
    throw new HttpRequestError(
      "upload_declaration_invalid",
      "The upload declaration is invalid.",
      400,
    );
  }
  return {
    blobId: input.blobId,
    byteSize: input.byteSize,
    operationId: input.operationId,
    principalId: OWNER_PRINCIPAL,
    realm: input.realm,
  };
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

function decodeCanonicalBase64Url(
  value: unknown,
  maximumBytes: number,
): ArrayBuffer | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > Math.ceil((maximumBytes * 4) / 3) ||
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
    if (bytes.byteLength > maximumBytes || encodeBase64Url(bytes) !== value) {
      return null;
    }
    return bytes.buffer;
  } catch {
    return null;
  }
}

async function readPublishDeclaration(
  request: Request,
): Promise<PublishArtifactInput> {
  if (
    request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
  ) {
    throw new HttpRequestError(
      "content_type_invalid",
      "Content-Type must be application/json.",
      415,
    );
  }
  const body = await readBoundedBody(request, MAX_PUBLISH_JSON_BODY_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new HttpRequestError(
      "request_json_invalid",
      "The request body must be valid JSON.",
      400,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpRequestError(
      "publish_declaration_invalid",
      "The publish declaration is invalid.",
      400,
    );
  }
  const input = parsed as Record<string, unknown>;
  if (
    !hasExactKeys(input, [
      "artifactBytes",
      "artifactId",
      "expectedPolicyEpoch",
      "operationId",
      "ref",
      "signatureBytes",
    ]) ||
    typeof input.artifactId !== "string" ||
    typeof input.operationId !== "string" ||
    !Number.isSafeInteger(input.expectedPolicyEpoch) ||
    (input.expectedPolicyEpoch as number) < 0
  ) {
    throw new HttpRequestError(
      "publish_declaration_invalid",
      "The publish declaration is invalid.",
      400,
    );
  }
  let ref: PublishArtifactInput["ref"] = null;
  if (input.ref !== null) {
    if (
      typeof input.ref !== "object" ||
      Array.isArray(input.ref) ||
      !hasExactKeys(input.ref as Record<string, unknown>, [
        "expectedGeneration",
        "name",
      ])
    ) {
      throw new HttpRequestError(
        "publish_declaration_invalid",
        "The publish declaration is invalid.",
        400,
      );
    }
    const candidate = input.ref as Record<string, unknown>;
    if (
      candidate.name !== "heads/main" ||
      !Number.isSafeInteger(candidate.expectedGeneration) ||
      (candidate.expectedGeneration as number) < 0
    ) {
      throw new HttpRequestError(
        "publish_declaration_invalid",
        "The publish declaration is invalid.",
        400,
      );
    }
    ref = {
      expectedGeneration: candidate.expectedGeneration as number,
      name: "heads/main",
    };
  }
  const artifactBytes = decodeCanonicalBase64Url(
    input.artifactBytes,
    MAX_ARTIFACT_BYTES,
  );
  const signatureBytes = decodeCanonicalBase64Url(
    input.signatureBytes,
    MAX_SIGNATURE_BYTES,
  );
  if (artifactBytes === null || signatureBytes === null) {
    throw new HttpRequestError(
      "publish_declaration_invalid",
      "The publish declaration is invalid.",
      400,
    );
  }
  return {
    artifactBytes,
    artifactId: input.artifactId,
    expectedPolicyEpoch: input.expectedPolicyEpoch as number,
    operationId: input.operationId,
    principalId: OWNER_PRINCIPAL,
    ref,
    signatureBytes,
  };
}

class HttpRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function repositoryStub(env: Env): DurableObjectStub<RepositoryDO> {
  return env.REPOSITORY.getByName(SINGLE_PROJECT_AUTHORITY, {
    locationHint: "apac-ne",
  });
}

async function handleUploadApi(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response> {
  const authorizationFailure = await authorizeOwner(request, env);
  if (authorizationFailure) return authorizationFailure;

  const repository = repositoryStub(env);
  if (pathname === "/api/v0/uploads") {
    if (request.method !== "POST") {
      return errorResponse("method_not_allowed", "Method not allowed.", 405, {
        allow: "POST",
      });
    }
    const result = await repository.beginUpload(
      await readUploadDeclaration(request),
    );
    return result.status === "conflict"
      ? errorResponse(
          result.code,
          "The operation ID was already used for different input.",
          409,
        )
      : jsonResponse({ upload: result.upload });
  }

  const match =
    /^\/api\/v0\/uploads\/([0-9a-f-]+)(?:\/(content|finalize))?$/.exec(
      pathname,
    );
  if (!match) {
    return errorResponse(
      "not_found",
      "The requested resource does not exist.",
      404,
    );
  }
  const uploadId = match[1];
  if (!uploadId) {
    return errorResponse(
      "not_found",
      "The requested resource does not exist.",
      404,
    );
  }
  const action = match[2];
  if (action === "content") {
    if (request.method !== "PUT") {
      return errorResponse("method_not_allowed", "Method not allowed.", 405, {
        allow: "PUT",
      });
    }
    const bytes = await readBoundedBody(request, MAX_SMALL_BLOB_BYTES);
    const upload = await repository.stageUpload(
      OWNER_PRINCIPAL,
      uploadId,
      bytes,
    );
    return jsonResponse({ upload });
  }
  if (action === "finalize") {
    if (request.method !== "POST") {
      return errorResponse("method_not_allowed", "Method not allowed.", 405, {
        allow: "POST",
      });
    }
    const upload = await repository.finalizeUpload(OWNER_PRINCIPAL, uploadId);
    return jsonResponse({ upload });
  }
  if (request.method !== "GET") {
    return errorResponse("method_not_allowed", "Method not allowed.", 405, {
      allow: "GET",
    });
  }
  return jsonResponse({
    upload: await repository.getUpload(OWNER_PRINCIPAL, uploadId),
  });
}

async function handlePublishApi(request: Request, env: Env): Promise<Response> {
  const authorizationFailure = await authorizeOwner(request, env);
  if (authorizationFailure) return authorizationFailure;
  if (request.method !== "POST") {
    return errorResponse("method_not_allowed", "Method not allowed.", 405, {
      allow: "POST",
    });
  }

  const result = await repositoryStub(env).publishArtifact(
    await readPublishDeclaration(request),
  );
  const status =
    result.status === "accepted"
      ? 200
      : result.status === "rejected"
        ? 422
        : 409;
  return jsonResponse({ publication: result }, status);
}

async function handlePublicPushPreflightApi(
  request: Request,
  env: Env,
): Promise<Response> {
  const authorizationFailure = await authorizeOwner(request, env);
  if (authorizationFailure) return authorizationFailure;
  if (request.method !== "POST") {
    return errorResponse("method_not_allowed", "Method not allowed.", 405, {
      allow: "POST",
    });
  }

  const result = await repositoryStub(env).preflightPublicPush(
    await readPublicPushPreflightDeclaration(request),
  );
  const status =
    result.status === "ok"
      ? 200
      : result.code === "project_conflict"
        ? 409
        : 400;
  return jsonResponse({ preflight: result }, status);
}

async function handleOutboxApi(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response> {
  const authorizationFailure = await authorizeOwner(request, env);
  if (authorizationFailure) return authorizationFailure;
  const match = /^\/api\/v0\/outbox\/([1-9][0-9]{0,15})(\/match)?$/u.exec(
    pathname,
  );
  if (!match?.[1]) {
    return errorResponse(
      "not_found",
      "The requested resource does not exist.",
      404,
    );
  }
  const repoSequence = Number(match[1]);
  if (!Number.isSafeInteger(repoSequence)) {
    return errorResponse(
      "outbox_sequence_invalid",
      "The repository sequence is invalid.",
      400,
    );
  }
  if (match[2] === "/match") {
    if (request.method !== "POST") {
      return errorResponse("method_not_allowed", "Method not allowed.", 405, {
        allow: "POST",
      });
    }
    return jsonResponse({
      match: await repositoryStub(env).outboxArtifactMatch(
        repoSequence,
        await readOutboxMatchDeclaration(request),
      ),
    });
  }
  if (request.method !== "GET") {
    return errorResponse("method_not_allowed", "Method not allowed.", 405, {
      allow: "GET",
    });
  }
  return jsonResponse({
    outbox: await repositoryStub(env).outboxObservation(repoSequence),
  });
}

async function handleSyncHelloApi(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET") {
    return errorResponse("method_not_allowed", "Method not allowed.", 405, {
      allow: "GET",
    });
  }
  if (
    !hasExactQueryParameters(url.searchParams, ["protocol", "view"]) ||
    url.searchParams.get("protocol") !== "0" ||
    url.searchParams.get("view") !== "public"
  ) {
    return errorResponse(
      "sync_hello_invalid",
      "The sync negotiation request is invalid.",
      400,
    );
  }
  const result = await repositoryStub(env).syncHello({
    offeredProtocolVersions: [0],
    principalId: "anonymous",
    requestedView: "public",
  });
  if (result.status === "rejected") {
    return errorResponse(
      result.code,
      "The public sync view is unavailable.",
      result.code === "project_not_initialized" ? 409 : 400,
    );
  }
  return jsonResponse({ hello: result });
}

async function handlePublicInventoryApi(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET") {
    return errorResponse("method_not_allowed", "Method not allowed.", 405, {
      allow: "GET",
    });
  }
  const allowedParameters = ["cursor", "limit", "project", "protocol", "view"];
  const requiredParameters = ["limit", "project", "protocol", "view"];
  if (
    !hasAllowedQueryParameters(
      url.searchParams,
      allowedParameters,
      requiredParameters,
    )
  ) {
    return errorResponse(
      "inventory_request_invalid",
      "The inventory request is invalid.",
      400,
    );
  }
  const projectId = url.searchParams.get("project") ?? "";
  const limitText = url.searchParams.get("limit") ?? "";
  const cursor = url.searchParams.get("cursor");
  if (
    !/^sha256:[0-9a-f]{64}$/u.test(projectId) ||
    !/^[1-9][0-9]{0,3}$/u.test(limitText) ||
    url.searchParams.get("protocol") !== "0" ||
    url.searchParams.get("view") !== "public" ||
    cursor === ""
  ) {
    return errorResponse(
      "inventory_request_invalid",
      "The inventory request is invalid.",
      400,
    );
  }
  const result = await repositoryStub(env).publicInventoryPage({
    cursor,
    limit: Number(limitText),
    principalId: "anonymous",
    projectId,
    protocolVersion: 0,
    view: "public",
  });
  if (result.status === "rejected") {
    const conflict =
      result.code === "cursor_expired" ||
      result.code === "cursor_stale" ||
      result.code === "project_not_initialized";
    return errorResponse(
      result.code,
      result.code.startsWith("cursor_")
        ? "The inventory cursor cannot be used."
        : "The inventory request is invalid.",
      conflict ? 409 : 400,
    );
  }
  return jsonResponse({ inventory: result });
}

async function handlePublicTransferPlanApi(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("method_not_allowed", "Method not allowed.", 405, {
      allow: "POST",
    });
  }
  if (
    !hasExactQueryParameters(url.searchParams, [
      "profile",
      "project",
      "protocol",
      "view",
    ])
  ) {
    return errorResponse(
      "transfer_request_invalid",
      "The transfer request is invalid.",
      400,
    );
  }
  await readBoundedBody(request, 0);
  const projectId = url.searchParams.get("project") ?? "";
  if (
    !/^sha256:[0-9a-f]{64}$/u.test(projectId) ||
    url.searchParams.get("profile") !== "complete" ||
    url.searchParams.get("protocol") !== "0" ||
    url.searchParams.get("view") !== "public"
  ) {
    return errorResponse(
      "transfer_request_invalid",
      "The transfer request is invalid.",
      400,
    );
  }
  const result = await repositoryStub(env).publicTransferPlan({
    principalId: "anonymous",
    projectId,
    protocolVersion: 0,
    view: "public",
  });
  if (result.status === "rejected") {
    const status =
      result.code === "clone_plan_too_large"
        ? 413
        : result.code === "request_invalid"
          ? 400
          : 409;
    return errorResponse(
      result.code,
      "The public transfer plan is unavailable.",
      status,
    );
  }
  return jsonResponse({
    transfer: {
      expiresAt: result.expiresAt,
      grant: result.grant,
      grantTtlSeconds: 600,
      plan: {
        artifactIds: result.plan.artifactIds,
        blobs: result.plan.blobs,
        manifestCbor: encodeBase64Url(
          new Uint8Array(result.plan.manifestBytes),
        ),
        profile: result.plan.profile,
        ref: result.plan.ref,
        semanticRoot: result.plan.semanticRoot,
        signatureIds: result.plan.signatureIds,
      },
      status: "ok",
    },
  });
}

async function handlePublicArtifactTransferApi(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("method_not_allowed", "Method not allowed.", 405, {
      allow: "POST",
    });
  }
  if ([...url.searchParams.keys()].length !== 0) {
    return errorResponse(
      "transfer_request_invalid",
      "The transfer request is invalid.",
      400,
    );
  }
  const authorized = readPublicTransferAuthorization(request);
  if (authorized instanceof Response) return authorized;
  const artifactIds = await readPublicArtifactWant(request);
  const result = await repositoryStub(env).publicGrantedArtifactTransfer({
    artifactIds,
    grant: authorized,
  });
  if (result.status === "rejected") {
    return publicTransferError(result.code, "artifact");
  }
  return jsonResponse({
    transfer: {
      items: result.items.map((item) => ({
        artifactCbor: encodeBase64Url(new Uint8Array(item.artifactBytes)),
        artifactId: item.artifactId,
        kind: item.kind,
        signatureCbor: encodeBase64Url(new Uint8Array(item.signatureBytes)),
      })),
      status: "ok",
    },
  });
}

async function handlePublicBlobTransferApi(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET") {
    return errorResponse("method_not_allowed", "Method not allowed.", 405, {
      allow: "GET",
    });
  }
  if (!hasExactQueryParameters(url.searchParams, ["length", "offset"])) {
    return errorResponse(
      "transfer_request_invalid",
      "The transfer request is invalid.",
      400,
    );
  }
  const match =
    /^\/api\/v0\/sync\/transfers\/blobs\/(sha256:[0-9a-f]{64})$/u.exec(
      url.pathname,
    );
  const offsetText = url.searchParams.get("offset") ?? "";
  const lengthText = url.searchParams.get("length") ?? "";
  if (
    match?.[1] === undefined ||
    !/^(?:0|[1-9][0-9]{0,15})$/u.test(offsetText) ||
    !/^(?:0|[1-9][0-9]{0,7})$/u.test(lengthText)
  ) {
    return errorResponse(
      "transfer_request_invalid",
      "The transfer request is invalid.",
      400,
    );
  }
  const authorized = readPublicTransferAuthorization(request);
  if (authorized instanceof Response) return authorized;
  const result = await repositoryStub(env).publicGrantedBlobChunk({
    blobId: match[1],
    grant: authorized,
    length: Number(lengthText),
    offset: Number(offsetText),
  });
  if (result.status === "rejected") {
    return publicTransferError(result.code, "blob");
  }
  const headers = new Headers({
    ...JSON_HEADERS,
    "content-length": String(result.chunk.bytes.byteLength),
    "content-type": "application/octet-stream",
    "x-edgefoss-blob-id": result.chunk.blobId,
    "x-edgefoss-complete": String(result.chunk.complete),
    "x-edgefoss-offset": String(result.chunk.offset),
    "x-edgefoss-total-bytes": String(result.chunk.totalBytes),
  });
  return new Response(result.chunk.bytes, { headers });
}

function readPublicTransferAuthorization(request: Request): string | Response {
  const authorization = request.headers.get("authorization") ?? "";
  const grant = /^Bearer (efoss_transfer_v0_[A-Za-z0-9_-]{1,4076})$/u.exec(
    authorization,
  )?.[1];
  return (
    grant ??
    errorResponse(
      "transfer_grant_invalid",
      "A valid public transfer grant is required.",
      401,
      { "www-authenticate": 'Bearer realm="edgefoss-public-transfer"' },
    )
  );
}

async function readPublicArtifactWant(request: Request): Promise<string[]> {
  if (
    request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
  ) {
    throw new HttpRequestError(
      "content_type_invalid",
      "Content-Type must be application/json.",
      415,
    );
  }
  const bytes = await readBoundedBody(request, MAX_JSON_BODY_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpRequestError(
      "transfer_request_invalid",
      "The transfer request is invalid.",
      400,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpRequestError(
      "transfer_request_invalid",
      "The transfer request is invalid.",
      400,
    );
  }
  const input = parsed as Record<string, unknown>;
  if (
    !hasExactKeys(input, ["artifactIds"]) ||
    !Array.isArray(input.artifactIds) ||
    input.artifactIds.length < 1 ||
    input.artifactIds.length > 16 ||
    input.artifactIds.some(
      (id) => typeof id !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(id),
    ) ||
    input.artifactIds.some(
      (id, index, ids) => index > 0 && id <= ids[index - 1]!,
    )
  ) {
    throw new HttpRequestError(
      "transfer_request_invalid",
      "The transfer request is invalid.",
      400,
    );
  }
  return input.artifactIds as string[];
}

function publicTransferError(
  code: string,
  kind: "artifact" | "blob",
): Response {
  if (code === "transfer_grant_invalid" || code === "transfer_grant_expired") {
    return errorResponse(
      "transfer_grant_invalid",
      "A valid public transfer grant is required.",
      401,
      { "www-authenticate": 'Bearer realm="edgefoss-public-transfer"' },
    );
  }
  if (code === "snapshot_stale" || code === "project_not_initialized") {
    return errorResponse(
      code,
      "The public transfer snapshot is unavailable.",
      409,
    );
  }
  if (code === "artifact_unavailable" || code === "blob_unavailable") {
    return errorResponse(
      `${kind}_unavailable`,
      `The requested ${kind} is unavailable.`,
      404,
    );
  }
  return errorResponse(
    code,
    "The transfer request is invalid.",
    code === "transfer_budget_exceeded" ? 413 : 400,
  );
}

function hasExactQueryParameters(
  parameters: URLSearchParams,
  expected: readonly string[],
): boolean {
  return hasAllowedQueryParameters(parameters, expected, expected);
}

function hasAllowedQueryParameters(
  parameters: URLSearchParams,
  allowed: readonly string[],
  required: readonly string[],
): boolean {
  const keys = [...parameters.keys()];
  const allowedSet = new Set(allowed);
  return (
    keys.every((key) => allowedSet.has(key)) &&
    allowed.every((key) => parameters.getAll(key).length <= 1) &&
    required.every((key) => parameters.getAll(key).length === 1)
  );
}

async function readOutboxMatchDeclaration(request: Request): Promise<string> {
  if (
    request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
  ) {
    throw new HttpRequestError(
      "content_type_invalid",
      "Content-Type must be application/json.",
      415,
    );
  }
  const bytes = await readBoundedBody(request, MAX_OUTBOX_MATCH_BODY_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpRequestError(
      "outbox_match_invalid",
      "The outbox match declaration is invalid.",
      400,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpRequestError(
      "outbox_match_invalid",
      "The outbox match declaration is invalid.",
      400,
    );
  }
  const input = parsed as Record<string, unknown>;
  if (
    !hasExactKeys(input, ["artifactId"]) ||
    typeof input.artifactId !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(input.artifactId)
  ) {
    throw new HttpRequestError(
      "outbox_match_invalid",
      "The outbox match declaration is invalid.",
      400,
    );
  }
  return input.artifactId;
}

async function readPublicPushPreflightDeclaration(
  request: Request,
): Promise<PublicPushPreflightInput> {
  if (
    request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
  ) {
    throw new HttpRequestError(
      "content_type_invalid",
      "Content-Type must be application/json.",
      415,
    );
  }
  const bytes = await readBoundedBody(
    request,
    MAX_PUSH_PREFLIGHT_JSON_BODY_BYTES,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw pushPreflightRequestError();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw pushPreflightRequestError();
  }
  const input = parsed as Record<string, unknown>;
  if (
    !hasExactKeys(input, [
      "artifactIds",
      "blobIds",
      "projectId",
      "protocolVersion",
      "realm",
    ]) ||
    input.protocolVersion !== 0 ||
    input.realm !== "public" ||
    typeof input.projectId !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(input.projectId) ||
    !validPushPreflightIds(input.artifactIds, MAX_PUSH_PREFLIGHT_ARTIFACTS) ||
    !validPushPreflightIds(input.blobIds, MAX_PUSH_PREFLIGHT_BLOBS)
  ) {
    throw pushPreflightRequestError();
  }
  return {
    artifactIds: input.artifactIds,
    blobIds: input.blobIds,
    principalId: OWNER_PRINCIPAL,
    projectId: input.projectId,
    protocolVersion: 0,
    realm: "public",
  };
}

function validPushPreflightIds(
  value: unknown,
  maximum: number,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every(
      (id, index, ids) =>
        typeof id === "string" &&
        /^sha256:[0-9a-f]{64}$/u.test(id) &&
        (index === 0 || id > ids[index - 1]!),
    )
  );
}

function pushPreflightRequestError(): HttpRequestError {
  return new HttpRequestError(
    "push_preflight_invalid",
    "The public push preflight request is invalid.",
    400,
  );
}

function mapRequestError(error: unknown, pathname: string): Response {
  if (error instanceof HttpRequestError) {
    return errorResponse(error.code, error.message, error.status);
  }
  const message = error instanceof Error ? error.message : "unknown_error";
  if (message === "upload_not_found") {
    return errorResponse("upload_not_found", "The upload does not exist.", 404);
  }
  if (message.endsWith("_invalid") || message === "upload_size_invalid") {
    return errorResponse(
      "upload_declaration_invalid",
      "The upload declaration is invalid.",
      400,
    );
  }
  if (
    message === "upload_not_staged" ||
    message === "upload_staging_changed" ||
    message === "upload_staging_conflict" ||
    message === "final_blob_conflict"
  ) {
    return errorResponse(message, "The upload could not be finalized.", 409);
  }
  console.error(
    JSON.stringify({
      error: message,
      message: "request failed",
      path: pathname,
    }),
  );
  return errorResponse("internal_error", "The request failed.", 500);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (
      (request.method === "GET" || request.method === "HEAD") &&
      url.pathname === "/health"
    ) {
      const repository = repositoryStub(env);
      const repositoryHealth = await repository.health();
      const body = {
        components: {
          repository: repositoryHealth,
          r2: {
            exports: "bound",
            publicBlobs: "bound",
            restrictedBlobs: "bound",
          },
        },
        edition: "single",
        environment: env.EDGEFOSS_ENV,
        service: "edgefoss",
        status: "ok",
      };

      if (request.method === "HEAD") {
        return new Response(null, { headers: JSON_HEADERS });
      }

      return jsonResponse(body);
    }

    if (url.pathname.startsWith("/api/v0/uploads")) {
      try {
        return await handleUploadApi(request, env, url.pathname);
      } catch (error) {
        return mapRequestError(error, url.pathname);
      }
    }

    if (url.pathname === "/api/v0/artifacts") {
      try {
        return await handlePublishApi(request, env);
      } catch (error) {
        return mapRequestError(error, url.pathname);
      }
    }

    if (url.pathname === "/api/v0/sync/push/preflight") {
      try {
        return await handlePublicPushPreflightApi(request, env);
      } catch (error) {
        return mapRequestError(error, url.pathname);
      }
    }

    if (url.pathname.startsWith("/api/v0/outbox")) {
      try {
        return await handleOutboxApi(request, env, url.pathname);
      } catch (error) {
        return mapRequestError(error, url.pathname);
      }
    }

    if (url.pathname === "/api/v0/sync/hello") {
      try {
        return await handleSyncHelloApi(request, env, url);
      } catch (error) {
        return mapRequestError(error, url.pathname);
      }
    }

    if (url.pathname === "/api/v0/inventory") {
      try {
        return await handlePublicInventoryApi(request, env, url);
      } catch (error) {
        return mapRequestError(error, url.pathname);
      }
    }

    if (url.pathname === "/api/v0/sync/transfers") {
      try {
        return await handlePublicTransferPlanApi(request, env, url);
      } catch (error) {
        return mapRequestError(error, url.pathname);
      }
    }

    if (url.pathname === "/api/v0/sync/transfers/artifacts") {
      try {
        return await handlePublicArtifactTransferApi(request, env, url);
      } catch (error) {
        return mapRequestError(error, url.pathname);
      }
    }

    if (url.pathname.startsWith("/api/v0/sync/transfers/blobs/")) {
      try {
        return await handlePublicBlobTransferApi(request, env, url);
      } catch (error) {
        return mapRequestError(error, url.pathname);
      }
    }

    return jsonResponse(
      {
        error: {
          code: "not_found",
          message: "The requested resource does not exist.",
        },
      },
      404,
    );
  },
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const repository = repositoryStub(env);
    for (const message of batch.messages) {
      await consumeAuthorityEventMessage(message, repository, batch.queue);
    }
  },
} satisfies ExportedHandler<Env, unknown>;
