# P5a1 public sync adapter local evidence — 2026-08-25

- Increment: anonymous `HELLO` and encrypted-cursor public `INVENTORY`
- Base commit: `2d088fc`
- Environment: local Workers runtime only
- Repository schema: unchanged at 5
- Remote mutation: none

## Implemented boundary

The Worker now has exact anonymous GET routes for sync negotiation and public
inventory. Query parameters are canonical and bounded. Responses contain only
public artifact ID and kind and always use `Cache-Control: no-store`.

The RepositoryDO encrypts and authenticates its internal continuation anchor
with AES-256-GCM. Tokens use a random nonce, protocol-specific authenticated
data, a recognizable version prefix, and a 600-second expiration. The key is a
random 256-bit value stored only in the existing meta table and generated only
when a page actually needs continuation.

## Workers runtime matrix

Focused tests prove:

- anonymous negotiation returns exactly protocol 0, public view,
  `HELLO`/`INVENTORY`, opaque cursor semantics, TTL, ordering, and page limit;
- no owner bearer token is requested;
- mixed public/members canonical state yields only public entries;
- token text contains no project, public artifact, or members artifact ID;
- the continuation page converges to the exact public set;
- tampering returns generic `cursor_invalid` without cryptographic detail;
- policy epoch advance returns `cursor_stale`;
- opening at an explicit time beyond TTL returns `cursor_expired`;
- duplicate, unknown, empty, and over-limit query input fails closed;
- non-GET methods return a typed method error;
- exactly one cursor-key meta row exists and schema version remains 5.

## Verification status

- latest published `@cloudflare/workers-types`: `5.20260825.1`
- Worker type checks: passed
- Worker tests: 35 passed across 8 files
- protocol tests: 182 passed across 9 files
- owner adapter and smoke tests: 8 passed
- cloud plan/state/deploy tests: 21 passed
- Rust tests and lint, static-assets smoke, vectors, formatting, and Markdown
  link audit: passed
- staging dry-run: existing `EVENTS`, `RepositoryDO`, and exact three staging R2
  bindings retained
- production dry-run: no Queue binding; existing `RepositoryDO` and exact three
  production R2 bindings retained
- bundle: 104.71 KiB, gzip 22.02 KiB
- local startup profile: active 3.9 ms, garbage collection 0.0 ms
- Markdown files checked: 109

The full repository gate and both named-environment dry-runs are green. Startup
timing is a local profile and is not an edge latency claim.

## Non-effects and next gate

There is no schema migration, binding, new secret, Cloudflare resource, remote
Worker version, Queue message, R2 operation, or production change. No remote
request was made.

After the full local gate and ordinary CI, remote staging activation remains
blocked until the account owner approves anonymous enumeration of staging
public artifact IDs/kinds and the possible one-row cursor-key initialization.
