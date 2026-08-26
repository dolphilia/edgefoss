import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import rawVector from "../../../spec/vectors/public-clone-v0.json";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const ENDPOINT = "https://edgefoss.test/api/v0/sync/push/preflight";
const OWNER_TOKEN =
  "efoss_owner_v0_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PROJECT_ID = `sha256:${"1".repeat(64)}`;
const ARTIFACT_ID = `sha256:${"2".repeat(64)}`;
const BLOB_ID = `sha256:${"3".repeat(64)}`;

interface PlanStep {
  artifact_id: string;
  artifact_path: string;
  expected_policy_epoch: number;
  operation_id: string;
  ref: { expected_generation: number; name: "heads/main" } | null;
  signature_path: string;
}

interface PushVector {
  files: Record<string, string>;
  fresh_push_plan: {
    artifacts: PlanStep[];
    blobs: Array<{
      blob_id: string;
      byte_size: number;
      object_path: string;
      operation_id: string;
    }>;
    snapshot: {
      missing_artifact_ids: string[];
      missing_blob_ids: string[];
    };
  };
  incremental_push: {
    files: Record<string, string>;
    head_artifact_id: string;
    plan: {
      artifacts: PlanStep[];
      snapshot: {
        missing_artifact_ids: string[];
        missing_blob_ids: string[];
      };
    };
  };
  project_id: string;
}

const vector = rawVector as PushVector;

function request(
  body: BodyInit | null,
  options: {
    authorized?: boolean;
    headers?: HeadersInit;
    method?: string;
  } = {},
): Request {
  const headers = new Headers(options.headers);
  if (options.authorized) {
    headers.set("authorization", `Bearer ${OWNER_TOKEN}`);
  }
  return new IncomingRequest(ENDPOINT, {
    body,
    headers,
    method: options.method ?? "POST",
  });
}

async function fetch(request: Request): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(request, env, context);
  await waitOnExecutionContext(context);
  return response;
}

function authorizedRequest(
  url: string,
  body: BodyInit | null,
  method = "POST",
  contentType = "application/json",
): Request {
  return new IncomingRequest(url, {
    body,
    headers: {
      authorization: `Bearer ${OWNER_TOKEN}`,
      "content-type": contentType,
    },
    method,
  });
}

function bytes(path: string, files: Record<string, string>): Uint8Array {
  const hex = files[path];
  if (hex === undefined || hex.length % 2 !== 0) {
    throw new Error(`invalid vector object ${path}`);
  }
  return Uint8Array.from(
    hex.match(/../gu)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function planDeclaration(
  artifactIds: string[],
  blobIds: string[],
  projectId = vector.project_id,
): string {
  return JSON.stringify({
    artifactIds,
    blobIds,
    projectId,
    protocolVersion: 0,
    realm: "public",
  });
}

async function publishStep(
  step: PlanStep,
  files: Record<string, string>,
): Promise<unknown> {
  const body = JSON.stringify({
    artifactBytes: base64Url(bytes(step.artifact_path, files)),
    artifactId: step.artifact_id,
    expectedPolicyEpoch: step.expected_policy_epoch,
    operationId: step.operation_id,
    ref:
      step.ref === null
        ? null
        : {
            expectedGeneration: step.ref.expected_generation,
            name: step.ref.name,
          },
    signatureBytes: base64Url(bytes(step.signature_path, files)),
  });
  const first = await fetch(
    authorizedRequest("https://edgefoss.test/api/v0/artifacts", body),
  );
  expect(first.status).toBe(200);
  const result: unknown = await first.json();
  const retry = await fetch(
    authorizedRequest("https://edgefoss.test/api/v0/artifacts", body),
  );
  expect(retry.status).toBe(200);
  await expect(retry.json()).resolves.toEqual(result);
  return result;
}

function declaration(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    artifactIds: [ARTIFACT_ID],
    blobIds: [BLOB_ID],
    projectId: PROJECT_ID,
    protocolVersion: 0,
    realm: "public",
    ...overrides,
  });
}

