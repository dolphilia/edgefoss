# ADR-0032: Persist authority events transactionally and drain them with bounded alarms

- Status: Accepted for P4d
- Date: 2026-08-25
- Owners: cloud and protocol leads
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

P4c proved canonical publication, receipt ordering, ref CAS, and exact operation
replay. Derived projections and other asynchronous consumers must observe those
accepted changes without making Queue availability part of the canonical write
path. Directly sending to Queue inside the publication transaction is
impossible because Queue I/O is asynchronous; sending after commit without a
durable handoff can lose an event if the Worker terminates between the two.

Cloudflare Queues delivers at least once. Durable Object alarms also execute at
least once, automatically retry failures a bounded number of times, and provide
only one scheduled alarm per object. The design therefore must tolerate both a
duplicate Queue send and duplicate consumer delivery, and it must explicitly
rearm after downstream outages rather than relying only on alarm auto-retries.

## Decision

RepositoryDO application schema 5 adds two strict tables:

- `authority_outbox`: one immutable JSON event per new repository sequence,
  with `pending`/`enqueued`, attempt count, and timestamps;
- `authority_event_deliveries`: one idempotent consumer receipt per event and
  repository sequence.

Every new accepted canonical sequence inserts an
`edgefoss-authority-event-v0` row in the same synchronous SQLite transaction as
the artifact/ref/receipt/operation result. Operation replay and acceptance of
an already-present artifact without a new ref sequence create no extra event.
Schema migration does not synthesize events for the three historical P4c
staging sequences.

After an accepted response is committed, the DO schedules an alarm only when a
Queue producer binding exists and pending work is present. Alarm work follows
this order:

```text
select at most 10 pending events by repo sequence
  -> transactionally increment attempts
  -> Queue.sendBatch using JSON messages
  -> after send confirms durable Queue storage, mark the batch enqueued
  -> rearm shortly if pending rows remain
```

If send fails, rows stay pending and the handler sets a new alarm using bounded
exponential delay before returning. A crash after Queue acceptance but before
the `enqueued` update can resend an event; the stable event ID makes that safe.

The Queue handler validates the exact event contract, records only events that
match an existing outbox row, and explicitly acknowledges accepted or duplicate
deliveries. Invalid or unknown events receive an explicit delayed retry so the
future configured retry limit and DLQ can isolate poison messages.

This increment configures an `EVENTS` producer only in the default local
development environment. Named staging and production environments deliberately
have no producer or consumer configuration yet. The consumer code is locally
tested with a synthetic message batch but is not remotely registered.

## Alternatives considered

- Send to Queue before committing publication: rejected because Queue could
  expose an event for rolled-back canonical state.
- Commit then send without an outbox: rejected because termination can lose the
  only notification.
- Mark enqueued before `sendBatch`: rejected because a send failure would leave
  an event permanently skipped.
- Delete rows after send: rejected because consumer provenance, reconciliation,
  and failure evidence would be lost.
- Rely only on alarm's automatic retries: rejected because the documented retry
  budget can be exhausted during a long Queue outage.
- Configure the staging consumer immediately: deferred until schema 5 migration
  is independently healthy and the remote failure effects are reviewed.

## Consequences

Canonical publication remains available while Queue is unavailable because the
external send is not inside the SQLite transaction. A post-commit alarm
scheduling error can make the HTTP call appear failed after acceptance, but the
same operation replay returns its stored result and tries to arm the pending
outbox again.

Queue delivery and derived processing remain at-least-once; exactly-once
transport is neither assumed nor claimed. Idempotency is provided by the
authority event ID at the consumer storage boundary. Outbox retention and
compaction are deferred until a verified consumer watermark exists.

## Verification

- publish and its outbox event commit atomically;
- 100 operation retries leave one event for one canonical sequence;
- a failed Queue send increments attempts but leaves the event pending;
- a later confirmed send marks that same event enqueued;
- 11 pending events drain as 10 then 1 across two alarms;
- a known event is acknowledged and a duplicate creates no second delivery;
- an unknown event is retried rather than acknowledged;
- staging and production dry-runs contain no Queue binding or consumer.

## Current platform references

- [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Queues JavaScript APIs](https://developers.cloudflare.com/queues/configuration/javascript-apis/)
- [Queue batching, retries, and delays](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- [Dead Letter Queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)
