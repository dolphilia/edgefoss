# ADR-0001: Separate portable, authority, and derived state

- Status: Accepted
- Date: 2026-08-24
- Owners: core/format lead
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

EdgeFossil must retain project identity across local SQLite, Cloudflare storage, static publication, export, and a future replacement authority. Treating a Durable Object database or an R2 layout as the repository format would bind recovery and interoperability to one provider implementation. Conversely, treating cache, search, and notification output as canonical state would make retries or index loss corrupt project meaning.

## Decision

State is divided into three layers:

1. **Portable canonical state**: canonical artifact bodies, referenced blob bytes, signatures, realm graph, refs expressed by portable identities, and semantic-root inputs.
2. **Authority state**: ACL/policy epoch, accepted ref generations, authority receipts and sequence, operation idempotency, upload verification/finalization, and transactional outbox.
3. **Derived state**: timeline/current-file/search projections, static output, caches, notifications, metrics, and delivery state.

Portable state must not contain Cloudflare account/resource IDs, DO SQLite dumps, R2 ETags, Queue delivery state, or cache metadata. Authority and derived databases may be rebuilt or replaced without changing portable artifact IDs. Derived state is disposable and rebuildable from accepted portable plus authority state.

## Alternatives considered

- **DO SQLite as repository format**: rejected because it prevents offline verification and provider-independent restore.
- **R2 object layout as repository format**: rejected because physical keys, multipart behavior, and lifecycle policy are deployment details.
- **Single database containing all meanings without layer boundaries**: rejected because backup, retry, cache, and migration semantics become ambiguous.

## Consequences

- Adapters must translate between portable types and physical storage.
- Complete export must include all portable state needed for offline verification but not raw authority storage.
- Restore creates new authority receipts/resource IDs while preserving artifact IDs and semantic roots.
- Projection loss is an availability/performance issue, not canonical data loss.
- Tests must prove that local, cloud, and restored representations share the same semantic root.

## Verification

- Architecture dependency test prevents Cloudflare packages/config types from entering `edgefoss-core`.
- P2 export/import round trip preserves semantic root.
- P7 fresh-environment restore preserves artifact IDs and semantic root.
- Projection deletion/rebuild does not change canonical state.
