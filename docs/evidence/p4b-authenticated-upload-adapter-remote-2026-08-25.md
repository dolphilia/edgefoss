# P4b authenticated upload adapter remote evidence — 2026-08-25

- Increment: P4b owner-authenticated small-blob remote smoke
- Deployed commit: `6407890ce1ca2c3c0985f60eadd36e146918b7af`
- Environment: `edgefoss-staging`
- Workflow ref: `main`
- Result: schema 3 deploy, stateful health, and bounded synthetic upload pass

## Account-owner observation

The account owner generated and retained the bootstrap token without sharing
its value, configured `EDGEFOSS_OWNER_TOKEN` as a staging Worker secret, and
reported the following ordered gates:

```text
deploy: success
stateful health: pass
repository schemaVersion: 3
3 R2 binding: bound
remote upload write before schema 3 health: not performed
Queue consumer: not added
```

After schema 3 health passed, the account owner ran the reviewed smoke with the
token supplied only through the process environment and reported:

```text
exit status: 0
target: edgefoss-staging
state: finalized
retryConverged: true
repositorySchemaVersion: 3
byteSize: 30
realm: public
Queue consumer: not added
token value shared: no
```

This verifies one deterministic harmless public blob through authenticated
declaration, bounded content staging, checksum verification, conditional final
write, status read, and retry convergence. The smoke did not target production,
members data, the restricted bucket, or Queue processing.

## Safe failed invocation and documentation correction

The first command attempt included an extra `--` before `--origin` and a URL
copied in Markdown-link form. Strict argument parsing rejected it with the usage
error before token validation, network requests, or remote writes. The user
procedure now passes `--origin` directly to `pnpm run`, requires a raw HTTPS
origin, and calls out the repository-pinned Node.js 24 runtime.

## Gate result

U3a and P4b are complete. P4c may now add artifact acceptance, realm ref CAS,
and operation dedupe while retaining the authenticated principal boundary and
without enabling a Queue consumer.
