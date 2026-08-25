# P5a1 public sync adapter remote deploy evidence — 2026-08-25

- Increment: anonymous public sync adapter staging activation
- Deployed commit: `58c8c3a`
- Workflow ref: `main`
- Target Worker: `edgefoss-staging`
- Result: deploy, stateful health, and anonymous `HELLO` passed
- Repository schema: 5

## Gate sequence

The adapter implementation at commit `02bae88` and the dedicated `HELLO`-only
post-deploy audit at commit `58c8c3a` both passed ordinary GitHub Actions before
the manual staging workflow ran. The account owner had explicitly approved the
two externally visible effects: anonymous enumeration of public artifact IDs and
kinds, and possible lazy creation of one RepositoryDO cursor-key meta row.

The main-only `Deploy staging Worker` workflow deployed the reviewed ref, ran the
existing stateful health audit, and then sent exactly one credential-free GET to
the anonymous sync `HELLO` endpoint. The operator did not call inventory.

## Observed deployment contract

The stateful health audit passed with `repository.schemaVersion=5`. Anonymous
sync negotiation returned the reviewed protocol contract:

```text
protocolVersion=0
view=public
cursor=opaque
cursorTtlSeconds=600
maxPageItems=1000
```

The staging Queue and three R2 bindings were unchanged, and production was
unchanged.

## Non-effects and limit

- the operator did not call `GET /api/v0/inventory`;
- the workflow did not fetch artifact IDs or kinds;
- no schema migration, new binding, Cloudflare resource, secret, or credential
  was introduced;
- no Queue event, R2 write, canonical artifact, ref mutation, or production
  change was requested by the deployment or audit.

The deployment makes the approved anonymous inventory route reachable. A third
party can therefore call it at any time and trigger lazy cursor-key creation.
This evidence does not claim that the cursor-key row remained absent after
deployment.

## Result and next gate

P5a1 is complete. Staging proves that the external anonymous adapter negotiates
the exact protocol-0 public view without credentials while retaining schema 5
and the reviewed cloud topology.

Commit this evidence and pass ordinary CI. P5a2 may then begin as a local-first
increment for bounded public artifact transfer and fresh local import. Its first
increment must not add a remote route, schema migration, binding, credential,
R2 write, Queue event, or production change.
