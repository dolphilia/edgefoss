import { strict as assert } from "node:assert";
import test from "node:test";

import { parseOrigin, smokeWorkerPublish } from "./smoke-worker-publish.mjs";

const ORIGIN = "https://edgefoss-staging.miga-and-raia.workers.dev";
const TOKEN = "efoss_owner_v0_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("publish smoke validates the exact approved HTTPS origin", () => {
  assert.equal(parseOrigin(["--origin", ORIGIN]), ORIGIN);
  assert.throws(() => parseOrigin(["--origin", "http://edgefoss.example"]));
  assert.throws(() => parseOrigin(["--origin", `${ORIGIN}/path`]));
  assert.throws(() => parseOrigin(["--origin", "https://edgefoss.example"]));
});

test("publish smoke fails before fetch for an unapproved target or token", async () => {
  const fetchImpl = () => {
    throw new Error("fetch must not run");
  };
  await assert.rejects(
    smokeWorkerPublish({
      fetchImpl,
      origin: "https://edgefoss.example",
      token: TOKEN,
    }),
    /approved staging Worker/u,
  );
  await assert.rejects(
    smokeWorkerPublish({ fetchImpl, origin: ORIGIN, token: "invalid" }),
    /owner token is missing or invalid/u,
  );
});

test("publish smoke proves all three publication retries converge", async () => {
  const calls = [];
  let sequence = 0;
  let currentBody;
  const fetchImpl = async (url, init) => {
    calls.push({ init, url });
    if (new URL(url).pathname === "/health") {
      return response({ components: { repository: { schemaVersion: 5 } } });
    }
    const body = JSON.parse(init.body);
    if (body.operationId !== currentBody?.operationId) {
      sequence += 1;
      currentBody = body;
    }
    return response({
      publication: {
        artifactId: body.artifactId,
        kind:
          sequence === 1
            ? "project.genesis"
            : sequence === 2
              ? "tree"
              : "change",
        policyEpoch: 0,
        realm: "public",
        ref:
          sequence === 3
            ? {
                generation: 1,
                name: "heads/main",
                targetArtifactId: body.artifactId,
              }
            : null,
        repoSequence: sequence,
        status: "accepted",
      },
    });
  };

  const result = await smokeWorkerPublish({
    fetchImpl,
    origin: ORIGIN,
    token: TOKEN,
  });

  assert.equal(result.state, "published");
  assert.equal(result.retryConverged, true);
  assert.equal(result.r2WritePerformed, false);
  assert.equal(result.repoSequence, 3);
  assert.equal(calls.length, 7);
  assert.ok(
    calls
      .slice(1)
      .every(({ init }) => init.headers.authorization === `Bearer ${TOKEN}`),
  );
  assert.ok(calls.slice(1).every(({ init }) => !init.body.includes(TOKEN)));
});

function response(body) {
  return new Response(JSON.stringify(body), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
    },
  });
}
