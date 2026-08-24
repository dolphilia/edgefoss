# ADR 0016: Export and verify the accepted public graph before composed realms

- Status: accepted
- Date: 2026-08-24
- Decision owners: local storage, CLI, format, and security maintainers
- Applies to: I3g local repository alpha

## Context

I3f can read accepted realm checkpoints, while the earlier `bundle-v0` spike
defines deterministic files and a semantic root but does not yet produce a
bundle from the local repository. Export must not accidentally package unsigned
working snapshots, unreachable rows, SQLite operational state, or the existence
of members/local data. Verification also needs to establish repository meaning,
not merely confirm that each file hashes to its manifest inventory entry.

A members bundle requires the exact public semantic root, and a local bundle
requires exact public and members roots. Accepting either bundle in isolation
would leave those base claims unverified. The first executable slice therefore
needs a realm that is both useful and independently verifiable.

## Decision

- I3g supports `ef export --realm public --output DIR`. The realm option remains
  explicit, but members/local fail before reading or creating output until
  composed base-bundle verification is implemented.
- Export begins at public `heads/main` and includes exactly the reachable linear
  change ancestry, every tree and raw blob reached by those changes, the public
  project genesis, one accepted signature for every included artifact, and the
  selected ref. Unsigned working roots and non-public tables are not inputs.
- One deferred SQLite read transaction fixes the head, inventory, object bytes,
  and manifest to a coherent database snapshot. Export revalidates stored IDs,
  envelopes, graph edges, blob hashes, and signatures while collecting it.
- The output uses the experimental unpacked `bundle-v0` layout. Files are first
  written with create-new semantics under a random sibling directory and then
  renamed into place. An existing or symbolic-link output is rejected.
- `ef verify DIR` requires no repository database, signing secret, Cloudflare
  account, or network. It treats the directory as untrusted, rejects symbolic
  links, unknown top-level entries, extra/missing objects, and per-file inputs
  above the local alpha limits.
- Deep verification checks canonical manifest bytes, semantic root, exact
  object hashes, known public artifact schemas, project/realm envelope binding,
  one valid actor signature per artifact, a contiguous linear change chain,
  change graph rules, tree/blob references, and exact reachability. Unreachable
  but correctly hashed objects are invalid.
- Provider state such as SQLite rows, R2 keys, Durable Object IDs/sequences,
  receipts, caches, and indexes never enters the bundle.

## Consequences

- A public bundle can be copied to a fresh machine and meaningfully verified
  offline. It is also a provider-neutral input for the later static-site and R2
  adapters.
- Members-only changes, messages, paths, object IDs, and counts cannot influence
  the public inventory or output. Tests scan the produced files and CLI output
  for restricted fixture markers.
- The current verifier intentionally rejects otherwise well-formed members and
  local manifests. The next composed-realm increment must accept explicit base
  bundle directories and compare their verified semantic roots to `base_roots`.
- I3g does not import, restore, stream, resume, archive, or encrypt a bundle.
  Transactional empty-database import and export→import→export root equality
  remain necessary before G2 can pass.
- The alpha reader loads inventoried objects into memory and retains the existing
  16 MiB per-object limit. Streaming/chunking and aggregate resource budgets are
  P7 work and cannot change canonical object bytes or semantic paths.

## Rejected alternatives

- Export every SQLite artifact row: rejected because working/unreachable state
  is not accepted project meaning and could leak restricted data.
- Start with members or authority-complete export: rejected because standalone
  verification cannot prove their claimed lower-realm bases.
- Let `verify` check only manifest and file hashes: rejected because a signed but
  unreachable object or invalid change/tree graph would still be accepted.
- Hide realm selection behind an implicit default: rejected because future
  restricted export must always be a deliberate capability and output choice.
- Store a ZIP/TAR archive now: deferred because archive framing, streaming, and
  resumability are transport concerns outside the already specified directory
  bundle semantics.

## Verification

Storage tests export public and members checkpoints from one database, verify
the public bundle without SQLite, prove the members marker is absent, and reject
a modified blob. CLI subprocess tests export to a new directory, run offline
verification, inspect all output files for restricted values, reject corruption,
and prove unsupported members export creates no output.
