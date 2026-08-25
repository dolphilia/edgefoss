# P4d outbox observation remote deploy evidence — 2026-08-25

- Increment: owner-only outbox observation adapter
- Target: `edgefoss-staging`
- Workflow ref: `main`
- Result: deploy and stateful health passed

## Observed contract

The account owner ran the manual main-only staging workflow after the local
observation increment passed ordinary CI. The deployed repository remained on
schema 5 and all three R2 bindings remained bound.

An unauthenticated `GET /api/v0/outbox/4` returned HTTP 401 with
`Cache-Control: no-store` and a `WWW-Authenticate` challenge. This proves that
the route is deployed and that owner authentication is applied before any
outbox state is exposed. No owner token value was shared.

## Non-effects

- no Queue producer was added;
- no Queue consumer was added;
- `cloud:smoke-queue` was not run;
- no remote artifact was published;
- no new R2 object was written;
- production was not changed.

This gate authorizes the next local-only increment: declare the exact staging
Queue producer, consumer, retry, and DLQ configuration and verify its named
dry-run. It does not authorize a staging deploy or the permanent sequence 4
smoke effect.
