# ADR-0037: Start P5a with an internal public inventory snapshot

- Status: Accepted for P5a0
- Date: 2026-08-25
- Owners: sync and security leads
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

G4 is complete, so P5 may begin. A complete clone/pull path would combine
protocol negotiation, authorization, inventory, transfer, local import, resume,
and conflict behavior in one risky increment. The first boundary must prove
that an anonymous public client can enumerate only its granted view without
making an HTTP API or cursor encoding prematurely public.

The canonical artifact table has a global receipt sequence shared by public and
members realms. Returning that sequence, its gaps, or a repository-wide count
would reveal activity outside the public view.

## Decision

Add two internal `RepositoryDO` RPC methods:

- `syncHello()` negotiates protocol version 0 and the public view. It advertises
  only the implemented `HELLO` and `INVENTORY` phases, artifact-ID ordering, and
  the maximum page size.
- `publicInventory()` returns bounded pages ordered by `artifact_id ASC`. Each
  entry contains only a public artifact ID and kind; it contains no global
  receipt sequence, size, path, blob reference, or inaccessible count.

The first page captures the maximum accepted sequence among public artifacts,
not the repository-wide sequence. Later pages filter to that snapshot. Public
artifacts accepted after the first page therefore appear only in a fresh scan,
while members artifacts never enter the result.

Continuation state is authority-internal and binds the project, anonymous
principal, public view, protocol version, policy epoch, last artifact ID, and
snapshot boundary. A policy-epoch change makes it stale. This structure is not
an external token: a later HTTP adapter must replace it with an opaque,
integrity-protected representation and must not serialize its internal fields.

The implementation uses the existing schema 5 indexes and a bounded
`limit + 1` query inside one synchronous SQLite transaction. The maximum page
size is 1,000.

## Scope boundary

This increment does not implement `AUTH`, `WANT`, `TRANSFER`, `ACK`, `DONE`,
artifact-body download, blob download, local repository import, an HTTP route,
or an externally encoded cursor. It does not advertise clone profiles or claim
that clone/pull is complete.

There is no schema migration, binding, secret, Cloudflare resource, staging
deploy, Queue message, R2 read/write, or production change.

## Consequences

- capability negotiation cannot promise an unimplemented transfer phase;
- public pagination is deterministic and bounded;
- a scan has stable membership across concurrent public publishes;
- members artifact IDs and counts are excluded from entries;
- policy changes fail closed with `cursor_stale`;
- the later HTTP token format remains an explicit security decision.

## Verification

- uninitialized projects reject negotiation;
- unsupported protocol versions reject negotiation;
- mixed public/members state returns only public artifact IDs;
- entries expose exactly artifact ID and kind;
- an artifact accepted after page one is absent from that scan and present in a
  fresh scan;
- project/principal/view binding tampering is rejected;
- a policy advance invalidates an earlier continuation anchor;
- page sizes outside 1–1,000 reject before querying;
- Workers runtime tests use real signed canonical publication paths.

## Current platform references

- [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [SQLite-backed Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
