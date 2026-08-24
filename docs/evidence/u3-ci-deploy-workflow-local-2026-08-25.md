# U3 CI deploy workflow local evidence — 2026-08-25

- Increment: U3 readiness, minimal staging CI deploy workflow
- Base commit: `ea275d63ca6bf63e24769fe8025eda52a056aa03`
- Checkpoint state: workflow ready locally; U3 credentials not requested yet
- Remote mutation: none
- Result: local implementation and focused verification pass; commit/CI pending

## Current-source review

Cloudflare's current GitHub Actions documentation requires a non-interactive API
token and account ID, recommends starting from the `Edit Cloudflare Workers`
template, and limiting the token to the deployment account. The current official
Wrangler Action is v4, uses Node 24, and accepts `apiToken`, `accountId`,
`workingDirectory`, `command`, `packageManager`, and `wranglerVersion` inputs.
The v4.0.0 tag resolved read-only to immutable commit
`ebbaa1584979971c8614a24965b4405ff95890e0`.

## Implemented gate

The new workflow is intentionally narrower than the general Cloudflare example:

- manual `workflow_dispatch` only;
- `refs/heads/main` only, with an explicit failing guard rather than a skipped
  job;
- GitHub `contents: read` only;
- one serialized staging deployment at a time;
- both U3 secret names must exist, but their values are never printed;
- locked dependency install, full project check, and staging dry-run precede the
  deployment action;
- command is fixed to `deploy --env staging`;
- no environment input, production command, resource provision, Queue consumer,
  custom domain, or Worker secret operation;
- exact GET/HEAD stateful health audit after deploy.

Merging the workflow cannot deploy automatically. Until U3 is complete, even a
manual run fails at the credential guard.

## Focused verification

```text
pnpm run test:cloud-deploy
  5 tests pass

node tools/audit-worker-health.mjs \
  --origin https://edgefoss-staging.miga-and-raia.workers.dev
  environment=staging, edition=single, schema_version=1: pass

wrangler deploy --dry-run --env staging
  RepositoryDO: bound
  PUBLIC_BLOBS: edgefoss-staging-public-blobs
  RESTRICTED_BLOBS: edgefoss-staging-restricted-blobs
  EXPORTS: edgefoss-staging-exports
  EDGEFOSS_ENV: staging
```

No Cloudflare token, account ID, deployment/version ID, account identity, or
unrelated resource name is recorded.

## Next checkpoint action

After this change is committed, pushed, and GitHub Actions succeeds, present the
account owner with the U3 work ticket. It must include only:

1. create one account-scoped Cloudflare token from `Edit Cloudflare Workers`;
2. save it as GitHub Actions secret `CLOUDFLARE_API_TOKEN`;
3. save the already selected account ID as secret `CLOUDFLARE_ACCOUNT_ID`;
4. manually run `Deploy staging Worker` from `main`;
5. report only success/failure, scope summary, token creation date, and the
   non-secret health result—never either value.

Production token, GitHub Environment, R2 S3 credential, custom domain, and
automatic push deployment remain out of scope.
