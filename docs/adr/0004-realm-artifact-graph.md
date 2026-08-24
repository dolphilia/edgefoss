# ADR-0004: Realm-separated artifact graph

- Status: Accepted for v0 candidate
- Date: 2026-08-24
- Owners: security owner
- Decision deadline: G1
- Supersedes: none
- Superseded by: none

## Context

Filtering a complete tree at Web request time can still leak restricted paths, hashes, counts, parent IDs, messages, or graph shape. Public and restricted views therefore cannot be projections of one realm-blind artifact graph.

## Decision

Every project artifact body contains its `realm_id`, and realm identity is covered by its artifact hash and actor signature. The initial realms are:

- `public`: project data intentionally distributable to anonymous readers;
- `members`: project data available only through member capabilities;
- `local`: working data that is not replicated as project state.

Reference flow follows visibility:

- public artifacts may reference only public artifacts/blobs;
- members artifacts may reference public or members artifacts/blobs;
- local state may refer to project artifacts, but project artifacts may never refer to local objects.

Each realm has independent trees, change ancestry, refs, semantic roots, inventory, export, search, and Web projections. Promotion/declassification creates new artifacts in the destination realm; it does not rewrite realm metadata while retaining an ID.

## Alternatives considered

- One graph with response-time ACL filtering: rejected because identifiers and graph shape leak before content filtering.
- Per-file ACLs in one tree: rejected for v0 because inherited/revoked policy and partial-tree identity are substantially more complex.
- Encrypting restricted objects while keeping public references: rejected because references still reveal existence and key management is outside v0.

## Consequences

- Identical content in different realms can have different artifact/tree identities.
- Public projection inputs can be tested for byte-for-byte independence from members-only changes.
- Moving public data to a restricted realm cannot recall already distributed copies; UI and CLI must say so.

## Verification

The invalid corpus rejects public-to-members and project-to-local references. Leakage tests inspect API, clone, export, static output, Queue messages, logs, caches, and error responses.
