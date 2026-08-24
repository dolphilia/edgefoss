# Cloud resource naming

Status: P4a0 reviewed manifest baseline; no stateful remote resources have been
created.

## Pattern

Use lowercase ASCII and hyphens:

```text
<deployment-slug>-<environment>-<role>
```

- `deployment-slug`: stable name for the single-project deployment, initially `edgefoss` for development.
- `environment`: `dev`, `staging`, or `production`.
- `role`: the resource's single responsibility.

Planned staging examples:

| Resource               | Name/binding                                             |
| ---------------------- | -------------------------------------------------------- |
| Worker                 | `edgefoss-staging`                                       |
| Durable Object binding | `REPOSITORY`                                             |
| public R2 bucket       | `edgefoss-staging-public-blobs` / `PUBLIC_BLOBS`         |
| restricted R2 bucket   | `edgefoss-staging-restricted-blobs` / `RESTRICTED_BLOBS` |
| export R2 bucket       | `edgefoss-staging-exports` / `EXPORTS`                   |
| events Queue           | `edgefoss-staging-events` / `EVENTS`                     |
| dead-letter Queue      | `edgefoss-staging-events-dlq`                            |

## Rules

- Names always include the environment; preview/local code must never bind production resources.
- [`infra/cloud-resources.json`](../../infra/cloud-resources.json) is the P4
  source of truth for Worker, Durable Object, bucket, and Queue intent.
- Bucket and Queue names are created only from that reviewed manifest.
- Physical IDs remain in deployment configuration and never enter portable artifacts.
- Rename/delete/transfer is a lifecycle operation requiring a verified backup and manual approval.
- Do not embed account IDs, email addresses, realm names, or secrets in resource names.
