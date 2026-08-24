# ADR-0009: Separate portable backup from authority PITR

- Status: Accepted
- Date: 2026-08-24
- Owners: operations and core leads
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

Durable Object point-in-time recovery can recover authority SQLite state, but it does not by itself package R2 blobs, realm views, signatures, or a provider-independent project identity. Conversely, a portable bundle does not necessarily preserve recent authority receipts, credentials, alarms, or operational delivery state.

## Decision

Maintain two explicitly different recovery mechanisms:

1. **Portable complete export**: canonical artifacts, required blobs, signatures, realm/ref state needed by the portable model, manifest, versions, and semantic roots. It is verifiable offline and restorable into an empty authority with new physical IDs/receipts.
2. **Authority operational recovery/PITR**: provider-specific recovery for recent SQLite operational mistakes or corruption, coordinated with R2 state and documented incident timing.

Neither is described as the other. General release requires a complete export restored into empty staging and verified without Cloudflare. Backups are encrypted/access-controlled according to the most restricted included realm.

## Alternatives considered

- Raw DO SQLite export as backup format: rejected because it couples recovery to physical schema and omits blob portability.
- Rely only on portable periodic exports: rejected because recovery-point objectives may require authority operational recovery.
- Rely only on provider PITR: rejected because project portability and full R2 consistency are not proven.

## Consequences

- Restore creates new Cloudflare resource IDs and authority receipt history while preserving portable artifact IDs and semantic roots.
- Backup schedules state which mechanism satisfies which RPO/RTO hypothesis.
- Export, verify, and restore remain product features and release gates, not an operations afterthought.

## Verification

P7 restores a complete bundle into empty staging and compares view roots. P9 rehearses authority upgrade/recovery separately and records gaps between SQLite recovery and R2/blob state.
