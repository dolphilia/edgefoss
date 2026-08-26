# P5b2 authenticated public push adapter local evidence

- Date: 2026-08-26
- Scope: bounded owner-authenticated HTTP preflight and existing mutation API
  composition
- Result: implementation, focused tests, full gate, named dry-runs, commit
  `fdfe87b`, push, and ordinary GitHub Actions pass; account-owner staging
  exposure approval received; approval-record commit and manual deploy remain
  pending

## Implemented HTTP contract

[`push-v0`](../../spec/push-v0.md) and
[`ADR 0046`](../adr/0046-owner-authenticated-public-push-preflight-adapter.md)
define `POST /api/v0/sync/push/preflight`.

- The existing owner bearer token is authenticated before body consumption.
- The request is exact-key `application/json`, limited to 65,536 bytes, protocol
  0/public, and 256 sorted unique canonical artifact and blob IDs each.
- The Worker injects the owner principal and calls RepositoryDO by RPC.
- Success is HTTP 200; project conflict is HTTP 409 without inventory or project
  disclosure; malformed input is HTTP 400; all responses are `no-store`.
- Preflight is read-only and grants no lease. Existing upload/finalize and
  artifact/ref publication endpoints remain the mutation boundaries.
- Anonymous public `HELLO` is unchanged.
- The manual staging workflow runs a credential-free audit that submits invalid
  JSON and requires the exact owner HTTP 401 before parsing. It performs no
  authenticated preflight or mutation.
- A separate operator audit reads the owner token only from the environment,
  obtains the project through anonymous HELLO, and submits empty inventories.
  It validates and reports the snapshot without logging the token or writing.

## Focused cross-runtime evidence

The committed two-change vector executes entirely through Worker HTTP routes:

1. fresh authenticated preflight returns all objects missing and null project/ref;
2. blob declaration, content, and finalization complete with exact retries;
3. genesis, tree, and first change/ref publish with exact retries;
4. incremental preflight reports sequence 3 and ref generation 1;
5. the one-change suffix publishes with an exact retry;
6. final preflight reports no missing objects, sequence 4, and ref generation 2;
7. a different project returns only HTTP 409 `project_conflict`.

Focused Worker typecheck and six push/preflight tests pass. Authentication-before-
parsing, method, media type, declared body size, exact keys, and canonical ID
ordering are covered.

## Full verification

The final `pnpm check` passed:

- protocol: 9 files and 182 tests;
- Worker: 15 files and 50 tests;
- authentication and remote smoke helpers: 12 tests;
- cloud plan/state/deploy helpers: 6, 7, and 22 tests;
- Rust workspace tests and clippy with warnings denied;
- static asset smoke, 9 shared vector files, formatting, typechecks, and 128
  Markdown files with valid local links.

Wrangler 4.125.0 completed staging and production dry-runs at 150.23 KiB,
gzip 29.21 KiB.

- Staging retains RepositoryDO, the existing EVENTS Queue, three R2 buckets,
  and `EDGEFOSS_ENV=staging`.
- Production retains RepositoryDO, three R2 buckets,
  `EDGEFOSS_ENV=production`, and no Queue producer/consumer.

## Platform review and non-effects

Current official Workers and Durable Objects guidance was checked before the
change. Request state remains local to each fetch, body reading is bounded,
authentication uses the existing timing-safe comparison, and RepositoryDO is
called through its binding/RPC surface. The latest observed
`@cloudflare/workers-types` is `5.20260826.1`.

- RepositoryDO schema remains 5.
- No binding, secret, Queue/R2 configuration, or production configuration changed.
- No remote Worker, artifact, blob, ref, R2 object, Queue event, staging state,
  or production state changed.
- No new user credential or Cloudflare resource is required.
- This evidence does not authorize staging deployment or P5b3 remote mutation.

## Remaining gates

- commit, push, and ordinary GitHub Actions confirmation for the approval record;
- one main-only manual staging deployment;
- automatic credential-free HTTP 401 boundary audit;
- operator read-only authenticated empty-inventory preflight audit.

The 2026-08-26 approval covers only exposing the owner-authenticated route, the
automatic unauthenticated HTTP 401 audit, and the operator's read-only
preflight. It does not authorize artifact/blob/ref/R2/Queue mutation or any
production change.
