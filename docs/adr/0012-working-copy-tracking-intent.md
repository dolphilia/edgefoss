# ADR 0012: Keep working-copy tracking intent local and distinct from policy

- Status: accepted
- Date: 2026-08-24
- Decision owners: local CLI, storage, and format maintainers
- Applies to: I3c local repository alpha

## Context

The next local slice must distinguish files that are not versioned, files with
device-local history, and files intended for project history. Project-tracked
files also need an initial `public` or `members` classification. At the same
time, the G1 review explicitly blocks persistence of a portable policy artifact
until that artifact's canonical schema and vectors are fixed.

Treating a user's current working-copy selection as authoritative project policy
would collapse two different concerns. It would also force Web/archive/sync
channel decisions before snapshot and portable policy artifacts exist.

## Decision

- SQLite schema version 2 adds `working_copy_tracking`. Every row is bound to
  the initialized project but remains ordinary local database state; it is not
  inserted into the artifact graph or a portable export.
- User-facing tracking destinations are `none`, `local`, and `project`.
  `none` has no realm, `local` always uses realm `local`, and `project` requires
  realm `public` or `members`.
- Selectors use the policy-v0 matching primitives: an exact `path` or directory
  `prefix`. Exact rules win; otherwise the longest matching prefix wins. The
  implicit result with no matching rule is `none`.
- `ef track` requires an existing target. Directories create prefix rules;
  regular files and symbolic-link entries create exact rules. The default is
  `project/public`; `--realm members`, `--local`, and `--none` are mutually
  exclusive.
- Targets are normalized to canonical portable paths relative to the discovered
  repository. Absolute paths, parent traversal, the repository root itself, and
  `.edgefossil` metadata are rejected.
- `ef status` reports explicit rule counts. `ef status --explain PATH` reports
  the effective tracking destination, realm, and matching selector. Explanation
  is local and may name restricted paths; it is not a public projection.
- Migration 1 to 2 is transactional and preserves repository identity.

## Consequences

- Snapshot work can consume one deterministic local selection model without
  prematurely freezing portable policy bytes.
- Public and members classification is explicit before file content is read.
- `local` intent can later create realm-local artifacts that project artifacts
  are forbidden to reference.
- `none` can be an explicit exact/prefix override instead of only an absence.
- I3c does not read file content, create blobs/trees, detect path collisions, or
  prove that a directory remains unchanged after tracking.
- Root-wide defaults, non-existing ignore targets, channel controls such as
  Web-hidden, `.efignore`, `.edgefossil/attributes`, and portable policy
  artifacts remain later work. Their implementation must preserve the
  tracking/confidentiality/channel separation in `policy-v0`.

## Rejected alternatives

- Persist a schema-less policy artifact now: rejected by the G1 residual gate
  and because cross-runtime canonical bytes do not yet exist.
- Encode `local` as `project` plus a disabled sync flag: rejected because local
  history must never enter project inventory or references.
- Infer realm from a repository-wide public/private switch: rejected because a
  single project can intentionally contain public and restricted histories.
- Enumerate every file immediately when tracking a directory: rejected because
  tracking intent and a point-in-time snapshot are separate operations.

## Verification

Storage tests cover v1-to-v2 migration, initialization gating, valid and invalid
mode/realm combinations, exact-first and longest-prefix resolution, explicit
none, upsert, and counts. CLI subprocess tests cover public directory
inheritance, members/local/none persistence, explanation, conflicting options,
and metadata-path rejection.
