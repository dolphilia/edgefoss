# I3j external process-kill evidence — 2026-08-25

- Increment: I3j, deterministic local SQLite crash-recovery harness
- Base commit: `16a440de74c93b22b336e22083ea144bfe73649e`
- Source commit: `e437aa17905ca92331cb6ef0cb1e1400c2127d7b`
- Environment: macOS, Node.js `v24.19.0`, pnpm `10.10.0`, Rust `1.94.1`
- Result: local implementation and full verification pass; commit, push, and
  GitHub Actions CI confirmed by the user

## Demonstrated slice

- A parent Rust test launches the storage test binary as a one-test child,
  waits for a separately synced marker, and externally terminates the child.
  The target operation does not return and Rust destructors do not perform the
  rollback.
- Eighteen named logical write points are exercised:
  - initialization: artifact, repository identity, commit;
  - snapshot replacement: old-root deletion, blob, tree, new root, commit;
  - signed checkpoint: change, signature, ref, commit;
  - portable import: artifact, repository identity, blob, signature, ref,
    commit.
- Every pre-commit termination reopens as the complete prior state. Every
  post-commit termination reopens as the complete new state.
- Every reopened file passes SQLite `integrity_check` and
  `foreign_key_check`. Identity, working roots, artifacts, blobs, signatures,
  refs, and verified history are checked according to the operation boundary.
- The child helper is ignored during an ordinary direct test run and is invoked
  only by the parent with the explicit ignored-test selector. Fault arming and
  marker handling are compiled only for tests; production uses an inlined
  no-op.

## Targeted verification

```text
cargo test -p ef-store-sqlite --lib \
  process_kill_at_local_transaction_write_points_preserves_atomic_state
  parent test: pass
  externally terminated child cases: 18 pass

cargo test -p ef-store-sqlite --all-targets
  storage tests: 22 pass, 1 child helper ignored

cargo clippy -p ef-store-sqlite --all-targets --all-features -- -D warnings
  pass
```

## Gate impact and scope boundary

The G2 process-kill condition is satisfied for the local-alpha write
transactions. Together with I3g–I3i, semantic restore and realm exclusion are
also covered. G2 remains open only for the 10,000-file / 100,000-artifact local
baseline and its recorded command timings.

This harness does not claim Durable Object, R2, Queue, Workflow, network retry,
or host-power-loss coverage. Those provider boundaries retain separate fault
tests in later phases. No Cloudflare account, binding, bucket, Durable Object,
or user action is required for I3j.

## Full verification

```text
pnpm check
  format and TypeScript checks: pass
  protocol: 182 tests pass
  Worker: 2 tests pass
  Rust: 67 tests pass, 1 subprocess helper ignored in the ordinary run
    edgefoss-core: 4
    ef-cli: 20
    ef-format: 21
    ef-store-sqlite: 22 pass, 1 ignored
  Rust lint: pass with warnings denied
  shared vectors: 9 files, 64 accepted and 81 rejected cases audited
  bundle vector reader: 1 valid file and 5 invalid cases checked
  documentation: 56 Markdown files, all local links valid
```

```text
pnpm build
  protocol TypeScript build: pass
  Worker Wrangler dry-run build: pass
```
