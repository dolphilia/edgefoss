import assert from "node:assert/strict";
import test from "node:test";

import {
  auditWorkerPublicTransfer,
  parseArguments,
} from "./audit-worker-public-transfer.mjs";

const ORIGIN = "https://edgefoss-staging.miga-and-raia.workers.dev";
const PROJECT_ID = `sha256:${"a".repeat(64)}`;

const helloBody = {
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
};

test("accepts only the exact approved staging origin", () => {
  assert.equal(parseArguments(["--origin", ORIGIN]).origin, ORIGIN);
  for (const value of [
    "http://edgefoss-staging.miga-and-raia.workers.dev",
    `${ORIGIN}/path`,
    `${ORIGIN}?query=yes`,
    "https://edgefoss.example",
    "not-a-url",
  ]) {
    assert.throws(() => parseArguments(["--origin", value]), /origin/u);
  }
  assert.throws(() => parseArguments([]), /usage/u);
});

test("audits the expected read-only incompatible staging plan", async () => {
  const calls = [];
  const result = await auditWorkerPublicTransfer(
    new URL(ORIGIN),
    async (url, init) => {
      calls.push({ init, url: new URL(url) });
      if (calls.length === 1) return jsonResponse(helloBody);
      return jsonResponse(
        {
          error: {
            code: "clone_profile_unsupported",
            message: "The public transfer plan is unavailable.",
          },
        },
        409,
      );
    },
  );
  assert.deepEqual(result, {
    artifactReadPerformed: false,
    blobReadPerformed: false,
    planStatus: "clone_profile_unsupported",
    projectId: PROJECT_ID,
    remoteWritePerformed: false,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.pathname, "/api/v0/sync/hello");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(
    calls[1].url.href,
    `${ORIGIN}/api/v0/sync/transfers?profile=complete&project=${encodeURIComponent(PROJECT_ID)}&protocol=0&view=public`,
  );
  assert.deepEqual(Object.keys(calls[1].init).sort(), [
    "method",
    "redirect",
    "signal",
  ]);
  assert.equal(calls[1].init.method, "POST");
});

test("fails closed on response and known-state drift", async () => {
  const cases = [
    jsonResponse({ transfer: { status: "ok" } }),
    jsonResponse(
      {
        error: {
          code: "public_ref_unavailable",
          message: "The public transfer plan is unavailable.",
        },
      },
      409,
    ),
    jsonResponse(
      {
        error: {
          code: "clone_profile_unsupported",
          message: "The public transfer plan is unavailable.",
        },
      },
      409,
      { "cache-control": "public" },
    ),
  ];
  for (const planResponse of cases) {
    let call = 0;
    await assert.rejects(
      auditWorkerPublicTransfer(new URL(ORIGIN), async () => {
        call += 1;
        return call === 1 ? jsonResponse(helloBody) : planResponse;
      }),
      /Worker public transfer audit failed/u,
    );
  }
});

test("rejects an unapproved target before fetch", async () => {
  await assert.rejects(
    auditWorkerPublicTransfer(new URL("https://edgefoss.example"), async () => {
      throw new Error("fetch must not run");
    }),
    /approved staging Worker/u,
  );
});

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
