import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import {
  createPlan,
  loadManifest,
  parseArguments,
  validateManifest,
} from "./cloud-plan.mjs";

const expectedBindings = ["PUBLIC_BLOBS", "RESTRICTED_BLOBS", "EXPORTS"];

test("manifest defines isolated staging and production resources", async () => {
  const manifest = validateManifest(await loadManifest());
  const allNames = [];
  for (const environment of ["staging", "production"]) {
    const resources = manifest.environments[environment];
    assert.equal(resources.worker.name, `edgefoss-${environment}`);
    assert.deepEqual(
      resources.r2Buckets.map((bucket) => bucket.binding),
      expectedBindings,
    );
    assert.ok(resources.r2Buckets.every((bucket) => !bucket.publicAccess));
    assert.equal(resources.durableObject.binding, "REPOSITORY");
    assert.deepEqual(resources.durableObject.export, {
      type: "durable-object",
      state: "created",
      storage: "sqlite",
    });
    assert.equal(resources.queue.binding, "EVENTS");
    assert.notEqual(resources.queue.name, resources.queue.deadLetterQueue.name);
    allNames.push(
      resources.worker.name,
      ...resources.r2Buckets.map((bucket) => bucket.name),
      resources.queue.name,
      resources.queue.deadLetterQueue.name,
    );
  }
  assert.equal(new Set(allNames).size, allNames.length);
});

test("plan is deterministic, non-mutating, and stops at U2", async () => {
  const manifest = await loadManifest();
  const first = createPlan(manifest, "staging");
  const second = createPlan(manifest, "staging");
  assert.deepEqual(first, second);
  assert.match(first.manifestDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(first.effects, {
    mutating: false,
    remoteReads: false,
    remoteWrites: false,
  });
  assert.equal(first.preflight.status, "USER_ACTION_REQUIRED");
  assert.equal(first.preflight.checkpoint, "U2");
  assert.equal(first.preflight.provisioningCommandAvailable, false);
  assert.equal(first.resources.dataPolicy.r2Location, "automatic");
  assert.equal(first.resources.dataPolicy.r2Jurisdiction, null);
  assert.equal(first.resources.dataPolicy.durableObjectJurisdiction, null);
  assert.equal(first.resources.dataPolicy.durableObjectLocationHint, "apac-ne");
});

test("CLI emits machine-readable output without credentials", () => {
  const sentinel = "must-not-appear-in-cloud-plan";
  const result = spawnSync(
    process.execPath,
    [resolve("tools/cloud-plan.mjs"), "--env", "staging"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: sentinel,
        CLOUDFLARE_ACCOUNT_ID: sentinel,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(sentinel, "u"));
  assert.equal(
    JSON.parse(result.stdout).preflight.status,
    "USER_ACTION_REQUIRED",
  );
});

test("CLI rejects missing, duplicate, and production-like environment input", () => {
  assert.equal(parseArguments(["--", "--env", "staging"]), "staging");
  assert.throws(() => parseArguments([]), /usage/u);
  assert.throws(
    () => parseArguments(["--env", "staging", "--env", "production"]),
    /usage/u,
  );
  assert.throws(() => parseArguments(["--env", "prod"]), /unsupported/u);
});

test("validator rejects public buckets and cross-environment names", async () => {
  const publicManifest = structuredClone(await loadManifest());
  publicManifest.environments.staging.r2Buckets[0].publicAccess = true;
  assert.throws(() => validateManifest(publicManifest), /remain private/u);

  const crossedManifest = structuredClone(await loadManifest());
  crossedManifest.environments.staging.r2Buckets[0].name =
    "edgefoss-production-public-blobs-copy";
  assert.throws(
    () => validateManifest(crossedManifest),
    /does not contain its environment/u,
  );

  const crossedQueueManifest = structuredClone(await loadManifest());
  crossedQueueManifest.environments.staging.queue.name =
    "edgefoss-production-events-copy";
  assert.throws(
    () => validateManifest(crossedQueueManifest),
    /outside its environment/u,
  );
});
