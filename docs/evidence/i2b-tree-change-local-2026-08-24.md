# I2b tree/change local evidence — 2026-08-24

- Increment: I2b, tree/change executable specification
- Base commit: `a97dfe428c0874dc3b9ac94a6ddf6cb17bd6c77a`
- Commit: `f973cc38202e34bb6402be6a7763b75f3129e55b`
- Environment: macOS, Node.js `v24.19.0`, pnpm `10.10.0`, Rust `1.94.1`
- Result: pass; account owner confirmed GitHub Actions CI success

## Demonstrated slice

- Exact schema-0 `tree` and `change` envelopes and payloads are normative.
- Rust and TypeScript independently encode the shared tree and change inputs to
  identical canonical CBOR bytes and artifact IDs.
- Tree input order is normalized by NFC UTF-8 name bytes.
- Decoders require serialized entry order and exact fields.
- Tree validation rejects multi-segment names, ASCII case collision, unsafe
  symlink targets, and invalid content IDs.
- Change validation rejects invalid roots and non-NFC messages; parent arrays
  are bounded and strictly ordered by raw digest.
- The portable collision key uses only ASCII folding, avoiding runtime Unicode
  version drift; checkout must additionally detect target-filesystem collisions.

## Shared vector results

- Tree ID: `sha256:5539e9a3b15288c68fc792a15d443fe9ce3ed3056634839255b2d359573cd7ff`
- Change ID: `sha256:82b53cad39e27537df70607d6be6b870affae453691eea93673ff02dae954f4d`
- New logical invalid cases: 6
- Aggregate corpus: accepted 57, rejected 67, realm-flow decisions 14

## Verification

With the pinned Node.js 24 and Rust toolchains:

```text
pnpm check
  formatting: pass
  TypeScript typecheck: pass
  protocol tests: 143 pass
  Worker runtime tests: 2 pass
  Rust workspace tests: 13 pass
  Clippy -D warnings: pass
  documentation links: 30 Markdown files pass

pnpm build
  @edgefoss/protocol: pass
  @edgefoss/worker Wrangler dry-run: pass
```

## Scope boundary

I2b does not resolve referenced IDs against a graph and does not verify
signatures. I2c must check project/kind/realm/logical-clock relationships without
revealing whether an inaccessible target exists. Semantic-root implementation
remains in I2d.
