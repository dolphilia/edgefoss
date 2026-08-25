# ADR-0034: Activate the first Queue path in staging as one reviewed unit

- Status: Accepted for P4d
- Date: 2026-08-25
- Owners: cloud and reliability leads
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

The schema 5 transactional outbox, bounded Durable Object alarm drain,
idempotent Queue consumer, owner-only delivery observation, and deterministic
single-event smoke have passed their local gates. The observation adapter has
also been deployed without a Queue binding and rejects unauthenticated access.

The first remote Queue activation must be reviewable before it can cause a
message or canonical write. Enabling only the producer would leave a sequence 4
event in `enqueued` without proving delivery. Enabling only the consumer would
not exercise the outbox alarm. Production must remain disconnected.

## Decision

Declare the staging producer and consumer together in the named staging
Wrangler environment:

- producer binding: `EVENTS`;
- Queue: `edgefoss-staging-events`;
- consumer Worker: `edgefoss-staging`;
- maximum batch size: 10;
- maximum batch timeout: 5 seconds;
- maximum retries: 3;
- dead-letter Queue: `edgefoss-staging-events-dlq`.

These values exactly match the already reviewed cloud resource manifest. The
production environment continues to declare empty producer and consumer lists.
The Queue handler continues to acknowledge only a validated event that matches
the authority outbox; invalid or unknown messages are explicitly retried.

The configuration change first passes ordinary CI, generated binding type
checks, and named staging and production dry-runs. A remote staging deploy is a
separate gate. Deploying the binding itself should not create a canonical
artifact, an outbox row, a Queue message, or an R2 object because schema 5 did
not backfill sequences 1–3 and no pending outbox row exists.

After deploy and health verification, the account owner must separately approve
the permanent deterministic smoke effect before running `cloud:smoke-queue`.
Only `delivered` is success. `enqueued` is incomplete and is not evidence of a
DLQ transfer.

## Rollback boundary

If deploy or health fails, redeploy the preceding configuration with both
staging Queue lists empty. If the smoke remains `pending` or `enqueued`, do not
publish another artifact and do not infer DLQ success. Preserve observation
data for diagnosis and disable both sides together only after recording the
phase and send-attempt count.

## Consequences

- The first success-path smoke can exercise alarm, producer, Queue storage,
  consumer, and idempotent delivery as one bounded path.
- Staging deployment gains a Queue trigger even before the smoke is approved,
  but has no expected message to consume.
- The P4d retry/DLQ failure matrix remains incomplete after the success-path
  smoke and needs a separately observable failure-injection design.

## Verification

- the generated staging environment type includes `EVENTS: Queue`;
- staging dry-run lists exactly one Queue producer and one Queue consumer;
- production dry-run lists neither;
- all existing outbox and Queue runtime tests remain green;
- no remote deploy or smoke occurs in this local increment.

## Current platform references

- [Queue configuration](https://developers.cloudflare.com/queues/configuration/configure-queues/)
- [Queue batching, retries, and delays](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- [Dead Letter Queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)
- [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
