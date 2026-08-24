# ADR 0014: Sign and publish one realm checkpoint at a time

- Status: accepted
- Date: 2026-08-24
- Decision owners: local CLI, storage, format, and security maintainers
- Applies to: I3e local repository alpha

## Context

I3d deliberately stops at unsigned realm working roots. Turning one of those
roots into history requires proof that the genesis owner authorized the
artifact graph, a causal parent/clock decision, and a ref update that cannot
partially succeed. Applying one message to all realms would also risk copying a
restricted description into the public graph.

The signing secret must not become repository data. A command-line seed value,
environment variable, or database column would be easy to expose through shell
history, process inspection, diagnostics, bundles, or backups.

## Decision

- `ef keygen --output KEY_FILE` creates a 32-byte Ed25519 seed using the OS
  random source. The file is created with `create_new` and Unix mode `0600`;
  only its derived public key and canonical path are printed.
- The alpha key file contains exactly 64 lowercase hexadecimal seed characters
  and one newline. Secret buffers use zeroizing wrappers, and the Ed25519
  implementation zeroizes signing-key material on drop. The seed is never
  placed in an artifact, SQLite, a signature record, command output, bundle, or
  test evidence.
- `ef checkpoint` requires an explicit `--signing-key-file`; it rejects a
  direct symbolic link, a non-regular file, Unix group/other permissions, a
  file inside the repository, and a key whose public half differs from the
  genesis actor. It reads the bounded file only for the duration of the
  command.
- A checkpoint requires exactly one explicit realm and one realm-specific
  message. Public, members, and local messages therefore cannot be copied
  implicitly across disclosure boundaries.
- The first change in a realm has no parent and logical clock zero. A later
  change parents the current same-realm `heads/main` change and increments that
  actor's clock. I3e accepts only the initial genesis actor; key rotation and
  multiple writers remain later protocol work.
- Before a realm head becomes visible, the CLI signs the project genesis, every
  tree reachable from that realm's working root, and the new change. SQLite
  independently recomputes IDs and graph reachability, verifies the exact
  signature set, and rejects missing, duplicate, unexpected, or invalid
  records. Raw blobs are verified by digest/reachability and are not Ed25519
  signed individually in this profile.
- Schema version 4 stores canonical detached signature records and realm refs.
  A ref is `(project, realm, heads/main, target, generation)`. Change insertion,
  signature insertion, and generation-based ref compare-and-swap commit in one
  `IMMEDIATE` transaction. The transaction rechecks the working root and head
  basis, so a concurrent snapshot/ref change rolls everything back.
- `ef status` reports each realm's accepted head and generation separately.
  Unsigned working roots remain staging state and may move independently.

## Consequences

- Possession of the initial owner key is proven when the first checkpoint also
  supplies the genesis signature anticipated by the artifact profile.
- Public history does not identify members/local roots, changes, messages,
  signatures, or counts. One realm can advance without moving another realm's
  ref generation.
- Repeating checkpoint without a new snapshot is allowed: it records another
  explicit historical event over the same tree with a new message/time/parent.
- Lost signing-key material cannot be recovered from the repository. Protected
  backup and later key-rotation design are prerequisites for irreplaceable use.
- This increment needs no Cloudflare account, binding, secret, Durable Object,
  or remote resource. A later sync sends signed public artifacts, never the
  signing seed.

## Rejected alternatives

- Store the seed in `.edgefossil/repository.sqlite3`: rejected because portable
  repository backup and local metadata compromise must not reveal signing
  authority.
- Accept the seed as a CLI option or environment variable: rejected because
  process and shell surfaces are broader than an explicit permission-checked
  file.
- Checkpoint all realms with one `-m`: rejected because a private description
  could silently enter the public artifact graph.
- Sign only the change: rejected because genesis possession and the immutable
  realm binding of reachable tree artifacts would remain unattested.
- Update refs after committing artifacts/signatures: rejected because a crash
  would leave ambiguous partially accepted state.

## Verification

Storage tests cover the initial signed head, parent/clock derivation, exact
signature verification, invalid-signature rollback, stale-working-root
rollback, and generation preservation. CLI subprocess tests cover protected key
generation, public/members independent heads, second-generation ancestry,
wrong-key rejection, repository-local-key rejection, and status inspection.
