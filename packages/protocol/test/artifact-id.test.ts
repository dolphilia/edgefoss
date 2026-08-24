import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  formatArtifactId,
  FormatError,
  parseArtifactId,
  verifyArtifactId,
} from "../src/index.js";

interface IdVectors {
  profile: string;
  valid: string[];
  invalid: string[];
  hash_cases: Array<{ name: string; body_hex: string; artifact_id: string }>;
}

const vectorPath = fileURLToPath(
  new URL("../../../spec/vectors/artifact-id-v0.json", import.meta.url),
);
const vectors = JSON.parse(readFileSync(vectorPath, "utf8")) as IdVectors;

describe("artifact ID shared vectors", () => {
  it("uses the expected profile", () => {
    expect(vectors.profile).toBe("edgefossil-artifact-id-v0");
  });

  for (const identifier of vectors.valid) {
    it(`round trips ${identifier.slice(0, 20)}`, () => {
      expect(formatArtifactId(parseArtifactId(identifier))).toBe(identifier);
    });
  }

  for (const identifier of vectors.invalid) {
    it(`rejects ${JSON.stringify(identifier)}`, () => {
      expect(() => parseArtifactId(identifier)).toThrowError(FormatError);
      try {
        parseArtifactId(identifier);
      } catch (error) {
        expect((error as FormatError).code).toBe("invalid_artifact_id");
      }
    });
  }

  it.each(vectors.hash_cases)("verifies hash case $name", async (entry) => {
    const body = Uint8Array.from(
      entry.body_hex.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ??
        [],
    );
    await expect(
      verifyArtifactId(body, entry.artifact_id),
    ).resolves.toBeUndefined();
    await expect(
      verifyArtifactId(body, `sha256:${"0".repeat(64)}`),
    ).rejects.toMatchObject({ code: "artifact_id_mismatch" });
  });
});
