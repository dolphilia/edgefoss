# P4b small-blob core local evidence — 2026-08-25

- Increment: P4b internal staging/verify/finalize core
- Base commit: `49ad667b5945175e621e646cfde00aeaa7f160ba`
- Environment: local Workers runtime only
- Remote mutation: none
- Result: implementation and focused verification pass; commit/CI pending

## Implemented boundary

`RepositoryDO` now migrates application schema 1 to 2 and owns minimal strict
`upload_sessions` and `blobs` tables. Typed internal RPC implements declaration,
realm-specific R2 selection, ETag-pinned staging reads, bounded size and SHA-256
verification, conditional final writes, transactional blob acceptance, and
stored finalize results.

The 16 MiB small-object path is intentionally bounded. Public objects use a
project-scoped content-address key. Members objects use a random upload-derived
key in `RESTRICTED_BLOBS`; neither its key nor bytes are written to
`PUBLIC_BLOBS`.

No HTTP mutation route, credential, Queue binding, production operation, or
remote R2 object is added. Authentication remains a prerequisite to exposing
the internal RPC through `/api/v0/uploads`.

## Focused verification

```text
pnpm --filter @edgefoss/worker typecheck
  pass

pnpm --filter @edgefoss/worker test
  2 files, 9 tests pass
```

The runtime tests cover exact health schema 2, declaration idempotency,
operation conflict, public finalize plus response-loss retry, members isolation,
concurrent finalize convergence, and terminal checksum rejection.

## Next gate

After commit and normal CI success, deploy schema 2 to staging through the
manual main-only workflow. The post-deploy health auditor must report schema 2.
Do not exercise remote upload writes until an authenticated HTTP adapter and a
synthetic-data smoke command are separately reviewed.
