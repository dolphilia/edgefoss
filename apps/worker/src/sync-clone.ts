import {
  artifactId,
  computeSemanticRoot,
  decodeChange,
  decodeProjectGenesis,
  decodeTree,
  encodeBundleManifest,
  encodeSignatureRecord,
  verifyArtifactSignature,
  type BundleManifest,
} from "@edgefoss/protocol";

import type { PublishArtifactKind } from "./artifact-publish.js";
import type { PublicInventoryAnchorV0 } from "./sync-inventory.js";
import {
  beginPublicTransfer,
  readPublicArtifactTransfer,
  validPublicTransferSnapshot,
  type BeginPublicTransferInput,
  type PublicArtifactTransferInput,
  type PublicArtifactTransferResult,
} from "./sync-transfer.js";

export const MAX_PUBLIC_CLONE_ARTIFACTS = 128;
export const MAX_PUBLIC_CLONE_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const MAX_PUBLIC_CLONE_BLOBS = 1_024;
export const MAX_PUBLIC_BLOB_CHUNK_BYTES = 1024 * 1024;

export interface PublicCloneBlobV0 {
  blobId: string;
  byteSize: number;
}

export interface PublicClonePlanV0 {
  artifactIds: string[];
  blobs: PublicCloneBlobV0[];
  manifestBytes: ArrayBuffer;
  profile: "complete";
  ref: {
    generation: number;
    name: "heads/main";
    targetArtifactId: string;
  };
  semanticRoot: string;
  signatureIds: string[];
  snapshot: PublicInventoryAnchorV0;
}

export type PublicClonePlanResult =
  | { plan: PublicClonePlanV0; status: "ok" }
  | { code: "clone_plan_too_large"; status: "rejected" }
  | { code: "clone_profile_unsupported"; status: "rejected" }
  | { code: "project_not_initialized"; status: "rejected" }
  | { code: "public_ref_unavailable"; status: "rejected" }
  | { code: "request_invalid"; status: "rejected" }
  | {
      code: "snapshot_stale";
      currentPolicyEpoch: number;
      status: "rejected";
    };

export interface PublicBlobChunkInput {
  blobId: string;
  headArtifactId: string;
  length: number;
  offset: number;
  snapshot: PublicInventoryAnchorV0;
}

export type PublicBlobChunkResult =
  | {
      chunk: {
        blobId: string;
        bytes: ArrayBuffer;
        complete: boolean;
        offset: number;
        totalBytes: number;
      };
      status: "ok";
    }
  | { code: "blob_unavailable"; status: "rejected" }
  | { code: "request_invalid"; status: "rejected" }
  | {
      code: "snapshot_stale";
      currentPolicyEpoch: number;
      status: "rejected";
    };

export interface PublicCloneArtifactTransferInput extends PublicArtifactTransferInput {
  headArtifactId: string;
}

interface CloneArtifactRow extends Record<string, SqlStorageValue> {
  actor_key: ArrayBuffer;
  artifact_id: string;
  canonical_body: ArrayBuffer;
  kind: PublishArtifactKind;
  signature: ArrayBuffer;
}

interface CloneBlobRow extends Record<string, SqlStorageValue> {
  blob_id: string;
  byte_size: number;
  r2_key: string;
}

interface EdgeRow extends Record<string, SqlStorageValue> {
  edge_kind: "blob" | "parent" | "tree";
  target_id: string;
}

interface RefRow extends Record<string, SqlStorageValue> {
  artifact_id: string;
  generation: number;
}

interface Closure {
  artifacts: Map<string, CloneArtifactRow>;
  blobs: Map<string, CloneBlobRow>;
}

