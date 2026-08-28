# EdgeFossil linear public reconciliation v0

Profile identifier: `edgefossil-public-reconcile-linear-v0`

Status: experimental candidate. This profile selects a safe direction between
one initialized local SQLite repository and one deeply verified complete public
bundle. It is a local state transition, not an HTTP wire format.

## Inputs and preconditions

The remote input MUST pass complete `edgefossil-bundle-v0` verification before
the local write transaction begins. Both sides MUST represent the same project,
the public realm, `heads/main`, and exact single-parent change histories. Merge
history and changes outside the reachable head closure are unsupported.

The implementation compares oldest-to-newest change IDs. Device-local tracking
rules and working snapshots are outside portable state and MUST NOT be deleted
or replaced by reconciliation.

## Direction selection

Exactly one result is selected:

- equal histories: `already_current`; perform no portable mutation;
- the local history is an exact prefix of remote: `fast_forwarded`;
- the remote history is an exact prefix of local: `local_ahead`; perform no
  mutation so the caller may use the push planner;
- neither is a prefix: `sync_head_conflict`; preserve both heads and perform no
  mutation.

Timestamp order, last-writer-wins, force push, and automatic merge MUST NOT be
used to turn divergence into a fast-forward.

## Transactional fast-forward

Before inserting a remote suffix, every local portable object MUST occur with
identical bytes in the remote complete bundle. The implementation then inserts
only missing artifacts, blobs, and signatures, and compare-and-swap updates the
public ref from the exact local target/generation to the remote target and
history length in one immediate SQLite transaction.

Before commit, rebuilding the accepted public bundle MUST reproduce the
verified remote manifest and object map exactly. Any validation, insertion,
ref-CAS, or reconstruction failure rolls the entire suffix back. Repeating a
successful input MUST return `already_current` without creating new rows.

## Scope and non-claims

This first P5c profile supports complete public bundles and linear history only.
It does not persist a network cursor, fetch data, update cloud state, resolve a
conflict, materialize promised blobs, or support members/local bundle
reconciliation. Cursor recovery, two-device orchestration, and partial clone
remain later P5c increments.
