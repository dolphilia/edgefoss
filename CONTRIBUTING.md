# Contributing to EdgeFossil

EdgeFossil is developed as a sequence of executable specifications and small vertical slices. The current and next increments are the only work that should be fully detailed.

## Before starting

1. Read the relevant specification or ADR.
2. State one testable outcome and at least one failure case.
3. Keep an issue within five engineer-days; prefer 0.5–3 days.
4. Identify format, protocol, schema, realm, migration, and rollback effects.
5. If a `USER-ACTION` checkpoint applies, prepare the minimal work order without requesting secret values.

## Local checks

```bash
pnpm install
pnpm types
pnpm check
```

Run `pnpm format` to apply repository formatting. Cloudflare bindings must be declared in `wrangler.jsonc`; regenerate types with `pnpm types` after every binding change.

## Change rules

- Never commit `.env`, `.dev.vars`, tokens, recovery codes, presigned URLs, or account credentials.
- Do not add Cloudflare resource identifiers to the portable Rust domain core.
- Every behavior change needs a test at the narrowest useful layer.
- Restricted paths, hashes, content, and counts must not enter public output or logs.
- Keep commits reviewable and separate compatibility-date changes from unrelated dependency updates.

See [coding conventions](docs/development/coding-conventions.md) for language-specific rules.
