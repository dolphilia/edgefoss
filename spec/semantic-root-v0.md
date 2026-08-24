# EdgeFossil semantic root v0

Profile identifier: `edgefossil-semantic-root-v0`

A semantic root compares portable repository meaning while excluding authority
implementation state. It is computed independently for each realm, so a change
only in `members` does not change the `public` semantic root.

## Artifact-set root

For one project and one realm:

1. collect every reachable, schema-valid artifact assigned to exactly that
   realm, including the public `project.genesis` artifact and applicable
   tombstones;
2. represent each artifact ID by its raw 32-byte SHA-256 digest;
3. sort those byte strings lexicographically and reject duplicates;
4. encode the resulting array with `edgefossil-cbor-v0`; and
5. SHA-256 the bytes.

The result is the 32-byte `artifact_set_root`. This simple set commitment is the
v0 correctness definition. A future Merkle index may optimize computation only
if it produces a value explicitly versioned away from this profile.

The calculator accepts candidates from multiple realms but MUST select records
whose realm exactly equals the requested realm before parsing IDs, validating
names, sorting, or hashing. It MUST NOT inspect other-realm record contents.
This is an isolation boundary: malformed or changed `members`/`local` candidates
cannot change or prevent calculation of the `public` root. Complete-import
validation separately proves that each artifact has exactly one realm; a root
for one realm is not evidence that ignored realms are valid.

One realm contains at most 65,535 artifact IDs. Duplicate selected IDs are
`invalid_schema`; input order has no meaning.

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
CBOR map order. A realm contains at most 4,096 refs. Duplicate selected names
are `invalid_schema`. Every selected ref target MUST occur in the selected
artifact set; otherwise calculation fails with `unknown_required_semantics`.
Refs from other realms are ignored under the same isolation rule as artifacts.

`policy_version` is an unsigned 64-bit integer. Empty artifact and ref sets are
representable, although a conforming public project view includes its genesis
artifact.

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

## Conformance vector

[`vectors/semantic-root-v0.json`](vectors/semantic-root-v0.json) fixes the
artifact-set root, canonical descriptor bytes, and final semantic root for all
three realms. Conforming implementations also prove that permutations and
members-only additions, including malformed ignored members records, leave the
public result unchanged.
