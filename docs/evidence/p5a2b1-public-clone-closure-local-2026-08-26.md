# P5a2b1 public clone closure local evidence — 2026-08-26

- Increment: bounded public closure, canonical manifest, and R2 blob chunks
- Base commit: `b55d365`
- Environment: local Workers runtime and local R2 bindings only
- Repository schema: unchanged at 5
- Remote mutation: none

## Implemented boundary

[`ADR 0040`](../adr/0040-bounded-public-clone-closure-and-blob-chunks.md)
defines one internal complete-profile clone plan. It captures public
`heads/main`, walks only its reachable public artifact/blob graph, verifies
artifact and signature integrity, and emits a canonical bundle manifest.

Planning is limited to 128 artifacts, 8 MiB aggregate artifact bodies, and
1,024 blobs. Blob reads use the existing `PUBLIC_BLOBS` binding in ranges of at
most 1 MiB. R2 keys are not returned. A policy epoch is checked before and after
external R2 I/O.

## Workers runtime matrix

Focused tests prove:

- genesis, tree, change, signature records, and reachable blobs assemble into a
  manifest/object set accepted by protocol bundle verification;
- a 1 MiB plus 17-byte blob resumes in two ordered chunks and recomputes to its
  content ID;
- a zero-byte blob completes through an explicit zero-length read;
- dangling public, members, and nonexistent blob IDs return the same result;
- repeated planning emits byte-identical manifest bytes;
- a missing public head rejects;
- policy epoch advance makes a planned blob read stale;
- RepositoryDO application schema remains 5.

## Platform review and non-effects

The code uses generated runtime binding types, typed DO RPC, synchronous SQLite
reads before R2 I/O, bounded buffering, the in-process R2 binding rather than a
REST API, and awaited Promises. There is no module-global request state.

The current HTTP adapter still advertises only `HELLO` and `INVENTORY`. There is
no external transfer route or grant, schema migration, new binding, secret,
Cloudflare resource, remote R2 read/write, Queue event, remote Worker version,
or production change.

## Verification status

The completed local gate produced:

- protocol: 9 files and 182 tests passed;
- Worker: 10 files and 39 tests passed;
- owner adapter and smoke tools: 12 tests passed;
- cloud plan, state, and deploy tools: 25 tests passed;
- Rust workspace tests, Clippy, formatting, static-assets smoke, protocol vectors,
  bundle-invalid vectors, and documentation checks all passed;
- 114 Markdown files passed the documentation and link checker.

Named Wrangler dry-runs also passed without deployment. Staging retained the
existing RepositoryDO, three R2 bindings, and `EVENTS` Queue producer/consumer
configuration. Production retained RepositoryDO and three R2 bindings without a
Queue binding. Both generated a 127.62 KiB Worker bundle (25.93 KiB gzip).

The local startup profile reported 3.9 ms active startup and 0.0 ms GC for that
bundle. This is a local compilation/startup observation, not an edge latency or
production performance claim.

## Next gate

P5a2b1 does not yet claim fresh local import. The full local gate and named
dry-runs are complete; commit and ordinary CI remain. After they pass, P5a2b2
must make the exact cloud-plan output deterministic across TypeScript and Rust,
import it atomically into an empty local repository, and re-export the identical
accepted public bundle.
