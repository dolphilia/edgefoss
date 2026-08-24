import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PathError, validatePath } from "../src/index.js";

type PathInput = string | { repeat: string; count: number };

interface PathVectors {
  profile: string;
  valid: PathInput[];
  invalid: Array<{ name: string; path: PathInput; error: string }>;
}

function expand(input: PathInput): string {
  return typeof input === "string" ? input : input.repeat.repeat(input.count);
}

const vectorPath = fileURLToPath(
  new URL("../../../spec/vectors/path-v0.json", import.meta.url),
);
const vectors = JSON.parse(readFileSync(vectorPath, "utf8")) as PathVectors;

describe("path v0 shared vectors", () => {
  it("uses the expected profile", () => {
    expect(vectors.profile).toBe("edgefossil-path-v0");
  });

  for (const input of vectors.valid) {
    const path = expand(input);
    it(`accepts ${typeof input === "string" ? input : `repeat-${input.count}`}`, () => {
      expect(() => validatePath(path)).not.toThrow();
    });
  }

  for (const vector of vectors.invalid) {
    it(`rejects ${vector.name}`, () => {
      try {
        validatePath(expand(vector.path));
        expect.fail("invalid path was accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(PathError);
        expect((error as PathError).code).toBe(vector.error);
      }
    });
  }
});
