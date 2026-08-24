# EdgeFossil

EdgeFossil is an experimental, portable, realm-aware source control system designed to run locally and on Cloudflare Workers.

The repository is in P0 bootstrap. Artifact and bundle formats are not stable and must not yet be used for irreplaceable data.

## Prerequisites

- Node.js 24, as pinned by [`.node-version`](.node-version)
- pnpm 10, as pinned by `packageManager` in [`package.json`](package.json)
- Rust 1.94.1, installed automatically by rustup from [`rust-toolchain.toml`](rust-toolchain.toml)

## Bootstrap

```bash
pnpm install
pnpm types
pnpm check
```

No Cloudflare account or remote resource is required for the P0 checks. Do not deploy without an explicit environment.

See [the implementation plan](docs/plans/EdgeFossil実装計画書.md) and [contribution guide](CONTRIBUTING.md).
