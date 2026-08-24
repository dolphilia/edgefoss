# I3a local-store foundation evidence — 2026-08-24

- Increment: I3a, SQLite migration and project-genesis persistence
- Commit: `a0146be181e808064ff90d111832eac7d4327fd6`
- Environment: macOS, Node.js `v24.19.0`, pnpm `10.10.0`, Rust `1.94.1`
- SQLite adapter: `rusqlite 0.40.2`, bundled SQLite
- Result: pass; account owner confirmed GitHub Actions success

## Demonstrated slice

- A new file or in-memory database atomically applies numbered schema version 1.
- The canonical shared-vector `project.genesis` body persists under raw digest
  key and reloads as project ID
  `sha256:78ac6588c390ceb2d29f2be9ff9e001d8af391985c0cf865b365ed69b786656e`.
- Repeating byte-identical initialization is idempotent.
- Initializing another project returns `AlreadyInitialized` without changing
  the first project.
- Reopen verifies the stored digest, canonical body, project, realm, kind, and
  schema metadata rather than trusting database columns.
- File databases run with WAL, foreign keys, and FULL synchronous mode and pass
  SQLite `quick_check` after reopen.

## Targeted verification

```text
cargo test -p ef-store-sqlite --all-targets
  storage tests: 6 pass

cargo clippy -p ef-store-sqlite --all-targets --all-features -- -D warnings
  pass
```

## Scope boundary

This is repository initialization, not yet a user-facing `ef init` command.
Blob/ref/policy/working-copy tables and commands are added only with their write
invariants in later I3 increments. Process-kill injection and export/import are
G2 work and are not claimed here.

## Full verification

With the pinned Node.js 24 and Rust toolchains:

```text
pnpm check
  formatting: pass
  TypeScript typecheck: pass
  protocol tests: 182 pass
  Worker runtime tests: 2 pass
  Rust workspace tests: 28 pass (local store: 6)
  Clippy -D warnings: pass
  independent vector audit: 9 files; accepted 64; rejected 81
  independent bundle reader: pass
  documentation links: 38 Markdown files pass

pnpm build
  @edgefoss/protocol: pass
  @edgefoss/worker Wrangler dry-run: pass
```
