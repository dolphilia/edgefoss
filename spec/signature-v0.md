# EdgeFossil artifact signature profile v0

Profile identifier: `edgefossil-signature-v0`

Signatures are mutable attestations kept outside the immutable artifact body.
Adding another signature therefore does not change the artifact ID.

## Signed message

For a canonical artifact ID, parse its raw 32-byte SHA-256 digest and construct:

```text
UTF8("EdgeFossil artifact signature v0") || 0x00 || digest
```

The signer creates a deterministic Ed25519 signature over those 65 bytes. v0
uses the standards-based Web Crypto algorithm name `Ed25519`; the legacy
Workers `NODE-ED25519` spelling is forbidden.

## Signature record

A record is `edgefossil-cbor-v0` with exactly:

| field       | type  | rule                           |
| ----------- | ----- | ------------------------------ |
| `format`    | text  | `edgefossil-signature`         |
| `version`   | uint  | `0`                            |
| `artifact`  | text  | canonical artifact ID          |
| `actor_key` | bytes | 32-byte raw Ed25519 public key |
| `signature` | bytes | 64-byte Ed25519 signature      |

Before acceptance, a verifier MUST recompute the artifact ID from canonical
artifact bytes, require the record's artifact and actor key to equal the
artifact envelope values, and verify Ed25519. A failure returns the single
`invalid_signature` code; public errors must not reveal which check failed.

Private keys and seeds are never serialized in artifacts, signature records,
logs, bundles, or test evidence. Golden test seeds are synthetic and MUST NOT be
used outside tests.

## Runtime compatibility

Node.js 24 and Cloudflare Workers both support `Ed25519` with Web Crypto
`importKey`, `sign`, and `verify`. TypeScript verification imports the public key
using the `raw` format, which Workers supports for Ed25519 public keys.

- [Node.js 24 Web Crypto documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/webcrypto.html)
- [Cloudflare Workers Web Crypto documentation](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
