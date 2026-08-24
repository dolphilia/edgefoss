# Gate evidence template

Copy this template for each gate decision. Do not include credentials, account IDs, restricted paths, artifact IDs, or source content.

```yaml
gate: G0
decision: pending # go | no-go | conditional
date: YYYY-MM-DD
commit: <git commit>
environment: local # local | staging | production
owner: <role>
reviewers: []
user_action_checkpoints: []
commands:
  - command: <redacted command>
    result: pass
evidence:
  tests: []
  fixtures: []
  measurements: []
  decisions: []
open_risks: []
rollback_or_fallback: <path>
notes: <non-secret notes>
```

Every `USER-ACTION` entry records only checkpoint ID, date, environment, scope summary, and non-secret result. Never attach token output, recovery codes, presigned URLs, or full `wrangler whoami` output.
