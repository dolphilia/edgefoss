# ADR-0033: Observe outbox delivery without exposing authority events

- Status: Accepted for P4d
- Date: 2026-08-25
- Owners: cloud and security leads
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

Schema 5 can transactionally persist authority events and the local runtime can
drain them through a Queue. Before staging receives a producer or consumer, the
account owner needs a deterministic way to decide whether one event remained
pending, reached Queue storage, or was accepted by the idempotent consumer.

Workers Logs are useful diagnostics but are sampled operational data, not a
stable smoke contract. Returning the stored event JSON would also expose an
artifact identifier and potentially a restricted realm identifier over HTTP.
Queue delivery is at least once, so observing a send is not evidence that the
consumer has converged.

## Decision

Add an owner-authenticated, read-only endpoint:

```text
GET /api/v0/outbox/<positive repository sequence>
```

The smoke also uses an owner-authenticated preflight:

```text
POST /api/v0/outbox/<positive repository sequence>/match
body: { "artifactId": "sha256:..." }
```

The artifact ID stays in the bounded request body rather than the URL or log
fields. The response returns only `exists`, `matches`, and the sequence; it
never echoes the identifier. A different artifact at sequence 4 stops the
smoke before publication, preventing an accidental sequence 5 write.

Authentication runs before path or method details are returned. The response
is bounded JSON with `Cache-Control: no-store` and contains only:

- aggregate pending, enqueued, and delivered row counts;
- the requested repository sequence;
- `pending`, `enqueued`, or `delivered` phase;
- Queue send attempt count;
- last send-attempt, enqueue, and delivery timestamps.

It never returns event JSON, event ID, artifact ID, realm, ref, path, content,
principal, token, or R2 key. A sequence without an outbox row returns `event:
null`; this supports an idempotent preflight and also represents the deliberate
absence of historical backfill for P4c sequences 1–3.

The aggregate counts are not mutually exclusive lifecycle buckets:
`delivered` rows remain retained as `enqueued` outbox rows. The requested
event's `phase` is the authoritative lifecycle projection.

Add a deterministic `cloud:smoke-queue` command, but do not run it until the
staging Queue producer and consumer are separately approved and deployed. The
command:

1. requires the exact approved staging origin and the existing owner token from
   the process environment;
2. verifies health schema 5 and reads sequence 4 observation;
3. verifies that an existing sequence 4 is absent or matches this exact fixture;
4. publishes one deterministic public tree as sequence 4 using the existing
   synthetic actor and existing 30-byte public blob;
5. repeats the same operation and requires an identical stored result;
6. polls the owner-only observation until sequence 4 is `delivered`;
7. reports only phase, sequence, realm, send attempts, retry convergence, and
   the fact that no new R2 write was performed.

The tree does not move `heads/main`, add a blob, or touch members data. Running
the smoke does permanently add one public tree, receipt, operation, outbox row,
and delivery receipt, so it requires explicit account-owner effect approval.

## Retry and DLQ judgement boundary

- `pending` with increasing `sendAttempts` proves producer send failure and
  alarm recovery attempts.
- `enqueued` proves Queue accepted the message, but does not prove consumer
  delivery.
- `delivered` proves the known event reached the idempotent consumer boundary.
- a prolonged `enqueued` phase alone cannot distinguish consumer retry,
  service outage, delayed delivery, or eventual DLQ transfer.

The smoke therefore fails rather than inferring success from `enqueued`. Remote
DLQ failure injection remains blocked until a separate bounded DLQ receipt or
read-only Queue inspection contract can prove the outcome. The first Queue
activation may prove only the successful delivery path; it does not complete
the P4d retry/DLQ failure matrix.

## Configuration boundary

This increment does not add a staging or production Queue binding or consumer.
The observation adapter may be deployed first while schema remains 5. The
single-event smoke must not be run during that adapter deployment gate.

## Verification

- unauthenticated observation is rejected before DO access;
- only `GET` is accepted and invalid paths stay bounded;
- a missing sequence returns `event: null`;
- artifact matching never echoes the supplied artifact ID;
- a different sequence 4 artifact stops the smoke before publish;
- failed sends expose attempt progress without event payload;
- enqueued and delivered phases are distinct;
- HTTP output contains neither artifact ID nor owner token;
- the deterministic smoke performs two identical publish requests but creates
  one sequence 4 event;
- the smoke rejects `enqueued` as an incomplete result;
- named staging and production dry-runs still contain no Queue binding or
  consumer.

## Current platform references

- [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Queue batching, retries, and delays](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- [Dead Letter Queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)
- [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
