# ADR 0020: Separate constrained fixture generation from timed local commands

- Status: accepted
- Date: 2026-08-25
- Decision owners: local storage, format, and performance maintainers
- Applies to: I3k local repository alpha

## Context

G2 requires measurements with 10,000 files and 100,000 artifacts. A useful
baseline must use valid EdgeFossil state, identify its source/environment, keep
fixture construction outside command latency, and remain reproducible without
making the full scale run part of every CI execution.

`bundle-v0` also imposes two relevant correctness constraints: inventories are
realm-scoped, and the canonical manifest artifact cannot exceed 1 MiB. A single
100,000-artifact bundle is invalid. Even an inventory below the nominal 65,535
entry limit can exceed the encoded-size limit because artifact and signature
digests are both listed.

## Decision

- `ef-local-baseline` has a small `smoke` profile and an explicit `g2` profile.
  Both use the same fixture builder and subprocess command runner. CI runs Rust
  tests over the synthetic two-realm builder; the costly full profile is an
  evidence-producing gate operation, not an ordinary test.
- The file fixture creates 10,000 real files in 100 directories, snapshots and
  checkpoints them through the release CLI/storage path, and measures snapshot,
  status, history, diff, and public export.
- The artifact fixture creates 14,000 canonical linear changes in each of
  public, members, and local. Every realm bundle is signed, deep-verified, and
  imported in composition order without exceeding the manifest limit.
- The same repository receives a 10,000-file unsigned working snapshot whose
  bounded fan-out and six unique directory levels create 60,101 additional
  tree artifacts. Combined with 42,004 accepted artifacts, the measured
  database contains 102,105 artifact rows while preserving realm and artifact
  size rules.
- Lightweight commands run three times and record all elapsed milliseconds plus
  minimum, median, and maximum. Huge exports run once to limit temporary file
  amplification; a one-sample result is not called a percentile.
- Fixture generation runs outside each command timer. Commands execute as
  release `ef` subprocesses. The JSON report records the source commit, OS,
  architecture, Rust version, executable path, exact fixture counts,
  repetitions, and raw elapsed values.
- No guessed latency becomes a pass/fail target. G2 requires a successful valid
  run and recorded observations; later optimization work compares against the
  raw baseline and sets thresholds only with additional evidence.

## Consequences

- G2 can close without weakening format limits or conflating provider/cloud
  performance with local SQLite/filesystem performance.
- The baseline exposes export as the dominant local cost and provides concrete
  optimization evidence rather than hiding it behind an aspirational target.
- Full runs create many temporary files and may take several minutes. The tool
  requires non-existing work/output paths and deletes only export directories
  it created; the caller owns removal of the retained fixture directory.
- Future format-limit changes require rerunning the builder rather than editing
  historical raw data.

## Rejected alternatives

- Raise the 1 MiB artifact limit for the benchmark: rejected because a fixture
  must test the product contract rather than modify it.
- Insert arbitrary malformed rows directly into SQLite: rejected because
  status/export results would not describe a valid repository.
- Time fixture construction together with commands: rejected because it makes
  command comparisons meaningless.
- Run the 100,000-artifact profile in every CI job: rejected because the
  filesystem amplification and duration are disproportionate to regression
  detection; the small profile and unit test exercise the same generator.

## Verification

The smoke profile, generator unit test, release G2 profile, all three realm
exports, workspace tests, strict lint, and raw-report validation must pass. The
G2 evidence links the immutable JSON observation file.
