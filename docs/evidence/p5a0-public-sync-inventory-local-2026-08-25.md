# P5a0 public sync inventory local evidence — 2026-08-25

- Increment: internal public `HELLO` and paged `INVENTORY`
- Base commit: `3bbd9a1`
- Environment: local Workers runtime only
- Repository schema: unchanged at 5
- Remote mutation: none

## Implemented boundary

`RepositoryDO.syncHello()` negotiates sync protocol 0 for the anonymous public
view and advertises only `HELLO` and `INVENTORY`. `RepositoryDO.publicInventory()`
performs an artifact-ID ordered scan with a hard 1,000-item maximum.

Inventory items contain only `artifactId` and `kind`. Query predicates select
`realm = 'public'`; neither the global receipt sequence nor a total is returned.
The initial page fixes a public-only accepted-sequence high-water mark, and the
authority-internal continuation anchor binds project, principal, view, protocol,
policy epoch, and snapshot.

The anchor is deliberately not an HTTP cursor. No external route serializes it.
Opaque token encoding and integrity protection remain prerequisites for the
later HTTP adapter.

## Workers runtime matrix

The focused tests prove:

- an uninitialized project and an unsupported protocol version reject cleanly;
- the accepted capability set contains only implemented phases;
- signed public and members artifacts may coexist while inventory returns only
  public entries;
- no item contains sequence, size, path, or blob metadata;
- page membership remains stable when a public artifact is accepted after the
  first page;
- a fresh scan sees the later artifact;
- project/principal/view mismatch rejects continuation;
- a policy epoch advance makes an earlier anchor stale;
- an over-limit request is rejected rather than issuing an unbounded query.

## Verification status

- Worker type checks: passed
- Worker tests: 31 passed across 7 files
- protocol tests: 182 passed across 9 files
- owner adapter and smoke tests: 8 passed
- cloud plan/state/deploy tests: 21 passed
- Rust tests and lint, static-assets smoke, vectors, formatting, and Markdown
  link audit: passed
- staging dry-run: existing `EVENTS`, `RepositoryDO`, and exact three staging R2
  bindings retained
- production dry-run: no Queue binding; existing `RepositoryDO` and exact three
  production R2 bindings retained
- bundle: 94.83 KiB, gzip 19.85 KiB
- local startup profile: active 12.5 ms, garbage collection 0.0 ms
- Markdown files checked: 107
- focused implementation: `apps/worker/src/sync-inventory.ts`
- focused tests: `apps/worker/test/sync-inventory.spec.ts`

The full repository gate and both named-environment dry-runs are green. Startup
timing is a local profile and is recorded as evidence, not an edge latency
claim.

## Non-effects and next gate

There is no HTTP route, schema migration, binding, secret, Cloudflare resource,
remote Worker version, Queue message, R2 operation, or production change. No
user Cloudflare action is required.

After the full local gate and ordinary CI, the next P5a increment should define
the external opaque cursor envelope and anonymous read adapter before adding
artifact-body transfer or local import.
