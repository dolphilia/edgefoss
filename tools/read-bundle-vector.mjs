import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

class BundleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const concat = (parts) => {
  const output = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

const compare = (left, right) => {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
};

const head = (major, value) => {
  if (value < 24n) return Uint8Array.of((major << 5) | Number(value));
  const widths = [
    [0xffn, 1, 24],
    [0xffffn, 2, 25],
    [0xffff_ffffn, 4, 26],
    [0xffff_ffff_ffff_ffffn, 8, 27],
  ];
  const selected = widths.find(([maximum]) => value <= maximum);
  if (!selected) throw new BundleError("invalid_schema", "uint64 overflow");
  const [, width, additional] = selected;
  const output = new Uint8Array(1 + width);
  output[0] = (major << 5) | additional;
  let remaining = value;
  for (let index = width; index > 0; index -= 1) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return output;
};

function encode(value) {
  if (typeof value === "bigint") return head(0, value);
  if (value instanceof Uint8Array)
    return concat([head(2, BigInt(value.length)), value]);
  if (typeof value === "string") {
    const body = new TextEncoder().encode(value);
    return concat([head(3, BigInt(body.length)), body]);
  }
  if (Array.isArray(value)) {
    return concat([head(4, BigInt(value.length)), ...value.map(encode)]);
  }
  if (value instanceof Map) {
    const entries = [...value].map(([key, item]) => [
      encode(key),
      encode(item),
    ]);
    entries.sort((left, right) => compare(left[0], right[0]));
    return concat([
      head(5, BigInt(entries.length)),
      ...entries.flatMap(([key, item]) => [key, item]),
    ]);
  }
  if (value === true) return Uint8Array.of(0xf5);
  if (value === false) return Uint8Array.of(0xf4);
  throw new BundleError("unsupported_type", "unsupported CBOR value");
}

class Decoder {
  offset = 0;
  items = 0;

  constructor(bytes) {
    if (bytes.length > 1_048_576)
      throw new BundleError("resource_limit", "input too large");
    this.bytes = bytes;
  }

  byte() {
    const value = this.bytes[this.offset];
    if (value === undefined)
      throw new BundleError("invalid_cbor", "truncated CBOR");
    this.offset += 1;
    return value;
  }

  argument(additional) {
    if (additional < 24) return BigInt(additional);
    const width =
      additional === 24
        ? 1
        : additional === 25
          ? 2
          : additional === 26
            ? 4
            : additional === 27
              ? 8
              : 0;
    if (width === 0)
      throw new BundleError("unsupported_type", "invalid CBOR length");
    let value = 0n;
    for (let index = 0; index < width; index += 1)
      value = (value << 8n) | BigInt(this.byte());
    const minimum =
      width === 1
        ? 24n
        : width === 2
          ? 0x100n
          : width === 4
            ? 0x1_0000n
            : 0x1_0000_0000n;
    if (value < minimum)
      throw new BundleError("non_canonical", "non-shortest CBOR");
    return value;
  }

