import {
  decodeCanonical,
  encodeCanonical,
  FormatError,
  type CborValue,
} from "./cbor.js";
import { validatePath } from "./path.js";
import { parseRealm, type Realm } from "./realm.js";

export interface ProjectGenesisInput {
  name: string;
  nonce: Uint8Array;
  actorKey: Uint8Array;
  createdAt: string;
}

export interface ArtifactMeta {
  project: string;
  realm: Realm;
  parents: string[];
  actorKey: Uint8Array;
  logicalClock: bigint;
  createdAt: string;
}

export type TreeEntryMode = "file" | "executable" | "directory" | "symlink";

export interface TreeEntry {
  name: string;
  mode: TreeEntryMode;
  target: string;
}

export interface TreeArtifactInput extends ArtifactMeta {
  entries: TreeEntry[];
}

export interface ChangeArtifactInput extends ArtifactMeta {
  root: string;
  message: string;
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
const commonEnvelopeKeys = new Set([...envelopeKeys, "project"]);
const treePayloadKeys = new Set(["entries"]);
const treeEntryKeys = new Set(["name", "mode", "target"]);
const changePayloadKeys = new Set(["root", "message"]);

function schemaError(message: string): never {
  throw new FormatError("invalid_schema", message);
}

export function parseArtifactId(value: string): Uint8Array {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new FormatError(
      "invalid_artifact_id",
      "artifact ID must be sha256 plus 64 lowercase hexadecimal characters",
    );
  }
  return Uint8Array.from(
    value
      .slice(7)
      .match(/../g)!
      .map((pair) => Number.parseInt(pair, 16)),
  );
}

