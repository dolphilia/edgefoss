import assert from "node:assert/strict";
import test from "node:test";

import { auditWorkerPublicPushOwner } from "./audit-worker-public-push-owner.mjs";

const ORIGIN = "https://edgefoss-staging.miga-and-raia.workers.dev";
const TOKEN = "efoss_owner_v0_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PROJECT_ID = `sha256:${"a".repeat(64)}`;
const HEAD_ID = `sha256:${"b".repeat(64)}`;

test("performs HELLO and one authenticated empty-inventory preflight", async () => {
  const calls = [];
  const result = await auditWorkerPublicPushOwner(
    new URL(ORIGIN),
    TOKEN,
    async (url, init) => {
      calls.push({ init, url: new URL(url) });
      return calls.length === 1 ? helloResponse() : preflightResponse();
    },
  );
  assert.deepEqual(result, {
    acceptedSequence: 4,
    policyEpoch: 0,
    projectId: PROJECT_ID,
    ref: {
      generation: 1,
      name: "heads/main",
      targetArtifactId: HEAD_ID,
    },
    remoteWritePerformed: false,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.pathname, "/api/v0/sync/push/preflight");
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    artifactIds: [],
    blobIds: [],
    projectId: PROJECT_ID,
    protocolVersion: 0,
    realm: "public",
  });
  assert.equal(calls[1].init.headers.authorization, `Bearer ${TOKEN}`);
});

test("rejects an invalid token or target before fetch", async () => {
  for (const [origin, token] of [
    [new URL(ORIGIN), "invalid"],
    [new URL("https://edgefoss.example"), TOKEN],
  ]) {
    await assert.rejects(
      auditWorkerPublicPushOwner(origin, token, async () => {
        throw new Error("fetch must not run");
      }),
      /Worker owner push audit failed/u,
    );
  }
});

test("fails closed on authenticated preflight contract drift", async () => {
  for (const response of [
    jsonResponse({ preflight: { status: "ok" } }),
    preflightResponse({ "cache-control": "public" }),
  ]) {
    let call = 0;
    await assert.rejects(
      auditWorkerPublicPushOwner(new URL(ORIGIN), TOKEN, async () => {
        call += 1;
        return call === 1 ? helloResponse() : response;
      }),
      /Worker owner push audit failed/u,
    );
  }
});

function helloResponse() {
  return jsonResponse({
    hello: {
      capabilities: {
        inventory: {
          cursor: "opaque",
          cursorTtlSeconds: 600,
          maxPageItems: 1_000,
          ordering: "artifact_id_asc",
        },
        phases: ["HELLO", "INVENTORY", "TRANSFER"],
        transfer: {
          grant: "opaque",
          grantTtlSeconds: 600,
          maxArtifactBytes: 2_097_152,
          maxArtifactItems: 16,
          maxBlobChunkBytes: 1_048_576,
          profiles: ["complete"],
        },
      },
      principalId: "anonymous",
      projectId: PROJECT_ID,
      protocolVersion: 0,
      status: "accepted",
      view: { id: "public", realms: ["public"] },
    },
  });
}

function preflightResponse(headers = {}) {
  return jsonResponse(
    {
      preflight: {
        limits: { maxArtifactIds: 256, maxBlobIds: 256 },
        missingArtifactIds: [],
        missingBlobIds: [],
        snapshot: {
          acceptedSequence: 4,
          policyEpoch: 0,
          projectId: PROJECT_ID,
          ref: {
            generation: 1,
            name: "heads/main",
            targetArtifactId: HEAD_ID,
          },
        },
        status: "ok",
      },
    },
    200,
    headers,
  );
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}
