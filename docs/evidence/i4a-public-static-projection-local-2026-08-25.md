# I4a public static projection local evidence — 2026-08-25

- Increment: I4a, first P3 `single-static` local slice
- Base commit: `0da98c81808b1362de0f9b4c67e5843055a35c90`
- Source state: local working tree; commit and CI confirmation pending
- Environment: local Rust `1.94.1`; no Cloudflare account or network resource
- Result: focused renderer/CLI tests, full workspace verification, and build
  pass; commit and CI confirmation pending

## Demonstrated slice

- `ef-static-site` projects a deeply verified public bundle into deterministic,
  read-only HTML/CSS plus `edgefossil-site.json`.
- `ef static-build PUBLIC_BUNDLE_DIRECTORY --output SITE_DIRECTORY` reuses the
  hardened directory bundle reader and publishes through an atomic rename.
- Output contains an index, paged history, paged current-file metadata, shared
  CSS, and static security headers. It requires no JavaScript, Worker script,
  Durable Object, R2 bucket, or Cloudflare account.
- The manifest binds the output to the public project and semantic root and
  records an external content-addressed payload boundary. Raw blobs are not
  expanded into separately deployed assets.

## Local assertions

- Rebuilding the same complete public bundle produces byte-identical files.
- A 205-file fixture produces at least three file pages at 100 logical records
  per page; it produces no `blobs/` output directory.
- The source fixture also contains members and local markers. Neither marker is
  present in any generated output byte.
- Members bundles are rejected before projection, corrupt public blobs fail
  deep verification, and HTML-sensitive project/message text is escaped.
- CLI E2E generates two identical site directories and refuses to overwrite an
  existing destination.

## Gate impact and remaining scope

This establishes the local generator portion of G3 and the page/chunk direction.
G3 remains open: file-content/timeline presentation, the assets-only Wrangler
profile, local HTTP smoke, and complete-bundle regeneration evidence at the
deploy boundary are still required.

U1 is not reached. The user should not perform Wrangler login or Cloudflare
configuration until the local assets-only profile and serving smoke are green
and remote deployment is the immediate next action.

## Focused verification

```text
cargo test -p ef-static-site --all-targets
  2 tests pass
cargo test -p ef-cli --all-targets
  21 tests pass (2 unit, 19 CLI E2E)
cargo clippy -p ef-static-site -p ef-cli --all-targets --all-features -- -D warnings
  pass
```

## Full verification

```text
pnpm check
  format and TypeScript checks: pass
  protocol: 182 tests pass
  Worker: 2 tests pass
  Rust: 71 tests pass, 1 subprocess helper ignored in the ordinary run
    edgefoss-core: 4
    ef-cli: 21
    ef-format: 21
    ef-static-site: 2
    ef-store-sqlite: 22 pass, 1 ignored
    ef-testkit: 1
  Rust lint: pass with warnings denied
  shared vectors: 9 files, 64 accepted and 81 rejected cases audited
  bundle vector reader: 1 valid file and 5 invalid cases checked
  documentation: 60 Markdown files, all local links valid

pnpm build
  protocol TypeScript build: pass
  Worker Wrangler dry-run build: pass
```
