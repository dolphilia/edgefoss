# P4c canonical publish core remote migration evidence — 2026-08-25

- Increment: P4c internal canonical publication schema migration
- Deployed commit: `7c15a01534336c67d1a6decfa16377294571a988`
- Environment: `edgefoss-staging`
- Workflow ref: `main`
- Result: deploy and exact stateful health pass

## Account-owner observation

The account owner ran the manual main-only `Deploy staging Worker` workflow and
reported:

```text
deploy: success
stateful health: pass
repository schemaVersion: 4
3 R2 binding: bound
remote artifact publish: not performed
new R2 write: not performed
P4b upload smoke: not repeated
Queue consumer: not added
```

This is the planned schema 3 to 4 migration gate for ADR-0030. It creates the
strict artifact, edge, attestation, receipt, realm-ref, and operation tables
without inserting a project genesis, artifact, ref, receipt, or publish
operation.

## Independent read-only verification

After the workflow report, an independent public read observed:

```text
GET /health: 200
cache-control: no-store
environment: staging
edition: single
repository: status=ok, storage=sqlite, schemaVersion=4
3 R2 binding: bound
```

A read-only `GET /api/v0/artifacts` returned the normal structured `404` with
`Cache-Control: no-store`. This confirms the typed `publishArtifact` RPC was not
accidentally exposed as an HTTP surface in this deployment.

## Gate result

The schema 4 authority foundation is healthy. The next P4c increment may add a
bounded owner-authenticated HTTP adapter and a reviewable deterministic staging
smoke. No remote artifact publication is authorized until that adapter and its
tests are committed, normal CI is green, and the synthetic project identity and
write effects have been reviewed.
