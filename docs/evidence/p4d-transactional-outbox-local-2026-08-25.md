# P4d transactional authority outbox local evidence — 2026-08-25

- Increment: schema 5 outbox, bounded DO alarm drain, and idempotent consumer core
- Base commit: `6a89b89`
- Environment: local Workers runtime only
- Remote mutation: none
- Result: focused implementation verification pass

## Implemented boundary

Schema 5 adds strict authority outbox and consumer delivery tables. Each new
canonical repository sequence inserts one immutable JSON event in the same
`transactionSync()` as artifact/ref/receipt/operation state. Existing P4c rows
are not backfilled. The outbox event contains only stable authority, artifact,
realm, policy, ref, and repository-sequence fields.

The DO alarm reads at most ten pending rows, records an attempt, sends a JSON
batch through the Queue binding, and marks rows enqueued only after the send
promise confirms Queue storage. Send failure leaves rows pending. The handler
always rearms after failure and rearms promptly when more than ten rows remain.

The Queue handler validates the exact event and its stored outbox identity,
records delivery idempotently, and explicitly acknowledges accepted and
duplicate messages. Unknown messages are explicitly retried with delay.

Only the default local environment has an `EVENTS` producer binding. Staging
and production have no producer or consumer entry, so this implementation does
not authorize a remote Queue change.

## Focused verification

```text
pnpm --filter @edgefoss/worker typecheck
  pass

pnpm --filter @edgefoss/worker test
  4 files, 20 tests pass

pnpm check
  pass; protocol 182 tests, Worker 20 tests, Node/Rust/static/lint/vectors/docs green

pnpm build
  pass; Worker 79.34 KiB / gzip 17.33 KiB; local dev EVENTS producer shown

pnpm --filter @edgefoss/worker check:startup
  pass; local active CPU 1.3 ms, 0.0 ms garbage collection

pnpm exec wrangler deploy --dry-run --env staging --config apps/worker/wrangler.jsonc
  pass without warnings; RepositoryDO and exact 3 R2 bindings only;
  no Queue producer or consumer
```

The outbox tests prove one row across exact publication replay, failed-send
retention followed by successful recovery, attempt accounting, bounded 10+1
alarm drain, local Queue producer send, explicit consumer ack, duplicate
delivery convergence, and unknown-event retry.

The implementation was reviewed against the Cloudflare Workers best-practices
page, Durable Object alarms and rules, Queues JavaScript API, batching/retry,
DLQ documentation, Wrangler 4.125.0 schema, and
`@cloudflare/workers-types` 5.20260825.1. Queue messages are bounded plain JSON;
all external I/O is awaited and remains outside synchronous SQLite
transactions.

## Next gate

The full local check, build, startup profile, and staging dry-run are complete.
After commit and normal CI success, manually deploy only the schema 4-to-5
migration and require stateful health schema 5. Do not publish another artifact,
run either historical smoke, or add a staging Queue producer/consumer. Queue
must remain absent from the named staging binding report.
