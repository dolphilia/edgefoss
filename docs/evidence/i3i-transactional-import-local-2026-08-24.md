# I3i transactional bundle import evidence — 2026-08-24

- Increment: I3i, empty-repository portable restore
- Base commit: `2c33a2bdd43f1c878de52fe23ed2cf0767a7c7f9`
- Source commit: `16a440de74c93b22b336e22083ea144bfe73649e`
- Environment: macOS, Node.js `v24.19.0`, pnpm `10.10.0`, Rust `1.94.1`
- Result: local implementation and full verification pass; commit, push, and
  GitHub Actions CI confirmed by the user

## Demonstrated slice

- `ef import` verifies the target and explicit bases before creating repository
  metadata, then restores public→members→local accepted state into empty realm
  slots.
- One immediate transaction inserts canonical artifacts, blobs, signatures,
  project identity where applicable, and `heads/main`. The generation is
  reconstructed from the verified complete linear change chain.
- The transaction re-exports its uncommitted rows and requires exact manifest
  and object-map equality with the input before commit.
- A forced SQLite abort on signature insertion occurs after artifact/project
  writes and leaves repository, artifact, blob, signature, and ref counts all at
  zero. Removing the fault trigger allows the same bundle to import normally.
- Public, members, and local bundles re-exported from a fresh database are
  byte-for-byte identical to their source directories, including manifests.
- Tracking counts remain zero and all unsigned working roots remain absent.
  Signing seeds, source files, WAL state, receipts, and indexes are not restored.
- Re-import into a non-empty realm fails closed. A hash-corrupted public bundle
  is rejected before `.edgefossil` is created in a new target directory.

## Targeted verification

```text
cargo test -p ef-store-sqlite --all-targets
  storage tests: 21 pass

cargo test -p ef-cli --all-targets
  unit tests: 2 pass
  subprocess integration tests: 18 pass

cargo clippy --workspace --all-targets --all-features -- -D warnings
  pass
```

## Gate impact and scope boundary

The first G2 condition—export→empty import→export semantic-root equality—is now
implemented with byte equality. Realm exclusion remains covered by I3g/I3h.
G2 is not yet complete: process-kill coverage at write points and the 10,000-file
/ 100,000-artifact baseline remain open.

I3i is not sync, clone merge, in-place repair, working-copy checkout, signing-key
recovery, authority restore, R2 upload, encryption, archive framing, or streaming
import. No Cloudflare account, binding, bucket, Durable Object, or user action is
required for this increment.

## Full verification

```text
pnpm check
  format and TypeScript checks: pass
  protocol: 182 tests pass
  Worker: 2 tests pass
  Rust: 66 tests pass
    edgefoss-core: 4
    ef-cli: 20
    ef-format: 21
    ef-store-sqlite: 21
  Rust lint: pass with warnings denied
  shared vectors: 9 files, 64 accepted and 81 rejected cases audited
  bundle vector reader: 1 valid file and 5 invalid cases checked
  documentation: 54 Markdown files, all local links valid
```

```text
pnpm build
  protocol TypeScript build: pass
  Worker Wrangler dry-run build: pass
```
