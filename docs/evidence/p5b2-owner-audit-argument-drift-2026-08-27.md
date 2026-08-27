# P5b2 owner audit argument drift evidence

- Date: 2026-08-27
- Scope: local CLI argument handling for the read-only staging owner audit
- Result: root cause identified; no network request or remote mutation occurred

## Observation

The operator used the documented package-script form:

```bash
pnpm run cloud:audit-public-push-owner -- --origin https://edgefoss-staging.miga-and-raia.workers.dev
```

pnpm forwarded the separator as a leading `--`. The shared parser required
`--origin` to be the first argument and raised its usage error before
`auditWorkerPublicPushOwner` was called.

Consequently, the failed attempt did not validate the token, issue anonymous
HELLO, call the authenticated preflight route, or perform any remote read or
write. The token must still be removed from the shell environment after the
failed attempt.

## Correction and boundary

The shared parser now normalizes exactly one optional leading package-manager
separator. Both of these forms resolve to the same exact approved staging
origin:

- direct Node invocation with `--origin HTTPS_ORIGIN`;
- `pnpm run` invocation with `-- --origin HTTPS_ORIGIN`.

Repeated separators, missing arguments, extra arguments, malformed URLs, and
any origin other than the exact approved HTTPS staging Worker remain rejected
before fetch. The existing credential-free workflow invocation therefore keeps
its behavior while the documented operator command becomes executable.

## Local verification

- `pnpm test:cloud-deploy`: 22 tests passed, including direct and pnpm argument
  forms plus repeated-separator and extra-argument rejection.
- `pnpm check`: passed; protocol 182 tests, Worker 50 tests, Rust tests and
  clippy, 9 shared vector files, static smoke, formatting, typechecks, and 129
  Markdown files all passed.
- The exact documented package-script command was run with
  `EDGEFOSS_OWNER_TOKEN` deliberately absent. It passed argument parsing and
  stopped at the expected local `EDGEFOSS_OWNER_TOKEN is missing or invalid`
  check before fetch. No credential or network request was used.

## Retry gate

The correction and its regression test must be committed, pushed, and pass
ordinary GitHub Actions before the operator retries. A retry is allowed only
after the manual staging workflow is also confirmed successful. The retry
remains an empty-inventory, read-only preflight and does not authorize upload,
publish, R2, Queue, or production effects.
