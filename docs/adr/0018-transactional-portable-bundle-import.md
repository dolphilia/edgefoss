# ADR 0018: Reconstruct accepted SQLite state transactionally from portable bundles

- Status: accepted
- Date: 2026-08-24
- Decision owners: local storage, CLI, format, and recovery maintainers
- Applies to: I3i local repository alpha

## Context

I3h can verify a three-realm bundle composition without its source database.
Recovery still requires rebuilding a usable local repository without treating a
raw SQLite file, WAL, Durable Object database, R2 key layout, or authority
receipt as portable project state.

Importing into an active realm would require merge/conflict semantics and could
silently combine unrelated histories. Restoring device-local tracking rules or
unsigned snapshots would also misrepresent transport-specific working state as
accepted repository meaning.

## Decision

- `ef import BUNDLE --path DIR` accepts the same explicit lower-realm `--base`
  options as verification. The target bundle and all bases are deep-verified
  before filesystem metadata is created or SQLite is mutated.
- Public import requires a database with no repository, artifact, blob,
  signature, or ref rows and initializes project identity from the verified
  genesis artifact. Members/local import requires the same project, already
  restored exact lower-realm roots, and an empty target realm.
- Import writes canonical artifacts, raw blobs, detached signatures, and the
  realm `heads/main` ref inside one immediate SQLite transaction. Any format,
  constraint, fault-injection, base, or reconstruction error rolls back every
  portable row from that import.
- The v0 checkpoint chain is linear and its exact change inventory is reachable;
  ref generation is therefore reconstructed as the number of imported changes.
  Generation remains physical CAS state and is not added to semantic-root input.
- Before commit, the importer rebuilds a bundle from the newly inserted rows in
  the same transaction. Manifest and all object paths/bytes must equal the input
  bundle exactly.
- Tracking intent, unsigned working snapshot roots, signing seeds, filesystem
  content, authority receipts/sequences, indexes, caches, and SQLite/WAL details
  are not imported.
- The CLI creates `.edgefossil` and the database only after verification. If an
  import into newly created metadata fails, those newly created files are
  removed; cleanup failure is reported alongside the original error.

## Consequences

- Export→empty import→export produces byte-identical realm bundles, which is
  stronger than semantic-root equality for the current deterministic container.
- A restored repository can serve history/status and later accept a new working
  snapshot, but the operator must separately supply the matching signing key to
  create future checkpoints.
- Import is intentionally not clone merge, pull, sync, or in-place repair.
  Re-importing an existing realm is rejected instead of being treated as
  idempotent or overwriting state.
- Local backup remains explicit and restores only when its exact public and
  members bases are supplied.
- The same validated object-to-row reducer can later target Durable Object
  SQLite or another physical store, while provider operational state is rebuilt
  separately.

## Rejected alternatives

- Copy the source SQLite file: rejected because it couples recovery to schema,
  WAL mode, derived/local rows, and one physical implementation.
- Import into a non-empty realm with `INSERT OR IGNORE`: rejected because it can
  hide conflicts and does not prove the resulting accepted graph.
- Restore tracking rules and working roots: rejected because they are
  device-local intent and unsigned staging state.
- Preserve an exported ref generation field: rejected because `bundle-v0` does
  not include authority/physical generations and linear history reconstructs the
  local CAS value exactly.
- Commit rows and verify afterward: rejected because a verifier failure could
  expose partial or semantically invalid accepted state.

## Verification

Storage tests import public→members→local into a fresh database, re-export each
realm byte-for-byte, reject a repeated realm, and inject a signature-table abort
after earlier inserts to prove complete rollback. CLI subprocess tests repeat
the full three-realm restore, verify heads/generations and absence of working
state, compare every re-exported file, and prove a corrupted bundle creates no
repository metadata.
