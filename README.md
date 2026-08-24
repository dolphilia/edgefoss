# EdgeFossil

EdgeFossil is an experimental, portable, realm-aware source control system designed to run locally and on Cloudflare Workers.

The repository is in P2 local alpha development. Artifact, bundle, database, and
CLI formats are experimental and must not yet be used for irreplaceable data.

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

## Local CLI

The first local slice initializes one repository and reports its validated
identity. Supply a 32-byte Ed25519 **public** key as 64 lowercase hexadecimal
characters; the CLI neither needs nor stores the corresponding private key.

```bash
cargo run -p ef-cli --bin ef -- init \
  --name "My project" \
  --actor-key "$ACTOR_PUBLIC_KEY_HEX" \
  --path /path/to/project

cargo run -p ef-cli --bin ef -- status --path /path/to/project
```

Initialization creates only `.edgefossil/repository.sqlite3`. Set
`ACTOR_PUBLIC_KEY_HEX` to your 64-character lowercase public-key encoding before
running the example. `status` may run from any descendant directory.

Working-copy tracking intent can then be recorded without reading or storing
file content:

```bash
cargo run -p ef-cli --bin ef -- track --path /path/to/project src/
cargo run -p ef-cli --bin ef -- track --path /path/to/project \
  --realm members ops/runbook.md
cargo run -p ef-cli --bin ef -- track --path /path/to/project \
  --local notes/private.md
cargo run -p ef-cli --bin ef -- status --path /path/to/project \
  --explain ops/runbook.md
```

The default destination is `project/public`; `--realm members`, `--local`, and
`--none` are mutually exclusive. Tracking state is device-local staging intent,
not yet a portable policy artifact or a snapshot. Commands for key creation,
signing, snapshots, and export/import are not implemented yet.

No Cloudflare account or remote resource is required for the current local
checks or CLI. Do not deploy without an explicit environment.

See [the implementation plan](docs/plans/EdgeFossil実装計画書.md) and [contribution guide](CONTRIBUTING.md).
