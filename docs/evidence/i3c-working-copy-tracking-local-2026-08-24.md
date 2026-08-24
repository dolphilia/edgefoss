# I3c working-copy tracking evidence — 2026-08-24

- Increment: I3c, local tracking intent and explanation
- Base commit: `c4b6115b267d600f9fce262e4d3bd17411f7366b`
- Source state: local working tree; commit and CI confirmation pending
- Environment: macOS, Node.js `v24.19.0`, pnpm `10.10.0`, Rust `1.94.1`
- Result: local pass; commit and GitHub Actions CI confirmation pending

## Demonstrated slice

- Schema migration 2 adds project-bound working-copy tracking rows and upgrades
  a schema-1 database without changing repository identity.
- `ef track TARGET` records project/public intent; `--realm members`, `--local`,
  and `--none` select the other supported destinations.
- Existing directories become prefix selectors; files and symbolic-link entries
  become exact selectors.
- Exact rules override prefixes, and otherwise the longest matching prefix wins.
- `ef status` reports explicit destination counts and `--explain TARGET` reports
  the effective result and its source rule.
- Invalid mode combinations, traversal/absolute paths, repository metadata, and
  writes before project initialization are rejected.
- Database constraints independently reject tracked rows without their required
  realm, rather than relying only on the Rust constructor.

## Targeted verification

```text
cargo test -p ef-store-sqlite --all-targets
  storage tests: 11 pass

cargo test -p ef-cli --all-targets
  unit tests: 2 pass
  subprocess integration tests: 10 pass (including traversal and absolute-path rejection)

cargo clippy --workspace --all-targets --all-features -- -D warnings
  pass
```

## Scope boundary

The new table is device-local working-copy intent, not a portable policy
artifact and not artifact-graph state. I3c reads only filesystem metadata needed
to choose exact versus prefix scope; it does not read content or create
blob/tree/change artifacts. Channel policy (`sync`, Web, archive), snapshot
collision handling, `.efignore`, project attributes, and signing remain later
increments. No Cloudflare account or resource is required.

## Full verification

With the pinned Node.js 24 and Rust toolchains:

```text
pnpm check
  formatting: pass
  TypeScript typecheck: pass
  protocol tests: 182 pass
  Worker runtime tests: 2 pass
  Rust workspace tests: 43 pass (CLI: 12; local store: 11)
  Clippy -D warnings: pass
  independent vector audit: 9 files; accepted 64; rejected 81
  independent bundle reader: pass
  documentation links: 42 Markdown files pass

pnpm build
  @edgefoss/protocol: pass
  @edgefoss/worker Wrangler dry-run: pass
```
