# ADR 0011: Local repository layout and initial CLI boundary

- Status: accepted
- Date: 2026-08-24
- Decision owners: local CLI and storage maintainers
- Applies to: I3b local repository alpha

## Context

I3a established transactional project-genesis persistence but did not expose a
user workflow. The first CLI slice needs a stable-enough repository location,
safe discovery from a working-copy child directory, cryptographically strong
project nonces, and an explicit boundary around credentials that are not yet
needed for writing signed artifacts.

Automatically generating a private key during `init` would force decisions
about encryption, backup, rotation, filesystem permissions, and signing before
there is a signed write path. Hiding the database in an arbitrary platform
configuration directory would also separate repository identity from the
working copy it governs.

## Decision

- A local repository database is `.edgefossil/repository.sqlite3` below the
  working-copy root.
- `ef init` requires `--name` and `--actor-key`. The actor key is exactly one
  32-byte Ed25519 public key encoded as 64 lowercase hexadecimal characters.
- `ef init` obtains the 32-byte project nonce directly from the operating
  system random source and records the current UTC time at whole-second RFC
  3339 precision.
- Genesis is canonically encoded and validated before repository metadata is
  created. A repository with an existing identity rejects reinitialization.
- `ef status` searches the selected/current directory and its ancestors for the
  database, then revalidates genesis identity, schema version, and SQLite
  `quick_check` before reporting success.
- Both commands reject symbolic links at the `.edgefossil` directory or database
  boundary. Paths are reported in canonical absolute form.
- On Unix, newly created metadata directories use mode `0700` and database
  files use mode `0600`; the process umask may make them more restrictive.
- I3b generates and stores no private key. Key generation, protected storage,
  proof of key possession, and artifact signing are deferred until a signed
  write command is implemented and tested end to end.

## Consequences

- The first CLI is usable without a Cloudflare account or remote resource.
- A caller must already possess or deliberately supply a public key. Merely
  accepting its byte encoding does not prove possession of the private key.
- Repository discovery has conventional working-copy behavior without a
  machine-global registry.
- The metadata directory is reserved for later local state, but only the
  SQLite file is created in I3b.
- Symlink rejection narrows accidental repository redirection. It does not
  claim a complete defense against a concurrently malicious local process;
  stronger descriptor-relative path handling can be evaluated with the write
  and threat models of later increments.

## Rejected alternatives

- Generate and save a plaintext private key during `ef init`: rejected because
  no signed operation needs it yet and safe lifecycle requirements are not
  defined.
- Derive the nonce from name, time, or public key: rejected because project IDs
  need collision resistance independent of user-selected input.
- Use a machine-global database: rejected because it complicates portability,
  working-copy discovery, and repository-scoped backup.
- Follow metadata/database symbolic links: rejected because command scope could
  silently cross the selected working-copy boundary.

## Verification

I3b covers initialization and status in a subprocess, descendant discovery,
reinitialization rejection with preserved identity, canonical actor-key input,
no metadata residue for invalid input, and read-only failure outside a
repository. Workspace checks continue to run the storage reopen and
canonical-genesis verification from I3a.
