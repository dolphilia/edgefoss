import {
  decodeCanonical,
  encodeCanonical,
  FormatError,
  type CborValue,
} from "./cbor.js";
import {
  formatArtifactId,
  parseArtifactId,
  verifyArtifactId,
} from "./artifact.js";
import { computeSemanticRoot } from "./semantic-root.js";
import { parseRealm, type Realm } from "./realm.js";

export interface BundleManifest {
  project: string;
  realm: Realm;
  policyVersion: bigint;
  semanticRoot: string;
  artifacts: readonly string[];
  blobs: readonly string[];
  signatures: readonly string[];
  refs: ReadonlyMap<string, string>;
  baseRoots: ReadonlyMap<Realm, string>;
}

const manifestKeys = new Set([
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
]);

function schemaError(message: string): never {
  throw new FormatError("invalid_schema", message);
}

function asMap(value: CborValue, label: string): Map<string, CborValue> {
  if (!(value instanceof Map)) schemaError(`${label} must be a map`);
  return value;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function normalizedIds(
  values: readonly string[],
  label: string,
  requireSorted: boolean,
): Array<{ id: string; digest: Uint8Array }> {
  const result = values.map((id) => ({ id, digest: parseArtifactId(id) }));
  if (result.length > 65_535) {
    throw new FormatError("resource_limit", `${label} inventory is too large`);
  }
  const sorted = [...result].sort((left, right) =>
    compareBytes(left.digest, right.digest),
  );
  for (let index = 1; index < sorted.length; index += 1) {
    if (sameBytes(sorted[index - 1]!.digest, sorted[index]!.digest)) {
      schemaError(`${label} inventory contains a duplicate`);
    }
  }
  if (
    requireSorted &&
    result.some(
      ({ digest }, index) => !sameBytes(digest, sorted[index]!.digest),
    )
  ) {
    schemaError(`${label} inventory is not sorted by raw digest`);
  }
  return sorted;
}

function requiredBaseRealms(realm: Realm): Realm[] {
  if (realm === "public") return [];
  if (realm === "members") return ["public"];
  return ["public", "members"];
}

function validateBaseRoots(
  realm: Realm,
  baseRoots: ReadonlyMap<Realm, string>,
): void {
  const required = requiredBaseRealms(realm);
  if (
    baseRoots.size !== required.length ||
    required.some((baseRealm) => !baseRoots.has(baseRealm))
  ) {
    schemaError("base_roots do not match the bundle realm");
  }
  for (const root of baseRoots.values()) parseArtifactId(root);
}

/** Recomputes and verifies the portable meaning claimed by a bundle manifest. */
export async function verifyBundleManifest(
  manifest: BundleManifest,
): Promise<void> {
  parseArtifactId(manifest.project);
  parseArtifactId(manifest.semanticRoot);
  validateBaseRoots(manifest.realm, manifest.baseRoots);
  const artifacts = normalizedIds(manifest.artifacts, "artifact", false);
  normalizedIds(manifest.blobs, "blob", false);
  normalizedIds(manifest.signatures, "signature", false);
  const result = await computeSemanticRoot({
    project: manifest.project,
    realm: manifest.realm,
    policyVersion: manifest.policyVersion,
    artifacts: artifacts.map(({ id }) => ({ id, realm: manifest.realm })),
    refs: [...manifest.refs].map(([name, target]) => ({
      name,
      target,
      realm: manifest.realm,
    })),
  });
  if (result.semanticRoot !== manifest.semanticRoot) {
    throw new FormatError(
      "semantic_root_mismatch",
      "bundle semantic root does not match portable state",
    );
  }
}

/** Encodes a normalized experimental bundle manifest. */
export async function encodeBundleManifest(
  manifest: BundleManifest,
): Promise<Uint8Array> {
  await verifyBundleManifest(manifest);
  const artifacts = normalizedIds(manifest.artifacts, "artifact", false);
  const blobs = normalizedIds(manifest.blobs, "blob", false);
  const signatures = normalizedIds(manifest.signatures, "signature", false);
  return encodeCanonical(
    new Map<string, CborValue>([
      ["format", "edgefossil-bundle"],
      ["version", 0n],
      ["experimental", true],
      ["project", parseArtifactId(manifest.project)],
      ["realm", manifest.realm],
      ["policy_version", manifest.policyVersion],
      ["semantic_root", parseArtifactId(manifest.semanticRoot)],
      ["artifacts", artifacts.map(({ digest }) => digest)],
      ["blobs", blobs.map(({ digest }) => digest)],
      ["signatures", signatures.map(({ digest }) => digest)],
      [
        "refs",
        new Map<string, CborValue>(
          [...manifest.refs].map(([name, target]) => [
            name,
            parseArtifactId(target),
          ]),
        ),
      ],
      [
        "base_roots",
        new Map<string, CborValue>(
          [...manifest.baseRoots].map(([realm, root]) => [
            realm,
            parseArtifactId(root),
          ]),
        ),
      ],
    ]),
  );
}

function decodeIdArray(value: CborValue | undefined, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (digest) => !(digest instanceof Uint8Array) || digest.length !== 32,
    )
  ) {
    schemaError(`${label} inventory must contain 32-byte digests`);
  }
  const ids = (value as Uint8Array[]).map(formatArtifactId);
  normalizedIds(ids, label, true);
  return ids;
}

