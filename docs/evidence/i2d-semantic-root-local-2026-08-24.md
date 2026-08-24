# I2d semantic-root local evidence — 2026-08-24

- Increment: I2d, realm-isolated semantic-root executable specification
- Base commit: `bed13df77dfbc21d64cf1101c4a543a736438b51`
- Commit: `f72eae35978dca36fe66a18059f5aff5d71a98ca`
- Environment: macOS, Node.js `v24.19.0`, pnpm `10.10.0`, Rust `1.94.1`
- Result: pass; account owner confirmed GitHub Actions CI success

## Demonstrated slice

- Rust and TypeScript select exactly one requested realm before validating or
  hashing candidate records.
- Both independently produce identical artifact-set digests, canonical root
  descriptor bytes, and semantic-root IDs for `public`, `members`, and `local`.
- Public inventory includes the project genesis artifact and binds named refs
  and portable policy version while excluding authority implementation state.
- Selected duplicate artifacts/refs and invalid ref names are rejected.
- A selected ref target outside the selected artifact set returns
  `unknown_required_semantics`.
- Input artifact order is immaterial.

## Public-members independence property

Each implementation starts from the shared public vector and evaluates 128
generated members-only mutations. The mutations reorder the complete input,
add members artifact IDs, and add deliberately malformed members artifact/ref
records. Every case produces the unchanged public semantic root:

```text
sha256:ca6263dfcbe8df9442012c75630304a3a553b46a7067f32d642d90854db88376
```

Ignoring malformed non-selected records is intentional. Validation of a
complete imported inventory is a separate operation; one realm root does not
certify other realms.

## Shared vector results

- exact realm roots: 3;
- invalid semantic-root cases: 6;
- generated public-members independence cases: 128 per implementation.

## Verification

With the pinned Node.js 24 and Rust toolchains:

```text
pnpm check
  formatting: pass
  TypeScript typecheck: pass
  protocol tests: 174 pass
  Worker runtime tests: 2 pass
  Rust workspace tests: 19 pass
  Clippy -D warnings: pass
  documentation links: 32 Markdown files pass

pnpm build
  @edgefoss/protocol: pass
  @edgefoss/worker Wrangler dry-run: pass
```

## Scope boundary

This increment calculates roots from an in-memory portable view. Reachability
enumeration, tombstone artifact schemas, bundle import/export, and storage-backed
incremental calculation remain later increments. G1 still requires the
third-party implementability review.
