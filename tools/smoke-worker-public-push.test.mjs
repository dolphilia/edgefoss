import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStagingPushFixture,
  parseOrigin,
  smokeWorkerPublicPush,
} from "./smoke-worker-public-push.mjs";

const ORIGIN = "https://edgefoss-staging.miga-and-raia.workers.dev";
const TOKEN = "efoss_owner_v0_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("public push smoke accepts only the exact staging origin", () => {
  assert.equal(parseOrigin(["--origin", ORIGIN]), ORIGIN);
  assert.equal(parseOrigin(["--", "--origin", ORIGIN]), ORIGIN);
  for (const arguments_ of [
    [],
    ["--", "--", "--origin", ORIGIN],
    ["--origin", "http://edgefoss-staging.miga-and-raia.workers.dev"],
    ["--origin", `${ORIGIN}/path`],
    ["--origin", "https://edgefoss.example"],
  ]) {
    assert.throws(() => parseOrigin(arguments_));
  }
});

test("public push smoke rejects target and token before fetch", async () => {
  const fetchImplementation = async () => {
    throw new Error("fetch must not run");
  };
  await assert.rejects(
    smokeWorkerPublicPush({
      fetchImplementation,
      origin: "https://edgefoss.example",
      token: TOKEN,
    }),
    /approved staging Worker/u,
  );
  await assert.rejects(
    smokeWorkerPublicPush({
      fetchImplementation,
      origin: ORIGIN,
      token: "invalid",
    }),
    /owner token is missing or invalid/u,
  );
});

test("public push smoke fixture and operation IDs are deterministic", async () => {
  const fixture = await buildStagingPushFixture();
  assert.deepEqual(
    {
      acceptedId: fixture.accepted.id,
      acceptedOperationId: fixture.accepted.operationId,
      conflictId: fixture.conflict.id,
      conflictOperationId: fixture.conflict.operationId,
      previousHeadId: fixture.previousHeadId,
      projectId: fixture.projectId,
      treeId: fixture.treeId,
    },
    {
      acceptedId:
        "sha256:5e0a9f0f3821572ae3664256f0de9c9a583c668094d4a2ec2d55cc1b6f668c15",
      acceptedOperationId: "02eb85e9-131f-5077-88be-26cefa447e2d",
      conflictId:
        "sha256:84f03fab17497bbb3fc7ffd5342f01f363cbd5c5a08f3e20e1f2425310de4ea0",
      conflictOperationId: "c11ebeec-66b0-598b-9453-0f2e45e6e871",
      previousHeadId:
        "sha256:9453021f617b85666983f2e9ae7888be99ff846490ab1a5578054ca70a1f6091",
      projectId:
        "sha256:13bb24446b8925e42db990bb80d97568da113f8e29ae0e34fb994834e2ee8e49",
      treeId:
        "sha256:773149704592ffa2de8003b02ac144cc44262db7a8f8289ea4ff85fda98f5ade",
    },
  );
});

test("public push smoke fast-forwards once and proves retry and stale conflict", async () => {
  const fixture = await buildStagingPushFixture();
  const remote = fakeRemote(fixture, false);
  const result = await smokeWorkerPublicPush({
    fetchImplementation: remote.fetchImplementation,
    origin: ORIGIN,
    poll: { attempts: 1, delayMilliseconds: 0 },
    token: TOKEN,
  });
  assert.deepEqual(result, {
    acceptedSequence: 5,
    conflictArtifactAccepted: false,
    conflictRetryConverged: true,
    deliveryPhase: "delivered",
    initialState: "initial",
    newR2WritePerformed: false,
    policyEpoch: 0,
    refGeneration: 2,
    retryConverged: true,
    sendAttempts: 1,
    state: "converged",
  });
  assert.equal(remote.acceptedPublications(), 2);
  assert.equal(remote.conflictPublications(), 2);
  assert.equal(remote.uploadCalls(), 0);
  assert.equal(remote.authorizationBoundariesValid(), true);
});

test("public push smoke safely resumes an already converged response-loss state", async () => {
  const fixture = await buildStagingPushFixture();
  const remote = fakeRemote(fixture, true);
  const result = await smokeWorkerPublicPush({
    fetchImplementation: remote.fetchImplementation,
    origin: ORIGIN,
    poll: { attempts: 1, delayMilliseconds: 0 },
    token: TOKEN,
  });
  assert.equal(result.initialState, "converged");
  assert.equal(result.retryConverged, true);
  assert.equal(result.conflictRetryConverged, true);
  assert.equal(remote.uploadCalls(), 0);
});

