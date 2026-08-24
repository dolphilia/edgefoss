# EdgeFossil realm flow profile v0

Profile identifier: `edgefossil-realm-v0`

The built-in realms form a disclosure order:

```text
public < members < local
```

The order means that an artifact may refer to content from the same or a less
restricted realm without revealing data to a reader who could not already read
it. It does not mean that a `local` object is project state.

## Reference classes

Every reference is classified before validation:

- `parent`: causal ancestry in a realm-specific history;
- `content`: a tree, blob, attachment, or other immutable dependency.

Rules:

| source    | parent targets | content targets              |
| --------- | -------------- | ---------------------------- |
| `public`  | `public`       | `public`                     |
| `members` | `members`      | `public`, `members`          |
| `local`   | `local`        | `public`, `members`, `local` |

Thus project artifacts (`public` or `members`) can never reference `local`
objects. Parents are stricter than other dependencies because each realm has an
independent change DAG and head. Promotion or restriction creates a new
destination-realm artifact; its audit correspondence is kept outside the less
restricted graph.

The `project` field pointing to the public `project.genesis` ID is project
identity, not a content reference, and is the sole cross-realm envelope
exception.

Unknown realms are rejected in v0. Custom realm DAGs require a later profile
that carries an explicit flow policy.
