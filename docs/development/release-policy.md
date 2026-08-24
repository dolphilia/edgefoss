# Release and versioning policy

Status: P0 baseline

## Independent version axes

EdgeFossil versions these concerns independently:

1. CLI/application release
2. artifact format
3. artifact-kind schema
4. bundle format
5. sync protocol
6. authority schema migration
7. reducer version

An application upgrade must not silently rewrite existing artifact identities.

## Pre-release policy

- Application versions remain `0.x` until G9 passes.
- P1–P6 artifact/bundle outputs carry an `experimental` marker.
- Experimental data may be discarded or explicitly migrated; it is not a compatibility promise.
- The v0 compatibility freeze occurs only after D3b, when local, cloud, sync, export, and public/member views have exercised the format.

## General-release policy

- Releases are immutable, signed artifacts with checksums.
- Every release states supported CLI, format, bundle, and protocol ranges.
- Breaking portable-format changes require a new format/schema version and an explicit migration decision.
- Authority schema migrations require staging upgrade and rollback/forward-fix rehearsal.
- Security fixes never weaken the ability to verify old portable artifacts offline.

Release dates are not fixed before the G7 restore drill succeeds.
