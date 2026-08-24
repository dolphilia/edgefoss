import {
  decodeCanonical,
  encodeCanonical,
  FormatError,
  type CborValue,
} from "./cbor.js";
import { parseArtifactId } from "./artifact.js";

export interface SignatureRecord {
  artifact: string;
  actorKey: Uint8Array;
  signature: Uint8Array;
}

const keys = new Set([
  "format",
  "version",
  "artifact",
  "actor_key",
  "signature",
]);
const domain = new TextEncoder().encode("EdgeFossil artifact signature v0\0");

function invalidSignature(): never {
  throw new FormatError("invalid_signature", "artifact signature is invalid");
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

export function artifactSignatureMessage(artifactId: string): Uint8Array {
  const digest = parseArtifactId(artifactId);
  const message = new Uint8Array(domain.length + digest.length);
  message.set(domain);
  message.set(digest, domain.length);
  return message;
}

export function encodeSignatureRecord(record: SignatureRecord): Uint8Array {
  parseArtifactId(record.artifact);
  if (record.actorKey.length !== 32 || record.signature.length !== 64) {
    invalidSignature();
  }
  return encodeCanonical(
    new Map<string, CborValue>([
      ["format", "edgefossil-signature"],
      ["version", 0n],
      ["artifact", record.artifact],
      ["actor_key", record.actorKey],
      ["signature", record.signature],
    ]),
  );
}

export function decodeSignatureRecord(bytes: Uint8Array): SignatureRecord {
  const value = decodeCanonical(bytes);
  if (!(value instanceof Map)) invalidSignature();
  if (
    value.size !== keys.size ||
    [...value.keys()].some((key) => !keys.has(key)) ||
    value.get("format") !== "edgefossil-signature" ||
    value.get("version") !== 0n
  ) {
    invalidSignature();
  }
  const artifact = value.get("artifact");
  const actorKey = value.get("actor_key");
  const signature = value.get("signature");
  if (
    typeof artifact !== "string" ||
    !(actorKey instanceof Uint8Array) ||
    !(signature instanceof Uint8Array) ||
    actorKey.length !== 32 ||
    signature.length !== 64
  ) {
    invalidSignature();
  }
  try {
    parseArtifactId(artifact);
  } catch {
    invalidSignature();
  }
  return { artifact, actorKey, signature };
}

export async function verifyArtifactSignature(
  record: SignatureRecord,
  expectedArtifactId: string,
  expectedActorKey: Uint8Array,
): Promise<void> {
  if (
    record.artifact !== expectedArtifactId ||
    !sameBytes(record.actorKey, expectedActorKey) ||
    record.actorKey.length !== 32 ||
    record.signature.length !== 64
  ) {
    invalidSignature();
  }
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      copyBuffer(record.actorKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "Ed25519",
      key,
      copyBuffer(record.signature),
      copyBuffer(artifactSignatureMessage(record.artifact)),
    );
    if (!valid) invalidSignature();
  } catch (error) {
    if (error instanceof FormatError) throw error;
    invalidSignature();
  }
}
