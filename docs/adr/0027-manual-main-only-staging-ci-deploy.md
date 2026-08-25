# ADR-0027: Gate staging CI deployment behind manual main-only execution

- Status: Accepted for U3 readiness
- Date: 2026-08-25
- Owners: cloud lead, account owner
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

P4a completed its first manual OAuth deployment and remote stateful smoke, so
checkpoint U3 may begin. A CI credential must not be requested until the exact
workflow that will consume it is present and locally verified. Automatic deploy
on every push would couple ordinary source integration to a remote Cloudflare
mutation before rollback and production release controls are mature.

The current target is only `edgefoss-staging`. Production remains unapproved,
and the provisioned Queue/DLQ must stay without consumers until P4d.

## Decision

Add `Deploy staging Worker` as a separate `workflow_dispatch` workflow. It:

1. explicitly fails unless the selected ref is `refs/heads/main`;
2. explicitly fails unless both U3 GitHub Actions secrets are configured;
3. grants the GitHub token only `contents: read`;
4. serializes staging deploys without canceling an in-flight deployment;
5. installs the locked project dependencies and reruns `pnpm check`;
6. performs a staging Wrangler dry-run before any mutation;
7. invokes the official `cloudflare/wrangler-action` v4.0.0 at immutable commit
   `ebbaa1584979971c8614a24965b4405ff95890e0`, with Wrangler `4.125.0` and the
   explicit command `deploy --env staging`;
8. runs a bounded, credential-free public health auditor after deployment.

The workflow references exactly two GitHub Actions repository secrets:
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The account owner creates
them only after this workflow is committed and GitHub Actions is green. The
Cloudflare token starts from the current official `Edit Cloudflare Workers`
template and is restricted to the one approved account. No extra permission is
added unless a real workflow run fails with a documented missing permission.

The health auditor accepts only a credential-free HTTPS origin, rejects
redirects, reads at most 4096 response bytes, and requires the
exact staging Single Edition/SQLite/R2 contract for GET plus a bodyless HEAD.
It never receives the Cloudflare credentials.

The command-line audit makes at most six complete attempts with a fixed
five-second delay between attempts. This bounded retry absorbs a transient
post-deploy Worker or Durable Object startup failure while preserving the exact
GET/HEAD contract on every attempt. A persistent transport, status, header,
body, or schema failure remains fatal after the retry budget.

## Alternatives considered

- Deploy automatically on every `main` push. Rejected until later release gates
  exist; CI validation and remote mutation remain separate operations.
- Allow a workflow input to choose staging or production. Rejected because U3
  authorizes staging only and an input typo must not widen the target.
- Call `wrangler deploy` in a shell step. Viable, but the official action provides
  supported credential inputs while the command remains explicit and pinned.
- Track a floating action tag. Rejected because an immutable commit prevents an
  upstream tag move from changing deploy code without repository review.
- Add a GitHub `staging` Environment and required reviewers now. Rejected as an
  additional account-owner setup that the current manual/main-only gate does not
  require. Production approval remains a later U6 concern.
- Re-run `cloud:provision` in the deployment workflow. Rejected because resource
  creation is separately approval-gated and is not part of ordinary code deploy.

## Consequences

Merging the workflow does not deploy anything. Before U3 credentials exist, a
manual run fails before checkout or dependency installation without printing
secret values. After U3, the account owner still chooses when to run the staging
deployment from GitHub Actions.

The official token template contains the supported Workers deployment
permissions. Its account resource scope is narrowed to the single EdgeFossil
account; no Global API Key, R2 S3 credential, production token, custom domain,
or GitHub Environment is introduced.

## Verification

- local tests assert the trigger, permissions, main guard, credential guard,
  immutable action SHA, staging-only commands, and absence of provision or
  production commands;
- health-auditor tests cover exact success, unsafe origins, contract drift,
  missing security headers, and oversized responses;
- the auditor passes against the existing public staging deployment;
- staging Wrangler dry-run lists only `RepositoryDO`, the three approved R2
  buckets, and `EDGEFOSS_ENV=staging`;
- `pnpm check` and `pnpm build` remain the repository gates;
- the first credentialed manual workflow run is deferred until this change is
  committed, GitHub Actions succeeds, and the account owner completes U3.

References:

- [Cloudflare GitHub Actions deployment](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Cloudflare API token templates](https://developers.cloudflare.com/fundamentals/api/reference/template/)
- [Wrangler Action](https://github.com/cloudflare/wrangler-action)
- [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use)
