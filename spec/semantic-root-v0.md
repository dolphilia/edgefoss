# EdgeFossil semantic root v0

Profile identifier: `edgefossil-semantic-root-v0`

A semantic root compares portable repository meaning while excluding authority
implementation state. It is computed independently for each realm, so a change
only in `members` does not change the `public` semantic root.

## Artifact-set root

For one project and one realm:

1. collect every reachable, schema-valid artifact assigned to exactly that
   realm, including applicable tombstones;
2. represent each artifact ID by its raw 32-byte SHA-256 digest;
3. sort those byte strings lexicographically and reject duplicates;
4. encode the resulting array with `edgefossil-cbor-v0`; and
5. SHA-256 the bytes.

The result is the 32-byte `artifact_set_root`. This simple set commitment is the
v0 correctness definition. A future Merkle index may optimize computation only
if it produces a value explicitly versioned away from this profile.

## Root descriptor

Construct an exact CBOR map containing:

| field               | type  | value                                              |
| ------------------- | ----- | -------------------------------------------------- |
| `format`            | text  | `edgefossil-semantic-root`                         |
| `version`           | uint  | `0`                                                |
| `project`           | bytes | raw digest of `project.genesis`                    |
| `realm`             | text  | `public`, `members`, or `local`                    |
| `artifact_set_root` | bytes | 32-byte value above                                |
| `refs`              | map   | normalized ref name to raw 32-byte artifact digest |
| `policy_version`    | uint  | portable policy version governing the view         |

Ref names are NFC UTF-8 text of 1–255 bytes, use `/` as an internal separator,
and obey the path segment safety rules. Entries are serialized in canonical
CBOR map order.

The semantic root is:

```text
"sha256:" || lowercase_hex(SHA-256(canonical_cbor(root_descriptor)))
```

## Included and excluded state

Included state is limited to immutable artifact membership, named refs, the
project identity, the realm, and the portable policy version. The following are
excluded:

- authority receipts and `repo_seq` acceptance order;
- upload sessions, retry/idempotency records, and delivery state;
- R2 object metadata and Durable Object/SQLite row layout;
- caches, search indexes, rendered HTML, thumbnails, and analytics;
- encryption-at-rest details and deployment resource names.

Two authorities with equal semantic roots for the same project/realm/profile
have the same defined portable state even if their operational databases differ.
