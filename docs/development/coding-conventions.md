# Coding conventions

Status: P0 baseline. Update through reviewed changes when executable evidence requires it.

## General

- Keep portable domain behavior independent from Cloudflare bindings and physical resource IDs.
- Prefer small modules with explicit inputs over mutable process- or isolate-global state.
- Treat all parsed input, remote responses, bundle bytes, and database rows as untrusted until validated.
- Do not log source paths, artifact IDs, change messages, content, credentials, presigned URLs, or restricted counts by default.
- Every asynchronous operation must be awaited, returned, or passed to `ctx.waitUntil()`.
- A behavior change includes its success test, at least one relevant failure test, and rollback/compatibility notes.

## Rust

- Stable Rust only, pinned by `rust-toolchain.toml`.
- `unsafe` is forbidden in workspace crates unless a future ADR defines a narrow audited exception.
- Run `cargo fmt`, `cargo test`, and Clippy with warnings denied.
- Prefer domain-specific types to ambiguous strings once the artifact specification starts in P1.
- Cloudflare adapters must not be dependencies of `edgefoss-core`.

## TypeScript and Workers

- Use strict TypeScript and ES modules.
- Generate `Env` with `wrangler types`; never hand-write a binding interface.
- Use bindings rather than Cloudflare REST calls from inside a Worker.
- Do not buffer unbounded request or response bodies.
- Do not store request-scoped mutable state at module scope.
- Use structured, allowlisted logs and explicit error responses. Do not use `passThroughOnException()`.
- Use Web Crypto for cryptographic hashes, signatures, identifiers, and secret comparison.
- Re-run `pnpm types` and typecheck after every Wrangler binding change.

## Naming

- Rust crates: `edgefoss-*`.
- JavaScript packages: `@edgefoss/*`.
- Cloudflare bindings: uppercase role names such as `PUBLIC_BLOBS`.
- Environment names: `dev`, `staging`, `production`; do not abbreviate `production` to `prod` in external resource names.
- Tests describe observable behavior, not implementation method names.

## Documentation

- ADRs record durable decisions; research notes retain alternatives and evidence.
- Commands in user-facing instructions must be copyable and state whether they mutate local, staging, or production state.
- Never include real secret values in examples.
