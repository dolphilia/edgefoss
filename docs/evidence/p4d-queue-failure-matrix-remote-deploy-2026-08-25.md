# P4d Queue failure-matrix adapter remote deploy evidence — 2026-08-25

- Increment: behavior-preserving deployment of the extracted Queue consumer
- Deployed commit: `f6c29af`
- Workflow ref: `main`
- Target: `edgefoss-staging`
- Result: deploy and stateful health passed
- Repository schema: 5

## Gate sequence

The bounded local failure matrix was committed, pushed, and passed ordinary
GitHub Actions before the manual staging workflow ran. The deployment used the
existing main-only `Deploy staging Worker` workflow. It did not run the Queue
smoke again or introduce a schema migration.

## Observed deployment contract

The deployment retained the reviewed staging topology:

```text
EVENTS producer=edgefoss-staging-events
Queue consumer=edgefoss-staging
batch size=10
batch timeout=5 seconds
max retries=3
DLQ=edgefoss-staging-events-dlq
R2 bindings=3
repository schemaVersion=5
```

The stateful health audit passed. An authenticated, read-only
`GET /api/v0/outbox/4` returned HTTP 200 and showed that the previously delivered
event remained stable across the deployment:

```text
repoSequence=4
phase=delivered
sendAttempts=1
pending=0
enqueued=1
delivered=1
```

The owner token was supplied only through the local process environment, was
unset afterward, and its value was not shared.

## Non-effects

- `cloud:smoke-queue` was not repeated;
- no remote artifact was published;
- no new R2 object was written;
- no Queue failure was injected;
- no Queue was paused or purged and no consumer was removed;
- no poison message was sent;
- production was unchanged.

## Interpretation and limit

Together with the local failure-matrix evidence, this deployment confirms that
extracting and validating the per-message consumer did not regress the known
staging success path. P4d is complete: the application-controlled recovery,
retry, duplicate, ordering, and redaction contracts are green, and the reviewed
staging configuration still points exhausted deliveries at the dedicated DLQ.

This evidence does **not** claim that an actual message was observed moving into
the Cloudflare-managed DLQ. That remains an explicitly documented platform
contract, not a remotely injected result.

G4 is not yet complete. Its independent ACL-revocation-versus-publish
linearization condition has not been implemented by the current owner-only
authority and must be closed locally before P5 begins.