describe("authenticated public push preflight adapter", () => {
  it("authenticates before body parsing and exposes no snapshot", async () => {
    const response = await fetch(request("not json"));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer realm="edgefoss"',
    );
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "unauthorized",
        message: "A valid owner bearer token is required.",
      },
    });
  });

  it("returns one bounded fresh authority snapshot without mutation", async () => {
    const response = await fetch(
      request(declaration(), {
        authorized: true,
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      preflight: {
        limits: { maxArtifactIds: 256, maxBlobIds: 256 },
        missingArtifactIds: [ARTIFACT_ID],
        missingBlobIds: [BLOB_ID],
        snapshot: {
          acceptedSequence: 0,
          policyEpoch: 0,
          projectId: null,
          ref: null,
        },
        status: "ok",
      },
    });
  });

  it("rejects methods, media types, oversized bodies, and noncanonical input", async () => {
    const wrongMethod = await fetch(
      request(null, { authorized: true, method: "GET" }),
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");

    const wrongMediaType = await fetch(
      request(declaration(), {
        authorized: true,
        headers: { "content-type": "text/plain" },
      }),
    );
    expect(wrongMediaType.status).toBe(415);

    const oversized = await fetch(
      request("{}", {
        authorized: true,
        headers: {
          "content-length": String(64 * 1024 + 1),
          "content-type": "application/json",
        },
      }),
    );
    expect(oversized.status).toBe(413);

    const unsorted = await fetch(
      request(declaration({ artifactIds: [ARTIFACT_ID, PROJECT_ID] }), {
        authorized: true,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(unsorted.status).toBe(400);
    await expect(unsorted.json()).resolves.toMatchObject({
      error: { code: "push_preflight_invalid" },
    });

    const tooMany = await fetch(
      request(
        declaration({
          artifactIds: Array.from(
            { length: 257 },
            (_, index) => `sha256:${index.toString(16).padStart(64, "0")}`,
          ),
        }),
        {
          authorized: true,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    expect(tooMany.status).toBe(400);

    const extraKey = await fetch(
      request(declaration({ unexpected: true }), {
        authorized: true,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(extraKey.status).toBe(400);
  });

  it("executes fresh and incremental deterministic plans through bounded HTTP APIs", async () => {
    const fresh = vector.fresh_push_plan;
    const freshPreflight = await fetch(
      authorizedRequest(
        ENDPOINT,
        planDeclaration(
          fresh.snapshot.missing_artifact_ids,
          fresh.snapshot.missing_blob_ids,
        ),
      ),
    );
    expect(freshPreflight.status).toBe(200);
    await expect(freshPreflight.json()).resolves.toMatchObject({
      preflight: {
        missingArtifactIds: fresh.snapshot.missing_artifact_ids,
        missingBlobIds: fresh.snapshot.missing_blob_ids,
        snapshot: { acceptedSequence: 0, projectId: null, ref: null },
        status: "ok",
      },
    });

    for (const step of fresh.blobs) {
      const declarationBody = JSON.stringify({
        blobId: step.blob_id,
        byteSize: step.byte_size,
        operationId: step.operation_id,
        realm: "public",
      });
      const first = await fetch(
        authorizedRequest(
          "https://edgefoss.test/api/v0/uploads",
          declarationBody,
        ),
      );
      expect(first.status).toBe(200);
      const declared = await first.json<{ upload: { uploadId: string } }>();
      const declarationRetry = await fetch(
        authorizedRequest(
          "https://edgefoss.test/api/v0/uploads",
          declarationBody,
        ),
      );
      await expect(declarationRetry.json()).resolves.toEqual(declared);

      const content = await fetch(
        authorizedRequest(
          `https://edgefoss.test/api/v0/uploads/${declared.upload.uploadId}/content`,
          bytes(step.object_path, vector.files),
          "PUT",
          "application/octet-stream",
        ),
      );
      expect(content.status).toBe(200);
      const finalizeUrl = `https://edgefoss.test/api/v0/uploads/${declared.upload.uploadId}/finalize`;
      const finalized = await fetch(authorizedRequest(finalizeUrl, null)).then(
        (response) => response.json(),
      );
      const finalizeRetry = await fetch(authorizedRequest(finalizeUrl, null));
      await expect(finalizeRetry.json()).resolves.toEqual(finalized);
    }

    for (const step of fresh.artifacts) {
      await publishStep(step, vector.files);
    }

    const incremental = vector.incremental_push;
    const incrementalPreflight = await fetch(
      authorizedRequest(
        ENDPOINT,
        planDeclaration(
          incremental.plan.snapshot.missing_artifact_ids,
          incremental.plan.snapshot.missing_blob_ids,
        ),
      ),
    );
    expect(incrementalPreflight.status).toBe(200);
    await expect(incrementalPreflight.json()).resolves.toMatchObject({
      preflight: {
        missingArtifactIds: incremental.plan.snapshot.missing_artifact_ids,
        missingBlobIds: [],
        snapshot: {
          acceptedSequence: 3,
          projectId: vector.project_id,
          ref: { generation: 1 },
        },
        status: "ok",
      },
    });

    for (const step of incremental.plan.artifacts) {
      await publishStep(step, incremental.files);
    }

    const converged = await fetch(
      authorizedRequest(
        ENDPOINT,
        planDeclaration(
          incremental.plan.snapshot.missing_artifact_ids,
          incremental.plan.snapshot.missing_blob_ids,
        ),
      ),
    );
    expect(converged.status).toBe(200);
    await expect(converged.json()).resolves.toMatchObject({
      preflight: {
        missingArtifactIds: [],
        missingBlobIds: [],
        snapshot: {
          acceptedSequence: 4,
          projectId: vector.project_id,
          ref: {
            generation: 2,
            targetArtifactId: incremental.head_artifact_id,
          },
        },
        status: "ok",
      },
    });

    const conflict = await fetch(
      authorizedRequest(
        ENDPOINT,
        planDeclaration([], [], `sha256:${"f".repeat(64)}`),
      ),
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      preflight: { code: "project_conflict", status: "rejected" },
    });
  });
});
