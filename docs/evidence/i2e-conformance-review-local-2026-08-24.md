# I2e conformance-review local evidence — 2026-08-24

- Increment: I2e, independent implementation readiness review and vector audit
- Base commit: `f72eae35978dca36fe66a18059f5aff5d71a98ca`
- Source state: local working tree; commit and CI confirmation pending
- Environment: macOS, Node.js `v24.19.0`, pnpm `10.10.0`, Rust `1.94.1`
- Result: local pass; G1 remains no-go because bundle-v0 is absent; commit and
  GitHub Actions CI confirmation pending

## Demonstrated slice

- Claimed artifact IDs are verified in both runtime APIs with a shared
  `artifact_id_mismatch` result.
- Four canonical-CBOR resource limits are now normative rather than
  implementation-configurable conformance behavior.
- Unknown kind/schema bytes have an explicit opaque-quarantine boundary and
  cannot be published, referenced, or included in semantic roots.
- Signature mutation cases are named in the shared corpus.
- A standalone Node.js audit imports neither production codec and checks eight
  vector files, recorded hashes, semantic roots, Ed25519, and corpus floors.

## Review decision

The detailed review is recorded in
[`G1 independent implementation readiness review`](../reviews/g1-independent-implementation-readiness-2026-08-24.md).
Six discovered gaps were closed or explicitly bounded. Missing `bundle-v0` and
its independent reader remain a gate blocker, so this evidence does not claim
G1 completion.

## Verification

With the pinned Node.js 24 and Rust toolchains:

```text
pnpm check
  formatting: pass
  TypeScript typecheck: pass
  protocol tests: 176 pass
  Worker runtime tests: 2 pass
  Rust workspace tests: 20 pass
  Clippy -D warnings: pass
  independent vector audit: 8 files; accepted 63; rejected 76
  documentation links: 34 Markdown files pass

pnpm build
  @edgefoss/protocol: pass
  @edgefoss/worker Wrangler dry-run: pass
```
