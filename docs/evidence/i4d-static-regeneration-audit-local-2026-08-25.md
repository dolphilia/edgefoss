# I4d static regeneration audit local evidence — 2026-08-25

- Increment: I4d, P3 complete-bundle regeneration and served-byte audit
- Base commit: `77558c855ed4097c5ba46fd5f311cc34c6589476`
- Source state: local working tree; commit and CI confirmation pending
- Toolchain: Wrangler `4.125.0`, Node.js `24.19.0`, Rust `1.94.1`
- Cloudflare state: no login, remote request, Worker, DO, R2, or other resource
- Result: focused and full workspace verification, CLI regeneration,
  assets-only served-byte audit, and build pass; commit and CI confirmation
  pending

## Complete-bundle regeneration audit

The CLI integration fixture creates signed public, members, and local history,
then exports the complete public bundle. It performs these two independent
paths:

1. build the source public bundle directly into a static site;
2. import that bundle into an empty repository, re-export public state, and
   build the restored bundle into another static site.

The audit requires all of the following:

- every re-exported manifest, artifact, blob, and signature byte equals the
  corresponding source-bundle byte;
- both `static-build` commands report the same semantic root;
- the two recursively enumerated static output trees have the same relative
  paths and byte-identical contents.

This exercises the actual `ef export`, `ef import`, and `ef static-build` CLI
boundaries rather than comparing two calls to the renderer in one process.

## Served-byte audit

The assets-only smoke still generates its site from a signed multi-realm
fixture through the production renderer. After Wrangler starts locally, the
smoke recursively enumerates every generated deployable asset and requires the
HTTP 200 response body to equal the generated file byte-for-byte. `_headers` is
excluded because it is deployment metadata and must return 404. The body served
for an unknown route must equal generated `404.html` while retaining status 404.

The audit also retains all prior assertions: no Worker script, three explicit
environment dry-runs, security headers, public content navigation, restricted
marker absence, and served/generated semantic-root equality.

## Gate impact and user checkpoint

All four G3 conditions now have local executable evidence:

- scriptless public viewing works through Workers Static Assets locally;
- only deeply verified public bundles can enter the projection;
- empty restore and complete re-export regenerate the identical site/root;
- paging and bounded content chunks avoid one artifact per asset.

G3 remains open only for remote staging evidence. U1 becomes the immediate next
checkpoint after this increment is committed and CI succeeds. No account login
or Cloudflare preparation was performed as part of I4d.

## Focused verification

```text
cargo test -p ef-cli --test init_status \
  regenerates_an_identical_static_site_after_empty_repository_restore -- --exact
  1 test passes
pnpm test:static
  root/staging/production Wrangler dry-run: pass
  6 deployable files served byte-identically; generated 404 body matches: pass
```

## Full verification

```text
pnpm check
  format and TypeScript checks: pass
  protocol: 182 tests pass
  Worker: 2 tests pass
  Rust: 72 tests pass, 1 subprocess helper ignored in the ordinary run
    edgefoss-core: 4
    ef-cli: 22
    ef-format: 21
    ef-static-site: 2
    ef-store-sqlite: 22 pass, 1 ignored
    ef-testkit: 1; static fixture binary compiles
  Static Assets: 3 environment dry-runs; 6 served files audited
  Rust lint: pass with warnings denied
  shared vectors: 9 files, 64 accepted and 81 rejected cases audited
  bundle vector reader: 1 valid file and 5 invalid cases checked
  documentation: 65 Markdown files, all local links valid

pnpm build
  protocol TypeScript build: pass
  dynamic Worker Wrangler dry-run build: pass
  static profile is verified separately by pnpm test:static: pass
```
