# ADR-0006: Separate public, restricted, and export R2 bindings

- Status: Accepted
- Date: 2026-08-24
- Owners: cloud lead and security owner
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

Application authorization bugs, public bucket configuration, cache rules, or operator mistakes must not turn one shared object namespace into a cross-realm disclosure. Export retention and deletion behavior also differs from live blob storage.

## Decision

Every environment uses three private R2 buckets and distinct Worker bindings:

- `PUBLIC_BLOBS`: blobs accepted into the public realm;
- `RESTRICTED_BLOBS`: members/authority-only blobs;
- `EXPORTS`: generated public/member/authority-complete export objects.

Public objects use a project-scoped content-derived key. Restricted objects use opaque random physical keys stored in the RepositoryDO blob index; a plaintext global digest is not a public physical locator. The Worker mediates access until an explicit public-delivery design is accepted.

The restricted bucket never enables `r2.dev` or receives a public custom domain. Staging and production names/bindings are separate and generated from the reviewed resource manifest.

## Alternatives considered

- One bucket with prefixes: rejected because a binding, lifecycle, CORS, or public-access mistake crosses all realms.
- Public `r2.dev` from the start: rejected because the Worker must first enforce view and cache policy.
- Encrypt all restricted values in one public bucket: rejected because key management and metadata leakage remain unsolved.

## Consequences

- More resources must be provisioned, verified, backed up, and costed.
- Realm-specific IAM, lifecycle, cache, and incident response are easier to audit.
- Cross-realm promotion copies/verifies bytes into the destination storage context and creates destination artifacts; it is not a metadata flip.

## Verification

P4 binding-isolation tests attempt every wrong-bucket access. P6 leakage tests cover URLs, headers, cache keys, logs, exports, and disabled public bucket endpoints.
