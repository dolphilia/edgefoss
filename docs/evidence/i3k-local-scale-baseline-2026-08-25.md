# I3k local scale baseline evidence — 2026-08-25

- Increment: I3k, reproducible G2 file/artifact baseline
- Base commit: `e437aa17905ca92331cb6ef0cb1e1400c2127d7b`
- Source state: local working tree; commit and CI confirmation pending
- Environment: macOS Darwin 24.6.0 on arm64, Rust `1.94.1`, release binaries
- Measured source: base commit `e437aa17905ca92331cb6ef0cb1e1400c2127d7b`
  plus the recorded I3k working-tree implementation (`source_dirty: true`)
- Result: full G2 profile and workspace verification pass; commit and CI
  confirmation pending
- Raw observations:
  [`i3k-local-baseline-g2-2026-08-25.json`](data/i3k-local-baseline-g2-2026-08-25.json)

## Demonstrated slice

- `ef-local-baseline` provides `smoke` and `g2` profiles, requires explicit
  non-existing work/output paths, runs release `ef` subprocesses, and emits a
  versioned JSON report containing environment, fixture counts, repetitions,
  and raw milliseconds.
- The file fixture contains exactly 10,000 real files in 100 directories. It
  exercises snapshot, status, history, diff, and public export.
- The artifact fixture contains 102,105 SQLite artifact rows:
  - 14,000 valid signed changes in each of public, members, and local;
  - one project genesis and one accepted tree per realm, for 42,004 accepted
    artifacts;
  - 60,101 valid public working-tree artifacts derived from 10,000 unique deep
    file paths with bounded top-level fan-out.
- All three accepted realm bundles stay below the 1 MiB canonical artifact
  limit, are deep-verified, and import in public→members→local order. The
  fixture therefore does not evade the format contract to reach 100,000 rows.
- The full profile asserted the database artifact count was at least 100,000
  before timing commands. Public, members, and local exports all completed.

## Baseline observations

Times are wall-clock observations from this machine, not release targets.
Lightweight commands have three samples; export has one sample and is therefore
reported as a single observation rather than a percentile.

| Fixture           | Command            |  Samples (ms) |    Median/observation |
| ----------------- | ------------------ | ------------: | --------------------: |
| 10,000 files      | snapshot           | 752, 496, 489 |         496 ms median |
| 10,000 files      | status             |      9, 10, 9 |           9 ms median |
| 10,000 files      | history public 20  |       3, 3, 3 |           3 ms median |
| 10,000 files      | diff public        | 309, 315, 308 |         309 ms median |
| 10,000 files      | export public      |        56,454 |  56.454 s observation |
| 102,105 artifacts | status             | 128, 115, 116 |         116 ms median |
| 102,105 artifacts | history public 20  |       8, 7, 7 |           7 ms median |
| 102,105 artifacts | history members 20 |       7, 7, 7 |           7 ms median |
| 102,105 artifacts | history local 20   |       8, 8, 8 |           8 ms median |
| 102,105 artifacts | export public      |       178,743 | 178.743 s observation |
| 102,105 artifacts | export members     |       208,201 | 208.201 s observation |
| 102,105 artifacts | export local       |       209,311 | 209.311 s observation |

Fixture generation runs outside each measured subprocess timer and is not
reported as command latency.

## Reproduction

Use disposable, non-existing paths. A full run creates many temporary files and
can take several minutes.

```text
cargo build --release -p ef-cli -p ef-testkit
target/release/ef-local-baseline \
  --profile g2 \
  --ef target/release/ef \
  --workdir /private/tmp/edgefoss-g2-FRESH \
  --output /private/tmp/edgefoss-g2-FRESH.json
```

The caller may remove the disposable work directory after preserving the JSON
report. The benchmark never uses or creates Cloudflare resources.

## Gate impact and scope boundary

All G2 conditions now have local evidence: byte-identical empty restore,
realm/untracked exclusion, external process-kill recovery, and the required
file/artifact baseline. G2 is `go`, subject to commit and CI confirmation for
this increment.

The observations identify export as the dominant performance concern. They do
not establish a production SLO and do not cover Durable Objects, R2, network,
Workers cold starts, or cost. No Cloudflare account or user action is required
for I3k.

## Full verification

```text
pnpm check
  format and TypeScript checks: pass
  protocol: 182 tests pass
  Worker: 2 tests pass
  Rust: 68 tests pass, 1 subprocess helper ignored in the ordinary run
    edgefoss-core: 4
    ef-cli: 20
    ef-format: 21
    ef-store-sqlite: 22 pass, 1 ignored
    ef-testkit: 1
  Rust lint: pass with warnings denied
  shared vectors: 9 files, 64 accepted and 81 rejected cases audited
  bundle vector reader: 1 valid file and 5 invalid cases checked
  documentation: 58 Markdown files, all local links valid
```

```text
pnpm build
  protocol TypeScript build: pass
  Worker Wrangler dry-run build: pass
```
