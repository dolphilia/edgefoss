import assert from "node:assert/strict";
import test from "node:test";

import {
  auditWorkerPublicPush,
  parseArguments,
} from "./audit-worker-public-push.mjs";

const ORIGIN = "https://edgefoss-staging.miga-and-raia.workers.dev";

test("accepts only the exact approved staging origin", () => {
  assert.equal(parseArguments(["--origin", ORIGIN]).origin, ORIGIN);
  assert.equal(parseArguments(["--", "--origin", ORIGIN]).origin, ORIGIN);
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
  assert.throws(
    () => parseArguments(["--", "--", "--origin", ORIGIN]),
    /usage/u,
  );
  assert.throws(
    () => parseArguments(["--", "--origin", ORIGIN, "extra"]),
    /usage/u,
  );
});

test("audits only the unauthenticated owner boundary", async () => {
  const calls = [];
  const result = await auditWorkerPublicPush(
    new URL(ORIGIN),
    async (url, init) => {
      calls.push({ init, url: new URL(url) });
      return jsonResponse(
        {
          error: {
            code: "unauthorized",
            message: "A valid owner bearer token is required.",
          },
        },
        401,
        { "www-authenticate": 'Bearer realm="edgefoss"' },
      );
    },
  );
  assert.deepEqual(result, {
    authenticatedPreflightPerformed: false,
    remoteWritePerformed: false,
    status: "owner_auth_required",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/api/v0/sync/push/preflight");
  assert.equal(calls[0].init.body, "not json");
  assert.equal(calls[0].init.headers.authorization, undefined);
  assert.equal(calls[0].init.method, "POST");
});

test("fails closed on response drift and rejects unapproved targets", async () => {
  for (const response of [
    jsonResponse({ preflight: { status: "ok" } }),
    jsonResponse({ error: { code: "unauthorized", message: "wrong" } }, 401, {
      "www-authenticate": 'Bearer realm="edgefoss"',
    }),
    jsonResponse(
      {
        error: {
          code: "unauthorized",
          message: "A valid owner bearer token is required.",
        },
      },
      401,
      {
        "cache-control": "public",
        "www-authenticate": 'Bearer realm="edgefoss"',
      },
    ),
  ]) {
    await assert.rejects(
      auditWorkerPublicPush(new URL(ORIGIN), async () => response),
      /Worker public push audit failed/u,
    );
  }
  await assert.rejects(
    auditWorkerPublicPush(new URL("https://edgefoss.example"), async () => {
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
