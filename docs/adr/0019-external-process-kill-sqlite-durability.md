# ADR 0019: Test local SQLite durability with external process termination

- Status: accepted
- Date: 2026-08-25
- Decision owners: local storage and recovery maintainers
- Applies to: I3j local repository alpha

## Context

SQLite error injection proves transaction rollback on a returned error, but it
does not exercise WAL recovery after the application disappears without
running destructors. G2 separately requires evidence that process termination
at local write points neither corrupts the database nor exposes a partial
operation.

Treating every SQL virtual-machine instruction as a stable named point would
couple tests to SQLite internals and statement plans. Testing only one arbitrary
termination time would be nondeterministic and could miss every meaningful
boundary.

## Decision

- The storage test binary launches itself as a dedicated child process. The
  parent waits until a named point has been durably announced in a separate
  marker file, then terminates the child with the platform process-kill API.
- Named points follow logical writes in the four local-alpha transactions:
  project initialization, working-snapshot replacement, signed checkpoint, and
  portable import. Looping stages pause after their first blob, tree, artifact,
  or signature write, which deliberately leaves a partial transaction in WAL.
- Every transaction also has an `after_commit` point. A killed child must
  therefore reopen as exactly the pre-operation state at earlier points or the
  complete post-operation state after commit.
- Reopened databases must pass SQLite `integrity_check` and
  `foreign_key_check`. Operation-specific assertions additionally check
  identity, roots, accepted refs/history, portable row counts, and signatures.
- Pause machinery and its environment variables exist only in Rust test builds.
  Production builds compile the call to an always-inlined no-op and do not
  expose a runtime fault-injection switch.
- The child helper has a 30-second self-timeout, while the parent fails after 10
  seconds if a requested point is not reached. Temporary database, WAL, shared
  memory, and marker files are isolated per case and removed after success.

## Consequences

- The test covers 18 deterministic kill cases: 3 initialization, 5 snapshot, 4
  checkpoint, and 6 import points.
- The harness validates application transaction boundaries and actual SQLite
  crash recovery without interpreting a killed operation as success.
- Named points are logical test contracts. Adding a new multi-write local
  transaction requires adding its relevant pre-commit stages and post-commit
  case.
- This evidence applies only to local SQLite. Durable Object transactions, R2
  upload/finalize, Queues, and response-loss retry behavior need separate cloud
  fault tests at their own boundaries.

## Rejected alternatives

- Panic or return an injected error: rejected because Rust unwinding/drops can
  roll back cleanly and do not model abrupt process loss.
- Kill at random elapsed times: rejected because coverage is nondeterministic
  and cannot show which write boundary was exercised.
- Expose fault controls in the production CLI or storage API: rejected because
  a test-only capability must not become an operational denial-of-service
  surface.
- Claim SQLite durability from upstream guarantees alone: rejected because G2
  requires evidence using EdgeFossil's schema, pragmas, and transaction layout.

## Verification

The parent test spawns and kills one child for every named point. Each resulting
database is reopened through `LocalRepository`, checked for structural and
foreign-key integrity, and compared with the expected pre-commit or post-commit
state. Existing returned-error rollback tests remain complementary coverage.
