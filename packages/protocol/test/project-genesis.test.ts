import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  artifactId,
  decodeProjectGenesis,
  encodeProjectGenesis,
  FormatError,
} from "../src/index.js";

interface VectorFile {
  profile: string;
  valid: Array<{
    name: string;
    input: {
      project_name: string;
      nonce_hex: string;
      actor_key_hex: string;
      created_at: string;
    };
    canonical_cbor_hex: string;
    artifact_id: string;
  }>;
  invalid: Array<{
    name: string;
    cbor_hex: string;
    error: string;
  }>;
}

function bytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex))
    throw new Error("invalid fixture hex");
  return Uint8Array.from(
    hex.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const vectorPath = fileURLToPath(
  new URL("../../../spec/vectors/project-genesis-v0.json", import.meta.url),
);
const vectors = JSON.parse(readFileSync(vectorPath, "utf8")) as VectorFile;

describe("project.genesis shared vectors", () => {
  it("uses the expected profile", () => {
    expect(vectors.profile).toBe("edgefossil-artifact-v0");
  });

  for (const vector of vectors.valid) {
    it(`encodes, hashes, and decodes ${vector.name}`, async () => {
      const input = {
        name: vector.input.project_name,
        nonce: bytes(vector.input.nonce_hex),
        actorKey: bytes(vector.input.actor_key_hex),
        createdAt: vector.input.created_at,
      };
      const encoded = encodeProjectGenesis(input);
      expect(hex(encoded)).toBe(vector.canonical_cbor_hex);
      expect(await artifactId(encoded)).toBe(vector.artifact_id);
      expect(decodeProjectGenesis(encoded)).toEqual(input);
    });
  }

  for (const vector of vectors.invalid) {
    it(`rejects ${vector.name}`, () => {
      try {
        decodeProjectGenesis(bytes(vector.cbor_hex));
        expect.fail("invalid vector was accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(FormatError);
        expect((error as FormatError).code).toBe(vector.error);
      }
    });
  }
});