function decodeIdMap(
  value: CborValue | undefined,
  label: string,
): Map<string, string> {
  const map = asMap(value ?? schemaError(`${label} is missing`), label);
  const result = new Map<string, string>();
  for (const [key, digest] of map) {
    if (!(digest instanceof Uint8Array) || digest.length !== 32) {
      schemaError(`${label} values must be 32-byte digests`);
    }
    result.set(key, formatArtifactId(digest));
  }
  return result;
}

/** Decodes the exact canonical schema-0 bundle manifest. */
export function decodeBundleManifest(bytes: Uint8Array): BundleManifest {
  const map = asMap(decodeCanonical(bytes), "bundle manifest");
  if (
    map.size !== manifestKeys.size ||
    [...map.keys()].some((key) => !manifestKeys.has(key)) ||
    map.get("format") !== "edgefossil-bundle" ||
    map.get("version") !== 0n ||
    map.get("experimental") !== true
  ) {
    schemaError("bundle manifest fields or constants are invalid");
  }
  const project = map.get("project");
  const realm = map.get("realm");
  const policyVersion = map.get("policy_version");
  const semanticRoot = map.get("semantic_root");
  if (
    !(project instanceof Uint8Array) ||
    project.length !== 32 ||
    typeof realm !== "string" ||
    typeof policyVersion !== "bigint" ||
    !(semanticRoot instanceof Uint8Array) ||
    semanticRoot.length !== 32
  ) {
    schemaError("bundle manifest field types are invalid");
  }
  const parsedRealm = parseRealm(realm);
  if (parsedRealm === undefined) schemaError("bundle realm is unknown");
  const refs = decodeIdMap(map.get("refs"), "refs");
  const baseRoots = decodeIdMap(map.get("base_roots"), "base_roots");
  const manifest: BundleManifest = {
    project: formatArtifactId(project),
    realm: parsedRealm,
    policyVersion,
    semanticRoot: formatArtifactId(semanticRoot),
    artifacts: decodeIdArray(map.get("artifacts"), "artifact"),
    blobs: decodeIdArray(map.get("blobs"), "blob"),
    signatures: decodeIdArray(map.get("signatures"), "signature"),
    refs,
    baseRoots: new Map(
      [...baseRoots].map(([baseRealm, root]) => {
        const parsed = parseRealm(baseRealm);
        if (parsed === undefined)
          schemaError("base_roots contains an unknown realm");
        return [parsed, root];
      }),
    ),
  };
  validateBaseRoots(manifest.realm, manifest.baseRoots);
  return manifest;
}

function objectPath(
  kind: "artifacts" | "blobs" | "signatures",
  id: string,
): string {
  return `${kind}/${id.slice(7)}.${kind === "blobs" ? "bin" : "cbor"}`;
}

/** Verifies that a directory bundle contains exactly its inventoried objects. */
export async function verifyBundleObjects(
  manifest: BundleManifest,
  objects: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
  const expected = new Map<string, string>();
  for (const [kind, ids] of [
    ["artifacts", manifest.artifacts],
    ["blobs", manifest.blobs],
    ["signatures", manifest.signatures],
  ] as const) {
    for (const id of ids) expected.set(objectPath(kind, id), id);
  }
  for (const [path, id] of expected) {
    const body = objects.get(path);
    if (body === undefined) {
      throw new FormatError(
        "missing_bundle_object",
        `missing bundle object: ${path}`,
      );
    }
    try {
      await verifyArtifactId(body, id);
    } catch {
      throw new FormatError(
        "bundle_object_mismatch",
        `bundle object mismatch: ${path}`,
      );
    }
  }
  for (const path of objects.keys()) {
    if (!expected.has(path)) {
      throw new FormatError(
        "unexpected_bundle_object",
        `unexpected bundle object: ${path}`,
      );
    }
  }
}
