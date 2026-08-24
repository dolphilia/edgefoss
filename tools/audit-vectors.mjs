import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";

const directory = new URL("../spec/vectors/", import.meta.url);
const expectedProfiles = new Map([
  ["artifact-id-v0.json", "edgefossil-artifact-id-v0"],
  ["bundle-v0.json", "edgefossil-bundle-v0"],
  ["change-graph-v0.json", "edgefossil-change-graph-v0"],
  ["path-v0.json", "edgefossil-path-v0"],
  ["project-genesis-v0.json", "edgefossil-artifact-v0"],
  ["realm-flow-v0.json", "edgefossil-realm-v0"],
  ["semantic-root-v0.json", "edgefossil-semantic-root-v0"],
  ["signature-v0.json", "edgefossil-signature-v0"],
  ["tree-change-v0.json", "edgefossil-artifact-v0"],
]);

function fail(message) {
  throw new Error(`vector audit failed: ${message}`);
}

function bytes(hex, label) {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) fail(`${label} is not lowercase hex`);
  return Uint8Array.from(
    hex.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function expectEqual(actual, expected, label) {
  if (actual !== expected)
    fail(`${label}: expected ${expected}, got ${actual}`);
}

async function load(name) {
  const value = JSON.parse(await readFile(new URL(name, directory), "utf8"));
  expectEqual(value.profile, expectedProfiles.get(name), `${name} profile`);
  return value;
}

const vectors = Object.fromEntries(
  await Promise.all(
    [...expectedProfiles.keys()].map(async (name) => [name, await load(name)]),
  ),
);

const ids = vectors["artifact-id-v0.json"];
for (const entry of ids.hash_cases) {
  expectEqual(
    `sha256:${digest(bytes(entry.body_hex, entry.name))}`,
    entry.artifact_id,
    `artifact hash ${entry.name}`,
  );
}

const genesis = vectors["project-genesis-v0.json"];
for (const entry of genesis.valid) {
  expectEqual(
    `sha256:${digest(bytes(entry.canonical_cbor_hex, entry.name))}`,
    entry.artifact_id,
    `genesis hash ${entry.name}`,
  );
}

const treeChange = vectors["tree-change-v0.json"];
for (const [name, entry] of [
  ["tree", treeChange.tree],
  ["change", treeChange.change],
]) {
  expectEqual(
    `sha256:${digest(bytes(entry.canonical_cbor_hex, name))}`,
    entry.artifact_id,
    `${name} hash`,
  );
}

const semantic = vectors["semantic-root-v0.json"];
for (const entry of semantic.expected) {
  expectEqual(
    `sha256:${digest(bytes(entry.descriptor_cbor_hex, entry.realm))}`,
    entry.semantic_root,
    `semantic root ${entry.realm}`,
  );
}

const signature = vectors["signature-v0.json"];
const artifactDigest = bytes(signature.artifact.slice(7), "signature artifact");
const domain = new TextEncoder().encode("EdgeFossil artifact signature v0\0");
const message = new Uint8Array(domain.length + artifactDigest.length);
message.set(domain);
message.set(artifactDigest, domain.length);
expectEqual(
  Buffer.from(message).toString("hex"),
  signature.message_hex,
  "signature message",
);
const publicKey = await webcrypto.subtle.importKey(
  "raw",
  bytes(signature.actor_key_hex, "actor key"),
  "Ed25519",
  false,
  ["verify"],
);
if (
  !(await webcrypto.subtle.verify(
    "Ed25519",
    publicKey,
    bytes(signature.signature_hex, "signature"),
    message,
  ))
) {
  fail("Ed25519 signature does not verify");
}

const accepted =
  ids.valid.length +
  ids.hash_cases.length +
  genesis.valid.length +
  vectors["path-v0.json"].valid.length +
  semantic.expected.length +
  2 +
  1 +
  1;
const rejected =
  ids.invalid.length +
  genesis.invalid.length +
  vectors["path-v0.json"].invalid.length +
  semantic.invalid.length +
  signature.invalid.length +
  treeChange.invalid_trees.length +
  treeChange.invalid_changes.length +
  vectors["bundle-v0.json"].invalid.length;
if (accepted < 50 || rejected < 50) {
  fail(`corpus floor not met: accepted=${accepted}, rejected=${rejected}`);
}

console.log(
  `Audited ${expectedProfiles.size} shared vector files independently; accepted=${accepted}, rejected=${rejected}.`,
);
