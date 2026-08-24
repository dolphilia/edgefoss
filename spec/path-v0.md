# EdgeFossil path profile v0

Profile identifier: `edgefossil-path-v0`

An artifact stores a repository-relative path as one NFC UTF-8 text string.
The separator is `/` on every platform.

## Valid path

A path MUST satisfy all of the following:

- its UTF-8 encoding is 1–4096 bytes;
- it is already Unicode NFC;
- it does not start or end with `/`;
- every segment is 1–255 UTF-8 bytes;
- no segment is `.` or `..`;
- it contains no NUL, control character U+0001–U+001F, or U+007F;
- no segment ends in ASCII space or `.`;
- taking the portion before the first ASCII `.` and ASCII-case-folding it, no segment is a
  Windows device name: `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, or
  `LPT1`–`LPT9`.

Backslash is an ordinary character, not a separator, but v0 rejects it to avoid
platform-dependent checkout behavior. The Windows-forbidden ASCII characters
`<`, `>`, `:`, `"`, `\`, `|`, `?`, and `*` are rejected in every segment.
Clients MUST validate before constructing an artifact and receivers MUST
validate again.

Validators report the first failure in this order: empty path, total byte
length, NFC, absolute path, trailing slash, then for each segment from left to
right: empty, dot segment, segment byte length, control character, forbidden
character, trailing dot/space, Windows device name. Stable error names are
defined by the shared path corpus.

## Collision rule

Within one tree, no two sibling names may have the same v0 portable collision
key. The key is the already-NFC name with ASCII `A`–`Z` replaced by `a`–`z`;
all other Unicode scalar values remain unchanged. This algorithm is deliberately
small and independent of a runtime's Unicode version. The original NFC spelling
remains authoritative; clients MUST NOT silently rename it.

Before checkout, a client MUST additionally probe or model the target
filesystem's case/normalization behavior and refuse any collision it would
create, including non-ASCII collisions not covered by the portable v0 key.

## Symlinks

A tree entry identifies a regular file, directory, executable file, or symbolic
link explicitly. A symlink payload is UTF-8 text and is not normalized as a
repository path. Checkout MUST resolve it relative to its containing directory
and reject absolute targets or any target whose lexical normalization escapes
the checkout root. Checkout MUST also defend against filesystem races and
pre-existing symlink ancestors.

## Realm collision

The same path MUST NOT appear in more than one realm in v0. Moving a path
between realms is represented as deletion/tombstone in the old realm and
creation in the new realm, committed as one local operation before publication.
