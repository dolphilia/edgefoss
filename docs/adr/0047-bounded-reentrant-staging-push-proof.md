# ADR-0047: Prove one bounded staging fast-forward and stale-ref conflict

- Status: Accepted for P5b3 local implementation
- Date: 2026-08-27
- Owners: sync, cloud authority, recovery, and security leads
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

P5b2 remotely proves the authenticated preflight without mutation. The current
staging authority is the deterministic P4 fixture at accepted sequence 4,
policy epoch 0, and public `heads/main` generation 1. P5b3 needs one real
linear push proof, exact response-loss retry convergence, and a stale-ref
conflict without turning the smoke into an open-ended repository writer.

The existing P4 fixture's project, actor key, tree, and head can be
deterministically reconstructed. Its finalized public blob and accepted tree
can be reused, so a new change need not upload a blob or write R2.

## Decision

Add an operator-only `cloud:smoke-public-push` command. It accepts only the
exact staging HTTPS origin and the existing owner token from the environment.
Before mutation it reconstructs two signed public sibling changes and accepts
only one of two complete authority states:

1. initial: sequence 4, epoch 0, known generation-1 head, both changes missing,
   and no sequence-5 outbox event;
2. converged: sequence 5, epoch 0, the intended generation-2 head, only the
   stale sibling missing, and a matching sequence-5 outbox event.

Any other project, sequence, policy epoch, ref, missing inventory, or outbox
ownership stops before publication.

From either accepted state the command submits the same deterministic
fast-forward operation twice and requires byte-equivalent accepted results at
sequence 5/ref generation 2. It then submits the signed sibling with the stale
expected generation 1 twice and requires the exact HTTP 409 `ref_conflict`
result pointing to the intended generation-2 head. A final preflight must show
the fast-forward present and the stale sibling still missing. The command waits
until the matching sequence-5 outbox event is delivered.

The operation IDs use the reviewed `edgefoss:push-operation:v0` derivation.
Reusing them makes a rerun after response loss observationally convergent.

## Alternatives considered

- Upload a new blob and tree: rejected because it adds R2 and two authority
  mutations that are unnecessary for the retry/ref-CAS proof.
- Publish only the successful change: rejected because it does not remotely
  prove stale ref rejection.
- Send two ref candidates concurrently: rejected for this first remote proof
  because winner selection would be nondeterministic.
- Treat any sequence at or above 5 as success: rejected because it could hide
  unrelated staging writes.
- Add the smoke to the deployment workflow: rejected because GitHub Actions
  intentionally has no owner token and deployment must remain non-mutating
  beyond publishing Worker code.

## Consequences

- The first approved execution adds exactly one public change artifact, moves
  `heads/main` from generation 1 to 2, advances accepted sequence 4 to 5, and
  emits one Queue event that must reach delivered.
- The accepted change reuses existing graph objects; no upload endpoint or R2
  write is called.
- The stale sibling records an idempotent conflict operation but does not add an
  artifact, move the ref, advance sequence, or emit an outbox event.
- A repeat execution makes no additional repository or Queue change.
- Schema, bindings, secrets, Worker routes, members state, and production stay
  unchanged. No deployment is required for this operator tool.
- Local implementation and ordinary CI do not authorize remote execution. The
  exact effects above require a separate explicit account-owner approval.

## Verification

- fixture artifact and operation IDs are fixed by regression tests;
- exact origin and token shape fail closed before fetch;
- local fake authority covers initial execution, exact accepted/conflict
  retries, already-converged rerun, Queue delivery, and unexpected-state abort;
- no test or smoke path calls the upload API;
- full local gate and named staging/production dry-runs pass before commit;
- only after commit/push/ordinary CI and explicit approval may the operator run
  the staging command once.
