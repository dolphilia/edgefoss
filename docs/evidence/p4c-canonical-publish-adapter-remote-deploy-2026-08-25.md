# P4c canonical publish adapter remote deploy evidence — 2026-08-25

- Increment: owner-authenticated bounded canonical publish adapter deployment
- Deployed ref: `main`
- Target Worker: `edgefoss-staging`
- Result: deploy and stateful health pass
- Remote publication: not performed

## Observed deployment

The account owner ran the existing manual main-only staging workflow after the
adapter commit passed normal GitHub Actions. The deploy completed successfully,
and the stateful health audit passed with RepositoryDO application schema 4.
The deployment did not add a Queue consumer or change the authority schema.

An unauthenticated request to `POST /api/v0/artifacts` returned HTTP 401 with:

```text
cache-control: no-store
www-authenticate: Bearer realm="edgefoss"
{"error":{"code":"unauthorized","message":"A valid owner bearer token is required."}}
```

This is the expected non-mutating adapter probe. It proves that the new route is
deployed and that the owner authentication boundary rejects the request before
body parsing or Durable Object publication.

## State deliberately not created

- no project genesis, tree, or change artifact;
- no artifact receipt or publish operation result;
- no public or members ref;
- no new R2 object;
- no members data;
- no Queue consumer.

The previously finalized P4b 30-byte public blob remains the only input planned
for the first publish smoke.

## Next gate

Commit this evidence and pass normal CI. Then obtain explicit account-owner
confirmation that the one-time smoke will permanently initialize the approved
staging Single Edition authority with the public synthetic actor, three
artifacts/receipts/operations, and public `heads/main` generation 1. Only after
that confirmation may the existing owner token be passed through the process
environment to `cloud:smoke-publish`. Production, members data, new R2 writes,
and Queue consumers remain out of scope.
