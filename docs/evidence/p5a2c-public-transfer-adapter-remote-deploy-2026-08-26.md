# P5a2c public transfer adapter remote deploy — 2026-08-26

- Increment: anonymous public transfer adapter staging activation
- Deployed commit: `e628203`
- Workflow ref: `main`
- Target Worker: `edgefoss-staging`
- Result: deploy, health, HELLO, and existing-profile boundary audit passed
- Repository schema: 5

## Gate sequence

The adapter implementation at commit `30b1784`, approval/audit increment at
commit `75a6544`, and empty-body correction at commit `e628203` each passed
ordinary GitHub Actions before the corresponding manual workflow. The account
owner explicitly approved the P5a2c anonymous staging effects before either
deployment.

The first deployment of `75a6544` passed deploy, health, and HELLO, then exposed
an empty-body representation drift in the final plan audit. The correction at
`e628203` was committed, pushed, passed ordinary CI, and was deployed by
rerunning the same main-only workflow. The supplied result retained `75a6544`
in its copied commit field; repository reconciliation shows that the successful
main ref containing the required correction is `e628203`, which is the deployed
commit recorded here.

## Observed contract

- deployment succeeded;
- stateful health passed with repository schema version 5;
- anonymous HELLO advertised `TRANSFER`, the `complete` profile, and a
  600-second grant TTL;
- the bodyless transfer-plan request returned HTTP 409 with exact
  `clone_profile_unsupported`;
- artifact and blob reads were not performed;
- the audit performed no remote write;
- Queue and R2 configuration remained unchanged;
- production remained unchanged.

The 409 is the expected compatibility fence, not an adapter error. The existing
P4c staging head uses tree/change logical clocks 1/2, while the current
Rust-compatible complete profile requires a zero-based history.

## Non-effects and limit

The successful audit stops before grant sealing and artifact/blob transfer. It
did not publish an artifact, write R2, advance a ref, enqueue an event, migrate
schema, change bindings, or touch production. Because the anonymous route is
now public, this evidence does not claim that no third party called it outside
the observed workflow.

P5a2c staging activation is complete: the external surface and its safe
incompatible-history rejection are proven remotely. It does not prove a
successful remote complete clone or disconnect resume. Achieving that result
would require a separately approved canonical staging publication and public
ref advance, or a new isolated compatible project topology.
