# I2a path/realm local evidence — 2026-08-24

- Increment: I2a, partial executable specification
- Base commit: `ef39b8de0dc59cf30e5425949fbd39885181e651`
- Source state: local working tree; commit and CI confirmation pending
- Environment: macOS, Node.js `v24.19.0`, pnpm `10.10.0`, Rust `1.94.1`
- Result: local pass

## Demonstrated slice

- Rust and TypeScript implement the same `edgefossil-path-v0` syntax validator
  with deterministic error precedence.
- The path corpus covers NFC/non-NFC text, traversal, Windows device names,
  forbidden checkout characters, control characters, nested paths, Unicode,
  and 255/256/4097-byte boundaries.
- Both implementations parse and format only canonical `sha256:` artifact IDs.
- Both implementations apply the same parent/content reference flow across the
  built-in `public`, `members`, and `local` realms.
- Normative realm-flow and verifier-error drafts were added.

## Corpus size

The shared files now contain:

- accepted vectors: 55 (`project.genesis` 1, path 51, artifact ID 3);
- rejected vectors: 61 (`project.genesis` 7, path 43, artifact ID 11);
- realm-flow decisions: 14.

This crosses the G1 numeric 50+50 floor, but does not pass G1 because tree,
change, graph resolution, signatures, logical clocks, and semantic-root
properties remain incomplete.

## Verification

With the pinned Node.js 24 and Rust toolchains:

```text
pnpm check
  formatting: pass
  TypeScript typecheck: pass
  protocol tests: 135 pass
  Worker runtime tests: 2 pass
  Rust workspace tests: 9 pass
  Clippy -D warnings: pass
  documentation links: 29 Markdown files pass

pnpm build
  @edgefoss/protocol: pass
  @edgefoss/worker Wrangler dry-run: pass
```

## Scope boundary

I2a passed the full local repository check and is ready for commit and CI. I2
continues with exact tree/change schemas, portable sibling-collision validation,
cross-project graph validation, and semantic-root executability.
