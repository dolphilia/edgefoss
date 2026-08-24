import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  FormatError,
  validateChangeGraph,
  type GraphArtifactKind,
  type GraphArtifactSummary,
  type Realm,
} from "../src/index.js";

interface Relation {
  project: "same" | "other";
  realm: Realm;
  kind: GraphArtifactKind;
}

interface GraphCase {
  name: string;
  change_realm: Realm;
  clock?: number;
  root: Relation & { present: boolean };
  parent?: Relation & { actor: "same" | "other"; clock: number };
  allowed?: boolean;
  error?: string;
}

interface GraphVectors {
  profile: string;
  project: string;
  other_project: string;
  root_id: string;
  parent_id: string;
  actor_key_hex: string;
  other_actor_key_hex: string;
  cases: GraphCase[];
}

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(
    hex.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
}

const vectorPath = fileURLToPath(
  new URL("../../../spec/vectors/change-graph-v0.json", import.meta.url),
);
const vectors = JSON.parse(readFileSync(vectorPath, "utf8")) as GraphVectors;

function project(relation: "same" | "other"): string {
  return relation === "same" ? vectors.project : vectors.other_project;
}

describe("change graph shared vectors", () => {
  it("uses the expected profile", () => {
    expect(vectors.profile).toBe("edgefossil-change-graph-v0");
  });

  for (const vector of vectors.cases) {
    it(vector.name, () => {
      const actorKey = bytes(vectors.actor_key_hex);
      const summaries = new Map<string, GraphArtifactSummary>();
      if (vector.root.present) {
        summaries.set(vectors.root_id, {
          project: project(vector.root.project),
          realm: vector.root.realm,
          kind: vector.root.kind,
          actorKey,
          logicalClock: 0n,
        });
      }
      if (vector.parent !== undefined) {
        summaries.set(vectors.parent_id, {
          project: project(vector.parent.project),
          realm: vector.parent.realm,
          kind: vector.parent.kind,
          actorKey:
            vector.parent.actor === "same"
              ? actorKey
              : bytes(vectors.other_actor_key_hex),
          logicalClock: BigInt(vector.parent.clock),
        });
      }
      const change = {
        project: vectors.project,
        realm: vector.change_realm,
        parents: vector.parent === undefined ? [] : [vectors.parent_id],
        actorKey,
        logicalClock: BigInt(vector.clock ?? 0),
        createdAt: "2026-08-24T00:03:00Z",
        root: vectors.root_id,
        message: "graph vector",
      };
      try {
        validateChangeGraph(change, (id) => summaries.get(id));
        expect(vector.allowed).toBe(true);
      } catch (error) {
        expect(error).toBeInstanceOf(FormatError);
        expect((error as FormatError).code).toBe(vector.error);
      }
    });
  }
});
