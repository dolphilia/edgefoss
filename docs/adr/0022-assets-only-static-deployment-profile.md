# ADR 0022: Keep the static deployment profile scriptless and explicit

- Status: accepted
- Date: 2026-08-25
- Decision owners: static publishing and Cloudflare deployment maintainers
- Applies to: P3 `single-static`

## Context

The generated public site needs a Cloudflare deployment profile and provider
smoke without weakening its ability to run on any static host. A root command
must not accidentally deploy a fixture, dynamic Worker, or wrong environment.
The clean repository also must not contain a generated `dist` snapshot whose
identity can silently drift from its public bundle.

Workers Static Assets supports assets-only projects: `main` is optional and a
missing asset returns 404 without invoking a Worker. Static Site Generation can
select `html_handling` and a nearest custom `404.html`. Wrangler environments
create distinct Workers, and non-inheritable configuration must be repeated.
See the official [Static Assets overview](https://developers.cloudflare.com/workers/static-assets/),
[SSG routing](https://developers.cloudflare.com/workers/static-assets/routing/static-site-generation/),
and [Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/).

## Decision

- `apps/static-site/wrangler.jsonc` contains no `main`, asset binding, Worker
  source, runtime variable, secret, DO, KV, D1, or R2 declaration.
- The profile serves `./dist` with `auto-trailing-slash` HTML handling and the
  generated nearest `404.html`. `_headers` remains generated public-site policy,
  not executable application code.
- The root profile and production disable `workers.dev`; only the explicitly
  named staging environment enables it. Preview URLs remain disabled.
- `assets` is repeated in staging and production so an environment cannot lose
  its static-only boundary through inheritance assumptions.
- There is no generic `deploy` script. Staging and production commands select
  their environment and use Wrangler strict mode. A clean checkout has no
  `dist`; a publish operator must first generate the intended public snapshot.
- CI smoke generates a signed multi-realm fixture in an OS temporary directory,
  exports only public state through the production renderer, and overrides only
  `--assets` to point Wrangler at that temporary site. It dry-runs root, staging,
  and production before starting a root local server.
- The HTTP smoke verifies successful index/history/files/manifest responses,
  custom 404 behavior, generated security headers, `_headers` non-exposure,
  public semantic-root identity, and absence of restricted markers.
- The temporary directory is uniquely created and removed in `finally`. The
  smoke neither logs in nor reads/mutates a remote Cloudflare resource.

## Consequences

- The provider profile proves scriptless delivery rather than merely serving
  files through a development-only generic web server.
- Root `pnpm build` does not invent publishable repository state. Static profile
  verification belongs to `pnpm test:static`, which always supplies an exact
  generated fixture.
- Assets-only deployments have no Worker logs or traces to configure because no
  Worker invocation exists. HTTP behavior is checked externally instead.
- Remote staging still requires U1. Passing this local smoke does not authorize
  Wrangler login or deployment.

## Rejected alternatives

- Add Static Assets to `apps/worker`: rejected because that would couple the
  archive profile to dynamic Worker routing and future authority bindings.
- Commit a sample `dist`: rejected because it could be deployed accidentally
  and would duplicate derived state in version control.
- Add a Worker solely for 404 or headers: rejected because Static Assets already
  supports both and G3 explicitly values scriptless viewing.
- Use Pages for this new profile: rejected because current Cloudflare guidance
  directs new static applications to Workers Static Assets.
- Run remote dev for smoke: rejected because local assets need no account,
  network service, secret, or billable resource.

## Verification

`pnpm test:static` must pass on a clean checkout. It must exercise all three
configuration environments with `wrangler deploy --dry-run`, then make real
HTTP requests to `wrangler dev --local`. The temporary output must be absent
after both success and failure.
