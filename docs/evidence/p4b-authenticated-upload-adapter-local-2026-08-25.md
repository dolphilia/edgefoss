# P4b authenticated upload adapter local evidence — 2026-08-25

- Increment: P4b owner-authenticated small-upload HTTP adapter
- Base commit: `13ccfa0e9b9664250868f1cc3bc707ba622f9b23`
- Environment: local Workers runtime only
- Remote mutation: none
- Result: implementation, full workspace check, build, and staging dry-run pass

## Implemented boundary

Staging and production now declare one required `EDGEFOSS_OWNER_TOKEN` Worker
secret. The route authenticates a Bearer header by hashing both values before a
timing-safe comparison and fails closed when the deployment secret is absent or
malformed. No secret value is committed.

RepositoryDO application schema 3 adds `principal_id` to upload sessions.
Declaration dedupe, content staging, status, and finalize bind the upload to the
fixed bootstrap `owner` principal. The HTTP adapter exposes only the four
bounded upload operations documented by ADR-0029. It does not expose a blob
read route, artifact publish, member token issuance, Queue consumer, or
production operation.

The content route reads no more than 16 MiB regardless of `Content-Length`,
checks the declared size and application SHA-256, and performs a conditional
checksum-bearing R2 staging write. Finalize retains the independent verification
and conditional finalization implemented by ADR-0028.

## Focused verification

```text
pnpm --filter @edgefoss/worker typecheck
  pass

pnpm --filter @edgefoss/worker test
  2 files, 11 tests pass

pnpm test:auth
  4 tests pass

pnpm check
  pass

pnpm build
  pass; Worker dry-run upload 22.61 KiB / gzip 5.43 KiB

pnpm exec wrangler deploy --dry-run --env staging ...
  pass; exact RepositoryDO, 3 R2, and staging environment bindings
```

The Worker tests cover unauthorized rejection and an authenticated
declaration-to-finalization path in the Workers runtime. The Node tests cover
256-bit token generation, strict approved-staging origin parsing, and the remote
smoke client's declaration/finalize retry convergence without printing the
token.

## Next gate

After commit and normal CI success, the account owner generates and saves one
staging owner token, configures the required Worker secret, and runs the manual
main-only staging deployment. Health must report schema 3 before the synthetic
remote write command is run. The smoke writes one deterministic harmless public
test blob; it must not be run against production.
