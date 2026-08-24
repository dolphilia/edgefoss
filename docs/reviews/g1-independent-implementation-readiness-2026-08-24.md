# G1 independent implementation readiness review — 2026-08-24

## Decision

**No-go.** The artifact, graph, signature, and semantic-root profiles are ready
for an independent reader, but G1 also requires an independently implementable
bundle reader. `bundle-v0` does not yet exist, so P2 local repository work must
not start on the critical path.

This review used only published files under `spec/` and their shared vectors to
derive expected behavior. The added `tools/audit-vectors.mjs` is deliberately a
clean-room consistency checker: it imports no Rust or TypeScript protocol code.
It is evidence of spec/vector readability, not a substitute for an external
human review or a complete bundle reader.

## Findings and disposition

| ID   | Severity | Finding                                                                 | Disposition                                                                                          |
| ---- | -------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| G1-1 | blocker  | No `bundle-v0` manifest/container specification or reader exists.       | Open. Define a realm-isolated experimental bundle, shared vectors, and an independent reader.        |
| G1-2 | high     | `artifact_id_mismatch` was specified but absent from both public APIs.  | Fixed. Rust/TypeScript now verify claimed IDs and share two body-hash vectors.                       |
| G1-3 | high     | CBOR resource limits were described as configurable, preventing parity. | Fixed. Input, nesting, item-count, and declared-length limits are normative.                         |
| G1-4 | high     | Unknown kind/schema storage versus acceptance was ambiguous.            | Fixed. Opaque quarantine is allowed, but publication, ref resolution, and semantic roots are denied. |
| G1-5 | medium   | Signature invalid cases existed only in language-specific tests.        | Fixed. The shared signature vector now names all three binding/mutation failures.                    |
| G1-6 | medium   | Corpus-size claims were copied into evidence rather than recomputed.    | Fixed. A protocol-independent audit enforces at least 50 accepted and 50 rejected cases.             |
| G1-7 | medium   | Policy v0 defines evaluation behavior but no portable policy artifact.  | Accepted for G1 draft only. P2 must version its persisted representation before policy persistence.  |

## Readability matrix

| Profile area            | Exact bytes/vector | Stable rejection | Cross-runtime executable | Review result                         |
| ----------------------- | ------------------ | ---------------- | ------------------------ | ------------------------------------- |
| canonical CBOR and IDs  | yes                | yes              | yes                      | ready                                 |
| genesis/tree/change     | yes                | yes              | yes                      | ready for registered schema-0 kinds   |
| path and realm flow     | decisions          | yes              | yes                      | ready                                 |
| change graph and clocks | decisions          | yes              | yes                      | ready                                 |
| detached Ed25519        | yes                | yes              | yes                      | ready                                 |
| semantic root           | yes                | yes              | yes                      | ready                                 |
| tracking/publication    | no artifact bytes  | prose rules      | no                       | draft sufficient; persistence blocked |
| bundle                  | no                 | no               | no                       | G1 blocker                            |

## Clean-room vector audit

`pnpm vectors:check` independently checks:

- all eight vector files advertise the expected profile;
- body bytes hash to the recorded genesis/tree/change/artifact IDs;
- all semantic-root descriptor bytes hash to their recorded roots;
- the signature domain message and Ed25519 signature verify without importing
  `@edgefoss/protocol` or `ef-format`; and
- the aggregate corpus floor is satisfied: 63 accepted and 76 rejected cases.

Graph and realm decision counts remain separate from accepted/rejected format
cases because they test relation matrices rather than encoded inputs.

## Required next increment

The next increment must define the experimental `bundle-v0` boundary narrowly
enough for an independent reader:

1. one realm per bundle, preserving public/members isolation;
2. exact manifest fields and canonical bytes;
3. deterministic object naming and inventory ordering;
4. artifact/blob/signature hash verification and duplicate/missing-object rules;
5. semantic-root recomputation from restored portable state;
6. valid and invalid shared bundle vectors; and
7. a reader that does not import the production Rust/TypeScript codec.

G1 may be reconsidered only after that increment passes local and CI checks.
