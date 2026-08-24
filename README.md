# EdgeFossil

EdgeFossil is an experimental, portable, realm-aware source control system designed to run locally and on Cloudflare Workers.

The repository is in P3 `single-static` development after completing the P2
local-alpha gate. Artifact, bundle, database, site, and CLI formats are
experimental and must not yet be used for irreplaceable data.

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
cargo run -p ef-cli --bin ef -- diff --path /path/to/project \
  --realm public
cargo run -p ef-cli --bin ef -- checkpoint --path /path/to/project \
  --realm public -m "Initial parser" \
  --signing-key-file /safe/path/outside/project/owner.seed
cargo run -p ef-cli --bin ef -- history --path /path/to/project \
  --realm public --limit 20
cargo run -p ef-cli --bin ef -- export --path /path/to/project \
  --realm public --output /safe/export/path/public.edge
cargo run -p ef-cli --bin ef -- verify /safe/export/path/public.edge
cargo run -p ef-cli --bin ef -- static-build \
  /safe/export/path/public.edge \
  --output /safe/publish/path/public-site
cargo run -p ef-cli --bin ef -- export --path /path/to/project \
  --realm members --base public=/safe/export/path/public.edge \
  --output /safe/export/path/members.edge
cargo run -p ef-cli --bin ef -- verify /safe/export/path/members.edge \
  --base public=/safe/export/path/public.edge
cargo run -p ef-cli --bin ef -- export --path /path/to/project \
  --realm local --base public=/safe/export/path/public.edge \
  --base members=/safe/export/path/members.edge \
  --output /safe/export/path/local.edge
cargo run -p ef-cli --bin ef -- import /safe/export/path/public.edge \
  --path /path/to/empty-restore
cargo run -p ef-cli --bin ef -- import /safe/export/path/members.edge \
  --base public=/safe/export/path/public.edge \
  --path /path/to/empty-restore
cargo run -p ef-cli --bin ef -- import /safe/export/path/local.edge \
  --base public=/safe/export/path/public.edge \
  --base members=/safe/export/path/members.edge \
  --path /path/to/empty-restore
```

The default destination is `project/public`; `--realm members`, `--local`, and
`--none` are mutually exclusive. Tracking state is device-local staging intent,
not a portable policy artifact. `snapshot` reads selected files, builds
realm-isolated raw blobs and canonical trees, and atomically replaces unsigned
working roots. `checkpoint` signs and advances exactly one realm's `heads/main`
ref atomically; use a public-safe message for the public realm. `diff` compares
the latest snapshot with that realm's accepted head using structural
name/status output, and `history` walks only that realm's verified checkpoint
chain. `export` writes the complete accepted public graph as an experimental
unpacked `bundle-v0` directory; `verify` checks it offline without the source
database or Cloudflare. The output path must not already exist. A members
bundle requires its exact verified public bundle as `--base`; a local bundle
requires exact public and members bases. Each output still contains only its
own realm, so protect members/local bundle directories according to their
content. A local bundle is an explicit device-backup artifact and is never
included implicitly in project/member export. `import` restores accepted
portable state into an empty repository in public→members→local order. It does
not restore signing secrets, tracking rules, or unsigned working snapshots.
`static-build` deeply verifies exactly one public bundle and atomically creates
a deterministic read-only HTML site. History and current-file metadata are
paged; raw blobs are deliberately not emitted as one asset per object. The
output works without JavaScript, a Worker script, or Cloudflare. Content hunks,
file-content viewing, and historical-change diff are not implemented yet.

The assets-only Cloudflare profile is separate from the dynamic Worker. To
preview an intentionally generated site locally, choose a non-existing ignored
output directory and start Wrangler without an environment:

```bash
cargo run -p ef-cli --bin ef -- static-build \
  /safe/export/path/public.edge \
  --output apps/static-site/dist
pnpm --filter @edgefoss/static-site dev
```

This local preview needs no Cloudflare login. Staging and production deployment
commands remain explicit and must not be run before the corresponding user
checkpoint in the implementation plan.

No Cloudflare account or remote resource is required for the current local
checks or CLI. Do not deploy without an explicit environment.

See [the implementation plan](docs/plans/EdgeFossil実装計画書.md) and [contribution guide](CONTRIBUTING.md).
