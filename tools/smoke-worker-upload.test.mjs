import { strict as assert } from "node:assert";
import test from "node:test";

import { parseOrigin, smokeWorkerUpload } from "./smoke-worker-upload.mjs";

const TOKEN = "efoss_owner_v0_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("upload smoke validates an exact HTTPS origin", () => {
  assert.equal(
    parseOrigin([
      "--origin",
      "https://edgefoss-staging.miga-and-raia.workers.dev",
    ]),
    "https://edgefoss-staging.miga-and-raia.workers.dev",
  );
  assert.throws(() => parseOrigin(["--origin", "http://edgefoss.example"]));
  assert.throws(() =>
    parseOrigin(["--origin", "https://edgefoss.example/path"]),
  );
  assert.throws(() => parseOrigin(["--origin", "https://edgefoss.example"]));
});

test("upload smoke fails before fetch for an unapproved target or token", async () => {
  const fetchImpl = () => {
    throw new Error("fetch must not run");
  };
  await assert.rejects(
    smokeWorkerUpload({
      fetchImpl,
      origin: "https://edgefoss.example",
      token: TOKEN,
    }),
    /approved staging Worker/u,
  );
  await assert.rejects(
    smokeWorkerUpload({
      fetchImpl,
      origin: "https://edgefoss-staging.miga-and-raia.workers.dev",
      token: "invalid",
    }),
    /owner token is missing or invalid/u,
  );
});

test("upload smoke proves declaration and finalize retries converge", async () => {
  const calls = [];
  const upload = {
    blobId:
      "sha256:d7fff80443a004a5fdbd4fdf058d7cb0b828a0d28cc4522f629bb60d841a4572",
    byteSize: 30,
    finalKey: null,
    uploadId: "00000000-0000-4000-8000-000000000402",
  };
  const fetchImpl = async (url, init) => {
    calls.push({ init, url });
    const pathname = new URL(url).pathname;
    let body;
    if (pathname === "/health") {
      body = { components: { repository: { schemaVersion: 4 } } };
    } else if (pathname.endsWith("/finalize")) {
      body = {
        upload: {
          ...upload,
          finalKey: "objects/public/smoke",
          state: "finalized",
        },
      };
    } else if (pathname.endsWith("/content")) {
      body = { upload: { ...upload, state: "staged" } };
    } else if (init.method === "GET") {
      body = {
        upload: {
          ...upload,
          finalKey: "objects/public/smoke",
          state: "finalized",
        },
      };
    } else {
      body = { upload: { ...upload, state: "declared" } };
    }
    return new Response(JSON.stringify(body), {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
      },
    });
  };

  const result = await smokeWorkerUpload({
    fetchImpl,
    origin: "https://edgefoss-staging.miga-and-raia.workers.dev",
    token: TOKEN,
  });

  assert.equal(result.state, "finalized");
  assert.equal(result.retryConverged, true);
  assert.equal(calls.length, 8);
  assert.equal(
    calls.at(-1).url,
    "https://edgefoss-staging.miga-and-raia.workers.dev/health",
  );
  assert.ok(
    calls
      .slice(0, -1)
      .every(({ init }) => init.headers.authorization === `Bearer ${TOKEN}`),
  );
});
