import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  artifactSignatureMessage,
  decodeSignatureRecord,
  encodeSignatureRecord,
  verifyArtifactSignature,
} from "../src/index.js";

interface SignatureVector {
  profile: string;
  artifact: string;
  actor_key_hex: string;
  message_hex: string;
  signature_hex: string;
  record_cbor_hex: string;
}

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(
    hex.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const vectorPath = fileURLToPath(
  new URL("../../../spec/vectors/signature-v0.json", import.meta.url),
);
const vector = JSON.parse(readFileSync(vectorPath, "utf8")) as SignatureVector;

describe("detached signature shared vector", () => {
  const record = {
    artifact: vector.artifact,
    actorKey: bytes(vector.actor_key_hex),
    signature: bytes(vector.signature_hex),
  };

  it("constructs the domain-separated message", () => {
    expect(hex(artifactSignatureMessage(vector.artifact))).toBe(
      vector.message_hex,
    );
  });

  it("encodes and decodes the canonical record", () => {
    const encoded = encodeSignatureRecord(record);
    expect(hex(encoded)).toBe(vector.record_cbor_hex);
    expect(decodeSignatureRecord(encoded)).toEqual(record);
  });

  it("verifies Ed25519 with a raw public key", async () => {
    await expect(
      verifyArtifactSignature(record, record.artifact, record.actorKey),
    ).resolves.toBeUndefined();
  });

  it("rejects a modified signature", async () => {
    const signature = record.signature.slice();
    signature[0] = signature[0]! ^ 1;
    await expect(
      verifyArtifactSignature(
        { ...record, signature },
        record.artifact,
        record.actorKey,
      ),
    ).rejects.toMatchObject({
      code: "invalid_signature",
    });
  });

  it("rejects an actor-key binding mismatch", async () => {
    const expectedActorKey = record.actorKey.slice();
    expectedActorKey[0] = expectedActorKey[0]! ^ 1;
    await expect(
      verifyArtifactSignature(record, record.artifact, expectedActorKey),
    ).rejects.toMatchObject({
      code: "invalid_signature",
    });
  });

  it("rejects an artifact binding mismatch", async () => {
    const other = `sha256:${"0".repeat(64)}`;
    await expect(
      verifyArtifactSignature(record, other, record.actorKey),
    ).rejects.toMatchObject({
      code: "invalid_signature",
    });
  });
});
