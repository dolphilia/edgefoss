import assert from "node:assert/strict";
import test from "node:test";
import {
  auditWorkerHealth,
  auditWorkerHealthWithRetry,
  parseArguments,
} from "./audit-worker-health.mjs";

const expectedBody = {
  components: {
    repository: { schemaVersion: 1, status: "ok", storage: "sqlite" },
    r2: {
      exports: "bound",
      publicBlobs: "bound",
      restrictedBlobs: "bound",
    },
  },
  edition: "single",
  environment: "staging",
  service: "edgefoss",
  status: "ok",
};

function response(body, init = {}) {
  const text = body === null ? null : JSON.stringify(body);
  return new Response(text, {
    status: 200,
    ...init,
    headers: {
      "cache-control": "no-store",
      "content-length": String(text?.length ?? 0),
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

test("audits the exact GET and HEAD stateful health contract", async () => {
  const methods = [];
  const fetchImplementation = async (url, init) => {
    assert.equal(url.href, "https://edgefoss.example/health");
    methods.push(init.method);
    return init.method === "HEAD" ? response(null) : response(expectedBody);
  };

  assert.deepEqual(
    await auditWorkerHealth(
      new URL("https://edgefoss.example"),
      fetchImplementation,
    ),
    { edition: "single", environment: "staging", schemaVersion: 1 },
  );
  assert.deepEqual(methods, ["GET", "HEAD"]);
});

test("rejects contract, security header, and size drift", async () => {
  const cases = [
    response({ ...expectedBody, environment: "production" }),
    response(expectedBody, { headers: { "cache-control": "public" } }),
    response("x".repeat(4097)),
  ];

  for (const getResponse of cases) {
    await assert.rejects(
      auditWorkerHealth(
        new URL("https://edgefoss.example"),
        async () => getResponse,
      ),
      /Worker health audit failed/u,
    );
  }
});

test("normalizes network failures without exposing response data", async () => {
  await assert.rejects(
    auditWorkerHealth(new URL("https://edgefoss.example"), async () => {
      throw new Error("credential-like-upstream-detail");
    }),
    /GET \/health request failed/u,
  );
});

test("retries a transient post-deploy failure before accepting the exact contract", async () => {
  const responses = [
    response({ error: "temporary" }, { status: 500 }),
    response(expectedBody),
    response(null),
  ];
  const delays = [];
  const reports = [];

  assert.deepEqual(
    await auditWorkerHealthWithRetry(
      new URL("https://edgefoss.example"),
      async () => responses.shift(),
      {
        attempts: 3,
        delayMilliseconds: 25,
        reportRetry: (message) => reports.push(message),
        sleep: async (milliseconds) => delays.push(milliseconds),
      },
    ),
    { edition: "single", environment: "staging", schemaVersion: 1 },
  );
  assert.deepEqual(delays, [25]);
  assert.deepEqual(reports, [
    "Worker health audit attempt 1/3 failed; retrying in 25ms",
  ]);
  assert.equal(responses.length, 0);
});

test("keeps a persistent post-deploy failure fatal after the retry budget", async () => {
  let requests = 0;
  let sleeps = 0;

  await assert.rejects(
    auditWorkerHealthWithRetry(
      new URL("https://edgefoss.example"),
      async () => {
        requests += 1;
        return response({ error: "temporary" }, { status: 500 });
      },
      {
        attempts: 3,
        delayMilliseconds: 0,
        reportRetry: () => {},
        sleep: async () => {
          sleeps += 1;
        },
      },
    ),
    /GET \/health returned 500/u,
  );
  assert.equal(requests, 3);
  assert.equal(sleeps, 2);
});
