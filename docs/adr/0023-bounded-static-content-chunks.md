# ADR 0023: Pack current text content into bounded static chunks

- Status: accepted
- Date: 2026-08-25
- Decision owners: static publishing, format, and disclosure maintainers
- Applies to: P3 `single-static`
- Extends: [ADR 0021](0021-deterministic-public-static-projection.md)

## Context

The first static projection exposed current file metadata but deliberately left
blob delivery open. File contents must now be readable without JavaScript, a
Worker script, Durable Objects, R2, or Cloudflare-specific routing. Emitting one
asset per blob would make deployment asset count follow repository object count
and would fail G3's paging/chunking requirement.

Workers Static Assets currently allows 20,000 files on the Free plan and
100,000 on paid plans, with a 25 MiB limit for each asset. Those limits are a
deployment ceiling, not a suitable target. See Cloudflare's official
[Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/)
and [Static Assets billing and limitations](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/).

## Decision

- The generator deduplicates current regular/executable files by artifact ID
  and packs their presentation records into deterministic
  `content/chunk-NNNN.html` assets.
- A chunk contains at most 100 records and at most 1 MiB of rendered section
  payload. The shared page shell is small and remains far below the provider's
  per-asset ceiling.
- A blob body is embedded only when it is valid displayable UTF-8 and no larger
  than 64 KiB. HTML escaping happens before packing, so the byte limit is
  enforced against the actual rendered section rather than raw input alone.
- Binary and larger current blobs receive an artifact-ID-addressed placeholder.
  Blobs present only in bundle history also remain external. A later authorized
  content store may serve those IDs without changing the bundle semantic root.
- Each current file row links to the corresponding record. Aliased paths share
  one content record; the record names one path and reports the alias count so
  aliases cannot make one section unbounded.
- `edgefossil-site.json` declares `bounded-static-chunks`, the thresholds,
  per-chunk record/body counts, inline object count, external object count, and
  total source blob bytes.
- The project index renders the five newest verified changes as a recent
  timeline. Full history and current-file views remain paged independently.
- Generated output stays plain linked HTML/CSS with no fetch dependency. The
  same bytes remain usable on Cloudflare or another ordinary static host.

## Alternatives considered

- One asset per blob: rejected because asset count scales directly with object
  count and deduplicated repository internals become deployment topology.
- One JSON file plus client-side rendering: rejected because it reintroduces
  JavaScript and can make one unbounded download and parse operation.
- Inline every current file: rejected because HTML escaping can expand data and
  a single source file can approach the local alpha's 16 MiB limit.
- Require R2 now: rejected because small public text needs no runtime or storage
  service, while large/binary delivery can remain an explicit later boundary.
- Pack archive files such as ZIP: rejected because direct browser navigation to
  an individual content record would require client extraction support.

## Consequences

- Asset growth follows bounded pages/chunks rather than one file per blob. A
  208-path/207-object current fixture produces three content assets, not 207
  assets.
- Small public source files are immediately browsable on the scriptless site.
  Binary, large, and historical-only bodies are not yet downloadable.
- `content_included` means at least one complete text body is embedded; it does
  not claim that all source blobs are present. `external_objects` makes the
  remaining delivery work explicit.
- The thresholds are experimental manifest-v0 policy. Changing them changes
  derived site bytes but never the source semantic root.
- The renderer still starts from a deeply verified public-only bundle, so
  chunking does not broaden the disclosure boundary.

## Verification

Unit tests use 205 small text files, one alias, one binary, and one over-limit
text file. They require deduplication, three content chunks, HTML-escaped text,
two external objects, deterministic repeat output, and absence of members/local
markers.
The assets-only HTTP smoke follows a file link, reads public text from the
served chunk, confirms restricted markers are absent, and checks manifest
chunk counts while the Wrangler profile still has no Worker script.