  item(depth = 0) {
    if (depth > 64) throw new BundleError("resource_limit", "nesting too deep");
    this.items += 1;
    if (this.items > 65_536)
      throw new BundleError("resource_limit", "too many items");
    const initial = this.byte();
    const major = initial >> 5;
    const additional = initial & 31;
    if (major === 7 && additional === 20) return false;
    if (major === 7 && additional === 21) return true;
    const argument = this.argument(additional);
    if (argument > 1_048_576n)
      throw new BundleError("resource_limit", "item too large");
    const length = Number(argument);
    if (major === 0) return argument;
    if (major === 2) {
      const value = this.bytes.slice(this.offset, this.offset + length);
      if (value.length !== length)
        throw new BundleError("invalid_cbor", "truncated bytes");
      this.offset += length;
      return value;
    }
    if (major === 3) {
      const value = this.bytes.slice(this.offset, this.offset + length);
      if (value.length !== length)
        throw new BundleError("invalid_cbor", "truncated text");
      this.offset += length;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(value);
      if (text.normalize("NFC") !== text)
        throw new BundleError("invalid_text", "non-NFC text");
      return text;
    }
    if (major === 4) return Array.from({ length }, () => this.item(depth + 1));
    if (major === 5) {
      const map = new Map();
      let previous;
      for (let index = 0; index < length; index += 1) {
        const start = this.offset;
        const key = this.item(depth + 1);
        const keyBytes = this.bytes.slice(start, this.offset);
        if (typeof key !== "string" || map.has(key))
          throw new BundleError("duplicate_key", "invalid map key");
        if (previous && compare(previous, keyBytes) >= 0)
          throw new BundleError("non_canonical", "map order");
        map.set(key, this.item(depth + 1));
        previous = keyBytes;
      }
      return map;
    }
    throw new BundleError("unsupported_type", "unsupported CBOR type");
  }
}

function decode(bytes) {
  const decoder = new Decoder(bytes);
  const value = decoder.item();
  if (decoder.offset !== bytes.length)
    throw new BundleError("invalid_cbor", "trailing bytes");
  if (compare(encode(value), bytes) !== 0)
    throw new BundleError("non_canonical", "re-encoding differs");
  return value;
}

function fromHex(value) {
  if (!/^(?:[0-9a-f]{2})*$/.test(value))
    throw new BundleError("invalid_schema", "invalid hex fixture");
  return Uint8Array.from(
    value.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
}

const hex = (value) => Buffer.from(value).toString("hex");
const sha256 = (value) =>
  new Uint8Array(createHash("sha256").update(value).digest());

function exactMap(value, keys) {
  if (
    !(value instanceof Map) ||
    value.size !== keys.length ||
    keys.some((key) => !value.has(key))
  ) {
    throw new BundleError("invalid_schema", "manifest fields differ");
  }
}

function digestArray(value, label) {
  if (!Array.isArray(value) || value.length > 65_535)
    throw new BundleError("invalid_schema", `${label} inventory`);
  let previous;
  for (const digest of value) {
    if (!(digest instanceof Uint8Array) || digest.length !== 32)
      throw new BundleError("invalid_schema", `${label} digest`);
    if (previous && compare(previous, digest) >= 0)
      throw new BundleError("invalid_schema", `${label} order`);
    previous = digest;
  }
  return value;
}

function validateRefName(name) {
  const body = new TextEncoder().encode(name);
  if (
    body.length === 0 ||
    body.length > 255 ||
    name.normalize("NFC") !== name ||
    name.startsWith("/") ||
    name.endsWith("/")
  ) {
    throw new BundleError("invalid_schema", "invalid ref name");
  }
  const reserved = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/;
  for (const segment of name.split("/")) {
    const stem = segment.split(".", 1)[0].toUpperCase();
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      new TextEncoder().encode(segment).length > 255 ||
      /[\u0000-\u001f\u007f<>:"\\|?*]/u.test(segment) ||
      /[ .]$/u.test(segment) ||
      reserved.test(stem)
    ) {
      throw new BundleError("invalid_schema", "invalid ref name");
    }
  }
}

const manifestKeys = [
  "format",
  "version",
  "experimental",
  "project",
  "realm",
  "policy_version",
  "semantic_root",
  "artifacts",
  "blobs",
  "signatures",
  "refs",
  "base_roots",
];

function validateManifest(manifest) {
  exactMap(manifest, manifestKeys);
  if (
    manifest.get("format") !== "edgefossil-bundle" ||
    manifest.get("version") !== 0n ||
    manifest.get("experimental") !== true
  ) {
    throw new BundleError("invalid_schema", "manifest constants");
  }
  const project = manifest.get("project");
  const semanticRoot = manifest.get("semantic_root");
  const realm = manifest.get("realm");
  const policyVersion = manifest.get("policy_version");
  if (
    !(project instanceof Uint8Array) ||
    project.length !== 32 ||
    !(semanticRoot instanceof Uint8Array) ||
    semanticRoot.length !== 32 ||
    !["public", "members", "local"].includes(realm) ||
    typeof policyVersion !== "bigint"
  ) {
    throw new BundleError("invalid_schema", "manifest field types");
  }
  const artifacts = digestArray(manifest.get("artifacts"), "artifact");
  const blobs = digestArray(manifest.get("blobs"), "blob");
  const signatures = digestArray(manifest.get("signatures"), "signature");
  const refs = manifest.get("refs");
  const bases = manifest.get("base_roots");
  if (!(refs instanceof Map) || !(bases instanceof Map))
    throw new BundleError("invalid_schema", "manifest maps");
  const artifactIds = new Set(artifacts.map(hex));
  for (const [name, target] of refs) {
    validateRefName(name);
    if (!(target instanceof Uint8Array) || target.length !== 32)
      throw new BundleError("invalid_schema", "ref target digest");
    if (!artifactIds.has(hex(target)))
      throw new BundleError("unknown_required_semantics", "ref target absent");
  }
  const required =
    realm === "public"
      ? []
      : realm === "members"
        ? ["public"]
        : ["public", "members"];
  if (bases.size !== required.length || required.some((key) => !bases.has(key)))
    throw new BundleError("invalid_schema", "base_roots shape");
  for (const root of bases.values())
    if (!(root instanceof Uint8Array) || root.length !== 32)
      throw new BundleError("invalid_schema", "base root digest");
  return {
    project,
    semanticRoot,
    realm,
    policyVersion,
    artifacts,
    blobs,
    signatures,
    refs,
  };
}

function expectedPaths(inventory) {
  const expected = new Map();
  for (const [kind, values] of [
    ["artifacts", inventory.artifacts],
    ["blobs", inventory.blobs],
    ["signatures", inventory.signatures],
  ]) {
    for (const digest of values)
      expected.set(
        `${kind}/${hex(digest)}.${kind === "blobs" ? "bin" : "cbor"}`,
        digest,
      );
  }
  return expected;
}

function verifyObjects(inventory, files) {
  const expected = expectedPaths(inventory);
  for (const [path, digest] of expected) {
    const body = files.get(path);
    if (!body)
      throw new BundleError("missing_bundle_object", `missing ${path}`);
    if (compare(sha256(body), digest) !== 0)
      throw new BundleError("bundle_object_mismatch", `mismatch ${path}`);
  }
  for (const path of files.keys())
    if (!expected.has(path))
      throw new BundleError("unexpected_bundle_object", `unexpected ${path}`);
}

function verifySemanticRoot(inventory) {
  const setRoot = sha256(encode(inventory.artifacts));
  const descriptor = new Map([
    ["format", "edgefossil-semantic-root"],
    ["version", 0n],
    ["project", inventory.project],
    ["realm", inventory.realm],
    ["artifact_set_root", setRoot],
    ["refs", inventory.refs],
    ["policy_version", inventory.policyVersion],
  ]);
  if (compare(sha256(encode(descriptor)), inventory.semanticRoot) !== 0) {
    throw new BundleError("semantic_root_mismatch", "semantic root mismatch");
  }
}

function verify(manifestBytes, files) {
  const manifest = decode(manifestBytes);
  const inventory = validateManifest(manifest);
  verifyObjects(inventory, files);
  verifySemanticRoot(inventory);
  return { manifest, inventory };
}

const input = process.argv[2];
if (!input)
  throw new Error("usage: node tools/read-bundle-vector.mjs <vector.json>");
const vector = JSON.parse(await readFile(input, "utf8"));
if (vector.profile !== "edgefossil-bundle-v0")
  throw new Error("unexpected bundle profile");
const manifestBytes = fromHex(vector.manifest_cbor_hex);
const files = new Map(
  Object.entries(vector.files).map(([path, body]) => [path, fromHex(body)]),
);
const baseline = verify(manifestBytes, files);

for (const test of vector.invalid) {
  const mutatedFiles = new Map(
    [...files].map(([path, body]) => [path, body.slice()]),
  );
  let mutatedManifest = baseline.manifest;
  if (test.mutation === "missing_object") mutatedFiles.clear();
  else if (test.mutation === "unexpected_object")
    mutatedFiles.set("extra", new Uint8Array());
  else if (test.mutation === "object_mismatch")
    mutatedFiles.values().next().value[0] ^= 1;
  else if (test.mutation === "semantic_root") {
    mutatedManifest = new Map(baseline.manifest);
    mutatedManifest.set("semantic_root", new Uint8Array(32));
  } else if (test.mutation === "public_base_root") {
    mutatedManifest = new Map(baseline.manifest);
    mutatedManifest.set(
      "base_roots",
      new Map([["public", new Uint8Array(32)]]),
    );
  } else throw new Error(`unknown mutation: ${test.mutation}`);
  try {
    verify(encode(mutatedManifest), mutatedFiles);
    throw new Error(`${test.mutation} was accepted`);
  } catch (error) {
    if (error.code !== test.error) throw error;
  }
}

console.log(
  `Independently read bundle vector; files=${files.size}, invalid=${vector.invalid.length}.`,
);
