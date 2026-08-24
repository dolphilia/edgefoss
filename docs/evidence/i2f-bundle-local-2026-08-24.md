# I2f bundle local evidence — 2026-08-24

- Increment: I2f, experimental realm bundle and independent reader
- Base commit: `17aee14c9e4d2d51b54c5febb651a4e42ddef15a`
- Source state: local working tree; commit and CI confirmation pending
- Environment: macOS, Node.js `v24.19.0`, pnpm `10.10.0`, Rust `1.94.1`
- Result: local pass; G1 is a go candidate; commit and GitHub Actions CI
  confirmation pending

## Demonstrated slice

- `bundle-v0` is an unpacked deterministic directory with one realm per
  manifest and exact artifact/blob/signature object paths.
- A public bundle has no bases; members requires the public semantic root;
  local requires public and members semantic roots.
- Rust and TypeScript encode the same 12-field canonical manifest, decode it,
  verify its semantic root, and hash every exact inventoried object.
- Missing, extra, and digest-mismatched objects have distinct stable codes.
- A semantic-root claim mismatch and invalid public `base_roots` are rejected.
- The first fixture contains only the canonical project genesis body, matching
  the executable-specification walking skeleton.

## Independent reader

The standalone Node.js reader imports no production codec or CBOR library. It
independently verifies the manifest and virtual directory and runs all five
invalid mutations. Together with the general vector audit, current totals are:

- shared vector files: 9;
- accepted format cases: 64;
- rejected format cases: 81;
- bundle files in the walking-skeleton fixture: 1;
- invalid bundle mutations: 5.

## Gate effect

The detailed [`G1 bundle reassessment`](../reviews/g1-bundle-reassessment-2026-08-24.md)
finds every technical G1 condition satisfied locally. G1 remains a go candidate
until this increment is committed and GitHub Actions succeeds.

## Scope boundary

This increment proves the container boundary and portable root for one genesis
bundle. Import acceptance still invokes artifact/schema/graph/blob/signature
validation and commits atomically. Policy artifact persistence and multi-realm
composed restore move into P2; archive framing and streaming remain P7.

## Verification

With the pinned Node.js 24 and Rust toolchains:

```text
pnpm check
  formatting: pass
  TypeScript typecheck: pass
  protocol tests: 182 pass
  Worker runtime tests: 2 pass
  Rust workspace tests: 22 pass
  Clippy -D warnings: pass
  independent vector audit: 9 files; accepted 64; rejected 81
  independent bundle reader: 1 file; 5 invalid mutations pass
  documentation links: 36 Markdown files pass

pnpm build
  @edgefoss/protocol: pass
  @edgefoss/worker Wrangler dry-run: pass
```
