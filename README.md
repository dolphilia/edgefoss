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

Generate an Ed25519 signing key outside the project, then initialize one local
repository with the printed public key. The private seed remains only in the
permission-protected key file; the repository database never stores it.

```bash
cargo run -p ef-cli --bin ef -- keygen \
  --output /safe/path/outside/project/owner.seed

cargo run -p ef-cli --bin ef -- init \
  --name "My project" \
  --actor-key "$ACTOR_PUBLIC_KEY_HEX" \
  --path /path/to/project

cargo run -p ef-cli --bin ef -- status --path /path/to/project
```

Copy the `actor-key` printed by `keygen` into `ACTOR_PUBLIC_KEY_HEX` before
running `init`. Initialization creates only `.edgefossil/repository.sqlite3`.
`status` may run from any descendant directory. Keep the seed file outside the
repository and do not paste its contents into a command, log, issue, or chat.

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
cargo run -p ef-cli --bin ef -- snapshot --path /path/to/project
cargo run -p ef-cli --bin ef -- checkpoint --path /path/to/project \
  --realm public -m "Initial parser" \
  --signing-key-file /safe/path/outside/project/owner.seed
```

The default destination is `project/public`; `--realm members`, `--local`, and
`--none` are mutually exclusive. Tracking state is device-local staging intent,
not a portable policy artifact. `snapshot` reads selected files, builds
realm-isolated raw blobs and canonical trees, and atomically replaces unsigned
working roots. `checkpoint` signs and advances exactly one realm's `heads/main`
ref atomically; use a public-safe message for the public realm. History, diff,
and export/import commands are not implemented yet.

No Cloudflare account or remote resource is required for the current local
checks or CLI. Do not deploy without an explicit environment.

See [the implementation plan](docs/plans/EdgeFossil実装計画書.md) and [contribution guide](CONTRIBUTING.md).
