# I3e signed checkpoint evidence — 2026-08-24

- Increment: I3e, protected local key and signed realm checkpoints
- Base commit: `6697e6cd8b0c3f2f75be16896a837e88b524badb`
- Source state: local working tree; commit and CI confirmation pending
- Environment: macOS, Node.js `v24.19.0`, pnpm `10.10.0`, Rust `1.94.1`
- Result: local pass; commit and GitHub Actions CI confirmation pending

## Demonstrated slice

- Schema migration 4 stores canonical detached signature records and one
  generation-based `heads/main` ref per realm.
- `ef keygen` creates a fresh Ed25519 seed file with exclusive creation and
  Unix owner-only permission, while printing only the derived public key and
  path.
- `ef checkpoint` requires an explicit realm, message, and repository-external
  signing-key file. It rejects direct symlinks, broad Unix permissions,
  non-regular/oversize/noncanonical files, and keys that do not match genesis.
- One checkpoint signs genesis, every tree reachable from the selected working
  root, and the new change. The storage boundary recomputes the exact reachable
  set and verifies canonical records and Ed25519 before acceptance.
- Change insertion, signature insertion, working-root recheck, and ref CAS use
  one `IMMEDIATE` SQLite transaction. An invalid signature or stale root leaves
  no change row and does not advance generation.
- Public and members checkpoints use separate messages, ancestry, heads, and
  generations. `ef status` exposes these local ref states independently.
- No signing seed is written to SQLite, artifact bytes, output, bundle fixture,
  documentation evidence, or Cloudflare configuration.

## Targeted verification

```text
cargo test -p ef-store-sqlite --all-targets
  storage tests: 15 pass

cargo test -p ef-cli --all-targets
  unit tests: 2 pass
  subprocess integration tests: 14 pass

cargo test --workspace --all-targets
  Rust workspace tests: 56 pass

cargo clippy --workspace --all-targets --all-features -- -D warnings
  pass
```

## Security and scope boundary

I3e supports only the initial genesis actor key and a plaintext seed file
protected by local filesystem permissions. It does not claim OS keychain or
hardware-token integration, passphrase encryption, key rotation/revocation,
multi-actor authorization, history/diff UI, remote sync, receipt issuance,
semantic-root persistence, or export/import. The seed file needs an encrypted
backup before irreplaceable use because it cannot be recovered from repository
state.

The local key is not a Cloudflare credential. This increment needs no
Cloudflare account, Wrangler login, API token, binding, R2 bucket, Durable
Object, or user action during automated development checks.

## Full verification

With the pinned Node.js 24 and Rust toolchains:

```text
pnpm check
  formatting: pass
  TypeScript typecheck: pass
  protocol tests: 182 pass
  Worker runtime tests: 2 pass
  Rust workspace tests: 56 pass (core: 4; CLI: 16; local store: 15)
  Clippy -D warnings: pass
  independent vector audit: 9 files; accepted 64; rejected 81
  independent bundle reader: pass
  documentation links: 46 Markdown files pass

pnpm build
  @edgefoss/protocol: pass
  @edgefoss/worker Wrangler dry-run: pass
```
