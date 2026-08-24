# P4a stateful foundation remote evidence — 2026-08-25

- Increment: P4a first stateful staging deployment
- Source commit: `85eb3e001101ac0f717af9785a80611ff0f6302e`
- GitHub Actions: success confirmed by the account owner before deployment
- User checkpoint: U1 and U2 complete
- Environment: staging only
- Worker: `edgefoss-staging`
- Result: deploy, Durable Object reconciliation, stateful health, and Queue
  isolation pass

## Deployment result

The account owner used the project-local Wrangler OAuth session to deploy the
committed staging profile. The command exited with status 0 and reconciled the
declarative SQLite `RepositoryDO` export successfully. No production profile,
custom domain, CI credential, Queue consumer, or R2 object write was involved.

The active deployment was independently inspected through Wrangler. It has one
version receiving 100% of traffic. Deployment IDs, version IDs, account IDs,
and account identity are intentionally omitted from this evidence.

## Stateful health audit

Origin:

```text
https://edgefoss-staging.miga-and-raia.workers.dev
```

An independent public GET returned HTTP 200 with:

```json
{
  "components": {
    "repository": {
      "schemaVersion": 1,
      "status": "ok",
      "storage": "sqlite"
    },
    "r2": {
      "exports": "bound",
      "publicBlobs": "bound",
      "restrictedBlobs": "bound"
    }
  },
  "edition": "single",
  "environment": "staging",
  "service": "edgefoss",
  "status": "ok"
}
```

The response also had `Content-Type: application/json; charset=utf-8`,
`Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`. A separate
HEAD request returned HTTP 200 and no body.

The GET traversed the Worker-to-DO RPC boundary, proving that the fixed Single
Edition authority instance exists, its SQLite schema version 1 can be read, and
the three realm-separated R2 bindings are present. The R2 fields are binding
topology assertions; no sentinel object was written.

## Queue isolation

Read-only Wrangler consumer listing returned:

```text
edgefoss-staging-events: No consumers found
edgefoss-staging-events-dlq: No consumers found
```

This matches ADR-0026: the provisioned Queue and DLQ stay idle until P4d defines
the outbox event contract, retry behavior, and idempotent consumer.

## Gate impact and next action

P4a is complete. Its exit condition is met: the Worker, SQLite `RepositoryDO`,
and separated R2 bindings run in staging and expose a stateful health check.

The next implementation slice is P4b small-blob upload with an explicit
staging, verify, finalize, and retry-safe state machine. CI deployment checkpoint
U3 is now eligible to start because the prerequisite manual OAuth deployment
and staging smoke succeeded. No token should be created until the repository
contains and locally verifies the exact minimal CI deployment workflow and its
required permissions.

References:

- [Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
- [Wrangler deploy](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy)
- [Durable Object observability](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/)
