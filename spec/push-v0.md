# EdgeFossil experimental public push plan v0

Profile identifier: `edgefossil-public-push-fresh-v0`

Status: experimental candidate. This first profile converts one verified
complete public bundle and one exact fresh-authority preflight into a bounded,
deterministic mutation plan. It is not the HTTP wire format.

## Required inputs

The planner MUST fully verify an `edgefossil-bundle-v0` public bundle before
planning. The P5b0 authority snapshot MUST have:

- `project_id`, public ref target, and public ref generation all null;
- accepted sequence and policy epoch both zero;
- sorted missing artifact and blob inventories exactly equal to the bundle;
- at most 256 artifact IDs and 256 blob IDs.

Any difference is `invalid_push_plan`. A preflight result is an observation,
not a lease; every mutation remains subject to server-side validation.

## Mutation order

The plan contains only references to verified bundle objects. It MUST order:

1. every raw blob upload in manifest order;
2. signed `project.genesis` publication;
3. signed trees in child-before-parent topological order; and
4. signed changes from oldest to newest.

Every change publication carries public `heads/main` compare-and-swap. The
oldest change expects generation zero and each following change increments the
expected generation by one. Genesis and trees carry no ref mutation.

Blob upload/finalization MUST complete before the first artifact that references
the blob. Artifact and signature paths MUST be exact inventoried bundle paths.

## Deterministic operation IDs

Each mutation receives one lowercase UUID-shaped ID derived from SHA-256. This
is an idempotency key, not a random secret and not an RFC 4122 name UUID.

The hash input begins with the ASCII domain and NUL byte:

```text
edgefoss:push-operation:v0\0
```

It is followed by the listed UTF-8 fields separated by one NUL byte:

```text
upload  = upload, project ID, public, blob ID, decimal byte size, policy epoch
publish = publish, project ID, public, artifact ID, policy epoch,
          expected ref generation or "-"
```

The first 16 digest bytes form the ID. The high nibble of byte 6 is replaced
with `5`, and the high two bits of byte 8 are replaced with `10`; lowercase hex
and `8-4-4-4-12` hyphenation are then applied. Domain separation and the
mutation-specific fields prevent upload, non-ref publish, and ref publish keys
from sharing an operation ID.

Changing the policy epoch or expected generation changes the publish operation
ID. A client MUST persist or deterministically reconstruct the same plan when
retrying an uncertain response.

## Scope and non-claims

This profile supports only a fresh single-project public authority. It does not
plan incremental push, a nonzero policy epoch, members data, pagination, merge
history, concurrent ref advancement, HTTP authentication, or automatic conflict
resolution. A later profile is required for those cases.

The upload operation ID includes the observed policy epoch, but the existing
P4 upload API does not itself grant a policy lease. A policy change or publish
failure may leave a finalized unreachable blob; it MUST NOT make an artifact
visible and is handled by later garbage collection.

## Shared vector

[`vectors/public-clone-v0.json`](vectors/public-clone-v0.json) contains
`fresh_push_plan`. TypeScript deterministically regenerates the bundle and plan;
the Rust planner MUST independently reproduce every step and operation ID; the
Workers runtime MUST execute the committed plan with exact retry convergence.
