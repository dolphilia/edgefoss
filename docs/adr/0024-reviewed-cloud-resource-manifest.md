# ADR-0024: Review cloud resources before provisioning

- Status: Accepted for P4a0
- Date: 2026-08-25
- Owners: cloud lead, account owner
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

P4 introduces the first stateful Cloudflare resources. R2 jurisdiction cannot be
changed after bucket creation, bindings are not inherited by Wrangler
environments, and staging must never resolve production resources. Dashboard
creation would put names and policy outside reviewable source control.

U2 is intentionally not satisfied yet. The account owner has completed U1, but
R2 subscription checkout, the data-residency confirmation, and approval of the
exact stateful resource set must happen only after a non-mutating plan exists.

Current Cloudflare documentation distinguishes R2 Automatic location from a
jurisdictional restriction. It also distinguishes both of those from a Durable
Object location hint: `apac-ne` is a best-effort hint on the first DO lookup,
not an R2 location or a storage guarantee.

## Decision

[`infra/cloud-resources.json`](../../infra/cloud-resources.json) is the single
non-secret manifest for P4 Cloudflare resource names, bindings, placement
policy, and Queue consumer policy. It defines complete, non-overlapping
`staging` and `production` environments.

The initial policy is:

- R2 location `automatic`, with no R2 jurisdiction;
- no Durable Object jurisdiction;
- `apac-ne` as the first-lookup hint for `RepositoryDO` because the primary use
  is expected in Japan;
- one SQLite-backed `RepositoryDO`, bound as `REPOSITORY` and declared through
  the current declarative `exports` lifecycle (not legacy `migrations`);
- three private R2 buckets bound as `PUBLIC_BLOBS`, `RESTRICTED_BLOBS`, and
  `EXPORTS`;
- one `EVENTS` Queue and a distinct DLQ per environment;
- no `r2.dev` or public bucket access, including for public-realm blobs. The
  Worker remains the delivery boundary until a separate public-delivery
  decision is accepted.

`pnpm run cloud:plan -- --env staging|production` reads only the local manifest.
It does not invoke Wrangler, fetch remote state, or write Cloudflare state. It
validates the complete manifest, emits deterministic JSON, marks all effects as
non-mutating, and returns a digest of the selected review target. The preflight
stays `USER_ACTION_REQUIRED` at U2 and states that no provisioning command is
available.

The digest approves content, not remote state. A later `cloud:provision` must
require evidence approving that exact digest, compare actual remote state, and
stop on an incompatible existing resource. Production review never authorizes
production mutation by itself.

## Alternatives considered

- Put bindings only in `wrangler.jsonc`. Rejected as the sole source because it
  cannot describe the pre-provision review, R2 public-access invariant, or DO
  first-lookup hint clearly enough.
- Create resources in the Dashboard and copy their names back. Rejected because
  it bypasses the reviewed manifest and encourages partial, unreproducible
  state.
- Make the first plan query Cloudflare. Deferred until U2 because R2 may not be
  enabled and a local plan must remain usable without credentials or network.
- Add `cloud:provision` now. Rejected for this increment because an apparent
  command must not exist before its approval input, remote comparison, and
  failure/rollback contract are implemented.

## Consequences

Resource intent and the irreversible placement choice are reviewable before any
stateful mutation. Validation fails closed on missing/extra keys, cross-
environment names, public buckets, mismatched jurisdictions, unexpected
bindings, or unsupported locations. Account IDs, tokens, credentials, and
physical Cloudflare IDs never enter the manifest or plan.

The plan currently describes desired state rather than an actual remote diff.
Provisioning and verification remain blocked. Changing the manifest changes the
digest and invalidates a prior approval. `apac-ne` must later be passed on the
first `getByName`/`get` call; it does not relocate an existing object.

## Verification

- `pnpm test:cloud-plan` validates both environments, isolation, private R2
  buckets, deterministic output, the U2 stop, argument rejection, and credential
  non-disclosure.
- `pnpm run cloud:plan -- --env staging` emits parseable JSON with no remote
  access and the expected digest.
- `pnpm check` keeps the plan validator in the ordinary CI path.
- U2 approval and later read-only remote comparison will be recorded separately
  before `cloud:provision` is implemented or run.

References:

- [R2 bucket naming and private defaults](https://developers.cloudflare.com/r2/buckets/create-buckets/)
- [R2 data location and jurisdictions](https://developers.cloudflare.com/r2/reference/data-location/)
- [Durable Objects data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)
- [Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
- [Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/)
- [Queue configuration](https://developers.cloudflare.com/queues/configuration/configure-queues/)
- [Dead Letter Queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)
