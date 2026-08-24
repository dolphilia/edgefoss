# U1 Cloudflare access checkpoint — 2026-08-25

- Checkpoint: U1, first remote staging deploy authorization
- Trigger: I4d committed as `0f3cf4b8dcbc7b108b90b6f2ec6654487aad3d1e`;
  GitHub Actions success confirmed by the repository owner
- Status: complete; owner confirmation received 2026-08-25
- Remote state: assets-only staging deploy authorized and completed after owner
  confirmation; no production, R2, DO, Queue, custom-domain, or token mutation

## Local prerequisites confirmed

```text
Node.js: 24.19.0
pnpm: 10.10.0
project-local Wrangler: 4.125.0
CLOUDFLARE_API_TOKEN: not set
CLOUDFLARE_API_KEY: not set
CLOUDFLARE_EMAIL: not set
CLOUDFLARE_ACCOUNT_ID: not set
I4d local checks and GitHub Actions: pass
```

The assets-only staging profile is `edgefoss-static-staging`. It enables only
its `workers.dev` route; preview URLs are disabled. Production and the unnamed
root profile keep `workers.dev` disabled. The profile has no Worker script,
secret, runtime binding, R2 bucket, or Durable Object.

## Owner completion evidence

The account owner reported all required non-secret results:

- the intended Cloudflare account is selected, with a single account
  membership;
- 2FA and safely stored backup codes are ready;
- project-local `wrangler whoami` succeeds for the intended account;
- OAuth credentials use encrypted storage backed by macOS Keychain;
- a non-sensitive account-wide `workers.dev` subdomain is configured.

Do not record account IDs, email addresses, OAuth values, backup codes, or the
full `whoami` output here. Completion evidence is limited to success/failure,
intended-account confirmation (name may be redacted), encrypted-storage
confirmation, and subdomain-configured confirmation.

## Explicitly deferred

U1 did not require a deploy, custom domain, Workers Paid plan, R2 subscription,
R2 credentials, API token, CI secret, Access, D1, KV, or Durable Object. Remote
staging is now authorized only for the assets-only `staging` profile.

## Authorized result

The implementation agent subsequently deployed only
`edgefoss-static-staging` and completed the remote byte audit. See
[I4e remote staging evidence](i4e-assets-only-remote-staging-2026-08-25.md).

## Current official references

- [Cloudflare two-factor authentication](https://developers.cloudflare.com/fundamentals/user-profiles/2fa/)
- [Wrangler general commands](https://developers.cloudflare.com/workers/wrangler/commands/general/)
- [workers.dev configuration](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
