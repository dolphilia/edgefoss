import { encodeCanonical, FormatError, type CborValue } from "./cbor.js";
import { formatArtifactId, parseArtifactId } from "./artifact.js";
import { validatePath } from "./path.js";
import type { Realm } from "./realm.js";

export interface SemanticArtifact {
  id: string;
  realm: Realm;
}

export interface SemanticRef {
  name: string;
  target: string;
  realm: Realm;
}

export interface SemanticRootInput {
  project: string;
  realm: Realm;
  artifacts: readonly SemanticArtifact[];
  refs: readonly SemanticRef[];
  policyVersion: bigint;
}

export interface SemanticRootResult {
  artifactSetRoot: Uint8Array;
  descriptor: Uint8Array;
  semanticRoot: string;
}

const MAX_REALM_ARTIFACTS = 65_535;
const MAX_REALM_REFS = 4_096;
const textEncoder = new TextEncoder();

function schemaError(message: string): never {
  throw new FormatError("invalid_schema", message);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
}

function validateRefName(name: string): void {
  if (textEncoder.encode(name).length > 255) {
    schemaError("ref name exceeds 255 UTF-8 bytes");
  }
  try {
    validatePath(name);
  } catch {
    schemaError("ref name violates edgefossil-path-v0");
  }
}

/** Computes one realm's portable semantic root while ignoring other realms. */
export async function computeSemanticRoot(
  input: SemanticRootInput,
): Promise<SemanticRootResult> {
  const project = parseArtifactId(input.project);
  if (
    input.policyVersion < 0n ||
    input.policyVersion > 0xffff_ffff_ffff_ffffn
  ) {
    schemaError("policy_version must be uint64");
  }

  const selectedArtifacts = input.artifacts
    .filter(({ realm }) => realm === input.realm)
    .map(({ id }) => ({ id, digest: parseArtifactId(id) }));
  if (selectedArtifacts.length > MAX_REALM_ARTIFACTS) {
    throw new FormatError("resource_limit", "realm artifact set is too large");
  }
  selectedArtifacts.sort((left, right) =>
    compareBytes(left.digest, right.digest),
  );
  for (let index = 1; index < selectedArtifacts.length; index += 1) {
    if (
      compareBytes(
        selectedArtifacts[index - 1]!.digest,
        selectedArtifacts[index]!.digest,
      ) === 0
    ) {
      schemaError("realm artifact set contains a duplicate");
    }
  }
  const selectedIds = new Set(selectedArtifacts.map(({ id }) => id));
  const artifactSetBytes = encodeCanonical(
    selectedArtifacts.map(({ digest }) => digest),
  );
  const artifactSetRoot = await sha256(artifactSetBytes);

  const selectedRefs = input.refs.filter(({ realm }) => realm === input.realm);
  if (selectedRefs.length > MAX_REALM_REFS) {
    throw new FormatError("resource_limit", "realm ref set is too large");
  }
  const refs = new Map<string, CborValue>();
  for (const ref of selectedRefs) {
    validateRefName(ref.name);
    if (refs.has(ref.name)) schemaError("realm ref name is duplicated");
    const target = parseArtifactId(ref.target);
    if (!selectedIds.has(ref.target)) {
      throw new FormatError(
        "unknown_required_semantics",
        "realm ref target is not in the realm artifact set",
      );
    }
    refs.set(ref.name, target);
  }

  const descriptor = encodeCanonical(
    new Map<string, CborValue>([
      ["format", "edgefossil-semantic-root"],
      ["version", 0n],
      ["project", project],
      ["realm", input.realm],
      ["artifact_set_root", artifactSetRoot],
      ["refs", refs],
      ["policy_version", input.policyVersion],
    ]),
  );
  return {
    artifactSetRoot,
    descriptor,
    semanticRoot: formatArtifactId(await sha256(descriptor)),
  };
}
