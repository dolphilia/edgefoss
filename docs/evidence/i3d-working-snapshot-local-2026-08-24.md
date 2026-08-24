# I3d working snapshot evidence — 2026-08-24

- Increment: I3d, realm-isolated unsigned working snapshots
- Base commit: `e65344d6ef62435cf336078932d85e2e3f389e1e`
- Source state: local working tree; commit and CI confirmation pending
- Environment: macOS, Node.js `v24.19.0`, pnpm `10.10.0`, Rust `1.94.1`
- Result: local pass; commit and GitHub Actions CI confirmation pending

## Demonstrated slice

- Schema migration 3 stores realm-owned raw blobs and unsigned working roots.
- `ef snapshot` walks effective tracked selectors, skips `none`, reads bounded
  stable file content, and builds canonical child-first schema-0 trees.
- Public, members, and local roots are constructed and committed independently;
  changing only members content leaves public and local roots unchanged.
- Identical public/members bytes use separate realm rows despite sharing their
  logical SHA-256 digest.
- Executable mode and safe relative symbolic links are representable; a symlink
  escaping the repository aborts without replacing the prior root.
- Storage rechecks blob/tree IDs, project, realm, genesis actor metadata, and
  every blob/tree dependency inside the root-replacement transaction.
- Clearing or replacing roots retains immutable objects for later reuse/GC.

## Targeted verification

```text
cargo test -p edgefoss-core --all-targets
  core tests: 4 pass

cargo test -p ef-store-sqlite --all-targets
  storage tests: 13 pass

cargo test -p ef-cli --all-targets
  unit tests: 2 pass
  subprocess integration tests: 12 pass

cargo clippy --workspace --all-targets --all-features -- -D warnings
  pass
```

## Scope boundary

Working roots are unsigned local staging state. No change/checkpoint artifact,
signature, historical ref, semantic-root update, diff, export, or sync is
claimed. File reads are capped at 16 MiB and use best-effort concurrent-change
detection; large blobs and descriptor-relative race hardening remain later
work. No Cloudflare account or resource is required.

## Full verification

With the pinned Node.js 24 and Rust toolchains:

```text
pnpm check
  formatting: pass
  TypeScript typecheck: pass
  protocol tests: 182 pass
  Worker runtime tests: 2 pass
  Rust workspace tests: 50 pass (core: 4; CLI: 14; local store: 13)
  Clippy -D warnings: pass
  independent vector audit: 9 files; accepted 64; rejected 81
  independent bundle reader: pass
  documentation links: 44 Markdown files pass

pnpm build
  @edgefoss/protocol: pass
  @edgefoss/worker Wrangler dry-run: pass
```
