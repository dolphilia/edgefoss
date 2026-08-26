# P5b1b incremental public push plan local evidence

- Date: 2026-08-26
- Scope: deterministic resume along an existing public linear history
- Result: implementation, cross-runtime execution, full gate, named dry-runs,
  commit `c96ada8`, push, and ordinary GitHub Actions pass

## Implemented contract

[`push-v0`](../../spec/push-v0.md) and
[`ADR 0045`](../adr/0045-deterministic-linear-public-push-resume.md) define
`edgefossil-public-push-linear-v0`.

The Rust planner fully verifies the bundle, validates a bounded P5b0 snapshot,
and produces only the safe mutation suffix. It supports uninitialized and
ref-less partial state, a known ancestor head, and a fully converged empty plan.
It preserves the observed policy epoch and ref generation in deterministic
operation IDs. An unknown head returns `PushHeadConflict`; a missing object
reachable from the accepted prefix is rejected as an inconsistent snapshot.

## Cross-runtime evidence

The shared vector contains a signed two-change incremental bundle and the exact
one-change suffix plan.

- TypeScript deterministically regenerates both bundle bytes and the expected
  operation ID.
- Rust independently reproduces the exact suffix and identical retry plan.
- Rust covers resume after blob finalization, resume before the first ref,
  converged empty plan, unknown-head conflict, and accepted-prefix corruption.
- Workers runtime executes the existing fresh plan, observes sequence 3/ref
  generation 1, executes the incremental suffix with an exact retry, and reaches
  sequence 4/ref generation 2.

Focused Rust tests, clippy, and the Workers runtime vector test pass.

## Full verification

The final `pnpm check` passed:

- protocol: 9 files and 182 tests;
- Worker: 14 files and 46 tests;
- authentication and remote smoke helpers: 12 tests;
- cloud plan/state/deploy helpers: 6, 7, and 16 tests;
- Rust workspace tests and clippy with warnings denied;
- static asset smoke, 9 shared vector files, formatting, typechecks, and 126
  Markdown files with valid local links.

Wrangler 4.125.0 completed staging and production dry-runs at 147.42 KiB,
gzip 28.88 KiB.

- Staging retains RepositoryDO, the existing EVENTS Queue, three R2 buckets,
  and `EDGEFOSS_ENV=staging`.
- Production retains RepositoryDO, three R2 buckets,
  `EDGEFOSS_ENV=production`, and no Queue producer/consumer.

## Platform review and non-effects

Current official Workers and Durable Objects guidance was checked before the
change. Repository authority remains SQLite-backed Durable Object state; each
mutation still performs server-side policy, deduplication, object, and ref CAS
validation. The latest observed `@cloudflare/workers-types` version is
`5.20260826.1`; no platform type change was needed.

- RepositoryDO schema remains 5.
- No HTTP route, capability, binding, secret, or configuration changed.
- No remote R2 object, Queue event, artifact, ref, staging state, or production
  state changed.
- No user Cloudflare work is required.
- This does not authorize P5b2 HTTP exposure or P5b3 staging mutation.
