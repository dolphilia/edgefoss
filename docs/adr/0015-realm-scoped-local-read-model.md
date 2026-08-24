# ADR 0015: Derive local history and working diff from one realm at a time

- Status: accepted
- Date: 2026-08-24
- Decision owners: local CLI, storage, and security maintainers
- Applies to: I3f local repository alpha

## Context

I3e can publish independent signed checkpoint chains for public, members, and
local realms. The first read commands must make those chains useful without
turning realm selection into a UI-only filter. Restricted change counts,
messages, timestamps, paths, IDs, and diff statistics are themselves protected
information and must never be loaded into a public result and filtered later.

A useful pre-checkpoint review also needs to answer what the latest explicit
`ef snapshot` would change relative to the accepted head. Reading the live
filesystem inside `diff` would collapse the established snapshot/review/sign
boundaries and create another filesystem-race surface.

## Decision

- `ef history` and `ef diff` require one explicit `--realm` from public,
  members, or local. There is no implicit complete/mixed view.
- History starts only from that realm's `heads/main`, walks newest-first through
  the signed parent IDs, and returns at most the requested 1–1000 entries. I3f
  supports the linear checkpoint chain produced by I3e; merge presentation is
  deferred rather than choosing an arbitrary parent.
- Before returning history, storage revalidates project genesis, its signature,
  each returned change body/ID/signature, its root body/signature, and the
  resolved same-project/same-realm graph edges. Missing or altered accepted
  signatures are repository corruption, not partially trusted output.
- `ef diff --realm R` compares R's current unsigned working snapshot with R's
  accepted head tree, or with an empty tree before the first checkpoint. It
  never reads another realm and never reads the live filesystem; users run
  `ef snapshot` first to establish the review input.
- I3f diff is a deterministic structural name/status view: added, modified, or
  deleted path plus file, executable, directory, or symlink mode. File/blob and
  symlink targets determine modification. A directory target hash is ignored
  for the directory entry itself so one child edit does not also mark every
  ancestor directory modified.
- Both accepted and working trees revalidate project/realm metadata, IDs, path
  rules, tree/blob dependencies, and the 100,000-path alpha bound. Accepted
  trees additionally require their stored signatures.
- CLI history escapes backslash and terminal control characters in messages;
  path-v0 already forbids control characters in paths. `status` applies the
  same escaping to the project display name.
- These views are derived directly from canonical state. I3f adds no table,
  projection cache, schema migration, receipt, or semantic-root input.

## Consequences

- A public history/diff request cannot reveal whether a members/local change or
  path exists, including through counts or validation of an ignored realm.
- `diff` is suitable for exact realm/path review before checkpoint, but it does
  not yet render text hunks or blob contents.
- Changing files after `snapshot` does not change diff output until the next
  snapshot. This is intentional and keeps review and signing over one stable
  tree identity.
- Corruption is detected during reads even if SQLite's structural quick check
  passes.
- The same realm-scoped query boundary can later back public/member Worker read
  models without sending restricted records to a public projection.

## Rejected alternatives

- Query all realms and filter CLI rows: rejected because errors, counts,
  allocations, logs, and future pagination could expose restricted state.
- Diff the live filesystem: rejected because it would not necessarily match the
  snapshot root later signed by checkpoint.
- Report directory hash changes: rejected because every leaf edit would create
  noisy ancestor modifications rather than a path-level source diff.
- Render arbitrary historical change IDs in I3f: deferred until reachability,
  pagination, and merge behavior are fixed; the current command has no
  cross-realm artifact-ID oracle.
- Persist a read projection now: rejected because the bounded local alpha can
  prove semantics directly from canonical state before adding cache repair.

## Verification

Storage tests cover first-checkpoint additions, clean accepted snapshots,
modified/executable paths, newest-first history, realm-specific messages and
paths, unchanged members state after a public edit, and corrupt-signature
rejection. CLI subprocess tests cover explicit realm selection, limits,
terminal-safe history messages, clean/modified diffs, and absence of selected
other-realm IDs, messages, and paths.
