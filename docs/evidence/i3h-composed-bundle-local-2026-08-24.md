# I3h composed realm bundle evidence — 2026-08-24

- Increment: I3h, explicit members/local base composition
- Base commit: `a7f0bbc520f6f0aac8f88be627ac2820abbfd288`
- Source state: local working tree; commit and CI confirmation pending
- Environment: macOS, Node.js `v24.19.0`, pnpm `10.10.0`, Rust `1.94.1`
- Result: local pass; commit and GitHub Actions CI confirmation pending

## Demonstrated slice

- `ef export --realm members` requires `--base public=DIR`; local requires both
  `--base public=DIR` and `--base members=DIR`.
- Export deep-verifies supplied base directories before opening the selected
  realm graph, then compares their semantic roots with lower-realm accepted
  state inside the same SQLite read transaction.
- `ef verify` verifies bases in public→members order and checks target project,
  actor, exact `base_roots`, and members→public composition before accepting a
  restricted target.
- Members/local object inventories exclude project genesis and every other
  realm's changes, trees, blobs, signatures, refs, paths, messages, and counts.
  The actor trust anchor is obtained from the verified public base.
- Missing, duplicate, extra, incorrectly labeled, cross-project, stale, or
  wrong-root bases fail closed. A failed export does not create its output
  directory.
- The same unpacked `bundle-v0` object paths remain suitable for later separate
  public/restricted/export R2 bindings; no provider identifier enters portable
  state.

## Targeted verification

```text
cargo test -p ef-store-sqlite --all-targets
  storage tests: 19 pass

cargo test -p ef-cli --all-targets
  unit tests: 2 pass
  subprocess integration tests: 17 pass

cargo clippy --workspace --all-targets --all-features -- -D warnings
  pass
```

## Scope boundary

I3h does not create a single authority-complete archive, import bundles into an
empty database, restore tracking intent, stream/resume large exports, encrypt
restricted files, upload to R2, or configure Cloudflare. Callers must apply
appropriate filesystem/access controls to members and local output.

The next increment is transactional empty-database import followed by
export→import→export semantic-root comparison. No Cloudflare user action is
required before that local work.

## Full verification

With the pinned Node.js 24 and Rust toolchains:

```text
pnpm check
  formatting: pass
  TypeScript typecheck: pass
  protocol tests: 182 pass
  Worker runtime tests: 2 pass
  Rust workspace tests: 63 pass (core: 4; CLI: 19; local store: 19)
  Clippy -D warnings: pass
  independent vector audit: 9 files; accepted 64; rejected 81
  independent bundle reader: pass
  documentation links: 52 Markdown files pass

pnpm build
  @edgefoss/protocol: pass
  @edgefoss/worker Wrangler dry-run: pass
```
