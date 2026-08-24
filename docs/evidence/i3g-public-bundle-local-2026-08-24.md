# I3g public bundle evidence — 2026-08-24

- Increment: I3g, accepted public graph export and offline deep verification
- Base commit: `991f3a4fcb91c852ec50fe28079a97681db35654`
- Source commit: `a7f0bbc520f6f0aac8f88be627ac2820abbfd288`
- Environment: macOS, Node.js `v24.19.0`, pnpm `10.10.0`, Rust `1.94.1`
- Result: local pass; commit, push, and GitHub Actions CI confirmed by the user

## Demonstrated slice

- `ef export --realm public --output DIR` starts at accepted public
  `heads/main`; a repository without that checkpoint fails without publishing a
  bundle.
- One SQLite read transaction collects project genesis, complete linear change
  ancestry, all trees/blobs reached by every accepted change, one verified
  signature for every artifact, and the public ref.
- Unsigned working roots, unreachable objects, SQLite/WAL state, and all
  members/local rows are excluded. A combined public/members fixture proves the
  restricted message and ID are absent from output and every bundle file.
- The generated manifest uses the existing experimental `bundle-v0` schema and
  recomputed public semantic root. Output is created in a random sibling
  directory, files use create-new writes, and publication is one final rename;
  existing/symbolic-link destinations are rejected.
- `ef verify DIR` runs without a repository or Cloudflare. It rejects unsafe or
  unexpected directory entries, missing/extra/hash-mismatched objects, invalid
  canonical artifacts, wrong project/realm binding, invalid/missing signatures,
  non-linear/non-contiguous changes, invalid tree/blob edges, and inventory that
  is not the exact graph reachable from `heads/main` plus genesis.
- I3g accepts only standalone public bundles. Members/local export and verify
  fail closed until explicit base bundles can be deep-verified against their
  `base_roots`.

## Targeted verification

```text
cargo test -p ef-store-sqlite --all-targets
  storage tests: 18 pass

cargo test -p ef-cli --all-targets
  unit tests: 2 pass
  subprocess integration tests: 16 pass

cargo clippy -p ef-store-sqlite -p ef-cli --all-targets -- -D warnings
  pass
```

## Scope boundary

I3g does not implement composed members/local or authority-complete export,
transactional import into an empty database, restore, archive framing,
streaming/resume, aggregate bundle limits, encryption, or remote upload. The
next local increments must first verify lower-realm bases, then prove
export→empty import→export preserves the semantic root before G2 is evaluated.

No Cloudflare account, Wrangler login, API token, binding, R2 bucket, Durable
Object, or user action is required for this local bundle increment.

## Full verification

With the pinned Node.js 24 and Rust toolchains:

```text
pnpm check
  formatting: pass
  TypeScript typecheck: pass
  protocol tests: 182 pass
  Worker runtime tests: 2 pass
  Rust workspace tests: 61 pass (core: 4; CLI: 18; local store: 18)
  Clippy -D warnings: pass
  independent vector audit: 9 files; accepted 64; rejected 81
  independent bundle reader: pass
  documentation links: 50 Markdown files pass

pnpm build
  @edgefoss/protocol: pass
  @edgefoss/worker Wrangler dry-run: pass
```
