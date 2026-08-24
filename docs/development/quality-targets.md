# Quality targets

Status: correctness gates are active. The first local baseline was observed at
G2; performance and cost thresholds remain unset until more environments and
runs are available.

## Non-negotiable correctness

- Cross-language canonical vectors must agree byte-for-byte and ID-for-ID.
- A visible artifact must reference only verified blobs.
- Retrying an operation must not multiply canonical side effects.
- Concurrent changes must not be silently discarded by last-write-wins.
- Public outputs must not expose restricted paths, hashes, content, or counts.
- A complete portable bundle must restore into an empty environment and retain its semantic root.

## Measurement schedule

| Metric                                          | First baseline        | Gate that sets a threshold |
| ----------------------------------------------- | --------------------- | -------------------------- |
| local status/snapshot/export latency            | P2 synthetic fixtures | G2                         |
| small publish latency/error/operation count     | P4 staging            | G4                         |
| sync inventory bytes/resume/convergence         | P5                    | G5                         |
| export/restore duration and large-upload memory | P7                    | G7                         |
| public Web P95/P99 and operational SLO          | P8 canary             | G9                         |
| per-project Cloudflare cost                     | P4 onward             | G9                         |

Each baseline records fixture size, commit, environment, command, repetitions, percentiles, and raw result location. A guessed number must be labeled `hypothesis`, not `target`.

## Observed local baseline

I3k recorded release-command observations for 10,000 files and 102,105 SQLite
artifacts. See the [human-readable evidence](../evidence/i3k-local-scale-baseline-2026-08-25.md)
and [raw JSON](../evidence/data/i3k-local-baseline-g2-2026-08-25.json). These
values are comparison baselines, not SLOs. In particular, the one-sample export
measurements are observations rather than percentiles.
