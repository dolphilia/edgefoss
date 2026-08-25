# U3 first CI deploy transient health evidence — 2026-08-25

- Source commit: `e72e826fee08600dba990606a2572868ea246a57`
- Environment: staging only
- Deployment step: pass
- Immediate post-deploy audit: `GET /health` returned HTTP 500
- Later independent audit: pass
- U3 state: remediation pending commit, CI, and another manual workflow run

## Observation

The first account-token GitHub Actions deployment passed its credential guard,
project checks, staging dry-run, and Wrangler deployment. The immediately
following stateful health step failed on its first GET with HTTP 500. The
workflow output contained no Cloudflare API authorization or deployment error.

A later credential-free request to the same origin returned HTTP 200 with the
exact staging contract: Single Edition, SQLite `RepositoryDO` schema version 1,
and all three R2 bindings. Running the repository health auditor independently
also passed. The Worker code and Durable Object declaration had not changed
between the previously successful manual deployment and this CI deployment.

These observations rule out a persistent token-scope failure, missing binding,
unsupported schema, or broken Durable Object lifecycle declaration. They do
not identify the internal cause of the isolated 500 because the GitHub output
contains only the public status and no retained Worker exception. It is
therefore recorded narrowly as a transient post-deploy health failure.

## Remediation

The exact single-attempt audit remains reusable and strict. Its command-line
entry point now allows at most six complete attempts with five seconds between
attempts. Every attempt still requires the exact GET response, security
headers, bounded JSON body, and bodyless HEAD response. A persistent failure
therefore remains fatal after a maximum additional wait of 25 seconds.

No Cloudflare permission, token scope, Durable Object namespace, R2 resource,
production setting, or Queue consumer is changed by this remediation.

## Next verification

After this remediation is committed, pushed, and the normal GitHub Actions
checks pass, manually run `Deploy staging Worker` from `main` again. U3 becomes
complete only when the deployment and bounded stateful health audit both pass.
