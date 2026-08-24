# ADR-0025: Gate idempotent cloud provisioning on an exact U2 approval

- Status: Accepted for P4a0
- Date: 2026-08-25
- Owners: cloud lead, account owner
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

U2 approved the staging resource names, Automatic R2 location, unrestricted R2
and Durable Object jurisdictions, `apac-ne` DO location hint, and exact manifest
digest at source commit `23ff83b`. A read-only R2 list confirmed that the
subscription is usable. Read-only probes confirmed that the three planned R2
buckets and two planned Queues do not yet exist.

Provisioning can fail after creating only some resources. Existing resources
with the approved name might also be unsafe to reuse if an R2 public development
URL or custom domain is enabled. Production has no corresponding approval.

## Decision

[`infra/approvals/staging-u2.json`](../../infra/approvals/staging-u2.json) is the
machine-readable U2 checkpoint. `cloud:provision` and `cloud:verify` fail before
remote access unless its environment, decision fields, and manifest digest
match the current plan exactly. No production approval exists, so both commands
remain blocked for production.

`cloud:provision` performs these steps:

1. inspect all three R2 buckets and both Queues before any write;
2. reject an existing R2 bucket if its `r2.dev` URL or a custom domain is
   enabled;
3. reuse safe matching resources and create only missing resources;
4. omit both R2 `--location` and `--jurisdiction`, preserving the approved
   Automatic/unrestricted policy;
5. inspect every resource again and succeed only when all five are present and
   all buckets remain private.

A failure does not delete or recreate resources. Re-running the same approved
command resumes from the observed state and converges. The command invokes
Wrangler directly without a shell and never places secrets in arguments or
result JSON.

`cloud:verify` runs the same remote inspection without writes and returns a
nonzero status until the five resources are ready. Both commands report the
`RepositoryDO` namespace as `pending_worker_deploy`: Cloudflare reconciles that
namespace from the declarative Worker `exports` configuration during P4a, not
from an independent create command.

## Alternatives considered

- Treat the chat confirmation alone as runtime authorization. Rejected because
  a later invocation could not prove which manifest digest was approved.
- Accept any existing bucket with the right name. Rejected because an existing
  public endpoint would violate the realm-delivery boundary.
- Roll back resources created before a later failure. Rejected because delete is
  destructive, can race with retry, and is less safe than idempotent resume.
- Create the DO namespace separately. Rejected because the current declarative
  `exports` lifecycle reconciles it with the Worker deployment.
- Provision production from the same approval. Rejected because environment
  approval is intentionally non-transitive.

## Consequences

The account owner can run one reviewed command without manually creating
Dashboard resources. A manifest change invalidates the approval automatically.
Partial creation is visible and recoverable by rerun; it is never hidden by
automatic deletion. Verification emits names and status but not account IDs,
Queue IDs, credentials, or unrelated account resources.

The first successful provision is still a billable Cloudflare mutation and must
be initiated only after this implementation is committed and CI is green.
Queue consumer policy, bindings, and the DO namespace are not active until the
P4a Worker configuration is deployed.

## Verification

- seven local tests cover the exact approval, digest mismatch, partial state,
  idempotent rerun, public bucket rejection before writes, read-only verify, and
  production blocking;
- a live `cloud:verify --env staging` performed remote reads only and reported
  all five planned resources missing;
- `pnpm check` and `pnpm build` cover the ordinary repository gates;
- after commit/CI, the account owner runs `cloud:provision` followed by
  `cloud:verify`, and the non-secret result is captured as separate evidence.

References:

- [Create R2 buckets](https://developers.cloudflare.com/r2/buckets/create-buckets/)
- [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/)
- [R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)
- [Create Queues](https://developers.cloudflare.com/queues/get-started/)
- [Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
