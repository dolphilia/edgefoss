# ADR-0046: Expose only bounded owner-authenticated public push preflight

- Status: Accepted for P5b2 local implementation
- Date: 2026-08-26
- Owners: sync, protocol, cloud authority, and security leads
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

P5b0 provides a coherent internal preflight, and P5b1 derives deterministic
fresh and incremental plans. The client still needs an HTTP boundary for the
observation. Existing P4 routes already provide authenticated, idempotent blob
upload/finalization and canonical artifact/ref publication, so adding a
monolithic push request would duplicate those contracts and create a long-lived
request that is harder to resume.

## Decision

Expose exactly `POST /api/v0/sync/push/preflight` for protocol 0 public push.
Reuse `EDGEFOSS_OWNER_TOKEN` and authenticate before body consumption. Accept a
maximum 65,536-byte exact-key JSON declaration containing project, protocol,
realm, and sorted unique artifact/blob inventories of at most 256 IDs each.
The Worker injects the owner principal and calls RepositoryDO by RPC.

Return the complete coherent observation under `preflight` with HTTP 200. Map a
different initialized project to HTTP 409 while returning only
`project_conflict`, and malformed declarations to HTTP 400. All responses are
`no-store`; unauthenticated requests return the existing owner HTTP 401 without
body parsing or authority disclosure.

The adapter is read-only. Clients separately execute deterministic plan steps
through existing upload and artifact routes. Anonymous `HELLO` remains
unchanged because owner-only push is not an anonymous capability.

## Alternatives considered

- One request containing the whole push: rejected because blob transfer,
  artifact acceptance, retry boundaries, and ref CAS already have reviewed
  independently resumable APIs.
- Put the owner principal in JSON: rejected because identity comes only from
  successful authentication.
- Advertise push in anonymous `HELLO`: rejected because it would conflate public
  read capability with authenticated authority mutation.
- Create a new push token: rejected because the existing staging owner token has
  the required scope and another credential adds no isolation in Single Edition.

## Consequences

- authentication and bounded parsing precede all authority access;
- a response-loss retry can repeat preflight without operation state;
- clients can compose the deterministic vector with the existing HTTP mutation
  routes and converge after each exact retry;
- project mismatch exposes neither missing IDs nor authority project identity;
- schema, bindings, secrets, R2/Queue configuration, and production remain
  unchanged;
- deploying the new route to staging is a separate explicit exposure gate, and
  remote mutation remains a later P5b3 gate.

## Verification

- unauthenticated malformed input returns HTTP 401 before parsing;
- method, media type, body bound, exact keys, ID syntax/order, and item bounds
  fail closed;
- fresh preflight returns the exact null-project snapshot;
- the shared vector executes fresh and incremental plans through HTTP with exact
  retries and converges at sequence 4/ref generation 2;
- a different project returns HTTP 409 with only `project_conflict`;
- the deployment audit sends malformed unauthenticated JSON and requires the
  exact HTTP 401 boundary without credentials or state access;
- a separate operator audit reads the token only from the environment, derives
  the public project from HELLO, submits empty inventories, and performs no write;
- full local gate and named staging/production dry-runs pass before commit.
