# P5b1a fresh public push plan local evidence

- Date: 2026-08-26
- Scope: verified local bundle to deterministic fresh-authority mutation plan
- Result: local implementation, cross-runtime execution, full gate, named
  dry-runs, commit `80dfc37`, push, and ordinary GitHub Actions pass

## Implemented contract

[`push-v0`](../../spec/push-v0.md) and
[`ADR 0044`](../adr/0044-deterministic-fresh-public-push-plan.md) define the
`edgefossil-public-push-fresh-v0` profile.

The Rust SQLite crate now:

- fully verifies the complete public portable bundle before planning;
- requires an exact fresh P5b0 snapshot with every bundled object missing;
- rejects more than 256 artifacts or blobs;
- orders blobs before genesis, child-before-parent trees, and oldest-first
  changes;
- assigns public `heads/main` expected generations starting at zero;
- references only exact verified bundle object paths;
- derives stable, domain-separated SHA-256 UUID-shaped operation IDs.

The profile intentionally rejects an existing project/ref, nonzero sequence or
policy epoch, and incomplete missing inventory. It is not an authority lease;
existing RepositoryDO validation, policy fencing, operation deduplication, and
ref CAS remain authoritative.

## Cross-runtime evidence

The shared [`public clone vector`](../../spec/vectors/public-clone-v0.json) now
contains `fresh_push_plan`.

- TypeScript regenerates the exact signed bundle, plan, byte sizes, paths, ref
  generation, and operation IDs.
- Rust independently verifies the TypeScript bundle and reproduces every plan
  field.
- Rust rejects a nonfresh sequence and an incomplete preflight inventory before
  producing mutations.
- Workers runtime executes the committed plan using the existing RepositoryDO
  upload and publish RPCs.
- begin-upload, finalize, and every artifact publication exact retry converge to
  the first result.
- final preflight reports no missing objects, accepted sequence 3, policy epoch
  0, and public ref generation 1 at the committed change.

The Workers test uses only local Durable Object, SQLite, R2, and Queue test
bindings. No Cloudflare account resource is contacted.

## Current platform review

The latest official Workers and Durable Objects guidance was retrieved before
implementation. The planner keeps request state out of global scope, calls the
existing Durable Object through its binding/RPC surface, and leaves strongly
consistent authority state in the SQLite-backed repository coordination atom:

- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Durable Object RPC](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/)

The latest published `@cloudflare/workers-types` observed on 2026-08-26 was
`5.20260826.1`. No platform type or binding change was required.

## Verification

Focused verification passed:

- deterministic vector regeneration;
- Rust `ef-store-sqlite` all-target tests, including two new push-vector tests;
- Rust clippy with warnings denied;
- Worker source/test typecheck;
- Workers runtime: 14 files and 46 tests.

The final `pnpm check` gate passed:

- protocol: 9 files, 182 tests;
- Worker: 14 files, 46 tests;
- auth/smoke: 12 tests;
- cloud plan/state/deploy: 6, 7, and 16 tests;
- Rust workspace tests, clippy, static smoke, all shared vectors, formatting,
  typechecks, and 124 Markdown files/links passed.

## Named dry-runs

Wrangler 4.125.0 completed staging and production dry-runs at 147.42 KiB,
gzip 28.88 KiB.

- Staging retains RepositoryDO, the existing EVENTS Queue, three existing R2
  buckets, and `EDGEFOSS_ENV=staging`.
- Production retains RepositoryDO, three existing R2 buckets,
  `EDGEFOSS_ENV=production`, and no Queue producer/consumer.

## Non-effects and next gate

- RepositoryDO schema remains 5.
- No Worker route, capability, secret, binding, or configuration changed.
- No remote R2 object, Queue event, artifact, ref, staging state, or production
  state changed.
- No user Cloudflare work is required.
- P5b1b must separately define existing-head ancestry, partial completion,
  response-loss resume, and stable conflict behavior.
- This evidence does not authorize an authenticated HTTP adapter or remote
  staging push.
