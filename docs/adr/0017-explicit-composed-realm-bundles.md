# ADR 0017: Compose restricted realm bundles from explicitly verified bases

- Status: accepted
- Date: 2026-08-24
- Decision owners: local storage, CLI, format, and security maintainers
- Applies to: I3h local repository alpha

## Context

`bundle-v0` keeps public, members, and local object inventories separate. A
members manifest commits to the public semantic root in `base_roots`; a local
manifest commits to both public and members roots. Checking those fields for
valid hash syntax is insufficient: a verifier must prove that the referenced
lower-realm states exist, belong to the same project, and have themselves
passed full graph and signature verification.

Implicitly locating bases beside the target bundle would make filesystem names
part of portable meaning and could silently select the wrong release. Embedding
lower-realm objects in each restricted bundle would duplicate data and weaken
the information-flow boundary established by one realm per bundle.

## Decision

- Export and verification require explicit `--base REALM=BUNDLE_DIRECTORY`
  options. Public takes no bases; members requires public; local requires public
  and members. Missing, duplicate, extra, or mislabeled bases fail before target
  acceptance.
- Bases are verified in dependency order: public independently, members over
  that verified public summary, then local over both verified summaries.
- A verified summary binds project ID, realm, semantic root, initial actor key,
  and its own base roots. A target manifest is accepted only when every claimed
  `base_roots` entry exactly matches the supplied verified summary.
- The members summary used for local verification must itself name the same
  public root supplied for the local composition. Matching a members root alone
  is not sufficient.
- Restricted bundles contain only their own changes, trees, blobs, signatures,
  and ref. Project genesis and its signature remain in the public base. The
  verified public base supplies the actor key used to validate restricted
  artifacts.
- Export also compares the supplied base semantic roots with lower-realm
  accepted state from the same SQLite read transaction. A valid but stale base
  cannot label a new restricted export.
- No implicit public/member merge is exposed as one inventory or count. A
  consumer may compose verified views after each bundle passes independently.
- Local export is an explicit device-backup operation. It is never added to a
  public, members, or future authority-complete project export implicitly.

## Consequences

- Public, members, and local directories can be stored under separate access
  controls or R2 bindings without changing portable bytes. A members download
  necessarily reveals the selected public semantic root, but not public object
  duplication or local existence.
- Moving or renaming directories does not change semantic roots; callers simply
  provide their new paths.
- Operators must retain the exact base bundles referenced by restricted
  bundles. Re-exporting public state after it advances does not retroactively
  satisfy an older or differently based restricted manifest.
- CLI paths are local transport arguments and never enter canonical manifests.
- I3h still does not provide one authority-complete archive, import, restore,
  encryption, retention, streaming, or remote publication.

## Rejected alternatives

- Trust `base_roots` without base objects: rejected because it proves only a
  claim's syntax, not the lower-realm repository state.
- Discover `public.edge` and `members.edge` by filename: rejected because names
  are mutable deployment convention, not portable identity.
- Copy genesis/public objects into every restricted bundle: rejected because it
  violates exact realm inventory and complicates leakage accounting.
- Accept any independently verified members bundle for local: rejected because
  that members state may be composed over a different public root.
- Automatically export newer lower realms while accepting an older supplied
  base: rejected because the produced manifest would not describe the files the
  operator intends to distribute together.

## Verification

Storage and CLI tests construct all three accepted realm checkpoints, export
public→members→local, verify each layer in order, reject a wrong public base,
and scan restricted output files for other-realm messages. Existing tests retain
the rule that omitted bases create no restricted output.
