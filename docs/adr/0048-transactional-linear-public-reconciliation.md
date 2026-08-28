# ADR-0048: Reconcile complete public bundles by prefix only

- Status: Accepted for P5c0 local implementation
- Date: 2026-08-27
- Owners: sync, local storage, conflict, and recovery leads
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

P5a can restore a complete public bundle into an empty SQLite repository, and
P5b can push when the authority head is an ancestor of local history. The
missing inverse is advancing an already initialized local repository when the
downloaded cloud head is its descendant. Reusing the empty import path would
reject the destination; replacing local rows would risk discarding a local
head or device-local working intent.

P5c also needs an explicit boundary between a safe fast-forward and a two-device
conflict before cursor persistence or partial clone increases the state space.

## Decision

Add `reconcile_public_bundle` to the local SQLite store. It deeply verifies a
complete public bundle, compares exact oldest-to-newest linear histories, and
selects `AlreadyCurrent`, `FastForwarded`, `LocalAhead`, or
`SyncHeadConflict`.

Only a remote descendant may mutate local portable state. Every existing local
portable object must be a byte-identical member of the remote bundle. Missing
artifacts, blobs, and signatures plus the public ref advance are applied in one
immediate transaction, then re-exported inside that transaction and compared
with the verified input before commit. Tracking rules and working snapshot
roots remain device-local and unchanged.

A remote ancestor returns `LocalAhead` for the existing push path. Divergence
returns both heads as `SyncHeadConflict`; it never guesses a winner, uses
timestamps, force-pushes, merges, or applies last-writer-wins.

## Alternatives considered

- Re-import into a temporary database and replace the original: rejected
  because it obscures device-local state preservation and ref-CAS semantics.
- Treat every different remote head as pullable set union: rejected because
  artifact union is safe but silently choosing the derived ref is not.
- Automatically merge two linear siblings: rejected until merge artifacts and
  kind-specific conflict rules have their own specification.
- Start with cursor persistence: rejected because resume cannot define correct
  convergence until the terminal local state transition is explicit.

## Consequences

- A complete downloaded descendant can now advance a non-empty local clone and
  exact replay is a no-op.
- A remote ancestor is non-mutating and composes with the P5b push planner.
- Divergent device heads remain visible and block automatic ref movement.
- Current implementation remains public-only, complete-profile, single-parent,
  and local-only. No Worker route, schema, binding, secret, or cloud state
  changes.

## Verification

- the shared TypeScript-generated two-change bundle fast-forwards the imported
  one-change SQLite clone and re-exports byte-identically;
- exact replay returns `AlreadyCurrent`;
- supplying the ancestor to the descendant clone returns `LocalAhead` without
  rollback;
- two clones that commit different children of one parent return
  `SyncHeadConflict` and preserve the original local bundle;
- an injected signature insertion failure rolls back every suffix row and ref
  update, and the unchanged input succeeds after fault removal;
- the full repository gate and named Worker dry-runs must pass before commit.
