# Threat model v0

Status: P0 draft. Revisit whenever an API, realm, trust boundary, or publication path is added.

## Assets

- portable artifact bodies, blobs, signatures, and semantic roots
- restricted paths, content, hashes, metadata, and counts
- authority state: ACL epoch, refs, receipts, operation dedupe, projections, and outbox
- owner/member credentials, deployment tokens, signing keys, and recovery material
- backups, exports, logs, caches, Queue payloads, and generated static output

## Trust boundaries

```text
working copy / CLI
        ↕ untrusted filesystem and network
portable validation core
        ↕ authenticated sync/API
Edge Worker
        ↕ binding calls
RepositoryDO / R2 / Queue
        ↕ view-specific publication
anonymous or authenticated Web clients
```

Cloudflare is an authority and storage provider, not part of portable project identity. Local files, imported bundles, HTTP input, Queue deliveries, and database rows are validated at their boundary.

## Initial adversaries and failures

- anonymous reader probing for restricted object existence
- expired or revoked member attempting reads/writes
- malicious contributor submitting non-canonical, oversized, cyclic, or cross-realm artifacts
- compromised browser, CI job, log sink, or cache receiving excessive data
- replayed operations, duplicate Queue delivery, lost responses, and partial uploads
- operator binding staging code to production resources
- storage corruption or incomplete restore
- dependency or build-chain compromise

## Required controls

- realm is signed canonical data; public graphs never reference restricted IDs
- capability checks and policy epoch validation occur inside the write authority transaction
- upload-then-verify-then-finalize; visible state never references missing/unverified blobs
- operation IDs, ref CAS, transactional outbox, and idempotent consumers
- separate public/restricted/export R2 bindings and environment-specific resources
- structured allowlisted logs without paths, IDs, content, messages, tokens, or presigned URLs
- credentials are least-privilege, environment-specific, revocable, and absent from source control
- complete offline-verifiable export plus tested fresh-environment restore

## Explicit non-claims

- Changing public data to restricted cannot recall copies already distributed.
- URL secrecy is not authorization.
- R2 ETags are not EdgeFossil content identity.
- PITR alone is not a complete portable backup.
- The initial design does not provide end-to-end encrypted realms or arbitrary per-file ACLs.
