# P5a2b2 cross-runtime public clone evidence — 2026-08-26

- Increment: deterministic Worker-to-Rust public clone import
- Base commit: `bee3d69`
- Environment: local Workers runtime, local R2, and in-memory local SQLite only
- Worker repository schema: unchanged at 5
- Remote mutation: none

## Implemented contract

[`ADR 0041`](../adr/0041-cross-runtime-public-clone-import-contract.md)
defines the complete-profile compatibility fence and the shared signed vector.
The Worker now rejects histories that the current Rust importer cannot
reconstruct, including nonzero tree clocks and noncontiguous or nonzero-based
linear change clocks.

`spec/vectors/public-clone-v0.json` contains the exact canonical manifest, three
signed artifacts, one blob, and three signature records. Its generator uses
only fixed public test material and `vectors:check` reproduces it byte for byte.

## Focused results

- deterministic vector generation check: passed;
- Worker runtime: exact plan, artifact/signature transfer, blob chunk, and
  protocol object verification passed;
- Worker incompatible-clock rejection: passed;
- Rust deep portable verification: passed;
- Rust fresh import: generation 1, public realm, expected project passed;
- Rust manifest and every re-exported object byte equal the Worker vector;
- corrupt vector left the destination empty and valid retry passed;
- replay rejection preserved the accepted re-export;
- existing injected mid-transaction import rollback test remains the direct
  partial-write atomicity proof.

## Full gate and dry-runs

The completed full local gate produced:

- protocol: 9 files and 182 tests passed;
- Worker: 11 files and 41 tests passed;
- owner adapter and smoke tools: 12 tests passed;
- cloud plan, state, and deploy tools: 25 tests passed;
- Rust workspace tests, the 2 new cross-runtime integration tests, Clippy,
  formatting, static-assets smoke, protocol vectors, and documentation checks
  all passed;
- 116 Markdown files passed the documentation and link checker.

Wrangler 4.125.0 named dry-runs passed without deployment. Staging retained
RepositoryDO, three R2 bindings, and the existing `EVENTS` Queue binding.
Production retained RepositoryDO and three R2 bindings without a Queue binding.
Both generated a 129.06 KiB Worker bundle (26.27 KiB gzip).

The local startup profile reported a 12.3 ms profile window, 5.3 ms sampled
time, and 0.0 ms active/GC time from one sample. This is a local diagnostic, not
an edge latency or production performance claim.

## Discovered compatibility gap

The first vector used tree clock 1 and first-change clock 2, matching an older
Workers-only fixture. Rust correctly rejected it because the current complete
profile starts the first change at zero and requires trees at zero. The Worker
planner now checks the complete Rust profile before emitting a manifest, and a
regression test keeps the incompatible history rejected.

## Non-effects

The implementation adds no HTTP route or capability, migration, binding,
credential, remote R2/Queue operation, Worker version, staging change, or
production change. No Cloudflare-side user work is required.

## Next gate

The full local gate and named staging/production dry-runs are complete. After
commit and ordinary CI succeed, P5a2c may design the external transfer grant and
adapter; no remote publication effect is authorized by P5a2b2.
