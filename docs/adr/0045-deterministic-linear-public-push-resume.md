# ADR-0045: Resume deterministic public push only along known linear ancestry

- Status: Accepted for P5b1b local implementation
- Date: 2026-08-26
- Owners: local storage, sync protocol, and cloud authority leads
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

P5b1a plans a fresh authority. Real retries may observe a finalized blob,
accepted non-ref artifacts, an established public head, or a fully converged
authority. An existing head also introduces divergence: absence from the local
history cannot safely mean overwrite, merge, or last-writer-wins.

## Decision

Define `edgefossil-public-push-linear-v0` in
[`push-v0`](../../spec/push-v0.md). After full bundle verification, the Rust
planner compares one P5b0 snapshot with the bundle's exact linear
`heads/main` ancestry.

- Null project is accepted only as a consistent uninitialized snapshot.
- A matching project with no ref resumes from generation zero.
- A known authority head selects the strict local suffix and uses the observed
  ref generation as its compare-and-swap base.
- Missing blobs, genesis, and trees are emitted only when reported missing.
- Remaining changes are emitted even if already stored, because a lost response
  may leave ref advancement to retry.
- A converged head and empty missing inventories produce an empty plan.
- An unknown authority head returns the stable `PushHeadConflict` result.
- A missing object reachable from the claimed accepted prefix is rejected as an
  inconsistent snapshot before mutation.

Operation IDs retain the P5b1a domain and include policy epoch and expected ref
generation. Identical bundle bytes and snapshot therefore reconstruct an exact
retry plan.

## Alternatives considered

- Force the local head over an unknown remote head: rejected because it loses
  accepted authority history.
- Treat every present artifact as complete: rejected because artifact presence
  does not prove that its ref compare-and-swap completed.
- Trust contradictory missing inventories: rejected because it can plan from a
  corrupt or non-atomic authority observation.
- Add merge planning: deferred; v0 has no reviewed merge/conflict contract.

## Consequences

- interrupted fresh and incremental pushes can resume without client session
  state;
- an existing linear ancestor advances by only the required suffix;
- concurrent or divergent heads fail closed and remain visible to the caller;
- the preflight remains an observation, so RepositoryDO still rechecks policy,
  deduplication, referenced objects, and ref generation per mutation;
- HTTP routes, schema, bindings, credentials, and remote state remain unchanged.

## Verification

- TypeScript generates a signed two-change bundle and exact suffix plan;
- Rust independently reproduces the plan and stable operation ID;
- Rust covers blob-finalized resume, ref-less resume, full convergence,
  unknown-head conflict, and accepted-prefix inconsistency;
- Workers runtime executes fresh then incremental plans, converges exact retries,
  and reaches sequence 4 and ref generation 2;
- full local gate and named staging/production dry-runs must pass before commit.
