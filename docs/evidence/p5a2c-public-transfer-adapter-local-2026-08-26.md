# P5a2c public transfer adapter local evidence — 2026-08-26

- Increment: opaque anonymous public clone transfer and range resume
- Base commit: `f13d705`
- Environment: local Workers runtime and local R2 only
- Worker repository schema: unchanged at 5
- Remote mutation: none

## Implemented contract

[`ADR 0042`](../adr/0042-opaque-public-transfer-grant-and-resumable-http-adapter.md)
defines a 600-second encrypted grant bound to one complete public clone plan.
The grant uses the existing lazily created `sync_cursor_key_v0` AES-GCM key with
a transfer-specific AAD label; it adds no credential or Cloudflare resource.

`HELLO` advertises `TRANSFER` with the exact limits. Anonymous HTTP clients can
create a complete plan, request at most 16 sorted unique artifacts under the
existing 2 MiB verified-byte budget, and read a blob in explicit ranges of at
most 1 MiB. Every response is `no-store`. Artifact and blob access recomputes
reachability from the planned head, and asynchronous reads finish with a policy
epoch fence.

## Focused results

- Worker runtime: 12 files and 42 tests passed;
- anonymous plan matched the committed cross-runtime vector manifest;
- artifact/signature retries returned byte-identical JSON;
- two blob ranges and a repeated range reconstructed exact vector bytes;
- the assembled response passed protocol bundle verification;
- a dangling accepted public artifact remained unavailable;
- missing and tampered grants returned the same HTTP 401 contract;
- an injected future clock rejected an expired grant;
- a policy epoch advance made an issued grant stale;
- repository schema remained 5 and only the existing sync token key kind was
  used.

## Full gate and dry-runs

The completed full local gate produced:

- protocol: 9 files and 182 tests passed;
- Worker: 12 files and 42 tests passed;
- owner adapter and smoke tools: 12 tests passed;
- cloud plan, state, and deploy tools: 29 tests passed, including the 4-test
  staging transfer-profile audit;
- Rust workspace tests, the 2 cross-runtime clone tests, Clippy, formatting,
  static-assets smoke, protocol vectors, and documentation checks all passed;
- 118 Markdown files passed the documentation and link checker.

Wrangler 4.125.0 named dry-runs passed without deployment. Staging retained
RepositoryDO, three R2 bindings, and the existing `EVENTS` Queue binding.
Production retained RepositoryDO and three R2 bindings without a Queue binding.
Both generated a 144.18 KiB Worker bundle (28.38 KiB gzip).

The local startup profile reported a 13.7 ms profile window, 8.2 ms sampled
time, 3.9 ms active time, and 0.0 ms garbage collection from two samples. This
is a local diagnostic, not an edge latency or production performance claim.

## Non-effects

No deployment, remote request, schema migration, binding or secret change, R2
write, Queue operation, staging mutation, or production change was performed.

## Staging-effect gate

Commit `30b1784` and ordinary CI passed. They do not authorize deployment.
Before a manual staging deploy, the account owner must explicitly approve all
of these effects:

- `HELLO` will advertise `TRANSFER`;
- anonymous plan, artifact, signature, and blob-range routes will be exposed;
- any third party may download every object reachable from the staging public
  head;
- the first plan may create the existing `sync_cursor_key_v0` meta row if it
  does not already exist;
- schema 5, R2 objects, Queue configuration, and production remain unchanged.

After commit `005152d` and its ordinary CI passed, the account owner explicitly
approved all listed P5a2c staging effects. This approval does not authorize a
new artifact, R2 object, ref advance, Queue event, or production change.

## Existing staging profile boundary

The committed P4c staging fixture uses tree logical clock 1 and first-change
clock 2. P5a2b2 deliberately restricts the current Rust-compatible `complete`
profile to tree clock 0 and first-change clock 0. Therefore the existing
staging head must return `clone_profile_unsupported` before grant creation. A
successful remote artifact/blob retry cannot be produced from that state
without a separately approved canonical publication and ref advance.

The dedicated `cloud:audit-public-transfer` command is credential-free and
fixed to the exact staging origin. It first verifies the full anonymous HELLO
contract, then sends one bodyless plan POST and requires HTTP 409, exact
`clone_profile_unsupported`, `no-store`, `nosniff`, and no authentication
challenge. It rejects a successful plan or any other state drift. The manual
deployment workflow runs it after health and HELLO.

This audit performs no artifact or blob read and no remote write. Its focused
matrix has four tests, the full local gate is green, and both named dry-runs
retain the 144.18 KiB bundle and existing binding topology. Commit and ordinary
CI for this approval/audit increment remain the final pre-deploy gate.
