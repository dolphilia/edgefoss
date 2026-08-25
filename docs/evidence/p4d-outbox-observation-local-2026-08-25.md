# P4d outbox observation local evidence — 2026-08-25

- Increment: owner-only observation and deterministic single-event smoke
- Base commit: `a34d6a4`
- Environment: local runtime and dry-run only
- Remote mutation: none
- Result: full local gate pass

## Implemented boundary

The Worker exposes a read-only owner-authenticated observation for one positive
repository sequence. It returns aggregate counts and a bounded lifecycle record
with only sequence, phase, send attempts, and timestamps. It does not serialize
the stored authority event, artifact ID, realm, ref, path, content, principal,
token, or R2 key.

A separate bounded owner-only POST compares a body-supplied artifact ID with a
stored outbox event and returns only `exists`/`matches`. It keeps the identifier
out of URLs and responses. The Queue smoke uses this preflight to stop before
publication if sequence 4 belongs to another artifact.

The deterministic Queue smoke prepares exactly one new public tree at staging
repository sequence 4, repeats the same operation for convergence, and waits
for a `delivered` observation. It reuses the P4c synthetic actor and existing
public blob, does not advance a ref, and performs no R2 write. The command is
implemented and tested but was not run against staging.

Named staging and production Queue configuration remains empty. This increment
does not add a producer, consumer, DLQ consumer, Queue message, artifact, or R2
object remotely.

## Judgement limits

Observation distinguishes producer `pending`, Queue-accepted `enqueued`, and
consumer-confirmed `delivered`. Multiple send attempts are visible. An
undelivered enqueued row does not reveal whether Cloudflare is retrying it or
has moved it to a DLQ, so the smoke deliberately fails on that state. Remote
DLQ failure injection remains outside this increment.

## Verification

```text
pnpm check
  pass
  protocol: 9 files, 182 tests
  Worker: 4 files, 21 tests
  auth/smoke: 12 tests, including 5 Queue smoke tests
  cloud plan/state/deploy, Rust, static, vectors, and docs: pass

pnpm build
  pass
  Worker: 83.83 KiB / gzip 17.93 KiB

pnpm --filter @edgefoss/worker check:startup
  pass
  local active CPU: 7.7 ms, garbage collection: 0.0 ms

pnpm exec wrangler deploy --dry-run --env staging ...
  pass
  RepositoryDO, exact 3 R2 bindings, and staging variable only
  no Queue producer or consumer

pnpm exec wrangler deploy --dry-run --env production ...
  pass
  RepositoryDO, exact 3 R2 bindings, and production variable only
  no Queue producer or consumer

pnpm docs:check
  95 Markdown files; local links valid

git diff --check
  pass
```

The implementation was reviewed against Cloudflare's current Queues delivery,
batching/retry, DLQ, Durable Object alarm, Workers Logs, and Wrangler
configuration documentation. Queue and message signatures match
`@cloudflare/workers-types` 5.20260825.1, and Queue configuration fields match
Wrangler 4.125.0's bundled schema.

## Next gate

After commit and normal CI success, deploy only the observation adapter while
keeping schema 5 and both named environment Queue lists empty. Verify stateful
health and an unauthenticated HTTP 401 probe. Do not run `cloud:smoke-queue` or
publish sequence 4 during that gate.
