# P4b small-blob core remote migration evidence — 2026-08-25

- Increment: P4b internal small-blob core schema migration
- Deployed commit: `13ccfa0e9b9664250868f1cc3bc707ba622f9b23`
- Environment: `edgefoss-staging`
- Workflow ref: `main`
- Result: deploy and stateful health pass

## Account-owner observation

The account owner ran the manual main-only `Deploy staging Worker` workflow and
reported:

```text
deploy: success
stateful health: pass
repository schemaVersion: 2
3 R2 binding: bound
remote upload write: not performed
Queue consumer: not added
```

This is the planned schema 1 to 2 migration gate for ADR-0028. It verifies that
the existing RepositoryDO upgraded and remained healthy without creating a
remote upload object. The authenticated adapter and its schema 2 to 3 migration
are a separate next increment.