export async function planPublicClone(
  sql: SqlStorage,
  input: BeginPublicTransferInput,
): Promise<PublicClonePlanResult> {
  const begun = beginPublicTransfer(sql, input);
  if (begun.status === "rejected") return begun;
  const ref = sql
    .exec<RefRow>(
      `SELECT artifact_id, generation
         FROM realm_refs
        WHERE realm = 'public' AND ref_name = 'heads/main'`,
    )
    .toArray()[0];
  if (ref === undefined) {
    return { code: "public_ref_unavailable", status: "rejected" };
  }

  const closure = capturePublicClosure(sql, begun.snapshot, ref.artifact_id);
  if (closure === "too_large") {
    return { code: "clone_plan_too_large", status: "rejected" };
  }
  if (
    !supportsCompleteCloneProfile(
      closure,
      begun.snapshot.projectId,
      ref.artifact_id,
      ref.generation,
    )
  ) {
    return { code: "clone_profile_unsupported", status: "rejected" };
  }

  const artifactIds = [...closure.artifacts.keys()].sort();
  const signatureIds: string[] = [];
  for (const id of artifactIds) {
    const row = closure.artifacts.get(id)!;
    if ((await artifactId(new Uint8Array(row.canonical_body))) !== id) {
      throw new Error("public_clone_corrupt");
    }
    const actorKey = new Uint8Array(row.actor_key);
    const record = {
      actorKey,
      artifact: id,
      signature: new Uint8Array(row.signature),
    };
    await verifyArtifactSignature(record, id, actorKey);
    signatureIds.push(await artifactId(encodeSignatureRecord(record)));
  }
  signatureIds.sort();

  const semantic = await computeSemanticRoot({
    artifacts: artifactIds.map((id) => ({ id, realm: "public" as const })),
    policyVersion: 0n,
    project: begun.snapshot.projectId,
    realm: "public",
    refs: [
      {
        name: "heads/main",
        realm: "public",
        target: ref.artifact_id,
      },
    ],
  });
  const blobIds = [...closure.blobs.keys()].sort();
  const manifest: BundleManifest = {
    artifacts: artifactIds,
    baseRoots: new Map(),
    blobs: blobIds,
    policyVersion: 0n,
    project: begun.snapshot.projectId,
    realm: "public",
    refs: new Map([["heads/main", ref.artifact_id]]),
    semanticRoot: semantic.semanticRoot,
    signatures: signatureIds,
  };
  const manifestBytes = await encodeBundleManifest(manifest);
  const currentPolicyEpoch = metaInteger(sql, "policy_epoch");
  if (currentPolicyEpoch !== begun.snapshot.policyEpoch) {
    return {
      code: "snapshot_stale",
      currentPolicyEpoch,
      status: "rejected",
    };
  }
  return {
    plan: {
      artifactIds,
      blobs: blobIds.map((blobId) => ({
        blobId,
        byteSize: closure.blobs.get(blobId)!.byte_size,
      })),
      manifestBytes: copyBuffer(manifestBytes),
      profile: "complete",
      ref: {
        generation: ref.generation,
        name: "heads/main",
        targetArtifactId: ref.artifact_id,
      },
      semanticRoot: semantic.semanticRoot,
      signatureIds,
      snapshot: begun.snapshot,
    },
    status: "ok",
  };
}

function supportsCompleteCloneProfile(
  closure: Closure,
  projectId: string,
  headArtifactId: string,
  generation: number,
): boolean {
  const genesisRow = closure.artifacts.get(projectId);
  if (genesisRow?.kind !== "project.genesis" || generation < 1) return false;
  const actorKey = decodeProjectGenesis(
    new Uint8Array(genesisRow.canonical_body),
  ).actorKey;
  const rows = [...closure.artifacts.values()];
  const changeCount = rows.filter((row) => row.kind === "change").length;
  if (generation !== changeCount) return false;
  for (const row of rows) {
    if (row.kind !== "tree") continue;
    const tree = decodeTree(new Uint8Array(row.canonical_body));
    if (tree.logicalClock !== 0n || !sameBytes(tree.actorKey, actorKey)) {
      return false;
    }
  }

  const seen = new Set<string>();
  let current = headArtifactId;
  let expectedClock = BigInt(generation - 1);
  while (true) {
    if (seen.has(current)) return false;
    seen.add(current);
    const row = closure.artifacts.get(current);
    if (row?.kind !== "change") return false;
    const change = decodeChange(new Uint8Array(row.canonical_body));
    if (
      change.logicalClock !== expectedClock ||
      !sameBytes(change.actorKey, actorKey) ||
      change.parents.length > 1
    ) {
      return false;
    }
    if (change.parents.length === 0) {
      return expectedClock === 0n && seen.size === changeCount;
    }
    if (expectedClock === 0n) return false;
    current = change.parents[0]!;
    expectedClock -= 1n;
  }
}

export async function readPublicBlobChunk(
  sql: SqlStorage,
  bucket: R2Bucket,
  input: PublicBlobChunkInput,
): Promise<PublicBlobChunkResult> {
  if (!validBlobChunkInput(input)) {
    return { code: "request_invalid", status: "rejected" };
  }
  const stale = snapshotStale(sql, input.snapshot);
  if (stale !== null) return stale;
  const closure = capturePublicClosure(
    sql,
    input.snapshot,
    input.headArtifactId,
  );
  if (closure === "too_large") {
    return { code: "blob_unavailable", status: "rejected" };
  }
  const blob = closure.blobs.get(input.blobId);
  if (
    blob === undefined ||
    input.offset > blob.byte_size ||
    input.length > blob.byte_size - input.offset
  ) {
    return { code: "blob_unavailable", status: "rejected" };
  }
  if (input.length === 0 && blob.byte_size !== 0) {
    return { code: "blob_unavailable", status: "rejected" };
  }

  const object = await bucket.get(
    blob.r2_key,
    input.length === 0
      ? undefined
      : { range: { length: input.length, offset: input.offset } },
  );
  if (object === null || object.size !== blob.byte_size) {
    throw new Error("public_blob_corrupt");
  }
  const checksum = object.checksums.sha256;
  if (checksum !== undefined && formatSha256(checksum) !== input.blobId) {
    throw new Error("public_blob_corrupt");
  }
  const bytes = await object.bytes();
  if (bytes.byteLength !== input.length) {
    throw new Error("public_blob_corrupt");
  }
  const staleAfterRead = snapshotStale(sql, input.snapshot);
  if (staleAfterRead !== null) return staleAfterRead;
  if (input.offset === 0 && input.length === blob.byte_size) {
    if ((await artifactId(bytes)) !== input.blobId) {
      throw new Error("public_blob_corrupt");
    }
  }
  return {
    chunk: {
      blobId: input.blobId,
      bytes: copyBuffer(bytes),
      complete: input.offset + input.length === blob.byte_size,
      offset: input.offset,
      totalBytes: blob.byte_size,
    },
    status: "ok",
  };
}

