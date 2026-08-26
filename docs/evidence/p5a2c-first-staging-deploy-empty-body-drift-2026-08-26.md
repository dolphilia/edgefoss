# P5a2c first staging deploy empty-body drift — 2026-08-26

- Increment: anonymous public transfer adapter staging activation
- Deployed commit: `75a6544`
- Workflow ref: `main`
- Failed step: `Verify existing public transfer profile boundary`
- Observed result: `POST /api/v0/sync/transfers` returned HTTP 400
- Remote corrective mutation: none

## Observed sequence

The manual workflow reached its final public-transfer boundary step. Its prior
ordered steps had therefore completed: project checks, named staging dry-run,
Worker deployment, schema-5 stateful health, and anonymous HELLO verification.
The final credential-free plan POST returned 400 instead of the expected 409
`clone_profile_unsupported`.

## Cause

The plan handler required `request.body === null` as a proxy for an empty body.
The local Fetch request used by the Worker integration test represented a
bodyless POST as `null`. The Node fetch request traversing the deployed edge was
observed by the Worker as an empty readable stream. Both carry zero bytes, but
the representation-only check rejected the latter before calling RepositoryDO.

The correction uses the existing streaming bounded-body reader with a zero-byte
limit. It accepts both valid empty representations without buffering and
rejects the first nonempty byte with HTTP 413. The Worker regression test now
constructs an explicit empty body stream and separately proves that a nonempty
body is rejected.

## Non-effects

The 400 response occurred before the RepositoryDO transfer-plan RPC. The failed
audit did not create a grant or sync key, read an artifact or blob, publish an
artifact, write R2, advance a ref, send a Queue message, change schema or
bindings, or touch production. The already deployed adapter remains within the
approved public-effect scope.

## Retry gate

The correction passed the full local gate: protocol 182 tests, Worker 42 tests,
cloud deploy 16 tests, the Rust workspace and lint gates, vectors, static smoke,
formatting, types, and 119 Markdown files are green. Wrangler 4.125.0 staging
and production dry-runs both produced a 144.19 KiB bundle (28.38 KiB gzip) and
retained their existing binding topology.

Commit and ordinary CI remain. Then rerun the same main-only manual workflow.
Do not run a separate curl, upload, publish, or Queue smoke.
