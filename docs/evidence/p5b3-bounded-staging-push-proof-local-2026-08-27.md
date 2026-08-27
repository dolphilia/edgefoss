# P5b3 bounded staging push proof local evidence

- Date: 2026-08-27
- Scope: reentrant operator smoke for one deterministic staging fast-forward,
  exact retries, stale-ref conflict, and Queue delivery
- Result: local implementation, commit `ca3d1fd`, ordinary CI, and explicit
  remote-effects approval pass; approval-record commit/CI remains pending

## Implemented boundary

[`ADR 0047`](../adr/0047-bounded-reentrant-staging-push-proof.md) fixes the
first remote proof to the existing deterministic staging fixture.

- The command accepts only the exact staging HTTPS origin and an owner token
  matching the existing non-secret shape. The token is read only from the
  environment, placed only in Authorization headers, and never returned.
- It deterministically reconstructs the project, existing tree, generation-1
  head, one intended child change, one stale sibling, their signatures, and
  their `edgefoss:push-operation:v0` IDs.
- Before publication it accepts only sequence 4/ref generation 1 with both new
  artifacts missing, or exact sequence 5/ref generation 2 convergence with the
  stale sibling still missing. Sequence-5 outbox ownership must agree.
- It sends the intended publication twice and requires identical accepted
  sequence-5/generation-2 results.
- It sends the stale sibling twice and requires identical HTTP 409
  `ref_conflict` results. Final preflight proves that sibling was not accepted.
- It verifies the sequence-5 event belongs to the intended artifact and waits
  for Queue delivery.
- It never calls an upload endpoint. The accepted change reuses the existing
  public tree/blob, so no R2 write is needed.

The same command is safe after an uncertain accepted response: exact converged
state is recognized, both operation results are replayed, and no additional
sequence, ref generation, artifact, or event is created. Any other state stops
before mutation.

## Local verification

The focused authentication/smoke suite passed 18 tests. Six are specific to
P5b3 and cover:

- direct and pnpm CLI argument forms plus target rejection;
- token rejection before fetch;
- fixed fixture artifact and operation IDs;
- first fast-forward, accepted retry, stale conflict retry, and no upload call;
- already-converged response-loss resumption;
- unexpected-state abort before publication.

The exact documented pnpm command form was also run with the owner token
deliberately absent. Argument parsing succeeded and the command stopped at the
local token-shape guard before fixture construction or fetch.

The final `pnpm check` passed:

- protocol: 9 files and 182 tests;
- Worker: 15 files and 50 tests;
- authentication/smoke helpers: 18 tests;
- cloud plan/state/deploy helpers: 6, 7, and 22 tests;
- Rust workspace tests and clippy with warnings denied;
- static asset smoke, 9 shared vector files, formatting, typechecks, and 132
  Markdown files with valid local links.

Wrangler 4.125.0 completed staging and production dry-runs at 150.23 KiB,
gzip 29.21 KiB. Staging retained RepositoryDO, EVENTS Queue, three R2 bindings,
and `EDGEFOSS_ENV=staging`. Production retained RepositoryDO, three R2
bindings, no Queue binding, and `EDGEFOSS_ENV=production`.

## Platform review and non-effects

Current [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/),
[Durable Objects storage guidance](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/),
and the SQLite-backed Durable Object API were reviewed. The latest observed
`@cloudflare/workers-types` is `5.20260826.1`.

The existing authority performs ref comparison, artifact/ref acceptance,
receipt, sequence allocation, and outbox insertion inside one synchronous
SQLite transaction. A stale generation stores only its idempotent conflict
result before artifact/ref/sequence/outbox mutation. The smoke uses bounded
responses, awaits every request, and keeps request state local.

- No Worker source, route, schema, binding, secret, or cloud configuration
  changed.
- No local command contacted staging or production.
- No artifact, ref, R2 object, Queue event, members state, or production state
  changed.
- No new credential or Cloudflare resource is required.

## Remaining gates

The local implementation was committed as `ca3d1fd`, pushed, and passed
ordinary GitHub Actions. On 2026-08-27, the account owner explicitly approved
the exact permanent staging effects, including the accepted and stale-conflict
operation records.

1. The approval record must itself be committed and pass ordinary CI.
2. Only then may the owner run `cloud:smoke-public-push` once with the existing
   token supplied from the local environment.

This evidence does not authorize remote mutation.
