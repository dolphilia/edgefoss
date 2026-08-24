import {
  decodeCanonical,
  encodeCanonical,
  FormatError,
  type CborValue,
} from "./cbor.js";

export interface ProjectGenesisInput {
  name: string;
  nonce: Uint8Array;
  actorKey: Uint8Array;
  createdAt: string;
}

const envelopeKeys = new Set([
  "format",
  "version",
  "kind",
  "schema",
  "realm",
  "parents",
  "actor_key",
  "logical_clock",
  "created_at",
  "payload",
]);
const payloadKeys = new Set(["name", "nonce", "policy_version"]);

function schemaError(message: string): never {
  throw new FormatError("invalid_schema", message);
}

function exactKeys(
  map: Map<string, CborValue>,
  expected: Set<string>,
  label: string,
): void {
  if (
    map.size !== expected.size ||
    [...map.keys()].some((key) => !expected.has(key))
  ) {
    schemaError(`${label} fields do not match schema 0`);
  }
}

function asMap(value: CborValue, label: string): Map<string, CborValue> {
  if (!(value instanceof Map)) schemaError(`${label} must be a map`);
  return value;
}

function asBytes(
  value: CborValue | undefined,
  length: number,
  label: string,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    schemaError(`${label} must be ${length} bytes`);
  }
  return value;
}

function validTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(
    value,
  );
  if (match === null) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1]! &&
    Number(hourText) <= 23 &&
    Number(minuteText) <= 59 &&
    Number(secondText) <= 59
  );
}

function validateInput(input: ProjectGenesisInput): void {
  const nameBytes = new TextEncoder().encode(input.name);
  if (
    input.name.normalize("NFC") !== input.name ||
    nameBytes.length === 0 ||
    nameBytes.length > 128
  ) {
    schemaError("name must be NFC and 1-128 UTF-8 bytes");
  }
  asBytes(input.nonce, 32, "nonce");
  asBytes(input.actorKey, 32, "actor_key");
  if (!validTimestamp(input.createdAt))
    schemaError("created_at must be a valid UTC RFC 3339 second");
}

export function encodeProjectGenesis(input: ProjectGenesisInput): Uint8Array {
  validateInput(input);
  const payload = new Map<string, CborValue>([
    ["name", input.name],
    ["nonce", input.nonce],
    ["policy_version", 0n],
  ]);
  return encodeCanonical(
    new Map<string, CborValue>([
      ["format", "edgefossil-artifact"],
      ["version", 0n],
      ["kind", "project.genesis"],
      ["schema", 0n],
      ["realm", "public"],
      ["parents", []],
      ["actor_key", input.actorKey],
      ["logical_clock", 0n],
      ["created_at", input.createdAt],
      ["payload", payload],
    ]),
  );
}

export function decodeProjectGenesis(bytes: Uint8Array): ProjectGenesisInput {
  const envelope = asMap(decodeCanonical(bytes), "artifact");
  exactKeys(envelope, envelopeKeys, "artifact");
  if (
    envelope.get("format") !== "edgefossil-artifact" ||
    envelope.get("version") !== 0n ||
    envelope.get("kind") !== "project.genesis" ||
    envelope.get("schema") !== 0n ||
    envelope.get("realm") !== "public" ||
    envelope.get("logical_clock") !== 0n
  ) {
    schemaError("project.genesis envelope constants are invalid");
  }
  const parents = envelope.get("parents");
  if (!Array.isArray(parents) || parents.length !== 0)
    schemaError("project.genesis parents must be empty");
  const createdAt = envelope.get("created_at");
  if (typeof createdAt !== "string" || !validTimestamp(createdAt))
    schemaError("created_at is invalid");
  const payload = asMap(
    envelope.get("payload") ?? schemaError("payload is missing"),
    "payload",
  );
  exactKeys(payload, payloadKeys, "payload");
  const name = payload.get("name");
  if (typeof name !== "string" || payload.get("policy_version") !== 0n)
    schemaError("project.genesis payload constants are invalid");
  const result = {
    name,
    nonce: asBytes(payload.get("nonce"), 32, "nonce"),
    actorKey: asBytes(envelope.get("actor_key"), 32, "actor_key"),
    createdAt,
  };
  validateInput(result);
  return result;
}

export async function artifactId(canonicalBody: Uint8Array): Promise<string> {
  const body = new ArrayBuffer(canonicalBody.byteLength);
  new Uint8Array(body).set(canonicalBody);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
