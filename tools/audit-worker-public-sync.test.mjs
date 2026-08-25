import assert from "node:assert/strict";
import test from "node:test";

import {
  auditWorkerPublicSync,
  parseArguments,
} from "./audit-worker-public-sync.mjs";

const expectedBody = {
  hello: {
    capabilities: {
      inventory: {
        cursor: "opaque",
        cursorTtlSeconds: 600,
        maxPageItems: 1_000,
        ordering: "artifact_id_asc",
      },
      phases: ["HELLO", "INVENTORY"],
    },
    principalId: "anonymous",
    projectId: `sha256:${"a".repeat(64)}`,
    protocolVersion: 0,
    status: "accepted",
    view: { id: "public", realms: ["public"] },
  },
};

function response(body, init = {}) {
  const text = JSON.stringify(body);
  return new Response(text, {
    status: 200,
    ...init,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...init.headers,
    },
  });
}

test("accepts only a credential-free HTTPS origin", () => {
  assert.equal(
    parseArguments(["--origin", "https://edgefoss.example"]).origin,
    "https://edgefoss.example",
  );
  for (const value of [
    "http://edgefoss.example",
    "https://user@edgefoss.example",
    "https://edgefoss.example/path",
    "https://edgefoss.example/?query=yes",
    "not-a-url",
  ]) {
    assert.throws(() => parseArguments(["--origin", value]), /origin/u);
  }
  assert.throws(() => parseArguments([]), /usage/u);
});

test("audits only the exact anonymous HELLO contract", async () => {
  let requests = 0;
  const result = await auditWorkerPublicSync(
    new URL("https://edgefoss.example"),
    async (url, init) => {
      requests += 1;
      assert.equal(
        url.href,
        "https://edgefoss.example/api/v0/sync/hello?protocol=0&view=public",
      );
      assert.equal(init.method, "GET");
      assert.equal("headers" in init, false);
      return response(expectedBody);
    },
  );
  assert.deepEqual(result, {
    cursorTtlSeconds: 600,
    maxPageItems: 1_000,
    projectId: `sha256:${"a".repeat(64)}`,
    protocolVersion: 0,
    view: "public",
  });
  assert.equal(requests, 1);
});

test("rejects contract, security-header, authentication, and size drift", async () => {
  const cases = [
    response({ ...expectedBody, extra: true }),
    response(expectedBody, { headers: { "cache-control": "public" } }),
    response(expectedBody, {
      headers: { "www-authenticate": 'Bearer realm="edgefoss"' },
    }),
    response("x".repeat(4_097)),
  ];

  for (const getResponse of cases) {
    await assert.rejects(
      auditWorkerPublicSync(
        new URL("https://edgefoss.example"),
        async () => getResponse,
      ),
      /Worker public sync audit failed/u,
    );
  }
});

test("normalizes network failures without exposing upstream detail", async () => {
  await assert.rejects(
    auditWorkerPublicSync(new URL("https://edgefoss.example"), async () => {
      throw new Error("credential-like-upstream-detail");
    }),
    /GET \/api\/v0\/sync\/hello request failed/u,
  );
});
