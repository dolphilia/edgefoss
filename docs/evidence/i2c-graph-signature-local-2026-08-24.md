# I2c graph/signature local evidence — 2026-08-24

- Increment: I2c, graph and signature executable specification
- Base commit: `f973cc38202e34bb6402be6a7763b75f3129e55b`
- Source state: local working tree; commit and CI confirmation pending
- Environment: macOS, Node.js `v24.19.0`, pnpm `10.10.0`, Rust `1.94.1`
- Result: local pass; commit and GitHub Actions CI confirmation pending

## Demonstrated slice

- Rust and TypeScript resolve schema-0 change roots and parents using the same
  authorization-neutral summary contract.
- Both reject cross-project roots/parents, forbidden realm flow, wrong kinds,
  unavailable required semantics, and same-actor logical-clock replay with the
  same code.
- Different actors' numeric clocks remain independent; parent edges carry
  causality.
- Detached signature records use canonical CBOR but do not alter artifact IDs.
- Both runtimes construct the same 65-byte domain-separated message and verify
  the same Ed25519 signature.
- Modified signatures, actor-key mismatch, and artifact-ID mismatch all return
  `invalid_signature` without a distinguishing public diagnostic.

## Runtime decision

The TypeScript implementation uses the standards-based Web Crypto `Ed25519`
algorithm and raw public-key import. Node.js 24 and Cloudflare Workers currently
support this combination. The legacy Workers-only `NODE-ED25519` name is not
used.

## New shared cases

- change graph decisions: 14;
- signature valid record/message: 1;
- signature binding/mutation failures: 3 in each implementation.

## Verification

With the pinned Node.js 24 and Rust toolchains:

```text
pnpm check
  formatting: pass
  TypeScript typecheck: pass
  protocol tests: 164 pass
  Worker runtime tests: 2 pass
  Rust workspace tests: 16 pass
  Clippy -D warnings: pass
  documentation links: 31 Markdown files pass

pnpm build
  @edgefoss/protocol: pass
  @edgefoss/worker Wrangler dry-run: pass
```

## Scope boundary

I2c verifies one signature against the actor key carried by an already-decoded
artifact. Owner/key rotation policy and multi-signature authorization remain
future policy artifacts. I2d must still implement semantic roots and prove that
members-only changes cannot alter the public root.
