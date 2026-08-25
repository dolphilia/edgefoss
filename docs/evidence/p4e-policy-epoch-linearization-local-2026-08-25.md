# P4e policy-epoch linearization local evidence — 2026-08-25

- Increment: owner-only revocation-class policy fence
- Base commit: `a9dc3eb`
- Environment: local Workers runtime only
- Repository schema: unchanged at 5
- Remote mutation: none

## Implemented authority boundary

`RepositoryDO.advancePolicyEpoch()` accepts an exact owner principal,
operation ID, and expected policy epoch. A synchronous SQLite transaction
checks the global operation namespace, replays an exact stored result, rejects
a stale epoch, or advances the epoch exactly once.

The operation record is stored under a namespaced key in the existing
`edgefoss_meta` table. Upload and publish reject IDs already used by this policy
operation, and the policy operation rejects IDs used by upload or publish. No
schema migration or schema-version change is required.

This is a revocation ordering fence, not a claim that a concrete member
credential has been revoked. The Single Edition cloud authority still exposes
only the owner principal. Full member ACL artifacts and credential lifecycle
remain later work.

## Workers runtime matrix

The focused tests prove:

- mutation before project initialization returns a typed rejection and stores
  no operation residue;
- 100 exact retries return the one accepted `0 -> 1` epoch transition;
- changed input under the same operation ID returns `operation_conflict`;
- operation IDs cannot cross upload, publish, and policy mutation kinds;
- a stale policy result remains stable after a later epoch advance;
- concurrent publish and policy mutation produce only a legal before-or-after
  result in the RepositoryDO order;
- a publish reaching the transaction after the fence returns a stable
  `policy_conflict`;
- canonical artifact, receipt, and outbox rows accepted before the fence remain
  intact;
- the fence itself creates no artifact, receipt, ref, repo sequence, or outbox
  event.

## Verification status

- latest published `@cloudflare/workers-types`: `5.20260825.1`
- Worker type checks: passed
- Worker tests: 27 passed across 6 files
- protocol tests: 182 passed across 9 files
- owner adapter and smoke tests: 8 passed
- cloud deploy/config tests: 8 passed
- Rust tests and lint, static-assets smoke, vectors, formatting, and Markdown
  link audit: passed
- staging dry-run: existing `EVENTS`, `RepositoryDO`, and exact three staging R2
  bindings retained
- production dry-run: no Queue binding; existing `RepositoryDO` and exact three
  production R2 bindings retained
- bundle: 89.30 KiB, gzip 18.70 KiB
- local startup profile: active 1.3 ms, garbage collection 0.0 ms

## Non-effects and next gate

There is no new HTTP route, schema migration, binding, secret, Cloudflare
resource, remote Worker version, Queue message, R2 object, or production change.
No user action was required. Commit `3bbd9a1` and its ordinary GitHub Actions
run were confirmed successful by the account owner. G4 is therefore go. Full
member ACL and credential revocation remain P6 scope; P4e proves the authority
ordering fence and does not claim those later features.
