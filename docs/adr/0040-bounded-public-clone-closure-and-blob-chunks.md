# ADR-0040: Plan a bounded public closure and read blobs in resumable chunks

- Status: Accepted for P5a2b1
- Date: 2026-08-26
- Owners: sync, storage, and security leads
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

P5a2a transfers requested public artifact and signature bodies, but an accepted
artifact inventory contains dangling objects and is not a portable clone. The
local importer requires exactly the graph reachable from an accepted ref, its
referenced blobs, canonical signatures, and a manifest whose semantic root
matches those objects.

Blob reads introduce external R2 I/O. A policy epoch may advance while that I/O
is in flight, and buffering the complete history or a large blob in one RPC
would create avoidable memory and retry risk.

## Decision

Add two internal RepositoryDO RPC operations.

`publicClonePlan()` captures the public snapshot and current `heads/main`, then
walks only `parent`, `tree`, and `blob` edges reachable from that head. It always
includes project genesis. The first profile is `complete` and is bounded to:

- 128 reachable artifacts;
- 8 MiB aggregate canonical artifact bodies while planning;
- 1,024 reachable blobs.

The planner rejects a missing public head, an oversized closure, merge history,
or a ref generation that cannot be reconstructed by the current linear local
importer. It recomputes every artifact ID, verifies every signature, computes
the public semantic root, and emits the canonical experimental bundle manifest.
The result lists sorted artifact, signature, and reachable blob IDs but never R2
keys. It rechecks policy epoch after asynchronous cryptographic work.

`publicBlobChunk()` accepts the internal snapshot, planned head, one reachable
blob ID, offset, and length. Reads are limited to 1 MiB. The authority recomputes
the bounded closure before R2 access so dangling public uploads, members blobs,
and nonexistent IDs all return `blob_unavailable`. It uses the existing
`PUBLIC_BLOBS` binding, checks object size and available SHA-256 metadata, and
rechecks policy epoch after R2 I/O before returning bytes. A complete one-chunk
read is hashed again. Zero-byte blobs use one explicit zero-length read.

The client resumes without server-side session state by retaining verified
artifact bodies and blob ranges, then requesting only missing ranges.

## Scope boundary

The plan and chunk operations remain internal RPCs. There is no new HTTP route,
external token, or advertised `TRANSFER` capability. The internal snapshot and
planned-head values are not yet an authorization token; P5a2c must replace them
with an opaque integrity-protected external grant.

P5a2b1 proves bundle assembly inside the TypeScript protocol/runtime boundary.
It does not yet feed the exact generated bundle into the Rust importer. P5a2b2
must add one deterministic cross-runtime vector and prove atomic import into a
fresh local repository followed by byte-identical re-export.

There is no schema migration, new binding, secret, Cloudflare resource, remote
R2 operation, Queue event, staging deployment, or production change.

## Consequences

- clone excludes accepted but unreachable public artifacts and blobs;
- members IDs, sizes, paths, and content do not enter the plan;
- large blobs resume in independently bounded ranges;
- policy changes fail closed even when they race cryptographic or R2 work;
- current merge histories fail explicitly instead of producing a bundle the
  linear local importer cannot reproduce;
- large repositories need paged closure planning in a later increment.

## Verification

- a genesis/tree/change head with a blob produces a valid complete manifest;
- transferred artifacts, signatures, and assembled blob chunks pass independent
  bundle manifest/object verification;
- a blob crossing the 1 MiB boundary resumes in two chunks;
- zero-byte blobs round-trip;
- dangling public, members, and nonexistent blobs are indistinguishable;
- repeated planning produces byte-identical manifest bytes;
- a missing public head rejects;
- policy advance invalidates a pending blob read;
- schema 5 and the external HTTP/capability surface remain unchanged.

## Current platform references

- [R2 Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Invoke Durable Object methods](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/)
