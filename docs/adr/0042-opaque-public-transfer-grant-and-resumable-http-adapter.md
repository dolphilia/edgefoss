# ADR-0042: Expose public clone transfer through an opaque bounded grant

- Status: Accepted for P5a2c local implementation
- Date: 2026-08-26
- Owners: sync, protocol, and cloud security leads
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

P5a2b2 proves that RepositoryDO can produce a complete public clone that the
Rust importer reconstructs exactly. That contract is internal: an anonymous
client still cannot obtain its manifest, artifacts, signatures, or blob bytes
over HTTP, nor resume an interrupted download.

An external adapter must not turn every accepted public upload into a readable
object. A public artifact can be dangling or cease to belong to the planned
head after a policy change. It must also avoid bearer credentials, unbounded
request bodies, long-lived server sessions, new Cloudflare resources, and R2
writes.

## Decision

Expose protocol 0 `complete` transfer through three anonymous endpoints:

- `POST /api/v0/sync/transfers` creates a plan and opaque grant;
- `POST /api/v0/sync/transfers/artifacts` returns a bounded set of verified
  artifact and signature bytes;
- `GET /api/v0/sync/transfers/blobs/{blob-id}` returns one bounded byte range.

The plan response includes the canonical manifest and sorted object inventory.
The grant is an AES-256-GCM envelope with a random 96-bit nonce and a distinct
`edgefoss:public-transfer:v0` additional-authenticated-data label. It reuses the
existing lazily generated `sync_cursor_key_v0` RepositoryDO key, so no Worker
secret or new database row type is introduced. The token contains no plaintext
project or object identifiers and expires after 600 seconds.

The encrypted grant binds the `complete` profile, planned head, semantic root,
and the full internal anonymous-public snapshot: project, principal, view,
protocol, policy epoch, accepted sequence, and empty starting position. An
artifact request recomputes the planned head closure before returning bytes.
A blob request uses the existing clone chunk reader, which also recomputes the
closure. Both paths recheck the current policy epoch after asynchronous crypto
or R2 work.

Artifact wants must be a sorted, unique JSON array of at most 16 IDs. The
existing verified-transfer budget remains 2 MiB of canonical artifact bytes.
Blob reads use explicit offset and length and return at most 1 MiB. A client
resumes by replaying an artifact request or requesting the next blob offset;
the server stores no download session.

Invalid, malformed, or tampered grants share one unauthenticated result.
Expired grants also require a new plan. Stale snapshots return conflict,
unreachable or absent objects return not found, and budget excess returns
payload too large. All transfer responses are `no-store`; binary blob responses
also carry the effective offset, total length, completion flag, and blob ID.

`HELLO` now advertises `TRANSFER`, the opaque grant and its TTL, the `complete`
profile, and the exact artifact/blob limits. Capability advertisement and route
deployment are one change so a client never discovers an unavailable phase.

## Atomicity boundary

Planning and each read are independent RepositoryDO operations. A grant does
not reserve a ref or lock policy. Instead, every operation is fenced by the
snapshot policy epoch and planned head. A partial HTTP response changes no
authority state; retry or range resume is safe and byte-identical while the
grant remains valid.

Creating the first cursor or transfer token may lazily add the existing
`sync_cursor_key_v0` meta row. Transfer performs no artifact publication, ref
change, R2 write, Queue event, or importer mutation.

## Scope boundary

P5a2c supports anonymous public complete-clone download only. It does not add
pull negotiation, restricted or members views, compression, server-side
sessions, multi-project routing, merge import, or remote smoke writes. There is
no schema migration, binding, secret, Queue change, R2 object creation, or
production change.

Deploying this adapter is a new public effect: any third party can download all
objects reachable from the staging public head. Therefore local completion and
ordinary CI do not authorize staging deployment. The account owner must
explicitly approve the advertised capability, anonymous routes, reachable data
download, and possible lazy key-row creation before deployment.

## Consequences

- grants are short-lived, opaque, tamper evident, and bound to one exact plan;
- dangling accepted public artifacts remain unreadable through the grant;
- disconnect recovery requires no mutable server session;
- the same range can be retried byte-for-byte;
- clients must obtain a new plan after expiry or a policy change;
- a single JSON artifact response may expand canonical bytes through base64url,
  but raw verified input remains bounded at 2 MiB.

## Verification

- publish the committed signed cross-runtime vector through RepositoryDO;
- obtain an anonymous plan whose manifest matches every committed byte;
- transfer artifacts twice and require byte-identical responses;
- fetch one blob in multiple ranges, repeat a range, and reconstruct the exact
  vector;
- verify the assembled bundle with the protocol verifier;
- reject a dangling public artifact even when the grant is otherwise valid;
- collapse missing and tampered grants to the same HTTP 401 contract;
- reject a previously issued grant after a policy epoch advance;
- prove expiry with an injected future clock;
- keep schema 5 and use only the existing sync token key row;
- pass the full local gate and named staging/production dry-runs before asking
  for staging-effect approval.
