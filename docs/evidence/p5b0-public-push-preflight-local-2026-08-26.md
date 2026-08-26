# P5b0 bounded public push preflight local evidence

- Date: 2026-08-26
- Scope: local implementation and non-deploying configuration validation
- Result: implementation, focused tests, full local gate, and both named
  dry-runs pass; commit, push, and ordinary GitHub Actions remain pending

## Implemented boundary

[`ADR 0043`](../adr/0043-bounded-internal-public-push-preflight.md) is
implemented as a RepositoryDO internal RPC. It accepts only owner protocol 0
public input and sorted, unique inventories bounded to 256 artifact IDs and 256
blob IDs.

One synchronous SQLite transaction returns the missing artifact/finalized-blob
subsets and the current project, policy epoch, accepted sequence, and public
head generation. Another project returns only `project_conflict`. Invalid
inventories return the stable `push_preflight_invalid` result. The result is an
observation, not a ref reservation or policy lease.

There is no HTTP route or capability advertisement. RepositoryDO remains the
single-project authority and uses its existing SQLite storage. This follows the
current Cloudflare guidance to use bindings rather than REST calls, avoid
request-scoped global state, use SQLite-backed Durable Objects, and keep one
Durable Object as the atom of coordination:

- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [SQLite-backed Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

## Verification

Focused Worker verification passed:

- TypeScript source and test typechecks passed.
- Workers runtime: 13 files and 45 tests passed, including three P5b0 tests.
- empty authority returns all requested IDs missing and null project/ref;
- finalized/public accepted objects disappear from the missing subsets;
- snapshot sequence 3, policy epoch 0, and public ref generation 1 match the
  canonical genesis/tree/change fixture;
- exact retry returns the same result;
- project mismatch discloses no inventory;
- duplicate, unsorted, malformed, and 257-item inventories are rejected.

The full `pnpm check` gate passed after this evidence file was added:

- protocol: 9 files, 182 tests;
- Worker: 13 files, 45 tests;
- auth/smoke: 12 tests;
- cloud plan/state/deploy: 6, 7, and 16 tests;
- Rust workspace tests, clippy with warnings denied, static assets smoke,
  9 shared vector files, bundle vector, public clone vector, formatting,
  typechecks, and documentation links all passed.

## Named dry-runs

Wrangler 4.125.0 completed both non-deploying builds at 147.42 KiB, gzip
28.88 KiB.

Staging bindings remain:

- `REPOSITORY` → `RepositoryDO`;
- `EVENTS` → `edgefoss-staging-events`;
- the existing staging public, restricted, and export R2 buckets;
- `EDGEFOSS_ENV=staging`.

Production bindings remain:

- `REPOSITORY` → `RepositoryDO`;
- the existing production public, restricted, and export R2 buckets;
- `EDGEFOSS_ENV=production`;
- no Queue producer or consumer.

## Non-effects and next gate

- RepositoryDO schema remains 5.
- No HTTP route, secret, binding, Queue configuration, or R2 object changed.
- No staging or production deployment or remote request was performed.
- No user Cloudflare work is required for P5b0.
- P5b1 must construct a bounded mutation plan from a verified local bundle.
- Any later authenticated adapter and staging mutation require their own review;
  this evidence does not authorize either.
