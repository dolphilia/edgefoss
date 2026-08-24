import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  artifactId,
  decodeChange,
  decodeTree,
  encodeChange,
  encodeTree,
  FormatError,
  type TreeEntry,
} from "../src/index.js";

interface ArtifactVector {
  profile: string;
  project: string;
  actor_key_hex: string;
  tree: {
    realm: "public";
    logical_clock: number;
    created_at: string;
    entries: TreeEntry[];
    canonical_cbor_hex: string;
    artifact_id: string;
  };
  change: {
    realm: "public";
    logical_clock: number;
    created_at: string;
    root: string;
    message: string;
    canonical_cbor_hex: string;
    artifact_id: string;
  };
  invalid_trees: Array<{
    name: string;
    entries: TreeEntry[];
    error: string;
  }>;
  invalid_changes: Array<{
    name: string;
    root: string;
    message: string;
    error: string;
  }>;
}

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(
    hex.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const shared = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

const vectorPath = fileURLToPath(
  new URL("../../../spec/vectors/tree-change-v0.json", import.meta.url),
);
const vectors = JSON.parse(readFileSync(vectorPath, "utf8")) as ArtifactVector;
const actorKey = bytes(vectors.actor_key_hex);

describe("tree/change shared vectors", () => {
  it("encodes, hashes, and decodes tree schema 0", async () => {
    const input = {
      project: vectors.project,
      realm: vectors.tree.realm,
      parents: [],
      actorKey,
      logicalClock: BigInt(vectors.tree.logical_clock),
      createdAt: vectors.tree.created_at,
      entries: vectors.tree.entries,
    };
    const encoded = encodeTree(input);
    expect(hex(encoded)).toBe(vectors.tree.canonical_cbor_hex);
    expect(await artifactId(encoded)).toBe(vectors.tree.artifact_id);
    expect(decodeTree(encoded)).toEqual({
      ...input,
      entries: [...input.entries].sort((left, right) =>
        compareUtf8(left.name, right.name),
      ),
    });
  });

  it("encodes, hashes, and decodes change schema 0", async () => {
    const input = {
      project: vectors.project,
      realm: vectors.change.realm,
      parents: [],
      actorKey,
      logicalClock: BigInt(vectors.change.logical_clock),
      createdAt: vectors.change.created_at,
      root: vectors.change.root,
      message: vectors.change.message,
    };
    const encoded = encodeChange(input);
    expect(hex(encoded)).toBe(vectors.change.canonical_cbor_hex);
    expect(await artifactId(encoded)).toBe(vectors.change.artifact_id);
    expect(decodeChange(encoded)).toEqual(input);
  });

  for (const vector of vectors.invalid_trees) {
    it(`rejects tree ${vector.name}`, () => {
      try {
        encodeTree({
          project: vectors.project,
          realm: "public",
          parents: [],
          actorKey,
          logicalClock: 1n,
          createdAt: vectors.tree.created_at,
          entries: vector.entries,
        });
        expect.fail("invalid tree was accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(FormatError);
        expect((error as FormatError).code).toBe(vector.error);
      }
    });
  }

  for (const vector of vectors.invalid_changes) {
    it(`rejects change ${vector.name}`, () => {
      try {
        encodeChange({
          project: vectors.project,
          realm: "public",
          parents: [],
          actorKey,
          logicalClock: 2n,
          createdAt: vectors.change.created_at,
          root: vector.root,
          message: vector.message,
        });
        expect.fail("invalid change was accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(FormatError);
        expect((error as FormatError).code).toBe(vector.error);
      }
    });
  }
});
