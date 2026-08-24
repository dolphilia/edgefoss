# P4a0 local cloud plan evidence — 2026-08-25

- Increment: P4a0 local resource manifest and non-mutating plan
- Base commit: `63f57c349cdc99e6bbcbd4d1b15f9c9e022a12db`
- Source state: committed as `23ff83b971ce3a248151b7fb69d71a8ed6171353`
- Cloud mutation: none
- Remote reads: none
- GitHub Actions: success confirmed by the account owner
- U2 state: approved for the exact staging digest; see the separate U2 evidence

## Inputs checked

The implementation was checked against Cloudflare Workers best practices last
updated 2026-08-20, R2 data-location documentation last updated 2026-08-19,
Durable Objects data-location documentation last updated 2026-06-26,
`@cloudflare/workers-types` `5.20260823.1`, and the installed Wrangler `4.125.0`
configuration schema.

The resulting policy keeps R2 at Automatic with no jurisdiction, leaves the DO
jurisdiction unrestricted, and records `apac-ne` only as a best-effort DO
first-lookup hint. All three R2 buckets remain private.

## Reviewed staging output

```text
format: edgefossil-cloud-plan-v0
environment: staging
manifest digest: sha256:eb9e8f30df7070728d1e3aa433584b35b8a38bd82f03cbdd7bdfe8f181eede3d
effects: mutating=false, remoteReads=false, remoteWrites=false
preflight: USER_ACTION_REQUIRED / U2
Worker: edgefoss-staging
RepositoryDO: REPOSITORY / RepositoryDO / exports state=created / sqlite
R2: edgefoss-staging-public-blobs / PUBLIC_BLOBS / private
R2: edgefoss-staging-restricted-blobs / RESTRICTED_BLOBS / private
R2: edgefoss-staging-exports / EXPORTS / private
Queue: edgefoss-staging-events / EVENTS
DLQ: edgefoss-staging-events-dlq
DO location hint: apac-ne
R2 and DO jurisdiction: none
provisioning command available: false
```

The production environment is also present and validated with distinct names,
but it was not selected for U2 and no production mutation is authorized.

## Targeted verification

```text
pnpm test:cloud-plan
  5 tests pass

pnpm run cloud:plan -- --env staging
  valid deterministic JSON
  manifest digest matches the value above
  USER_ACTION_REQUIRED emitted
```

The test launches the CLI with sentinel values in
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` and proves neither appears in
output. It also rejects public bucket settings, cross-environment bucket names,
missing/duplicate arguments, and abbreviated production-like environment names.

## Full verification

```text
pnpm check
  formatting and TypeScript checks: pass
  protocol: 182 tests pass
  Worker: 2 tests pass
  cloud plan: 5 tests pass
  Rust workspace: all ordinary tests pass; subprocess helper ignored as designed
  Static Assets local smoke: pass
  Rust lint with warnings denied: pass
  shared vectors: 9 files, 64 accepted and 81 rejected cases audited
  bundle vector reader: 1 valid file and 5 invalid cases checked
  documentation: 69 Markdown files, all local links valid

pnpm build
  protocol TypeScript build: pass
  dynamic Worker Wrangler dry-run build: pass
```

## Remaining gate

This evidence made U2 review possible. The account owner subsequently approved
the exact staging digest, and the R2 subscription was verified read-only. See
[`U2 evidence`](u2-stateful-resource-approval-2026-08-25.md). Provisioning and
verification are implemented in the next increment; no stateful resource was
created by this evidence.
