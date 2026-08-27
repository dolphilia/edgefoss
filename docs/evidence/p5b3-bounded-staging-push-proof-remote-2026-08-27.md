# P5b3 bounded staging push proof remote evidence

- Date: 2026-08-27
- Target: `edgefoss-staging`
- Scope: one approved deterministic public fast-forward, exact accepted and
  stale-conflict retries, and matching Queue delivery
- Result: pass; P5b3 complete

## Preconditions

- Local implementation commit `ca3d1fd` passed ordinary GitHub Actions.
- The account owner explicitly approved the permanent staging effects.
- Approval-record commit `53b1c6b` passed ordinary GitHub Actions.
- The command used the existing owner token only through the local environment;
  its value was not shared or recorded.
- No Worker deployment was needed because P5b3 added an operator tool and did
  not change Worker code or configuration.

## Observed result

The account owner ran `cloud:smoke-public-push` once. It exited 0 and reported:

```json
{
  "acceptedSequence": 5,
  "conflictArtifactAccepted": false,
  "conflictRetryConverged": true,
  "deliveryPhase": "delivered",
  "initialState": "initial",
  "newR2WritePerformed": false,
  "policyEpoch": 0,
  "refGeneration": 2,
  "retryConverged": true,
  "sendAttempts": 1,
  "state": "converged"
}
```

The exact initial guard therefore matched sequence 4 and public ref generation
1 before mutation. One deterministic public child change was accepted at
sequence 5 and moved `heads/main` to generation 2. Repeating its operation
returned the stored accepted result. The stale signed sibling returned the
stored HTTP 409 ref-conflict result on retry and remained absent from artifact
inventory.

The sequence-5 outbox event matched the accepted change and reached delivered
after one send attempt.

## Permanent effects

- one public change artifact and its attestation/receipt were accepted;
- accepted sequence advanced from 4 to 5;
- public `heads/main` advanced from generation 1 to 2;
- one accepted operation result was persisted;
- one stale-ref conflict operation result was persisted;
- one sequence-5 outbox event was created, enqueued, and delivered.

## Verified non-effects

- The stale sibling artifact was not accepted.
- No upload endpoint was called and no R2 object was written.
- No additional blob or tree was added.
- Schema remains 5; bindings, secrets, and Worker configuration are unchanged.
- Members state and production were not accessed or changed.
- Exact retries did not add another sequence, ref generation, artifact, or
  Queue event.
- No credential value appears in this evidence.

P5b3 is complete. Any future staging mutation requires the authorization gate
defined by its own increment; this evidence does not authorize unrelated push,
members, or production effects.