test("public push smoke stops before mutation on unexpected staging state", async () => {
  const fixture = await buildStagingPushFixture();
  let publicationCalls = 0;
  await assert.rejects(
    smokeWorkerPublicPush({
      fetchImplementation: async (url, init) => {
        const pathname = new URL(url).pathname;
        if (pathname === "/health") return response(health());
        if (pathname === "/api/v0/sync/push/preflight") {
          return response(
            preflight(fixture, [fixture.accepted.id, fixture.conflict.id], {
              acceptedSequence: 99,
            }),
          );
        }
        publicationCalls += 1;
        throw new Error(`unexpected ${init.method} ${pathname}`);
      },
      origin: ORIGIN,
      token: TOKEN,
    }),
    /exact approved initial or converged state/u,
  );
  assert.equal(publicationCalls, 0);
});

function fakeRemote(fixture, initiallyConverged) {
  const calls = [];
  let converged = initiallyConverged;
  const fetchImplementation = async (url, init) => {
    const pathname = new URL(url).pathname;
    calls.push({ init, pathname });
    if (pathname === "/health") return response(health());
    if (pathname === "/api/v0/sync/push/preflight") {
      return response(
        converged
          ? preflight(fixture, [fixture.conflict.id], {
              acceptedSequence: 5,
              ref: ref(2, fixture.accepted.id),
            })
          : preflight(
              fixture,
              [fixture.accepted.id, fixture.conflict.id].sort(),
            ),
      );
    }
    if (pathname === "/api/v0/outbox/5/match") {
      return response({
        match: {
          exists: converged,
          matches: converged,
          repoSequence: 5,
        },
      });
    }
    if (pathname === "/api/v0/outbox/5") {
      return response({
        outbox: {
          event: converged
            ? {
                deliveredAt: 3_000,
                enqueuedAt: 2_000,
                lastSendAttemptAt: 2_000,
                phase: "delivered",
                repoSequence: 5,
                sendAttempts: 1,
              }
            : null,
          totals: {
            delivered: converged ? 1 : 0,
            enqueued: converged ? 1 : 0,
            pending: 0,
          },
        },
      });
    }
    if (pathname === "/api/v0/artifacts") {
      const body = JSON.parse(init.body);
      if (body.artifactId === fixture.accepted.id) {
        converged = true;
        return response({
          publication: {
            artifactId: fixture.accepted.id,
            kind: "change",
            policyEpoch: 0,
            realm: "public",
            ref: ref(2, fixture.accepted.id),
            repoSequence: 5,
            status: "accepted",
          },
        });
      }
      return response(
        {
          publication: {
            code: "ref_conflict",
            currentGeneration: 2,
            currentTargetArtifactId: fixture.accepted.id,
            status: "ref_conflict",
          },
        },
        409,
      );
    }
    throw new Error(`unexpected path ${pathname}`);
  };
  return {
    acceptedPublications: () =>
      calls.filter(
        ({ init, pathname }) =>
          pathname === "/api/v0/artifacts" &&
          JSON.parse(init.body).artifactId === fixture.accepted.id,
      ).length,
    authorizationBoundariesValid: () =>
      calls.every(({ init, pathname }) => {
        if (pathname === "/health") {
          return new Headers(init.headers).has("authorization") === false;
        }
        const authorization = new Headers(init.headers).get("authorization");
        return (
          authorization === `Bearer ${TOKEN}` &&
          (typeof init.body !== "string" || !init.body.includes(TOKEN))
        );
      }),
    conflictPublications: () =>
      calls.filter(
        ({ init, pathname }) =>
          pathname === "/api/v0/artifacts" &&
          JSON.parse(init.body).artifactId === fixture.conflict.id,
      ).length,
    fetchImplementation,
    uploadCalls: () =>
      calls.filter(({ pathname }) => pathname.startsWith("/api/v0/uploads"))
        .length,
  };
}

function health() {
  return { components: { repository: { schemaVersion: 5 } } };
}

function preflight(fixture, missingArtifactIds, overrides = {}) {
  return {
    preflight: {
      limits: { maxArtifactIds: 256, maxBlobIds: 256 },
      missingArtifactIds,
      missingBlobIds: [],
      snapshot: {
        acceptedSequence: 4,
        policyEpoch: 0,
        projectId: fixture.projectId,
        ref: ref(1, fixture.previousHeadId),
        ...overrides,
      },
      status: "ok",
    },
  };
}

function ref(generation, targetArtifactId) {
  return { generation, name: "heads/main", targetArtifactId };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}
