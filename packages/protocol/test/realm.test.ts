import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  canReference,
  parseRealm,
  type Realm,
  type ReferenceClass,
} from "../src/index.js";

interface RealmVectors {
  profile: string;
  cases: Array<{
    name: string;
    source: Realm;
    target: Realm;
    class: ReferenceClass;
    allowed: boolean;
  }>;
}

const vectorPath = fileURLToPath(
  new URL("../../../spec/vectors/realm-flow-v0.json", import.meta.url),
);
const vectors = JSON.parse(readFileSync(vectorPath, "utf8")) as RealmVectors;

describe("realm flow v0 shared vectors", () => {
  it("uses the expected profile", () => {
    expect(vectors.profile).toBe("edgefossil-realm-v0");
  });

  for (const vector of vectors.cases) {
    it(vector.name, () => {
      expect(canReference(vector.source, vector.target, vector.class)).toBe(
        vector.allowed,
      );
    });
  }

  it("rejects unknown realm names", () => {
    expect(parseRealm("maintainers")).toBeUndefined();
  });
});
