import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decodeBundleManifest,
  encodeBundleManifest,
  verifyBundleManifest,
  verifyBundleObjects,
  type BundleManifest,
  type Realm,
} from "../src/index.js";

interface Vector {
  manifest: {
    project: string;
    realm: Realm;
    policy_version: number;
    semantic_root: string;
    artifacts: string[];
    blobs: string[];
    signatures: string[];
    refs: Record<string, string>;
    base_roots: Partial<Record<Realm, string>>;
  };
  manifest_cbor_hex: string;
  files: Record<string, string>;
  invalid: Array<{ mutation: string; error: string }>;
}

const vector = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../spec/vectors/bundle-v0.json", import.meta.url),
    ),
    "utf8",
  ),
) as Vector;

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(
    hex.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function manifest(): BundleManifest {
  return {
    project: vector.manifest.project,
    realm: vector.manifest.realm,
    policyVersion: BigInt(vector.manifest.policy_version),
    semanticRoot: vector.manifest.semantic_root,
    artifacts: [...vector.manifest.artifacts],
    blobs: [...vector.manifest.blobs],
    signatures: [...vector.manifest.signatures],
    refs: new Map(Object.entries(vector.manifest.refs)),
    baseRoots: new Map(
      Object.entries(vector.manifest.base_roots) as Array<[Realm, string]>,
    ),
  };
}

function files(): Map<string, Uint8Array> {
  return new Map(
    Object.entries(vector.files).map(([path, body]) => [path, bytes(body)]),
  );
}

describe("experimental bundle shared vector", () => {
  it("encodes, decodes, and verifies the exact manifest", async () => {
    const expected = manifest();
    const encoded = await encodeBundleManifest(expected);
    expect(hex(encoded)).toBe(vector.manifest_cbor_hex);
    expect(decodeBundleManifest(encoded)).toEqual(expected);
    await expect(verifyBundleManifest(expected)).resolves.toBeUndefined();
    await expect(
      verifyBundleObjects(expected, files()),
    ).resolves.toBeUndefined();
  });

  it.each(vector.invalid)("rejects $mutation", async ({ mutation, error }) => {
    const candidate = manifest();
    const objects = files();
    let operation: Promise<void>;
    if (mutation === "missing_object") {
      objects.clear();
      operation = verifyBundleObjects(candidate, objects);
    } else if (mutation === "unexpected_object") {
      objects.set("extra", new Uint8Array());
      operation = verifyBundleObjects(candidate, objects);
    } else if (mutation === "object_mismatch") {
      const body = objects.values().next().value!;
      body[0] = body[0]! ^ 1;
      operation = verifyBundleObjects(candidate, objects);
    } else if (mutation === "semantic_root") {
      candidate.semanticRoot = `sha256:${"0".repeat(64)}`;
      operation = verifyBundleManifest(candidate);
    } else if (mutation === "public_base_root") {
      candidate.baseRoots = new Map([["public", `sha256:${"0".repeat(64)}`]]);
      operation = verifyBundleManifest(candidate);
    } else {
      throw new Error(`unknown mutation: ${mutation}`);
    }
    await expect(operation).rejects.toMatchObject({ code: error });
  });
});
