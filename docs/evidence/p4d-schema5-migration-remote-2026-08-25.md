# P4d schema 5 migration remote evidence — 2026-08-25

- Increment: transactional authority outbox schema migration
- Deployed commit: `5bea40e31a547e03508b78d018ec28e4d064e58d`
- Environment: `edgefoss-staging`
- Workflow ref: `main`
- Result: deploy and exact stateful health pass

## Account-owner observation

The account owner ran the manual main-only `Deploy staging Worker` workflow
after the P4d outbox core passed normal GitHub Actions and reported:

```text
deploy: success
stateful health: pass
repository schemaVersion: 5
3 R2 binding: bound
remote artifact publish: not performed
new R2 write: not performed
Queue producer: not added
Queue consumer: not added
```

This is the planned schema 4-to-5 migration-only gate for ADR-0032. It adds the
strict `authority_outbox` and `authority_event_deliveries` tables to the fixed
Single Edition `RepositoryDO`. The migration deliberately does not synthesize
outbox events for the three repository sequences accepted during P4c.

## State deliberately unchanged

- no project genesis, tree, change, receipt, ref, or operation was added;
- no public or restricted R2 object was written;
- neither the staging events Queue nor its DLQ was bound to the Worker;
- no Queue producer send, consumer delivery, retry, or DLQ effect occurred;
- production remained unchanged.

The health contract still traverses the Worker-to-DO RPC boundary and now
requires application schema version 5 while retaining the exact three R2
binding assertions.

## Gate result and next boundary

The canonical authority can now persist future event handoffs transactionally,
but remote asynchronous delivery remains disabled. Before adding the staging
Queue producer or consumer, implement and locally verify a bounded owner-only
delivery observation contract and a remote smoke that can distinguish pending,
enqueued, delivered, retried, and DLQ outcomes without exposing event payloads.

Queue activation must remain a separate committed increment with normal CI,
staging dry-run review, explicit account-owner effect approval, and a narrowly
scoped remote smoke. No new Cloudflare resource or credential is required; the
approved staging Queue and DLQ already exist.
