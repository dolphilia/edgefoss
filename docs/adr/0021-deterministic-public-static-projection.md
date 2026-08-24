# ADR 0021: Project verified public bundles into paged static sites

- Status: accepted
- Date: 2026-08-25
- Decision owners: static publishing, format, and disclosure maintainers
- Applies to: P3 `single-static`

## Context

`single-static` must remain viewable without a Worker script or Durable Object,
must never compose members/local state into a public site, and must avoid
turning every graph artifact or blob into a separately deployed asset. The
output also needs a stable boundary at which a later profile can deliver large
content through R2 without changing the public bundle identity.

Cloudflare currently recommends Workers Static Assets for new static projects
and documents an assets-only configuration using `assets.directory` without a
Worker script. The same output directory is ordinary HTML/CSS and must remain
hostable elsewhere. See the official
[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
and [Static Assets configuration](https://developers.cloudflare.com/workers/static-assets/binding/).

## Decision

- `ef-static-site` accepts one in-memory `bundle-v0`, decodes its manifest, and
  rejects every realm other than `public` before projection.
- It then runs the existing provider-independent deep verifier. Rendering never
  becomes an alternate, weaker bundle reader.
- The output contains server-independent HTML, one shared CSS asset, `_headers`,
  and `edgefossil-site.json`. It has no JavaScript, runtime binding, network
  fetch, Worker entry point, or generated timestamp.
- History and the current file tree use deterministic pages of at most 100
  logical records. Page names and ordering derive only from verified portable
  state.
- Blob bodies are not copied into one asset per blob in this slice. File rows
  expose the verified content ID and byte count. The site manifest records
  `external-content-addressed` payload delivery, object count, and total bytes;
  later content viewing may map those IDs to grouped static chunks or R2.
- `ef static-build PUBLIC_BUNDLE_DIRECTORY --output SITE_DIRECTORY` reads with
  the hardened bundle-directory boundary and publishes the complete output by
  atomic directory rename. It refuses an existing output.
- HTML text is escaped, the output carries a no-script Content Security Policy,
  and the site semantic identity remains the source public semantic root.

## Consequences

- A verified complete public bundle regenerates byte-identical site files and
  the same semantic root without Cloudflare access.
- Members/local bundles fail closed, and restricted state cannot enter through
  lower-realm composition because no bases are accepted.
- File content viewing is deliberately incomplete in this first slice. Adding
  it requires a bounded chunk/container design and leakage tests; it must not
  regress to one blob per deployed asset.
- `_headers` improves deployments on Workers Static Assets, while hosts that do
  not interpret it still serve standards-based static files.
- An assets-only Wrangler profile and actual local/remote serving remain
  separate follow-up work. No Cloudflare account action is justified yet.

## Rejected alternatives

- Render directly from SQLite: rejected because publishing would bypass the
  portable bundle boundary and make exact regeneration harder to prove.
- Accept members/local plus bases and filter during rendering: rejected because
  this enlarges the disclosure boundary without providing public-site value.
- Emit every artifact and blob as a file: rejected because deployed asset count
  would scale with repository internals rather than view pages.
- Require a Worker to render or mediate every request: rejected because it
  violates the archive/static-host goal and introduces an avoidable runtime.
- Build a client-side SPA over JSON: rejected for the first slice because plain
  linked HTML works from simple static hosts and has a smaller execution and
  content-security surface.

## Verification

Unit and CLI E2E tests must prove deep-verification failure on corruption,
non-public rejection, byte-identical repeat generation, HTML escaping,
members/local marker absence, more than two file pages, no `blobs/` output, and
atomic refusal to overwrite an existing site directory.
