import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computeSemanticRoot,
  FormatError,
  type FormatErrorCode,
  type Realm,
  type SemanticArtifact,
  type SemanticRef,
  type SemanticRootInput,
} from "../src/index.js";

interface Vector {
  project: string;
  artifacts: SemanticArtifact[];
  refs: SemanticRef[];
  expected: Array<{
    realm: Realm;
    artifact_set_root_hex: string;
    descriptor_cbor_hex: string;
    semantic_root: string;
  }>;
  invalid: Array<{
    name: string;
    mutation: string;
    error: FormatErrorCode;
  }>;
}

const vector = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../spec/vectors/semantic-root-v0.json", import.meta.url),
    ),
    "utf8",
  ),
) as Vector;

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

function base(realm: Realm): SemanticRootInput {
  return {
    project: vector.project,
    realm,
    artifacts: structuredClone(vector.artifacts),
    refs: structuredClone(vector.refs),
    policyVersion: 0n,
  };
}

describe("semantic root shared vectors", () => {
  it.each(vector.expected)("matches $realm bytes and roots", async (entry) => {
    const result = await computeSemanticRoot(base(entry.realm));
    expect(hex(result.artifactSetRoot)).toBe(entry.artifact_set_root_hex);
    expect(hex(result.descriptor)).toBe(entry.descriptor_cbor_hex);
    expect(result.semanticRoot).toBe(entry.semantic_root);
  });

  it.each(vector.invalid)("rejects $name", async ({ mutation, error }) => {
    const input = base("public");
    if (mutation === "duplicate_artifact") {
      input.artifacts = [...input.artifacts, input.artifacts[0]!];
    } else if (mutation === "duplicate_ref") {
      input.refs = [...input.refs, input.refs[0]!];
    } else if (mutation === "missing_ref_target") {
      input.refs = [
        {
          ...input.refs[0]!,
          target:
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        },
      ];
    } else if (mutation === "invalid_ref_name") {
      input.refs = [{ ...input.refs[0]!, name: "heads/../main" }];
    } else if (mutation === "invalid_artifact_id") {
      input.artifacts = [{ id: "sha256:bad", realm: "public" }];
      input.refs = [];
    } else if (mutation === "invalid_project_id") {
      input.project = "sha256:bad";
    } else {
      throw new Error(`unknown mutation: ${mutation}`);
    }
    await expect(computeSemanticRoot(input)).rejects.toMatchObject({
      code: error,
    } satisfies Partial<FormatError>);
  });

  it("keeps the public root independent of members-only inputs", async () => {
    const expected = (await computeSemanticRoot(base("public"))).semanticRoot;
    for (let byte = 0; byte < 128; byte += 1) {
      const input = base("public");
      const digest = byte.toString(16).padStart(2, "0").repeat(32);
      input.artifacts = [
        ...[...input.artifacts].reverse(),
        { id: `sha256:${digest}`, realm: "members" },
        { id: "sha256:bad", realm: "members" },
      ];
      input.refs = [
        ...[...input.refs].reverse(),
        { name: "../ignored", target: "sha256:bad", realm: "members" },
      ];
      expect((await computeSemanticRoot(input)).semanticRoot).toBe(expected);
    }
  });
});
