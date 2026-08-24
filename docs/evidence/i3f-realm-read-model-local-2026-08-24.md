# I3f realm read-model evidence — 2026-08-24

- Increment: I3f, verified realm history and structural working diff
- Base commit: `4ad5c780437dd0e1b6a931b10297e70259f71746`
- Source state: local working tree; commit and CI confirmation pending
- Environment: macOS, Node.js `v24.19.0`, pnpm `10.10.0`, Rust `1.94.1`
- Result: local pass; commit and GitHub Actions CI confirmation pending

## Demonstrated slice

- `ef history --realm R` starts only at R's `heads/main`, walks its linear
  parent chain newest-first, and applies a bounded 1–1000 entry limit.
- History reads revalidate canonical IDs, the genesis/change/root signatures,
  and resolved project/realm/kind/logical-clock graph edges rather than trusting
  SQLite row presence alone.
- `ef diff --realm R` compares R's latest unsigned working snapshot with R's
  accepted head, or an empty tree before its first checkpoint. It does not read
  the live filesystem or another realm.
- Structural diff reports deterministic added/modified/deleted path and entry
  mode. File, executable, and symlink target changes are significant;
  directory target hashes are suppressed so leaf edits do not mark all parent
  directories modified.
- Public and members E2E fixtures prove that selected history, counts, IDs,
  messages, paths, and diff output do not contain the other realm's values.
- Stored-signature corruption makes both history and accepted-head diff fail
  closed. Terminal control characters in messages are escaped before output.
- The read model is derived from canonical state and requires no schema change
  beyond I3e's version 4.

## Targeted verification

```text
cargo test -p ef-store-sqlite --all-targets
  storage tests: 17 pass

cargo test -p ef-cli --all-targets
  unit tests: 2 pass
  subprocess integration tests: 15 pass

cargo clippy --workspace --all-targets --all-features -- -D warnings
  pass
```

## Scope boundary

I3f does not render text/binary hunks, inspect unsnapshotted filesystem edits,
detect renames, select arbitrary historical change IDs, display merge DAGs,
persist projection caches, or implement export/import. Those capabilities must
retain the explicit realm boundary and accepted-artifact reachability rules.

No Cloudflare account, Wrangler login, API token, binding, R2 bucket, Durable
Object, or user action is required for this local read increment.

## Full verification

With the pinned Node.js 24 and Rust toolchains:

```text
pnpm check
  formatting: pass
  TypeScript typecheck: pass
  protocol tests: 182 pass
  Worker runtime tests: 2 pass
  Rust workspace tests: 59 pass (core: 4; CLI: 17; local store: 17)
  Clippy -D warnings: pass
  independent vector audit: 9 files; accepted 64; rejected 81
  independent bundle reader: pass
  documentation links: 48 Markdown files pass

pnpm build
  @edgefoss/protocol: pass
  @edgefoss/worker Wrangler dry-run: pass
```
