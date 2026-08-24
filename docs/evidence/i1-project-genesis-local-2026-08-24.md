# I1 `project.genesis` local evidence — 2026-08-24

- Increment: I1
- Base commit: `eb395ea50f117f9853d393f7fc459b0e6b8ba5b6`
- Commit: `ef39b8de0dc59cf30e5425949fbd39885181e651`
- Environment: macOS, Node.js `v24.19.0`, pnpm `10.10.0`, Rust `1.94.1`
- Result: pass; account owner confirmed GitHub Actions CI success

## Demonstrated slice

- `project.genesis` schema 0 has an exact normative envelope and payload.
- Rust and TypeScript independently encode the same logical input to the same
  canonical CBOR bytes and `sha256:` artifact ID.
- Both implementations decode the shared valid vector and reject the same seven
  malformed/non-canonical vectors with the same error category.
- The expected vector ID is
  `sha256:78ac6588c390ceb2d29f2be9ff9e001d8af391985c0cf865b365ed69b786656e`.

## Verification

With the pinned Node.js and Rust binaries on `PATH`:

```text
pnpm check
  format: pass
  TypeScript typecheck: pass
  TypeScript tests: 11 pass (protocol 9, Worker 2)
  Rust tests: 3 pass
  Clippy -D warnings: pass
  documentation link check: pass (27 Markdown files)

pnpm build
  @edgefoss/protocol TypeScript build: pass
  @edgefoss/worker Wrangler dry-run build: pass
```

The first sandboxed Worker test attempt failed because the test runtime could
not bind localhost or write Wrangler's normal user log directory. Re-running
the same repository command outside that filesystem/network sandbox with
`WRANGLER_LOG_PATH` directed to a temporary file passed. This was an execution
environment restriction, not a test failure.

## Scope boundary

This evidence completes I1. It does not pass G1. G1 still
requires tree/change/path/realm/signature/semantic-root implementations and at
least 50 valid plus 50 invalid shared vectors.
