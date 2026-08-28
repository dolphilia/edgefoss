# P5c0 linear public reconciliation local evidence

- Date: 2026-08-27
- Scope: transactional local pull direction and two-head classification
- Result: local implementation complete; ordinary CI pending

## Implemented boundary

[`ADR 0048`](../adr/0048-transactional-linear-public-reconciliation.md) and the
[`linear reconciliation profile`](../../spec/sync-v0.md) define the first P5c
increment.

`LocalRepository::reconcile_public_bundle` verifies a complete public bundle
before mutation and compares exact linear `heads/main` histories. Equal input
is an idempotent no-op, a remote descendant is a transactional fast-forward, a
remote ancestor reports `LocalAhead`, and siblings produce
`SyncHeadConflict`. Existing tracking rules and working snapshots remain local.

The fast-forward inserts only the verified suffix, advances the ref with its
exact prior target/generation, and reconstructs the entire accepted public
bundle before commit. It does not select a conflict winner.

## Focused verification

The `ef-store-sqlite` tests prove:

- the committed cross-runtime one-change bundle advances to the committed
  two-change bundle and re-exports the exact object map;
- exact replay returns `AlreadyCurrent` at generation 2;
- the inverse direction returns `LocalAhead` and preserves generation 2;
- two independently signed sibling changes remain a non-mutating conflict;
- an injected signature insertion failure leaves the base bundle exact and a
  retry after fault removal fast-forwards successfully.

Focused Rust tests and Clippy with warnings denied pass. The full `pnpm check`
gate also passes:

- protocol: 9 files and 182 tests;
- Worker: 15 files and 50 tests;
- authentication/smoke helpers: 18 tests;
- cloud plan/state/deploy helpers: 6, 7, and 22 tests;
- Rust workspace tests and Clippy with warnings denied, including 25 local
  store unit cases plus 4 public-clone and 5 public-push vector cases;
- static asset smoke, 9 shared vector files, formatting, typechecks, and 135
  Markdown files with valid local links.

Wrangler 4.125.0 completed both named dry-runs at 150.23 KiB, gzip 29.21 KiB.
Staging retained RepositoryDO, EVENTS Queue, three R2 bindings, and
`EDGEFOSS_ENV=staging`. Production retained RepositoryDO, three R2 bindings,
no Queue binding, and `EDGEFOSS_ENV=production`. Both commands exited at
`--dry-run`; neither deployed a Worker.

## Cloud and security non-effects

- No Worker source, route, Durable Object schema, binding, Queue/R2 behavior,
  secret, resource manifest, staging, or production state changed.
- No command contacted Cloudflare.
- No owner action or credential is required for P5c0.
- This evidence does not claim cursor persistence, interrupted HTTP resume,
  partial clone, members reconciliation, automatic merge, or G5 completion.

## Next gate

Commit the local increment and pass ordinary GitHub Actions. P5c1 may then add
durable client-side transfer progress and deterministic disconnect recovery
without changing remote state unless its own reviewed adapter requires it.
