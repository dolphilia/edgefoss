import { DurableObject } from "cloudflare:workers";

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
} as const;

const SINGLE_PROJECT_AUTHORITY = "edgefoss-single-project-v0";
const REPOSITORY_SCHEMA_VERSION = 2;
const MAX_SMALL_BLOB_BYTES = 16 * 1024 * 1024;

export type CloudRealm = "public" | "members";
export type UploadState =
  "declared" | "staged" | "verified" | "finalized" | "rejected";

export interface BeginUploadInput {
  blobId: string;
  byteSize: number;
  operationId: string;
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

interface UploadRow extends Record<string, SqlStorageValue> {
  blob_id: string;
  byte_size: number;
  failure: "hash_mismatch" | "size_mismatch" | null;
  final_key: string | null;
  operation_id: string;
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

    if (schemaVersion !== REPOSITORY_SCHEMA_VERSION) {
      throw new Error("RepositoryDO schema version is unsupported.");
    }
  }

  beginUpload(input: BeginUploadInput): BeginUploadResult {
    validateBeginUpload(input);

    const existing = this.ctx.storage.sql
      .exec<UploadRow>(
        `SELECT upload_id, operation_id, realm, blob_id, byte_size,
                staging_key, final_key, failure, state
           FROM upload_sessions
          WHERE operation_id = ?`,
        input.operationId,
      )
      .toArray()[0];
    if (existing) {
      if (
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
         final_key, failure, state, created_at, finalized_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'declared', ?, NULL)`,
      uploadId,
      input.operationId,
      input.realm,
      input.blobId,
      input.byteSize,
      stagingKey,
      Date.now(),
    );

    return {
      status: "ok",
      upload: {
        ...input,
        failure: null,
        finalKey: null,
        stagingKey,
        state: "declared",
        uploadId,
      },
    };
  }

  async finalizeUpload(uploadId: string): Promise<UploadResult> {
    validateUuid(uploadId, "upload_id");
    let upload = this.#readUpload(uploadId);
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

  getUpload(uploadId: string): UploadResult {
    validateUuid(uploadId, "upload_id");
    return uploadResult(this.#readUpload(uploadId));
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
                staging_key, final_key, failure, state
           FROM upload_sessions
          WHERE upload_id = ?`,
        uploadId,
      )
      .toArray()[0];
    if (!upload) throw new Error("upload_not_found");
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
  const existing = await bucket.head(key);
  if (existing === null || existing.size !== upload.byte_size) {
    throw new Error("final_blob_conflict");
  }
  const checksum = existing.checksums.sha256;
  if (checksum && formatSha256(checksum) === formatSha256(expectedDigest)) {
    return;
  }

  const body = await bucket.get(key);
  if (body === null || body.size !== upload.byte_size) {
    throw new Error("final_blob_conflict");
  }
  const digest = await crypto.subtle.digest("SHA-256", await body.bytes());
  if (formatSha256(digest) !== upload.blob_id) {
    throw new Error("final_blob_conflict");
  }
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (
      (request.method === "GET" || request.method === "HEAD") &&
      url.pathname === "/health"
    ) {
      const repository = env.REPOSITORY.getByName(SINGLE_PROJECT_AUTHORITY, {
        locationHint: "apac-ne",
      });
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
} satisfies ExportedHandler<Env>;
