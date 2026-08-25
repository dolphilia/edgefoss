import {
  artifactId,
  decodeCanonical,
  decodeChange,
  decodeProjectGenesis,
  decodeSignatureRecord,
  decodeTree,
  MAX_ARTIFACT_BYTES,
  verifyArtifactSignature,
} from "@edgefoss/protocol";

export type PublishArtifactKind = "project.genesis" | "tree" | "change";
export type PublishEdgeKind = "blob" | "parent" | "tree";

export interface PublishRefInput {
  expectedGeneration: number;
  name: "heads/main";
}

export interface PublishArtifactInput {
  artifactBytes: ArrayBuffer;
  artifactId: string;
  expectedPolicyEpoch: number;
  operationId: string;
  principalId: string;
  ref: PublishRefInput | null;
  signatureBytes: ArrayBuffer;
}

export interface PreparedPublishArtifact {
  actorKey: ArrayBuffer;
  artifactBytes: ArrayBuffer;
  artifactId: string;
  createdAt: string;
  edges: Array<{ kind: PublishEdgeKind; targetId: string }>;
  expectedPolicyEpoch: number;
  kind: PublishArtifactKind;
  logicalClock: string;
  operationId: string;
  principalId: string;
  projectId: string;
  realm: "public" | "members";
  ref: PublishRefInput | null;
  requestHash: string;
  signature: ArrayBuffer;
}

export async function preparePublishArtifact(
  input: PublishArtifactInput,
): Promise<PreparedPublishArtifact> {
  validateTransport(input);
  const bytes = new Uint8Array(input.artifactBytes);
  if ((await artifactId(bytes)) !== input.artifactId) {
    throw new Error("artifact_id_mismatch");
  }

  const envelope = decodeCanonical(bytes);
  if (!(envelope instanceof Map) || typeof envelope.get("kind") !== "string") {
    throw new Error("artifact_schema_invalid");
  }

  const kind = envelope.get("kind");
  let prepared: Omit<
    PreparedPublishArtifact,
    | "artifactBytes"
    | "artifactId"
    | "expectedPolicyEpoch"
    | "operationId"
    | "principalId"
    | "requestHash"
    | "signature"
  >;
  if (kind === "project.genesis") {
    const genesis = decodeProjectGenesis(bytes);
    if (input.ref !== null) throw new Error("artifact_ref_invalid");
    prepared = {
      actorKey: copyBuffer(genesis.actorKey),
      createdAt: genesis.createdAt,
      edges: [],
      kind,
      logicalClock: "0",
      projectId: input.artifactId,
      realm: "public",
      ref: null,
    };
  } else if (kind === "tree") {
    const tree = decodeTree(bytes);
    const realm = cloudRealm(tree.realm);
    if (input.ref !== null) throw new Error("artifact_ref_invalid");
    prepared = {
      actorKey: copyBuffer(tree.actorKey),
      createdAt: tree.createdAt,
      edges: tree.entries.flatMap((entry) => {
        if (entry.mode === "symlink") return [];
        return [
          {
            kind: entry.mode === "directory" ? "tree" : "blob",
            targetId: entry.target,
          } satisfies { kind: PublishEdgeKind; targetId: string },
        ];
      }),
      kind,
      logicalClock: tree.logicalClock.toString(),
      projectId: tree.project,
      realm,
      ref: null,
    };
  } else if (kind === "change") {
    const change = decodeChange(bytes);
    const realm = cloudRealm(change.realm);
    if (input.ref === null || input.ref.name !== "heads/main") {
      throw new Error("artifact_ref_invalid");
    }
    prepared = {
      actorKey: copyBuffer(change.actorKey),
      createdAt: change.createdAt,
      edges: [
        { kind: "tree", targetId: change.root },
        ...change.parents.map((targetId) => ({
          kind: "parent" as const,
          targetId,
        })),
      ],
      kind,
      logicalClock: change.logicalClock.toString(),
      projectId: change.project,
      realm,
      ref: input.ref,
    };
  } else {
    throw new Error("artifact_kind_unsupported");
  }

  const signatureRecord = decodeSignatureRecord(
    new Uint8Array(input.signatureBytes),
  );
  await verifyArtifactSignature(
    signatureRecord,
    input.artifactId,
    new Uint8Array(prepared.actorKey),
  );
  const signatureHash = await sha256(input.signatureBytes);
  const requestHash = await sha256(
    new TextEncoder().encode(
      JSON.stringify({
        artifactId: input.artifactId,
        expectedPolicyEpoch: input.expectedPolicyEpoch,
        principalId: input.principalId,
        ref: input.ref,
        signatureHash,
      }),
    ),
  );

  return {
    ...prepared,
    artifactBytes: copyBuffer(bytes),
    artifactId: input.artifactId,
    expectedPolicyEpoch: input.expectedPolicyEpoch,
    operationId: input.operationId,
    principalId: input.principalId,
    requestHash,
    signature: copyBuffer(signatureRecord.signature),
  };
}

function validateTransport(input: PublishArtifactInput): void {
  if (
    input === null ||
    typeof input !== "object" ||
    !(input.artifactBytes instanceof ArrayBuffer) ||
    typeof input.artifactId !== "string" ||
    typeof input.operationId !== "string" ||
    typeof input.principalId !== "string" ||
    !(input.signatureBytes instanceof ArrayBuffer) ||
    input.artifactBytes.byteLength === 0 ||
    input.artifactBytes.byteLength > MAX_ARTIFACT_BYTES ||
    input.signatureBytes.byteLength === 0 ||
    input.signatureBytes.byteLength > 1024 ||
    !Number.isSafeInteger(input.expectedPolicyEpoch) ||
    input.expectedPolicyEpoch < 0
  ) {
    throw new Error("artifact_transport_invalid");
  }
  if (
    input.ref !== null &&
    (typeof input.ref !== "object" ||
      input.ref.name !== "heads/main" ||
      !Number.isSafeInteger(input.ref.expectedGeneration) ||
      input.ref.expectedGeneration < 0)
  ) {
    throw new Error("artifact_ref_invalid");
  }
}

function cloudRealm(realm: string): "public" | "members" {
  if (realm !== "public" && realm !== "members") {
    throw new Error("artifact_realm_invalid");
  }
  return realm;
}

function copyBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const result = new ArrayBuffer(source.byteLength);
  new Uint8Array(result).set(source);
  return result;
}

async function sha256(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", copyBuffer(bytes));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
