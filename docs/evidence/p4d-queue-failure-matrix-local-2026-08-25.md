# P4d Queue failure matrix local evidence — 2026-08-25

- Increment: bounded application-controlled Queue failure matrix
- Scope: local Workers runtime only
- Remote mutation: none
- Repository schema: unchanged at 5

## Implementation

The Queue consumer now treats every message body as untrusted `unknown` input
and validates the exact authority event contract before Durable Object RPC. The
individual message processor is independently testable while the deployed
handler retains the same sequential per-message acknowledgement behavior.

Structured failure logs contain only the Queue name, delivery attempt count,
bounded error code, and fixed message. They do not contain the Queue message
body, event ID, artifact ID, realm, principal, or token.

## Injected boundaries

Workers runtime tests cover:

- Queue rejection before accepting a producer batch;
- Queue acceptance followed by producer response loss;
- delivery while the authority outbox still appears pending;
- later alarm resend and duplicate consumer delivery;
- one retained outbox row and one delivery row after convergence;
- no artifact, operation, or receipt created by the response-loss harness;
- known events delivered out of repository order;
- valid and invalid messages in one batch, with only valid neighbors acked;
- duplicate known-event delivery;
- invalid-event retries for delivery attempts 1 through 4;
- absence of a private-looking artifact identifier and field name from logs.

The retry-budget test proves the Worker asks for retry through the configured
initial-plus-three-retry budget. Cloudflare, not the Worker, performs the
subsequent DLQ storage transition. This evidence therefore does not claim that a
local or remote message was observed in the DLQ.

## Verification status

- latest `@cloudflare/workers-types`: 5.20260825.1
- Worker type checks: passed
- Worker tests: 23 passed across 5 files
- protocol tests: 182 passed across 9 files
- owner adapter and smoke tests: 8 passed
- cloud deploy/config tests: 8 passed
- Rust tests and lint, static-assets smoke, vectors, formatting, and 102-file
  Markdown link audit: passed
- staging dry-run: `EVENTS`, `RepositoryDO`, and exact three staging R2
  bindings present
- production dry-run: no Queue binding; `RepositoryDO` and exact three
  production R2 bindings present
- bundle: 84.15 KiB, gzip 18.03 KiB
- local startup profile: 2.6 ms active, 0.0 ms garbage collection

## Non-effects and next gate

No remote artifact, outbox row, Queue message, DLQ message, R2 object, Worker
version, consumer setting, or production resource was changed. The full local
gate is green; the next gate is commit and ordinary CI. Remote Queue pause,
purge, consumer removal, or poison-message injection remains prohibited.
