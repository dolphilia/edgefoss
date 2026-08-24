# U2 stateful resource approval evidence — 2026-08-25

- Checkpoint: U2
- Approved source commit: `23ff83b971ce3a248151b7fb69d71a8ed6171353`
- GitHub Actions: success confirmed by the account owner
- Environment: staging only
- Manifest digest:
  `sha256:eb9e8f30df7070728d1e3aa433584b35b8a38bd82f03cbdd7bdfe8f181eede3d`
- Result: approved and recorded; no provisioning performed
- Provision/verify implementation state: local working tree; commit and CI
  confirmation pending

## Account-owner decisions

```text
legal/contractual data residency requirement: none
primary usage region: Japan
R2 location: Automatic, approved
R2 jurisdiction: none, approved
Durable Object jurisdiction: none, approved
Durable Object location hint: apac-ne, approved
staging resource names and bindings: approved
manifest digest: approved
```

No account ID, user identity, OAuth credential, API token, S3 key, payment
method, or billing detail is recorded.

## Read-only readiness checks

The project-local Wrangler `4.125.0` OAuth session successfully listed R2
buckets, proving that the R2 subscription is usable. The output was used only
to test name collisions; unrelated bucket names and IDs are not part of this
evidence.

The three planned bucket names and two Queue names were absent. The new
read-only command then returned:

```text
pnpm run cloud:verify -- --env staging
  approval: U2 / approved
  mutating: false
  remoteReads: true
  remoteWrites: false
  edgefoss-staging-public-blobs: missing
  edgefoss-staging-restricted-blobs: missing
  edgefoss-staging-exports: missing
  edgefoss-staging-events: missing
  edgefoss-staging-events-dlq: missing
  RepositoryDO: pending_worker_deploy
  exit status: 1, expected until provisioning
```

## Gate effect

U2 is complete for the exact staging digest above. Production remains
unapproved. `cloud:provision` and `cloud:verify` are now implemented with an
exact approval check, pre-write inspection, private-bucket enforcement,
idempotent resume, and post-write verification.

No resource has been created yet. The next authorized user action occurs only
after this implementation is committed and CI is green: run staging provision,
then read-only verify, and return only the non-secret status summary.

## Full local verification

```text
pnpm check
  formatting and TypeScript checks: pass
  protocol: 182 tests pass
  Worker: 2 tests pass
  cloud plan: 6 tests pass
  cloud state: 7 tests pass
  Rust workspace: all ordinary tests pass; subprocess helper ignored as designed
  Static Assets local smoke: pass
  Rust lint with warnings denied: pass
  shared vectors: 9 files, 64 accepted and 81 rejected cases audited
  bundle vector reader: 1 valid file and 5 invalid cases checked
  documentation: 71 Markdown files, all local links valid

pnpm build
  protocol TypeScript build: pass
  dynamic Worker Wrangler dry-run build: pass
```
