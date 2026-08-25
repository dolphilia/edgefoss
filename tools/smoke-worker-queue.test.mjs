import { strict as assert } from "node:assert";
import test from "node:test";

import { parseOrigin, smokeWorkerQueue } from "./smoke-worker-queue.mjs";

const ORIGIN = "https://edgefoss-staging.miga-and-raia.workers.dev";
const TOKEN = "efoss_owner_v0_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("Queue smoke validates the exact approved HTTPS origin", () => {
  assert.equal(parseOrigin(["--origin", ORIGIN]), ORIGIN);
  assert.throws(() => parseOrigin(["--origin", "http://edgefoss.example"]));
  assert.throws(() => parseOrigin(["--origin", `${ORIGIN}/path`]));
  assert.throws(() => parseOrigin(["--origin", "https://edgefoss.example"]));
});

test("Queue smoke fails before fetch for an unapproved target or token", async () => {
  const fetchImpl = () => {
    throw new Error("fetch must not run");
  };
  await assert.rejects(
    smokeWorkerQueue({
      fetchImpl,
      origin: "https://edgefoss.example",
      token: TOKEN,
    }),
    /approved staging Worker/u,
  );
  await assert.rejects(
    smokeWorkerQueue({ fetchImpl, origin: ORIGIN, token: "invalid" }),
    /owner token is missing or invalid/u,
  );
});

test("Queue smoke publishes one deterministic event and waits for delivery", async () => {
  const calls = [];
  let observations = 0;
  let publication;
  const fetchImpl = async (url, init) => {
    const pathname = new URL(url).pathname;
    calls.push({ init, pathname });
    if (pathname === "/health") {
      return response({ components: { repository: { schemaVersion: 5 } } });
    }
    if (pathname === "/api/v0/outbox/4") {
      observations += 1;
      if (observations === 1) return response(outbox(null, 0, 0, 0));
      if (observations === 2) {
        return response(
          outbox(event({ phase: "pending", sendAttempts: 0 }), 0, 0, 1),
        );
      }
      return response(
        outbox(
          event({
            deliveredAt: 3_000,
            enqueuedAt: 2_000,
            lastSendAttemptAt: 2_000,
            phase: "delivered",
            sendAttempts: 1,
          }),
          1,
          1,
          0,
        ),
      );
    }
    if (pathname === "/api/v0/outbox/4/match") {
      return response({
        match: { exists: false, matches: false, repoSequence: 4 },
      });
    }
    const body = JSON.parse(init.body);
    publication ??= {
      artifactId: body.artifactId,
      kind: "tree",
      policyEpoch: 0,
      realm: "public",
      ref: null,
      repoSequence: 4,
      status: "accepted",
    };
    return response({ publication });
  };

  const result = await smokeWorkerQueue({
    fetchImpl,
    origin: ORIGIN,
    poll: { attempts: 3, delayMilliseconds: 0 },
    sleep: async () => {},
    token: TOKEN,
  });

  assert.deepEqual(result, {
    deliveryPhase: "delivered",
    newR2WritePerformed: false,
    realm: "public",
    repoSequence: 4,
    retryConverged: true,
    sendAttempts: 1,
    state: "delivered",
  });
  assert.equal(
    calls.filter(({ pathname }) => pathname === "/api/v0/artifacts").length,
    2,
  );
  assert.equal(
    calls.filter(({ pathname }) => pathname === "/api/v0/outbox/4").length,
    3,
  );
  assert.equal(
    calls.filter(({ pathname }) => pathname === "/api/v0/outbox/4/match")
      .length,
    1,
  );
  assert.ok(
    calls
      .filter(({ pathname }) => pathname !== "/health")
      .every(({ init }) => init.headers.authorization === `Bearer ${TOKEN}`),
  );
  assert.ok(
    calls
      .filter(({ pathname }) => pathname === "/api/v0/artifacts")
      .every(({ init }) => !init.body.includes(TOKEN)),
  );
});

test("Queue smoke does not mistake an enqueued event for delivery", async () => {
  const fetchImpl = async (url, init) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/health") {
      return response({ components: { repository: { schemaVersion: 5 } } });
    }
    if (pathname === "/api/v0/outbox/4") {
      return response(
        outbox(
          event({
            enqueuedAt: 2_000,
            lastSendAttemptAt: 2_000,
            phase: "enqueued",
            sendAttempts: 1,
          }),
          0,
          1,
          0,
        ),
      );
    }
    if (pathname === "/api/v0/outbox/4/match") {
      return response({
        match: { exists: true, matches: true, repoSequence: 4 },
      });
    }
    const body = JSON.parse(init.body);
    return response({
      publication: {
        artifactId: body.artifactId,
        kind: "tree",
        policyEpoch: 0,
        realm: "public",
        ref: null,
        repoSequence: 4,
        status: "accepted",
      },
    });
  };
  await assert.rejects(
    smokeWorkerQueue({
      fetchImpl,
      origin: ORIGIN,
      poll: { attempts: 1, delayMilliseconds: 0 },
      sleep: async () => {},
      token: TOKEN,
    }),
    /delivery did not converge from enqueued/u,
  );
});

test("Queue smoke stops before publish when sequence 4 is a different event", async () => {
  let publishCalls = 0;
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/health") {
      return response({ components: { repository: { schemaVersion: 5 } } });
    }
    if (pathname === "/api/v0/outbox/4") {
      return response(
        outbox(event({ phase: "pending", sendAttempts: 0 }), 0, 0, 1),
      );
    }
    if (pathname === "/api/v0/outbox/4/match") {
      return response({
        match: { exists: true, matches: false, repoSequence: 4 },
      });
    }
    publishCalls += 1;
    throw new Error("publish must not run");
  };
  await assert.rejects(
    smokeWorkerQueue({
      fetchImpl,
      origin: ORIGIN,
      poll: { attempts: 1, delayMilliseconds: 0 },
      token: TOKEN,
    }),
    /belongs to a different artifact/u,
  );
  assert.equal(publishCalls, 0);
});

function event(overrides) {
  return {
    deliveredAt: null,
    enqueuedAt: null,
    lastSendAttemptAt: null,
    phase: "pending",
    repoSequence: 4,
    sendAttempts: 0,
    ...overrides,
  };
}

function outbox(observedEvent, delivered, enqueued, pending) {
  return {
    outbox: {
      event: observedEvent,
      totals: { delivered, enqueued, pending },
    },
  };
}

function response(body) {
  return new Response(JSON.stringify(body), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
    },
  });
}
