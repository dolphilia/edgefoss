# I3b CLI init/status evidence — 2026-08-24

- Increment: I3b, usable local `ef init` and `ef status`
- Base commit: `a0146be181e808064ff90d111832eac7d4327fd6`
- Source state: local working tree; commit and CI confirmation pending
- Environment: macOS, Node.js `v24.19.0`, pnpm `10.10.0`, Rust `1.94.1`
- OS randomness adapter: `getrandom 0.4.3`
- Result: local pass; commit and GitHub Actions CI confirmation pending

## Demonstrated slice

- `ef init --name ... --actor-key ... [--path ...]` creates
  `.edgefossil/repository.sqlite3` and commits a canonical project genesis.
- The project nonce comes from the operating system random source; creation
  time is whole-second UTC RFC 3339.
- `ef status [--path ...]` discovers a repository from descendants and reports
  its canonical root, project ID, name, schema version, and integrity result.
- A second initialization fails before generating a replacement identity and
  leaves the original project unchanged.
- Invalid non-canonical public-key/project-name input creates no repository
  metadata, and `status` outside a repository is read-only.
- Metadata-directory and database symbolic links are rejected.
- New Unix metadata/database paths are limited to owner mode `0700`/`0600`.

## Targeted verification

```text
cargo test -p ef-cli --all-targets
  unit tests: 2 pass
  subprocess integration tests: 7 pass

cargo clippy -p ef-cli --all-targets --all-features -- -D warnings
  pass
```

## Scope boundary

The required actor key is public data. I3b does not generate, accept, or store a
private key and does not claim proof that the caller controls one. Signing and
protected key lifecycle belong to the later increment that first writes signed
artifacts. Tracking, snapshots, export/import, and remote operations are also
outside I3b. No Cloudflare account or resource is required.

## Full verification

With the pinned Node.js 24 and Rust toolchains:

```text
pnpm check
  formatting: pass
  TypeScript typecheck: pass
  protocol tests: 182 pass
  Worker runtime tests: 2 pass
  Rust workspace tests: 35 pass (CLI: 9)
  Clippy -D warnings: pass
  independent vector audit: 9 files; accepted 64; rejected 81
  independent bundle reader: pass
  documentation links: 40 Markdown files pass

pnpm build
  @edgefoss/protocol: pass
  @edgefoss/worker Wrangler dry-run: pass
```
