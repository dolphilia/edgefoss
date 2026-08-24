# I4c bounded static content local evidence — 2026-08-25

- Increment: I4c, P3 bounded file-content delivery and recent timeline
- Base commit: `5fb513971092fd419444776fb71c343652ea97b6`
- Source state: committed as `77558c855ed4097c5ba46fd5f311cc34c6589476`;
  GitHub Actions success confirmed by the repository owner
- Toolchain: Wrangler `4.125.0`, Node.js `24.19.0`, Rust `1.94.1`
- Cloudflare state: no login, remote request, Worker, DO, R2, or other resource
- Result: focused and full workspace verification, assets-only HTTP smoke,
  build, commit, and CI pass

## Demonstrated slice

- Current regular/executable file bodies are deduplicated by artifact ID and
  packed into deterministic linked HTML chunks rather than separate blob files.
- Each chunk is limited to 100 content records and 1 MiB of rendered section
  payload. Complete displayable UTF-8 text is embedded only through 64 KiB.
- Binary, over-limit, and historical-only blobs remain external by artifact ID.
  The manifest records all thresholds, inline/external counts, and per-chunk
  payload sizes for a later R2 or equivalent content store.
- The index shows the five newest verified changes as a recent timeline, while
  full history and file metadata retain deterministic pagination.
- The output remains plain HTML/CSS with no JavaScript, Worker script, binding,
  or provider-specific content URL.

## Disclosure and scaling assertions

- A fixture with 208 current paths over 205 small public text blobs, one binary
  blob, and one 65,537 byte text blob produces three content assets, not 207
  blob assets. Two paths sharing one blob share one content record.
- The manifest reports 205 inline and two external objects. HTML-sensitive file
  content is escaped before packing.
- Members/local fixture markers are absent from every generated output byte.
- The HTTP smoke follows the generated file-content link and serves public text
  from a chunk; members/local markers remain absent.

## Gate impact and remaining scope

G3's bounded chunk/paging condition and local timeline/file-content portion now
have executable evidence. G3 remains open for a final complete-bundle
regeneration audit and remote staging evidence.

U1 is still not reached because the regeneration audit is the next local step.
No Cloudflare preparation is requested from the user in I4c.

## Focused verification

```text
cargo test -p ef-static-site --all-targets
  2 tests pass
cargo clippy -p ef-static-site -p ef-testkit --all-targets --all-features -- -D warnings
  pass
pnpm test:static
  root/staging/production Wrangler dry-run: pass
  local HTTP: public content chunk, realm isolation, manifest counts: pass
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
  documentation: 64 Markdown files, all local links valid

pnpm build
  protocol TypeScript build: pass
  dynamic Worker Wrangler dry-run build: pass
  static profile is verified separately by pnpm test:static: pass
```
