# P5a2a public artifact transfer local evidence — 2026-08-25

- Increment: bounded internal public artifact and signature transfer
- Base commit: `ecc03f0`
- Environment: local Workers runtime only
- Repository schema: unchanged at 5
- Remote mutation: none

## Implemented boundary

[`ADR 0039`](../adr/0039-bounded-internal-public-artifact-transfer.md) fixes a
local-first snapshot and WANT/TRANSFER contract. A start-of-snapshot anchor can
seed the existing internal inventory, and a transfer request returns 1–16 sorted
public artifacts plus canonical signature records within a 2 MiB response
budget.

The implementation loads only rows classified public and accepted at or before
the snapshot. It recomputes each content ID and verifies each detached signature
before returning bytes. Members, later, and nonexistent IDs share one
`artifact_unavailable` response. An exact retry returns byte-identical frames.

## Workers runtime matrix

Focused tests prove:

- the captured snapshot and internal inventory identify the same public set;
- canonical artifact bodies recompute to their transferred IDs;
- reconstructed signature records verify with Web Crypto;
- exact replay returns identical artifact and signature bytes;
- a members ID, a later public ID, and a nonexistent ID are indistinguishable;
- empty, duplicate, unsorted, and over-item-limit WANT sets and a non-start
  anchor reject;
- policy epoch advance rejects the old snapshot as `snapshot_stale`;
- RepositoryDO application schema remains 5.

The full repository gate is green:

- protocol tests: 182 passed across 9 files;
- Worker tests: 37 passed across 9 files;
- owner adapter and smoke tests: 12 passed;
- cloud plan/state/deploy tests: 25 passed;
- Rust workspace tests, Clippy, formatting, static-assets smoke, shared vectors,
  and Markdown link audit: passed;
- Markdown files checked: 112.

## Platform and code review

The implementation was checked against the Cloudflare Workers and Durable
Objects best-practice pages current on 2026-08-25. The project-generated runtime
types use workerd `1.20260820.1` with compatibility date `2026-08-24` and
`nodejs_compat`. RPC inputs and outputs are structured-clone values, SQL reads
finish before Web Crypto awaits, no request state is stored globally, and no
Promise is left floating.

Both named dry-runs preserve the reviewed topology. Staging retains
`RepositoryDO`, the `edgefoss-staging-events` producer, and exactly three R2
bindings. Production retains `RepositoryDO` and exactly three production R2
bindings with no Queue binding. Both bundles are 110.99 KiB, gzip 22.97 KiB.
The local startup profile reports 9.1 ms active time with 0.0 ms garbage
collection; this is not an edge-latency claim.

## Scope and next gate

The current HTTP adapter still advertises only `HELLO` and `INVENTORY`. There is
no transfer route, external snapshot token, blob or R2 read, ref, manifest,
bundle assembly, local import call, schema migration, binding, secret, Queue
event, remote Worker version, or production change.

P5a2a does not complete clone/pull. The full local gate and both named dry-runs
are complete. Commit and ordinary CI remain the gate before P5a2b can define
public ref and reachable-graph closure, bounded blob reads, portable bundle
assembly, and atomic import into a fresh local repository.