export function formatArtifactId(digest: Uint8Array): string {
  if (digest.length !== 32) {
    throw new FormatError(
      "invalid_artifact_id",
      "SHA-256 digest must be 32 bytes",
    );
  }
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
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

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function validateMeta(meta: ArtifactMeta, maxParents: number): void {
  parseArtifactId(meta.project);
  if (parseRealm(meta.realm) === undefined) schemaError("unknown realm");
  asBytes(meta.actorKey, 32, "actor_key");
  if (meta.logicalClock < 0n || meta.logicalClock > 0xffff_ffff_ffff_ffffn) {
    schemaError("logical_clock must be uint64");
  }
  if (!validTimestamp(meta.createdAt)) schemaError("created_at is invalid");
  if (meta.parents.length > maxParents) schemaError("too many parents");
  const digests = meta.parents.map(parseArtifactId);
  for (let index = 1; index < digests.length; index += 1) {
    if (compareBytes(digests[index - 1]!, digests[index]!) >= 0) {
      schemaError("parents must be strictly sorted by raw digest");
    }
  }
}

function commonEnvelope(
  kind: "tree" | "change",
  meta: ArtifactMeta,
  payload: Map<string, CborValue>,
): Map<string, CborValue> {
  return new Map<string, CborValue>([
    ["format", "edgefossil-artifact"],
    ["version", 0n],
    ["project", meta.project],
    ["kind", kind],
    ["schema", 0n],
    ["realm", meta.realm],
    ["parents", meta.parents],
    ["actor_key", meta.actorKey],
    ["logical_clock", meta.logicalClock],
    ["created_at", meta.createdAt],
    ["payload", payload],
  ]);
}

function decodeMeta(
  envelope: Map<string, CborValue>,
  kind: "tree" | "change",
  maxParents: number,
): ArtifactMeta {
  exactKeys(envelope, commonEnvelopeKeys, "artifact");
  if (
    envelope.get("format") !== "edgefossil-artifact" ||
    envelope.get("version") !== 0n ||
    envelope.get("kind") !== kind ||
    envelope.get("schema") !== 0n
  ) {
    schemaError(`${kind} envelope constants are invalid`);
  }
  const project = envelope.get("project");
  const realm = envelope.get("realm");
  const parentsValue = envelope.get("parents");
  const logicalClock = envelope.get("logical_clock");
  const createdAt = envelope.get("created_at");
  if (
    typeof project !== "string" ||
    typeof realm !== "string" ||
    !Array.isArray(parentsValue) ||
    parentsValue.some((parent) => typeof parent !== "string") ||
    typeof logicalClock !== "bigint" ||
    typeof createdAt !== "string"
  ) {
    schemaError(`${kind} envelope field types are invalid`);
  }
  const parsedRealm = parseRealm(realm);
  if (parsedRealm === undefined) schemaError("unknown realm");
  const meta = {
    project,
    realm: parsedRealm,
    parents: parentsValue as string[],
    actorKey: asBytes(envelope.get("actor_key"), 32, "actor_key"),
    logicalClock,
    createdAt,
  };
  validateMeta(meta, maxParents);
  return meta;
}

function collisionKey(name: string): string {
  return name.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function validateSymlinkTarget(target: string): void {
  const length = new TextEncoder().encode(target).length;
  if (
    length === 0 ||
    length > 4096 ||
    target.normalize("NFC") !== target ||
    target.includes("\0") ||
    target.startsWith("/") ||
    target.startsWith("\\") ||
    /^[A-Za-z]:/.test(target)
  ) {
    schemaError("symlink target is invalid");
  }
}

function validateTreeEntries(
  entries: TreeEntry[],
  requireSorted: boolean,
): TreeEntry[] {
  if (entries.length > 65_535) schemaError("tree has too many entries");
  const encoder = new TextEncoder();
  const sorted = entries
    .map((entry) => ({ ...entry }))
    .sort((left, right) =>
      compareBytes(encoder.encode(left.name), encoder.encode(right.name)),
    );
  const seenCollisionKeys = new Set<string>();
  for (let index = 0; index < sorted.length; index += 1) {
    const entry = sorted[index]!;
    try {
      validatePath(entry.name);
    } catch {
      schemaError("tree entry name is invalid");
    }
    if (entry.name.includes("/"))
      schemaError("tree entry name must be one segment");
    if (!["file", "executable", "directory", "symlink"].includes(entry.mode)) {
      schemaError("tree entry mode is invalid");
    }
    if (entry.mode === "symlink") validateSymlinkTarget(entry.target);
    else parseArtifactId(entry.target);
    const key = collisionKey(entry.name);
    if (seenCollisionKeys.has(key)) {
      throw new FormatError("path_collision", "tree entry collision");
    }
    seenCollisionKeys.add(key);
    if (
      requireSorted &&
      (entries[index]!.name !== entry.name ||
        entries[index]!.mode !== entry.mode ||
        entries[index]!.target !== entry.target)
    ) {
      schemaError("tree entries are not sorted by UTF-8 name");
    }
  }
  return sorted;
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

export function encodeTree(input: TreeArtifactInput): Uint8Array {
  validateMeta(input, 0);
  const entries = validateTreeEntries(input.entries, false).map(
    (entry) =>
      new Map<string, CborValue>([
        ["name", entry.name],
        ["mode", entry.mode],
        ["target", entry.target],
      ]),
  );
  return encodeCanonical(
    commonEnvelope("tree", input, new Map([["entries", entries]])),
  );
}

export function decodeTree(bytes: Uint8Array): TreeArtifactInput {
  const envelope = asMap(decodeCanonical(bytes), "artifact");
  const meta = decodeMeta(envelope, "tree", 0);
  const payload = asMap(
    envelope.get("payload") ?? schemaError("payload is missing"),
    "payload",
  );
  exactKeys(payload, treePayloadKeys, "tree payload");
  const entriesValue = payload.get("entries");
  if (!Array.isArray(entriesValue))
    schemaError("tree entries must be an array");
  const entries = entriesValue.map((value) => {
    const entry = asMap(value, "tree entry");
    exactKeys(entry, treeEntryKeys, "tree entry");
    const name = entry.get("name");
    const mode = entry.get("mode");
    const target = entry.get("target");
    if (
      typeof name !== "string" ||
      typeof mode !== "string" ||
      typeof target !== "string"
    ) {
      schemaError("tree entry field types are invalid");
    }
    return { name, mode: mode as TreeEntryMode, target };
  });
  validateTreeEntries(entries, true);
  return { ...meta, entries };
}

function validateChange(input: ChangeArtifactInput): void {
  validateMeta(input, 32);
  parseArtifactId(input.root);
  const messageLength = new TextEncoder().encode(input.message).length;
  if (
    messageLength > 4096 ||
    input.message.normalize("NFC") !== input.message
  ) {
    schemaError("change message must be NFC and at most 4096 UTF-8 bytes");
  }
}

export function encodeChange(input: ChangeArtifactInput): Uint8Array {
  validateChange(input);
  return encodeCanonical(
    commonEnvelope(
      "change",
      input,
      new Map<string, CborValue>([
        ["root", input.root],
        ["message", input.message],
      ]),
    ),
  );
}

export function decodeChange(bytes: Uint8Array): ChangeArtifactInput {
  const envelope = asMap(decodeCanonical(bytes), "artifact");
  const meta = decodeMeta(envelope, "change", 32);
  const payload = asMap(
    envelope.get("payload") ?? schemaError("payload is missing"),
    "payload",
  );
  exactKeys(payload, changePayloadKeys, "change payload");
  const root = payload.get("root");
  const message = payload.get("message");
  if (typeof root !== "string" || typeof message !== "string") {
    schemaError("change payload field types are invalid");
  }
  const result = { ...meta, root, message };
  validateChange(result);
  return result;
}

export async function artifactId(canonicalBody: Uint8Array): Promise<string> {
  const body = new ArrayBuffer(canonicalBody.byteLength);
  new Uint8Array(body).set(canonicalBody);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  return formatArtifactId(digest);
}

export async function verifyArtifactId(
  canonicalBody: Uint8Array,
  expectedId: string,
): Promise<void> {
  parseArtifactId(expectedId);
  if ((await artifactId(canonicalBody)) !== expectedId) {
    throw new FormatError(
      "artifact_id_mismatch",
      "artifact ID does not match canonical bytes",
    );
  }
}
