# EdgeFossil experimental public push plan v0

Profile identifiers:

- `edgefossil-public-push-fresh-v0`
- `edgefossil-public-push-linear-v0`

Status: experimental candidate. These profiles convert one verified complete
public bundle and one exact authority preflight into a bounded, deterministic
mutation plan. They are not the HTTP wire format.

## Required inputs

The planner MUST fully verify an `edgefossil-bundle-v0` public bundle before
planning. The P5b0 authority snapshot MUST have:

- `project_id`, public ref target, and public ref generation all null;
- accepted sequence and policy epoch both zero;
- sorted missing artifact and blob inventories exactly equal to the bundle;
- at most 256 artifact IDs and 256 blob IDs.

Any difference is `invalid_push_plan`. A preflight result is an observation,
not a lease; every mutation remains subject to server-side validation.

## Linear incremental inputs

The `linear-v0` profile accepts the same verified public bundle and bounds. The
snapshot MUST describe exactly one of these states:

- uninitialized: sequence and policy epoch zero, null project/ref, and genesis
  missing;
- initialized without a public ref: nonzero accepted sequence, matching
  project, null ref target and generation, and genesis not missing;
- initialized with a public ref: matching project and a target present in the
  bundle's exact oldest-to-newest `heads/main` ancestry, with nonzero accepted
  sequence.

Missing inventories MUST be sorted, unique subsets of the bundle inventory.
For an existing ref, no artifact or blob reachable from the accepted history
prefix may be reported missing. Such a contradiction is `invalid_push_plan`.
An authority ref target outside the local linear history is
`push_head_conflict`; the planner MUST NOT guess, force-push, merge, or apply
last-writer-wins.

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

For `linear-v0`, the planner omits blobs and non-change artifacts not reported
missing. It emits every change strictly after the observed authority head,
including an already-present artifact when ref advancement may still need to
resume. The first emitted change uses the observed ref generation; later
changes increment it by one. With no ref, the full change history starts at
generation zero. If the authority head equals the bundle head and nothing is
missing, the valid result is an empty mutation plan.

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

These profiles support only one bounded, single-project, public, linear history.
They do not plan members data, pagination, merge history, concurrent ref
advancement, HTTP authentication, force push, or automatic conflict resolution.
The fresh profile additionally requires policy epoch zero. The linear profile
preserves the observed policy epoch in every publish operation and relies on
the authority to reject a stale epoch at mutation time.

The upload operation ID includes the observed policy epoch, but the existing
P4 upload API does not itself grant a policy lease. A policy change or publish
failure may leave a finalized unreachable blob; it MUST NOT make an artifact
visible and is handled by later garbage collection.

## Shared vector

[`vectors/public-clone-v0.json`](vectors/public-clone-v0.json) contains
`fresh_push_plan` and a one-change `incremental_push`. TypeScript
deterministically regenerates both bundles and plans; the Rust planner MUST
independently reproduce every step and operation ID; the Workers runtime MUST
execute the committed plans with exact retry convergence.

## Owner-authenticated HTTP preflight adapter

Protocol 0 exposes exactly `POST /api/v0/sync/push/preflight`. The adapter MUST
authenticate the existing owner bearer token before reading the request body.
It accepts `application/json` up to 65,536 bytes with exactly these fields:

```json
{
  "artifactIds": [],
  "blobIds": [],
  "projectId": "sha256:...",
  "protocolVersion": 0,
  "realm": "public"
}
```

The adapter injects `principalId: "owner"`; the client MUST NOT supply a
principal. Artifact and blob arrays are independently limited to 256 canonical
IDs and MUST be strictly ascending, which also rejects duplicates.

Responses always use `Cache-Control: no-store`. A valid observation is HTTP 200
with `{ "preflight": { ... } }`. A different initialized project is HTTP 409
with only `project_conflict`; malformed input is HTTP 400
`push_preflight_invalid`. Missing or invalid owner authentication is HTTP 401
and MUST reveal no snapshot or parsing detail. Other methods are HTTP 405 with
`Allow: POST`.

This endpoint performs no mutation and grants no lease. The client executes the
returned local plan through the existing bounded upload/finalize and artifact
publication endpoints. Each mutation remains independently authenticated and
revalidates policy, referenced objects, operation deduplication, and ref CAS.
Anonymous public `HELLO` does not advertise owner-only push capability.