export async function readPublicCloneArtifactTransfer(
  sql: SqlStorage,
  input: PublicCloneArtifactTransferInput,
): Promise<PublicArtifactTransferResult> {
  if (!/^sha256:[0-9a-f]{64}$/u.test(input.headArtifactId)) {
    return { code: "request_invalid", status: "rejected" };
  }
  const transferred = await readPublicArtifactTransfer(sql, input);
  if (transferred.status === "rejected") return transferred;
  const closure = capturePublicClosure(
    sql,
    input.snapshot,
    input.headArtifactId,
  );
  if (
    closure === "too_large" ||
    input.artifactIds.some((id) => !closure.artifacts.has(id))
  ) {
    return { code: "artifact_unavailable", status: "rejected" };
  }
  return transferred;
}

function capturePublicClosure(
  sql: SqlStorage,
  snapshot: PublicInventoryAnchorV0,
  headArtifactId: string,
): Closure | "too_large" {
  const artifacts = new Map<string, CloneArtifactRow>();
  const blobIds = new Set<string>();
  const pending = [snapshot.projectId, headArtifactId];
  let artifactBytes = 0;
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (artifacts.has(id)) continue;
    if (artifacts.size >= MAX_PUBLIC_CLONE_ARTIFACTS) return "too_large";
    const row = sql
      .exec<CloneArtifactRow>(
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
        id,
        snapshot.projectId,
        snapshot.snapshotAcceptedSequence,
      )
      .toArray()[0];
    if (row === undefined) throw new Error("public_clone_corrupt");
    artifactBytes += row.canonical_body.byteLength;
    if (artifactBytes > MAX_PUBLIC_CLONE_ARTIFACT_BYTES) return "too_large";
    artifacts.set(id, row);
    const edges = sql
      .exec<EdgeRow>(
        `SELECT edge_kind, target_id
           FROM artifact_edges
          WHERE source_id = ?
          ORDER BY edge_kind, target_id`,
        id,
      )
      .toArray();
    for (const edge of edges) {
      if (edge.edge_kind === "blob") {
        blobIds.add(edge.target_id);
        if (blobIds.size > MAX_PUBLIC_CLONE_BLOBS) return "too_large";
      } else {
        pending.push(edge.target_id);
      }
    }
  }

  const blobs = new Map<string, CloneBlobRow>();
  for (const blobId of blobIds) {
    const row = sql
      .exec<CloneBlobRow>(
        `SELECT blob_id, byte_size, r2_key
           FROM blobs
          WHERE realm = 'public' AND blob_id = ? AND state = 'finalized'`,
        blobId,
      )
      .toArray()[0];
    if (row === undefined) throw new Error("public_clone_corrupt");
    blobs.set(blobId, row);
  }
  return { artifacts, blobs };
}

function validBlobChunkInput(input: PublicBlobChunkInput): boolean {
  return (
    input !== null &&
    typeof input === "object" &&
    /^sha256:[0-9a-f]{64}$/u.test(input.blobId) &&
    /^sha256:[0-9a-f]{64}$/u.test(input.headArtifactId) &&
    validPublicTransferSnapshot(input.snapshot) &&
    Number.isSafeInteger(input.offset) &&
    input.offset >= 0 &&
    Number.isSafeInteger(input.length) &&
    input.length >= 0 &&
    input.length <= MAX_PUBLIC_BLOB_CHUNK_BYTES
  );
}

function snapshotStale(
  sql: SqlStorage,
  snapshot: PublicInventoryAnchorV0,
): Extract<PublicBlobChunkResult, { code: "snapshot_stale" }> | null {
  const projectId = metaValue(sql, "project_id");
  if (projectId === "" || projectId !== snapshot.projectId) {
    return {
      code: "snapshot_stale",
      currentPolicyEpoch: metaInteger(sql, "policy_epoch"),
      status: "rejected",
    };
  }
  const currentPolicyEpoch = metaInteger(sql, "policy_epoch");
  return currentPolicyEpoch === snapshot.policyEpoch
    ? null
    : { code: "snapshot_stale", currentPolicyEpoch, status: "rejected" };
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

function formatSha256(digest: ArrayBuffer): string {
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

function copyBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const result = new ArrayBuffer(source.byteLength);
  new Uint8Array(result).set(source);
  return result;
}
