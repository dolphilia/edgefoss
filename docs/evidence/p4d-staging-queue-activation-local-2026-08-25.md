# P4d staging Queue activation local evidence — 2026-08-25

- Increment: first staging Queue producer and consumer configuration
- Scope: local configuration, generated types, tests, and dry-runs only
- Remote mutation: none

## Configuration contract

The named staging Wrangler environment now declares the already provisioned
`edgefoss-staging-events` Queue as the `EVENTS` producer binding and as a
consumer of the same Worker. Its maximum batch size 10, maximum batch timeout 5
seconds, maximum retries 3, and `edgefoss-staging-events-dlq` dead-letter Queue
exactly match `infra/cloud-resources.json`.

The named production environment still declares empty producer and consumer
lists. A deploy-workflow contract test compares both named environments against
the reviewed manifest so an accidental resource-name or policy divergence
fails ordinary CI.

Generated Wrangler types make `EVENTS` required in `Cloudflare.StagingEnv` and
leave it absent from `Cloudflare.ProductionEnv`. The shared base `Env` keeps the
binding optional so the same module can safely represent the disconnected
production environment.

## Local verification

- Wrangler: 4.125.0
- staging dry-run: one `EVENTS` Queue producer, `RepositoryDO`, three R2
  bindings, and the staging environment variable
- production dry-run: no Queue binding, with `RepositoryDO`, three production
  R2 bindings, and the production environment variable
- protocol tests: 182 passed
- Worker integration tests: 21 passed across 4 files
- owner adapter and smoke tests: 8 passed, including 5 Queue smoke tests
- cloud deploy tests: 8 passed, including the exact manifest/config comparison
- Rust tests and lint, static-assets smoke, shared vectors, formatting,
  TypeScript type checks, and 98-file Markdown link audit: passed
- staging and production dry-run bundle: 83.83 KiB, gzip 17.93 KiB
- local startup profile: 10.2 ms active, 0.0 ms garbage collection

## Non-effects and next gate

No Worker was deployed, no Queue consumer was registered remotely, no artifact
or outbox row was created, no Queue message was sent, and no R2 object was
written. After this increment is committed and ordinary CI succeeds, the next
gate is a main-only manual staging deploy followed by schema 5 health and
no-write verification. `cloud:smoke-queue` remains prohibited until that deploy
passes and the account owner separately approves the permanent sequence 4
effect.
