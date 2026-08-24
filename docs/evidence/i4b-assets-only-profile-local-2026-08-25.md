# I4b assets-only profile local evidence — 2026-08-25

- Increment: I4b, P3 assets-only Cloudflare profile and local HTTP smoke
- Base commit: `d948a1142a4be6e9f9ddcd01ef2a4b43ef176e01`
- Source state: committed as `5fb513971092fd419444776fb71c343652ea97b6`;
  GitHub Actions success confirmed by the repository owner
- Toolchain: Wrangler `4.125.0`, Node.js `24.19.0`, Rust `1.94.1`
- Cloudflare state: no login, remote request, Worker, DO, R2, or other resource
- Result: focused and full workspace verification, assets-only HTTP smoke,
  build, commit, and CI pass

## Demonstrated slice

- `apps/static-site` is an assets-only Wrangler project. Its config has no
  Worker entry point or runtime bindings and explicitly defines root, staging,
  and production behavior.
- The generator now emits `404.html`; Static Assets serves it with status 404.
- `ef-static-fixture` constructs signed public, members, and local state, exports
  only the public bundle, and runs the production renderer into a unique OS
  temporary directory.
- `tools/smoke-static-assets.mjs` dry-runs every configured environment with the
  temporary site, starts `wrangler dev --local`, performs real HTTP requests,
  then removes all temporary output.

## HTTP assertions

- `/`, history, files, and `edgefossil-site.json` return 200.
- The served HTML is generated fixture output, and the served semantic root
  equals the locally generated manifest root.
- Content Security Policy and `X-Content-Type-Options: nosniff` are present.
- A missing path returns the generated 404 body with status 404.
- `_headers` itself returns 404 rather than being exposed as content.
- Public history/file metadata is present; members/local smoke markers are
  absent.
- Wrangler reports an assets-only deployment; no Worker script is supplied.

## Gate impact and remaining scope

The Worker-script-free local HTTP portion of G3 now has executable evidence.
G3 remains open for bounded file-content delivery, timeline presentation, the
final complete-bundle regeneration audit, and remote staging evidence.

U1 is still not reached because remote deploy is not yet the immediate next
step. No Cloudflare preparation is requested from the user in I4b.

## Focused verification

```text
cargo test -p ef-static-site -p ef-testkit --all-targets
  ef-static-site: 2 tests pass
  ef-testkit: 1 test passes; fixture binary compiles
cargo clippy -p ef-static-site -p ef-testkit --all-targets --all-features -- -D warnings
  pass
pnpm test:static
  root/staging/production Wrangler dry-run: pass
  local HTTP: 200/404, security headers, realm isolation, semantic root: pass
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
    ef-testkit: 1; static fixture binary compiles
  Static Assets: 3 environment dry-runs and local HTTP smoke pass
  Rust lint: pass with warnings denied
  shared vectors: 9 files, 64 accepted and 81 rejected cases audited
  bundle vector reader: 1 valid file and 5 invalid cases checked
  documentation: 62 Markdown files, all local links valid

pnpm build
  protocol TypeScript build: pass
  dynamic Worker Wrangler dry-run build: pass
  static profile is verified separately by pnpm test:static: pass
```
