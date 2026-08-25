# P4d sequence 4 Queue smoke remote evidence — 2026-08-25

- Increment: deterministic single-event Queue success path
- Target: `edgefoss-staging`
- Result: success, exit status 0
- Repository schema: 5

## Approved permanent effect

After the binding-only evidence passed ordinary CI, the account owner explicitly
approved one permanent public sequence 4 tree, receipt, publish operation,
outbox row, and delivery record. The approved smoke was then run once against
the exact staging origin with the existing owner token supplied only through the
process environment. The token value was not shared.

## Observed result

The deterministic publish and its exact retry converged to repository sequence 4. The Durable Object alarm sent the outbox event in one attempt, and the
idempotent Queue consumer recorded delivery:

```text
state=delivered
deliveryPhase=delivered
repoSequence=4
retryConverged=true
sendAttempts=1
realm=public
```

This proves the bounded staging success path from canonical transaction through
outbox, alarm, Queue producer, Queue storage, consumer validation, explicit
acknowledgement, and delivery observation.

## Non-effects

- `heads/main` did not change;
- no new R2 object was written;
- members state did not change;
- production did not change;
- no second canonical artifact was created by the retry.

## Remaining boundary

This success does not prove producer-outage recovery, consumer retry exhaustion,
or DLQ transfer. P4d remains open until a bounded failure matrix is green. The
next increment must begin locally and must not create another staging artifact,
disable a remote consumer, or inject a poison message without a separate review
and explicit effect approval.
