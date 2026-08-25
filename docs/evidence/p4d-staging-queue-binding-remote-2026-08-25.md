# P4d staging Queue binding remote evidence — 2026-08-25

- Increment: first staging Queue producer and consumer deployment
- Target Worker: `edgefoss-staging`
- Workflow ref: `main`
- Result: deploy and stateful health passed

## Deployed Queue contract

The manual main-only staging workflow deployed the reviewed Queue topology:

- `EVENTS` producer: `edgefoss-staging-events`;
- consumer Worker: `edgefoss-staging`;
- maximum batch size: 10;
- maximum batch timeout: 5 seconds;
- maximum retries: 3;
- dead-letter Queue: `edgefoss-staging-events-dlq`.

The repository remained on schema 5. Production stayed unchanged and retains
no Queue producer or consumer.

## Read-only no-effect observation

After deployment, the account owner made an authenticated, read-only
`GET /api/v0/outbox/4`. It returned HTTP 200 with no sequence 4 event and these
aggregate counts:

```text
pending=0, enqueued=0, delivered=0
```

This confirms that adding the bindings did not create an artifact, outbox row,
Queue message, or delivery record. The three R2 bindings remained unchanged and
no new R2 write was performed. The owner token value was not shared.

## Gate boundary

`cloud:smoke-queue` was not run. This remote evidence must be committed and pass
ordinary CI before requesting account-owner approval for the deterministic
sequence 4 smoke. Running that smoke will permanently add one public tree,
receipt, operation, outbox row, and delivery record. It will not move a ref or
write a new R2 object. Only a final `delivered` observation is success; an
`enqueued` result remains incomplete and does not prove DLQ behavior.
