# EdgeFossil artifact profile v0

Profile identifier: `edgefossil-artifact-v0`

Artifacts are immutable values encoded with `edgefossil-cbor-v0`. Map entries
shown below are schema fields, not serialization order; the CBOR profile decides
their byte order.

## Common envelope

Every non-genesis v0 artifact has exactly these fields:

| field           | type          | rule                                                       |
| --------------- | ------------- | ---------------------------------------------------------- |
| `format`        | text          | exactly `edgefossil-artifact`                              |
| `version`       | uint          | `0`                                                        |
| `project`       | text          | canonical `sha256:` ID of `project.genesis`                |
| `kind`          | text          | registered artifact-kind name                              |
| `schema`        | uint          | kind-specific schema version                               |
| `realm`         | text          | `public`, `members`, or `local`                            |
| `parents`       | array of text | canonical artifact IDs; no duplicates                      |
| `actor_key`     | bytes         | 32-byte Ed25519 public key                                 |
| `logical_clock` | uint          | actor-local monotonic counter                              |
| `created_at`    | text          | UTC RFC 3339 seconds, `YYYY-MM-DDTHH:MM:SSZ`; display only |
| `payload`       | map           | kind-specific exact schema                                 |

Unknown and missing fields are errors. `parents` is sorted by raw 32-byte digest
and MUST describe only meaningful causal predecessors, not an arbitrary total
order. A parent MUST have the same `project` and `realm`. Other kind-specific
references follow `edgefossil-realm-v0`: a `members` artifact may depend on
public content, but a public artifact can never identify members content.

`created_at` MUST NOT determine authorization, conflict winners, or graph
validity. Signature records and server acceptance receipts are separate objects
that refer to the artifact ID.

## `project.genesis`, schema 0

Genesis breaks the otherwise circular project-ID dependency: it omits the
`project` field, and its own artifact ID becomes the project ID. It has exactly
these envelope values and fields:

```text
format        = "edgefossil-artifact"
version       = 0
kind          = "project.genesis"
schema        = 0
realm         = "public"
parents       = []
actor_key     = first owner Ed25519 public key (32 bytes)
logical_clock = 0
created_at    = UTC RFC 3339 seconds
payload       = project.genesis payload below
```

The payload has exactly:

| field            | type  | rule                                              |
| ---------------- | ----- | ------------------------------------------------- |
| `name`           | text  | NFC, 1–128 UTF-8 bytes; public-safe display label |
| `nonce`          | bytes | 32 cryptographically random bytes                 |
| `policy_version` | uint  | `0`                                               |

The genesis realm is `public` so every later realm can identify the same
project without a reference from a less privileged graph to a more privileged
graph. `public` is a maximum disclosure classification, not an instruction to
enable anonymous routes: a private deployment does not publish the genesis.
The `name` MUST NOT contain a secret because it becomes publishable if a public
view is enabled later.

The `actor_key` is the initial owner key; a separate signature over the genesis
artifact ID proves possession. Key rotation and additional owners are later
artifacts and cannot change the portable project ID.

The nonce prevents two projects created by the same owner at the same timestamp
and name from receiving the same ID. It is not a secret and MUST come from a
cryptographically secure random-number generator.

## Validation order

Receivers validate in this order:

1. transport size;
2. canonical CBOR profile;
3. exact envelope and kind schema;
4. artifact ID recomputation when an expected ID is supplied;
5. project, realm, parent, policy, and signature constraints.

Failure must not partially publish the artifact or advance a ref.

## `tree`, schema 0

A tree is one immutable directory. Its common envelope has `kind = "tree"`,
`schema = 0`, and an empty `parents` array. Its payload has exactly one field,
`entries`, containing 0–65535 entry maps.

Each entry has exactly:

| field    | type | rule                                                   |
| -------- | ---- | ------------------------------------------------------ |
| `name`   | text | one valid path-v0 segment; `/` forbidden               |
| `mode`   | text | `file`, `executable`, `directory`, or `symlink`        |
| `target` | text | canonical artifact/blob ID, except symlink target text |

Entries are strictly sorted by bytewise lexicographic comparison of the NFC
UTF-8 `name`. Duplicate names and duplicate path-v0 portable collision keys are
invalid. `file` and `executable` target a blob; `directory` targets another
`tree`; the authority resolves target project/realm/kind separately.

A symlink target is NFC UTF-8 text of 1–4096 bytes. NUL, an initial `/` or `\`,
and an ASCII drive prefix such as `C:` are forbidden. Full-tree validation and
checkout must additionally reject lexical or filesystem resolution outside the
checkout root.

## `change`, schema 0

A change points one realm-specific history node at a root tree. Its common
envelope has `kind = "change"`, `schema = 0`, and 0–32 parent change IDs sorted
by raw digest. The payload has exactly:

| field     | type | rule                                              |
| --------- | ---- | ------------------------------------------------- |
| `root`    | text | canonical artifact ID of a `tree`                 |
| `message` | text | NFC, 0–4096 UTF-8 bytes; same realm as the change |

Graph validation resolves every parent and root, checks project/kind/realm flow,
and verifies that `logical_clock` is greater than every same-actor parent clock.
