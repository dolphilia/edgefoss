# EdgeFossil tracking and publication policy v0

Policy version: `0`

Tracking, confidentiality, and delivery-channel presentation are independent
decisions. A policy evaluation returns:

```text
tracking: ignored | tracked
realm:    public | members | local       # only when tracked
channels: subset of {sync, web, archive} # only when tracked
```

## Security meaning

`realm` is the confidentiality ceiling:

- `public`: safe for anonymous distribution if the deployment enables it;
- `members`: available only after member authorization;
- `local`: tracked locally and never uploaded by the v0 sync protocol.

`channels` controls presentation and delivery within that ceiling. Omitting
`web` can hide a path from Web navigation and file-content endpoints while
retaining it in clone/sync and archives. It is **not confidentiality**: a user
who can obtain the public graph may recover a public-realm artifact by ID or
from a clone. Sensitive content MUST use `members` or `local`.

Channel constraints are:

- `local` permits no remote channel;
- `members` channels require member authorization;
- `public` channels may be anonymously exposed only when deployment policy
  separately enables the relevant public endpoint;
- a file omitted from `sync` cannot be needed to reconstruct a tree delivered
  through `sync`;
- `web` omission suppresses path, directory-entry, search, preview, diff, and
  raw-content projections. Aggregate public metadata MUST not derive secret
  values from suppressed content.

The tracked-public-but-not-Web example is therefore:

```text
tracking = tracked
realm    = public
channels = [sync, archive]
```

## Rule matching

The portable v0 policy is an ordered array of rules. Each rule selects exactly
one of:

- `path`: one valid canonical path; or
- `prefix`: a valid canonical directory path, matching the directory and all
  descendants at a `/` boundary.

Glob syntax, regular expressions, negation, and platform-native path matching
are not part of v0. Evaluation chooses the matching exact `path` rule first;
otherwise it chooses the matching `prefix` with the greatest UTF-8 byte length.
Two rules with the same selector are invalid. If no rule matches, the explicit
policy default is used.

Rules cannot override protocol invariants: invalid paths, cross-realm parent
references, or channel/realm inconsistencies remain errors.

## Publication projections

Each channel is built as a projection, not by filtering an already serialized
HTML page or archive. The projection walks the authorized realm graph and emits
only entries allowed for that channel. Cache keys include project, realm/view,
channel, policy version, and semantic root. A response created for a broader
audience MUST NOT be reused for a narrower audience.

Policy changes are immutable policy artifacts and affect new projection roots;
they do not erase previously distributed public content. Removing already
public data requires a tombstone plus operational cache/search cleanup and can
never retract existing clones.
