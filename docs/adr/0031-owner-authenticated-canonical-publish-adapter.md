# ADR-0031: Expose canonical publication through one bounded owner endpoint

- Status: Accepted for P4c
- Date: 2026-08-25
- Owners: cloud and protocol leads
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

ADR-0030 established the schema 4 `RepositoryDO.publishArtifact` transaction
and the schema 3-to-4 staging migration is healthy. The first remote artifact
must now cross an HTTP boundary without weakening canonical identity, owner
authentication, operation replay, or ref compare-and-swap. This rollout also
needs a repeatable proof that uses the already-finalized P4b blob and creates no
additional R2 object.

## Decision

The Worker exposes exactly `POST /api/v0/artifacts`. It authenticates the
existing `EDGEFOSS_OWNER_TOKEN` bearer before reading the body, fixes the
principal to `owner` server-side, and accepts one exact JSON shape:

```text
artifactBytes      canonical unpadded base64url, decoded size <= 1 MiB
artifactId         protocol artifact ID text
expectedPolicyEpoch non-negative safe integer
operationId        operation UUID, validated by the authority core
ref                null or exact {expectedGeneration, name:"heads/main"}
signatureBytes     canonical unpadded base64url, decoded size <= 1 KiB
```

The entire streamed JSON body is capped at 2 MiB. Unknown or missing fields,
padded/non-canonical base64url, invalid JSON, and invalid ref transport are
rejected before the RPC. The adapter does not decode CBOR or decide authority
semantics; the existing RPC remains the single canonical validation and
transaction boundary.

The response preserves the typed RPC result:

- accepted publication: HTTP 200;
- operation, policy, or ref conflict: HTTP 409;
- semantic/canonical rejection: HTTP 422;
- malformed HTTP transport: HTTP 400/413/415.

All responses retain `cache-control: no-store`. There is no CORS policy,
anonymous mutation, token in JSON, new secret, R2 binding, or Queue consumer.

The remote staging smoke uses a deterministic, publicly derivable Ed25519 test
fixture and fixed operation IDs to publish genesis, a public tree referencing
the existing 30-byte P4b blob, and a public change advancing `heads/main` from
generation 0 to 1. Each request is sent twice and must return the exact same
accepted result. The fixture is deliberately not a credential and must never
be used for production identity. The bearer token remains the mutation
credential and is read only from `EDGEFOSS_OWNER_TOKEN`.

## Alternatives considered

- Accept decoded JSON artifact fields: rejected because it would create a
  second canonical encoder and could change portable artifact identity.
- Accept a client-supplied principal: rejected because the bootstrap adapter
  has only one authenticated owner principal.
- Put the signing private key in a Worker secret: rejected because signing is a
  client responsibility and the deterministic staging fixture is non-secret.
- Upload another smoke blob: rejected because P4b already finalized the exact
  required public object and P4c should isolate authority writes from R2 writes.
- Add browser CORS or Queue dispatch now: deferred until those consumers and
  event contracts exist.

## Consequences

The first successful staging smoke permanently initializes this Single Edition
authority with a synthetic project ID and public test actor, accepts three
artifacts and three receipts/operations, and creates public `heads/main`
generation 1. It performs no R2 write and is safe to rerun with the same inputs.
Because Single Edition permits only one project, this smoke must run only on the
approved disposable staging authority, never production or a user repository.

The root tooling uses `tsx` only to execute the workspace protocol TypeScript
implementation; the deployed Worker dependency graph and bindings do not
change.

## Verification

- unauthenticated malformed input is rejected before body parsing;
- valid signed genesis, tree, and change pass through the HTTP adapter;
- accepted retry returns the exact stored result;
- ref conflict remains structured at HTTP 409;
- authority rejection remains structured at HTTP 422;
- unknown fields, non-canonical base64url, and oversized declared bodies fail;
- the smoke rejects any origin except the exact approved staging Worker;
- mock smoke makes seven calls: health plus two attempts for each artifact;
- token values appear in neither request bodies nor smoke output.

## Current platform references

- [Workers Request API](https://developers.cloudflare.com/workers/runtime-apis/request/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [SQLite-backed Durable Object Storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
