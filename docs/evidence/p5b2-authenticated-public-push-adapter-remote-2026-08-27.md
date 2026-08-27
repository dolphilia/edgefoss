# P5b2 authenticated public push adapter remote evidence

- Date: 2026-08-27
- Target: `edgefoss-staging`
- Scope: approved route exposure, credential-free authentication boundary, and
  owner-authenticated empty-inventory preflight
- Result: pass; P5b2 complete without remote mutation

## Deployment workflow

The account owner confirmed that the main-only `Deploy staging Worker` workflow
succeeded. Therefore its project checks, staging dry-run, Worker deployment,
stateful health audit, anonymous public HELLO audit, existing transfer-profile
boundary audit, and credential-free owner-only preflight HTTP 401 audit all
passed. The workflow did not receive the owner token and could not perform an
authenticated preflight or push mutation.

The approval record was committed as `252bd94`. The subsequent local audit
argument correction was committed as `28ef687` and passed ordinary GitHub
Actions. That CLI-only correction did not require another Worker deployment.

## Owner read-only observation

After both gates were confirmed, the account owner ran the documented audit
with the token supplied only through `EDGEFOSS_OWNER_TOKEN`. The command exited
0 and validated:

- accepted sequence: 4;
- policy epoch: 0;
- project ID: canonical and matching anonymous HELLO, value not shared;
- ref name: `heads/main`;
- ref generation: 1;
- target artifact ID: canonical, value not shared;
- remote write performed: false.

The audit first performed anonymous HELLO and then sent one authenticated
empty-inventory preflight. It required empty missing-artifact and missing-blob
sets and validated the bounded response and security headers. It did not call
blob declaration/upload/finalization, artifact publication, ref mutation, or
Queue observation endpoints.

Accepted sequence and ref generation count different state transitions, so the
observed values 4 and 1 are consistent.

## Non-effects and next gate

- No new blob, artifact, ref generation, R2 object, or Queue event was created.
- Repository schema remains 5; bindings and secrets were not changed.
- Members state and production were not accessed or changed.
- The token value was not shared or recorded.
- This evidence completes P5b2 but does not authorize P5b3 staging mutation.

Before any P5b3 remote proof, its exact deterministic object set, expected
sequence/ref changes, R2 and Queue effects, retry behavior, cleanup posture, and
production non-effects must be implemented and verified locally, then presented
for a separate explicit account-owner approval.
