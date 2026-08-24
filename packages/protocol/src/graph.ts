import type { ChangeArtifactInput } from "./artifact.js";
import { FormatError } from "./cbor.js";
import { canReference, type Realm } from "./realm.js";

export type GraphArtifactKind = "tree" | "change";

export interface GraphArtifactSummary {
  project: string;
  realm: Realm;
  kind: GraphArtifactKind;
  actorKey: Uint8Array;
  logicalClock: bigint;
}

export type GraphResolver = (
  artifactId: string,
) => GraphArtifactSummary | undefined;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

function graphError(
  code:
    | "cross_project_reference"
    | "parent_realm_mismatch"
    | "realm_flow_denied"
    | "unknown_required_semantics"
    | "invalid_logical_clock",
  message: string,
): never {
  throw new FormatError(code, message);
}

/** Resolves and validates the graph edges of one schema-0 change. */
export function validateChangeGraph(
  change: ChangeArtifactInput,
  resolve: GraphResolver,
): void {
  const root = resolve(change.root);
  if (root === undefined || root.kind !== "tree") {
    graphError(
      "unknown_required_semantics",
      "root is unavailable or is not a tree",
    );
  }
  if (root.project !== change.project) {
    graphError("cross_project_reference", "root belongs to another project");
  }
  if (!canReference(change.realm, root.realm, "content")) {
    graphError(
      "realm_flow_denied",
      "root realm is not readable from change realm",
    );
  }

  for (const parentId of change.parents) {
    const parent = resolve(parentId);
    if (parent === undefined || parent.kind !== "change") {
      graphError(
        "unknown_required_semantics",
        "parent is unavailable or is not a change",
      );
    }
    if (parent.project !== change.project) {
      graphError(
        "cross_project_reference",
        "parent belongs to another project",
      );
    }
    if (!canReference(change.realm, parent.realm, "parent")) {
      graphError(
        "parent_realm_mismatch",
        "parent realm differs from change realm",
      );
    }
    if (
      sameBytes(parent.actorKey, change.actorKey) &&
      change.logicalClock <= parent.logicalClock
    ) {
      graphError(
        "invalid_logical_clock",
        "logical clock must advance same-actor parents",
      );
    }
  }
}
