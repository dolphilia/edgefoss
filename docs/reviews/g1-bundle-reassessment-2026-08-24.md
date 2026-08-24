# G1 bundle reassessment — 2026-08-24

## Decision

**Local go candidate; commit and CI confirmation pending.** I2f closes blocker
G1-1 from the earlier
[`independent implementation readiness review`](g1-independent-implementation-readiness-2026-08-24.md).
The decision applies to the experimental P1 candidate and does not freeze v0
compatibility.

## Gate reassessment

| G1 condition                                                         | Evidence                                                                                     | Result |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------ |
| Rust and TypeScript agree on all shared bytes, IDs, and error codes. | Both consume the exact bundle manifest/object vector in addition to the earlier eight files. | pass   |
| Public semantic root is independent of members-only inputs.          | 128 generated cases per runtime remain in I2d.                                               | pass   |
| A reader can be implemented from specs without production code.      | Clean-room Node reader independently decodes/re-encodes CBOR, inventories and roots.         | pass   |
| Corpus includes at least 50 accepted and 50 rejected cases.          | Independent audit recomputes 64 accepted and 81 rejected cases.                              | pass   |
| Realm and bundle boundaries are unambiguous.                         | One realm per bundle; exact lower-realm `base_roots`; mixed-realm bundle forbidden.          | pass   |

## Independent-reader boundary

`tools/read-bundle-vector.mjs` imports only Node standard-library modules. It
does not import `@edgefoss/protocol`, `ef-format`, or a third-party CBOR package.
It independently implements the CBOR subset needed by the bundle manifest,
canonical re-encoding, fixed resource limits, ref/inventory validation, exact
object paths, SHA-256 object checks, and semantic-root recomputation. It also
executes all five invalid bundle mutations.

The fixture intentionally contains only `project.genesis`, matching the P1
walking skeleton. Full repository import must additionally run the registered
artifact, graph, blob, policy, and signature validators before atomic commit;
container verification alone is never treated as authority acceptance.

## Residual items outside G1

- The portable policy artifact schema must be fixed before P2 persists policy
  artifacts.
- Tree-to-blob/directory reachability and composed members/local base imports
  require P2 fixtures.
- Directory archive framing, streaming, resumable export, and large blobs stay
  in P7 and do not alter the directory bundle's semantic paths or bytes.
- The `experimental = true` candidate remains disposable until the later D3b
  compatibility freeze.

After the I2f commit passes GitHub Actions, the G1 decision can be recorded as
go and the P2 local repository critical path may start. No Cloudflare resource
is required for that transition.
