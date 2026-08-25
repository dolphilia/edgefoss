# P4c canonical publish adapter local evidence — 2026-08-25

- Increment: owner-authenticated bounded canonical publish adapter
- Base commit: `6227eef`
- Environment: local Workers runtime and mocked staging smoke only
- Remote mutation: none
- Result: implementation and focused verification pass

## Implemented boundary

`POST /api/v0/artifacts` now authenticates the existing owner bearer before
reading a maximum 2 MiB JSON body. It accepts exact fields, canonical unpadded
base64url, a protocol-bounded 1 MiB artifact, a 1 KiB signature record, and the
single `heads/main` ref shape. The Worker supplies principal `owner`; the client
cannot choose it. Canonical CBOR, ID, signature, realm, graph, operation, policy,
and CAS validation remain in the schema 4 internal publication core.

Accepted results map to HTTP 200, stored operation/policy/ref conflicts to 409,
and typed authority rejections to 422 without discarding their fields. All
responses are non-cacheable. No CORS, public mutation, new secret, binding,
schema migration, R2 write, or Queue consumer was added.

The new deterministic smoke imports the shared protocol implementation,
requires the exact staging origin and owner token environment variable, and
will publish genesis, tree, and change only after health reports schema 4. The
tree references the existing P4b blob
`sha256:d7fff80443a004a5fdbd4fdf058d7cb0b828a0d28cc4522f629bb60d841a4572`.
It retries every publication and exposes no token or private material in its
result.

## Focused verification

```text
pnpm --filter @edgefoss/worker typecheck
  pass

pnpm --filter @edgefoss/worker test
  3 files, 17 tests pass; accepted/retry, HTTP 409/422, strict transport,
  unauthenticated-first, and declared-size rejection are covered

pnpm exec tsx --test tools/smoke-worker-publish.test.mjs
  3 tests pass

pnpm check
  pass; protocol 182 tests, Worker 17 tests, Node/Rust/static/lint/vectors/docs green

pnpm build
  pass; Worker 70.44 KiB / gzip 15.44 KiB

pnpm --filter @edgefoss/worker check:startup
  pass; local active CPU 6.4 ms, 0.0 ms garbage collection

pnpm exec wrangler deploy --dry-run --env staging --config apps/worker/wrangler.jsonc
  pass; RepositoryDO, exact 3 staging R2 bindings, staging environment;
  no Queue binding or consumer
```

No live Worker request was made during local implementation.

## Next gate

After commit and normal CI success, run the existing manual main-only staging
deployment and require schema 4 health. Before the smoke, review that it
permanently initializes only the approved staging authority with a public,
synthetic signing fixture, three artifacts/receipts/operations, and public
`heads/main` generation 1. It adds no R2 object and no Queue consumer. Run the
smoke only after explicit user confirmation of those effects.
