# G0 bootstrap evidence — local

- Gate: G0
- Decision: go
- Date: 2026-08-24
- Commit: `eb395ea50f117f9853d393f7fc459b0e6b8ba5b6`
- Environment: local macOS 15.6.1, Apple Silicon
- Owner: implementation DRI
- Reviewers: account owner; GitHub Actions CI
- USER-ACTION checkpoints: U0 complete

## Toolchain

| Tool       | Verified version       |
| ---------- | ---------------------- |
| Node.js    | 24.19.0                |
| pnpm       | 10.10.0                |
| Rust/Cargo | 1.94.1                 |
| Wrangler   | 4.125.0, project-local |

## Commands and results

| Command                                        | Result                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`               | pass                                                                     |
| `pnpm types`                                   | pass; generated Worker runtime and binding types                         |
| `pnpm check`                                   | pass after all P0 ADR and scaffold changes                               |
| `pnpm build`                                   | pass; explicit root environment dry run, 0.96 KiB bundle / 0.53 KiB gzip |
| `pnpm --filter @edgefoss/worker check:startup` | pass; local startup profile only, not a production target                |
| GitHub Actions `CI` on `eb395ea`               | pass; account-owner confirmation and public workflow badge               |

The `pnpm check` aggregate covers Prettier, `cargo fmt`, TypeScript source/test typechecking, Workers runtime tests, Rust tests, Clippy with warnings denied, and local Markdown link validation.

## Implemented G0 artifacts

- Node, pnpm, Rust, TypeScript, Wrangler, and dependency lockfiles
- Cargo/pnpm workspace scaffold
- generated Worker `Env`, local Workers runtime tests, dry-run build, startup profile command
- minimal portable Rust core with forbidden unsafe code and unit test
- CI workflow with read-only repository permission
- coding, contribution, release, resource naming, quality target, gate evidence, and threat-model documents
- ADR template/index and all eight P0 architecture decisions, plus artifact ID text representation

## Remaining risks

- P1 format/schema documents and cross-language golden vectors have not started.
- No Cloudflare login, account ID, remote resource, billing product, or credential was used or created.
- Startup measurements are local diagnostic evidence only and must not become a release threshold.

## Fallback

All new runtime state is local and reproducible from lockfiles. No remote rollback is required.

CI status: [GitHub Actions](https://github.com/dolphilia/edgefoss/actions/workflows/ci.yml) / [badge](https://github.com/dolphilia/edgefoss/actions/workflows/ci.yml/badge.svg)
