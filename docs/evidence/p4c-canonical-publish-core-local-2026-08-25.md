# P4c canonical publish core local evidence — 2026-08-25

- Increment: P4c internal canonical artifact publication transaction
- Base commit: `e84e8e3e5eb41e54f4f63432f29542c63b66ed12`
- Environment: local Workers runtime only
- Remote mutation: none
- Result: implementation and focused verification pass

## Implemented boundary

RepositoryDO application schema 4 adds strict tables for artifacts, edges,
attestations, receipts, per-realm `heads/main`, and publish operation results.
The typed internal RPC validates the shared canonical CBOR profile, artifact
ID, project and realm flow, finalized blob references, and Ed25519 signature.
The synchronous SQLite transaction combines operation replay, policy epoch,
project owner key, reference validation, ref generation CAS, artifact
acceptance, receipt sequence, and stored result.

The schema adds no HTTP publish route, project data, R2 write, Queue binding, or
Queue consumer. Existing authenticated upload routes remain unchanged. The
health contract advances from schema 3 to schema 4 so a later manual staging
deployment can verify migration independently before any remote publication.

## Focused verification

```text
pnpm --filter @edgefoss/worker typecheck
  pass

pnpm --filter @edgefoss/worker test
  3 files, 14 tests pass

pnpm test:auth
  4 tests pass

pnpm test:cloud-deploy
  7 tests pass

pnpm check
  pass; protocol 182 tests, Worker 14 tests, Node/Rust/static/lint/vectors/docs green

pnpm build
  pass; Worker 65.60 KiB / gzip 14.56 KiB

pnpm --filter @edgefoss/worker check:startup
  pass; local active CPU 9.0 ms, 0.0 ms garbage collection

pnpm exec wrangler deploy --dry-run --env staging ...
  pass; RepositoryDO, exact 3 staging R2 bindings, staging environment;
  no Queue binding or consumer
```

The publish suite includes 100 exact retries of one accepted operation,
operation-input conflict, stable policy/ref conflicts, concurrent generation
CAS, missing-blob rollback followed by same-operation success, public-to-members
denial, bootstrap actor authorization, invalid signature rejection, and
duplicate blob-edge set semantics.

The implementation was reviewed against the Cloudflare Workers best-practices
page updated 2026-08-20, the current SQLite Durable Object transaction API, and
`@cloudflare/workers-types` version `5.20260825.1`. `transactionSync()` contains
only synchronous SQL; hashing and signature verification complete before it.

## Next gate

After commit and normal CI success, run the existing manual main-only staging
deployment. The exact health audit must report schema 4 and all three R2
bindings. Do not run an artifact publish or repeat the P4b upload smoke. Queue
must remain unbound as a consumer.
