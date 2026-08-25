# P4c canonical publish adapter remote evidence — 2026-08-25

- Increment: first owner-authenticated canonical staging publication
- Target Worker: `edgefoss-staging`
- Repository schema: 4
- Result: publication and exact operation retries converge
- Token value shared: no

## Reviewed mutation

Before execution, the adapter commit and remote-deploy evidence passed normal
CI. The account owner explicitly approved permanently initializing the
Single Edition staging authority with the deterministic public test actor and
synthetic project. Production and user repositories were excluded.

The account owner passed the existing staging owner token only through the
process environment and ran the exact-origin `cloud:smoke-publish` command. The
command exited 0 and reported:

```text
state: published
retryConverged: true
repositorySchemaVersion: 4
repoSequence: 3
refGeneration: 1
byteSize: 30
realm: public
r2WritePerformed: false
```

The smoke accepted one project genesis, one public tree referring to the
already-finalized P4b 30-byte public blob, and one public change. It advanced
public `heads/main` from absent generation 0 to generation 1. Each of the three
fixed operation IDs was submitted twice and returned the same stored accepted
result, demonstrating remote replay convergence.

## Confirmed boundaries

- three artifacts, receipts, and publish operation results now exist;
- public `heads/main` points at the synthetic change at generation 1;
- no new R2 object was written;
- no members artifact, blob, or ref was created;
- no production resource was contacted;
- no Queue consumer was added;
- the owner token was neither printed nor reported.

The approved staging authority is now intentionally dedicated to this
synthetic project. Re-running the same smoke is safe but unnecessary because it
replays the stored operations rather than creating new canonical effects.

## Gate result

P4c is complete: the schema 4 transaction, bounded authenticated HTTP adapter,
staged deployment, first remote publication, ref CAS, and exact retries have all
been demonstrated. G4 remains open. P4d must next prove transactional outbox,
alarm retry, Queue/DLQ delivery, and recovery while keeping canonical writes
independent of asynchronous delivery.
