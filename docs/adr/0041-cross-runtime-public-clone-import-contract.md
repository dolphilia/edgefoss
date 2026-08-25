# ADR-0041: Prove the public clone contract across Workers and local SQLite

- Status: Accepted for P5a2b2
- Date: 2026-08-26
- Owners: sync, protocol, and local storage leads
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

P5a2b1 assembles a canonical public bundle inside the Workers runtime. Passing
TypeScript bundle verification alone does not prove that the Rust local store
can reconstruct the same accepted state. The first cross-runtime attempt found
a real mismatch: the cloud publication core accepted a first change with a
nonzero logical clock, while the current Rust complete importer requires a
single-actor linear history beginning at clock zero.

Silently emitting such a plan would defer a deterministic incompatibility until
after the client downloaded every object.

## Decision

Keep the existing `edgefossil-bundle` schema and make the internal `complete`
clone profile an explicit compatibility subset. Before emitting a plan, the
Worker requires:

- project genesis, every tree, and every change to use the genesis actor;
- every reachable tree to use logical clock zero;
- change ancestry to be linear and acyclic;
- the first change to use logical clock zero and each descendant clock to be
  exactly one greater;
- ref generation, reachable change count, and the head clock plus one to agree.

An accepted cloud history outside that subset returns
`clone_profile_unsupported`. It remains accepted cloud state, but is not
misrepresented as importable by the current local complete profile.

Add `spec/vectors/public-clone-v0.json` as one deterministic signed clone. It is
generated from a fixed RFC 8032 test key, fixed timestamps, a fixed nonce, and a
fixed blob. The private seed is test data only and is never a credential.

The Workers test publishes the vector through RepositoryDO, finalizes its blob
through the local R2 binding, and requires clone plan, artifact transfer,
signature transfer, and blob chunk output to match every committed byte. The
Rust test reads that exact file, deeply verifies it, imports it into a fresh
in-memory SQLite repository, and requires byte-identical re-export.

The generator has a `--check` mode included in `vectors:check`; CI fails if the
committed vector drifts from deterministic generation.

## Atomicity boundary

The cross-runtime vector is passed to the existing immediate SQLite transaction.
A corrupt vector is rejected while the destination remains empty and can be
retried with the valid vector. The existing injected mid-import failure test
continues to prove that artifacts, repository identity, blobs, signatures, and
refs all roll back together. P5a2b2 does not add a second import path.

## Scope boundary

There is no new HTTP route, advertised capability, schema migration, binding,
secret, Cloudflare resource, remote R2 operation, Queue event, staging deploy,
or production change. P5a2c remains responsible for an opaque external grant,
HTTP transport, disconnect resume, and a separately approved staging effect.

## Consequences

- an emitted complete clone plan is directly consumable by the current Rust
  importer;
- incompatible accepted histories fail before object transfer;
- TypeScript and Rust share exact manifest, artifact, signature, and blob bytes;
- local import creates no working-copy or staging state;
- future merge or multi-actor support requires a new importer/profile decision,
  not a relaxed assertion in this test.

## Verification

- deterministic generation reproduces the committed vector;
- Worker plan bytes and all transferred objects equal the vector;
- protocol manifest and object verification accepts the assembled output;
- Rust deep verification accepts the same output;
- a fresh Rust repository imports at generation one and re-exports identical
  manifest and object bytes;
- corrupt input leaves a fresh destination empty and a valid retry succeeds;
- replay into the populated realm rejects without changing its re-export;
- unsupported Worker logical-clock history returns
  `clone_profile_unsupported`;
- Worker schema remains 5 and the external surface remains unchanged.
