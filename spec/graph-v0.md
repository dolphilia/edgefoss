# EdgeFossil change graph validation v0

Profile identifier: `edgefossil-change-graph-v0`

Schema validation proves that references are canonical IDs; graph validation
then resolves those IDs within an authorization-filtered project view.

For a schema-0 `change`, validation proceeds in this order:

1. Resolve `root`; unavailable and non-tree targets return
   `unknown_required_semantics`.
2. Require the root project to equal the change project.
3. Apply the `content` realm-flow rule from `edgefossil-realm-v0`.
4. For each parent in digest order, resolve it and require kind `change`.
5. Require the parent project to equal the change project.
6. Apply the stricter `parent` realm rule, requiring equal realms.
7. If parent and child actor keys are equal, require
   `child.logical_clock > parent.logical_clock`.

A different actor's numeric clock is not compared. Causality comes from the
parent edge itself; actor-local counters only detect replay or non-advancement
for one key.

The resolver MUST expose only targets authorized for the validation context.
An absent target, inaccessible target, and target with unsupported required
semantics share `unknown_required_semantics` at a public boundary. Detailed
restricted diagnostics may distinguish them internally but may not change the
public response, timing class, or cache behavior.

This validator establishes structural admissibility, not ref publication.
Signature, capability, policy, operation deduplication, and ref compare-and-swap
checks still occur before an authority commits a change.
