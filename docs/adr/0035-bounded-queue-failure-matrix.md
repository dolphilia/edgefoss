# ADR-0035: Separate the application failure matrix from managed DLQ transfer

- Status: Accepted for P4d
- Date: 2026-08-25
- Owners: reliability and security leads
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

The staging success-path smoke proved one schema 5 authority event can move from
the transactional outbox through a Durable Object alarm, Queue producer, Queue
storage, consumer, and delivery observation. That does not prove behavior when
producer acknowledgement is lost, messages are duplicated or reordered, or a
consumer rejects an invalid message.

Cloudflare Queues provides at-least-once delivery and does not guarantee
ordering. The Worker chooses individual acknowledgement or retry, while
Cloudflare applies `max_retries` and moves an exhausted message to the configured
DLQ. The Workers Vitest helpers expose the handler's explicit ack/retry result;
they do not claim to reproduce the managed service's DLQ storage transition.

## Decision

Keep the P4d failure matrix local and divide it into two contracts.

The application contract runs inside the Workers runtime and proves:

1. producer failure before acceptance leaves the event pending and recoverable;
2. response loss after Queue acceptance may deliver while the outbox remains
   pending, and a later alarm resend converges to one delivery record;
3. duplicate delivery is acknowledged without a second delivery or canonical
   side effect;
4. out-of-order known events are independently accepted;
5. an invalid or unknown event is individually retried without forcing valid
   messages in the same batch to retry;
6. invalid body fields and identifiers are not copied into structured logs;
7. canonical artifact, operation, receipt, ref, and R2 state do not change
   during the harness.

The platform contract is pinned by the reviewed manifest and Wrangler config:

- `max_retries` is 3, meaning an initial delivery plus up to three retries;
- exhausted delivery targets `edgefoss-staging-events-dlq`;
- production remains disconnected;
- the handler returns an explicit retry through the fourth invalid attempt;
- the local test calls the transition "retry requested", not "DLQ delivered".

The Queue handler accepts `Message<unknown>` and validates the exact authority
event before calling the Durable Object. Its extracted message function returns
only an internal acknowledgement classification and logs the queue name,
attempt count, and bounded error code without the message body or event ID.

## Remote failure-injection decision

Do not pause or purge the staging Queue, remove its consumer, or send a poison
message merely to re-test Cloudflare's managed DLQ promise. Those operations
would introduce avoidable availability changes or retained untrusted data while
adding little evidence about EdgeFoss's own invariants.

A future operational exercise may test real DLQ transfer only if it first adds a
bounded, read-only observation mechanism, a cleanup plan, and a separate effect
approval. Until then, an `enqueued` event or repeated retries must never be
reported as observed DLQ delivery.

## Consequences

- The application-controlled P4d failure matrix can be deterministic and free
  of remote canonical writes.
- Queue response loss is treated as the expected source of duplicate sends,
  not as evidence of data corruption.
- One invalid message does not cause already accepted neighbors to be retried.
- Actual managed DLQ transfer remains a platform/configuration assertion rather
  than a remote test result, and the evidence states this limitation directly.

## Verification

- Workers Vitest executes the response-loss, recovery, duplicate, reorder,
  mixed-batch, invalid-body, and retry-budget cases;
- storage assertions show zero canonical artifact/operation/receipt rows in the
  synthetic response-loss harness;
- the config/manifest test pins retry 3 and the exact DLQ name;
- staging and production dry-runs preserve their current isolation;
- no remote Worker, Queue, Durable Object, or R2 mutation occurs.

## Current platform references

- [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [How Queues works](https://developers.cloudflare.com/queues/reference/how-queues-works/)
- [Batching, retries, and delays](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- [Dead Letter Queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)
- [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Workers Vitest test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/)
