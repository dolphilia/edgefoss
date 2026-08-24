# P4a stateful foundation local evidence — 2026-08-25

- Increment: P4a Worker/RepositoryDO/R2 topology
- Base commit: `e785d33191304c7f8e5a7c8b9b30801762151c4a`
- Source state: committed as `85eb3e001101ac0f717af9785a80611ff0f6302e`
- Environment authorized for later deployment: staging only
- Remote mutation in this increment: none
- Result: local implementation, commit, and GitHub Actions complete; the later
  remote deployment is recorded separately

## Current platform inputs

The implementation was checked against installed Wrangler `4.125.0`, its
configuration schema, and the latest published `@cloudflare/workers-types`
version `5.20260823.1`. Current Cloudflare documentation confirms declarative
Durable Object class exports, SQLite storage for a new namespace, explicit
non-inheritable binding configuration, and best-effort location hints.

## Read-only resource verification

After the account owner reported successful provisioning, the project-local
OAuth session reran the approval-gated read-only command:

```text
pnpm run cloud:verify -- --env staging
  exit status: 0
  approval: U2 / approved
  mutating: false
  remoteReads: true
  remoteWrites: false
  ready: true
  readyForWorkerDeployment: true
  edgefoss-staging-public-blobs: ready / r2Dev=false / customDomain=false
  edgefoss-staging-restricted-blobs: ready / r2Dev=false / customDomain=false
  edgefoss-staging-exports: ready / r2Dev=false / customDomain=false
  edgefoss-staging-events: ready
  edgefoss-staging-events-dlq: ready
  RepositoryDO: pending_worker_deploy
```

No account ID, resource ID, unrelated resource name, credential, or billing
detail is recorded. The final provision report's `actions: unchanged` means an
idempotent rerun observed the approved five resources and performed no writes.

## Implemented boundary

- one deterministic Single Edition authority name;
- declarative SQLite `RepositoryDO`, with strict schema metadata version 1;
- an RPC health method and an HTTP health path that actually traverses the DO;
- explicit dev, staging, and production DO/R2 bindings;
- the approved staging bucket names and separately named production buckets;
- `apac-ne` only as the first lookup hint, with no DO jurisdiction restriction;
- no bucket names, DO IDs, account data, or credentials in the health response;
- no Queue binding or consumer yet; the provisioned Queue/DLQ stay idle until
  the P4d outbox event contract and idempotency rules exist.

## Focused verification

```text
pnpm --filter @edgefoss/worker test
  1 test file passed
  4 tests passed

wrangler deploy --dry-run --env staging
  RepositoryDO binding: ready in bundle
  3 staging R2 bindings: exact approved names
  environment: staging

wrangler deploy --dry-run --env production
  RepositoryDO binding: ready in bundle
  3 production R2 bindings: separately named
  environment: production
```

Generated Worker types contain `DurableObjectNamespace<RepositoryDO>` and three
`R2Bucket` bindings for the base, staging, and production environments.

## Gate and next action

This local evidence alone was not remote P4a completion. The account owner then
committed and pushed the change, confirmed GitHub Actions success, and completed
the first manual OAuth deployment and stateful smoke. See the
[`P4a remote evidence`](p4a-stateful-foundation-remote-2026-08-25.md).

Production and CI credentials remained out of scope throughout this increment.
