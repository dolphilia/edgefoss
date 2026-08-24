import assert from "node:assert/strict";
import test from "node:test";
import {
  executeCloudState,
  parseStateArguments,
  provisionCloudResources,
  validateApproval,
  verifyCloudResources,
} from "./cloud-state.mjs";
import { createPlan, loadManifest } from "./cloud-plan.mjs";

function fakeCloud(initial = {}) {
  const r2 = new Map(
    (initial.r2 ?? []).map((name) => [
      name,
      { r2Dev: false, customDomain: false },
    ]),
  );
  const queues = new Set(initial.queues ?? []);
  const calls = [];
  const runner = (arguments_) => {
    calls.push(arguments_);
    const key = arguments_.slice(0, 3).join(" ");
    const name = arguments_[3] ?? arguments_[2];
    if (key === "r2 bucket info") {
      return r2.has(name)
        ? { status: 0, stdout: JSON.stringify({ name }), stderr: "" }
        : { status: 1, stdout: "", stderr: "[code: 10006]" };
    }
    if (key === "r2 bucket dev-url") {
      const state = r2.get(arguments_[4]);
      return {
        status: 0,
        stdout: state.r2Dev
          ? "Public access is enabled at 'https://example.r2.dev'."
          : "Public access via the r2.dev URL is disabled.",
        stderr: "",
      };
    }
    if (key === "r2 bucket domain") {
      const state = r2.get(arguments_[4]);
      return {
        status: 0,
        stdout: state.customDomain
          ? "domain: public.example"
          : "There are no custom domains connected to this bucket.",
        stderr: "",
      };
    }
    if (key === "r2 bucket create") {
      r2.set(name, { r2Dev: false, customDomain: false });
      return { status: 0, stdout: "created", stderr: "" };
    }
    if (arguments_[0] === "queues" && arguments_[1] === "info") {
      return queues.has(arguments_[2])
        ? { status: 0, stdout: "ready", stderr: "" }
        : {
            status: 1,
            stdout: "",
            stderr: `Queue "${arguments_[2]}" does not exist.`,
          };
    }
    if (arguments_[0] === "queues" && arguments_[1] === "create") {
      queues.add(arguments_[2]);
      return { status: 0, stdout: "created", stderr: "" };
    }
    throw new Error(`unexpected fake Wrangler call: ${arguments_.join(" ")}`);
  };
  return { r2, queues, calls, runner };
}

test("U2 approval matches the committed staging plan", async () => {
  const result = await executeCloudState(
    "verify",
    "staging",
    fakeCloud().runner,
  );
  assert.equal(result.approval.status, "approved");
  assert.equal(
    result.manifestDigest,
    "sha256:eb9e8f30df7070728d1e3aa433584b35b8a38bd82f03cbdd7bdfe8f181eede3d",
  );
  assert.equal(result.readyForWorkerDeployment, false);
  assert.equal(result.durableObject.status, "pending_worker_deploy");
});

test("approval fails closed when the digest changes", async () => {
  const plan = createPlan(await loadManifest(), "staging");
  const approval = {
    format: "edgefossil-user-checkpoint-v0",
    checkpoint: "U2",
    environment: "staging",
    status: "approved",
    confirmedOn: "2026-08-25",
    sourceCommit: "23ff83b971ce3a248151b7fb69d71a8ed6171353",
    manifestDigest:
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    decisions: {
      r2Subscription: "verified",
      legalOrContractualDataResidencyRequirement: "none",
      primaryUsageRegion: "Japan",
      r2Location: "automatic",
      r2Jurisdiction: null,
      durableObjectJurisdiction: null,
      durableObjectLocationHint: "apac-ne",
      resourceNamesAndBindings: "approved",
    },
  };
  assert.throws(
    () => validateApproval(approval, plan),
    /digest does not match/u,
  );
});

test("provision creates only missing resources and converges on rerun", async () => {
  const resources = (await loadManifest()).environments.staging;
  const cloud = fakeCloud({
    r2: [resources.r2Buckets[0].name],
    queues: [resources.queue.name],
  });
  const first = provisionCloudResources(resources, cloud.runner);
  assert.equal(
    first.actions.filter((item) => item.action === "created").length,
    3,
  );
  assert.ok(first.resources.every((item) => item.status === "ready"));
  const second = provisionCloudResources(resources, cloud.runner);
  assert.ok(second.actions.every((item) => item.action === "unchanged"));
});

test("provision refuses an existing public bucket before writes", async () => {
  const resources = (await loadManifest()).environments.staging;
  const cloud = fakeCloud({ r2: [resources.r2Buckets[0].name] });
  cloud.r2.get(resources.r2Buckets[0].name).r2Dev = true;
  assert.throws(
    () => provisionCloudResources(resources, cloud.runner),
    /public access/u,
  );
  assert.equal(
    cloud.calls.filter((arguments_) => arguments_.includes("create")).length,
    0,
  );
});

test("verify is read-only and reports missing resources", async () => {
  const resources = (await loadManifest()).environments.staging;
  const cloud = fakeCloud();
  const result = verifyCloudResources(resources, cloud.runner);
  assert.equal(result.ready, false);
  assert.ok(result.resources.every((item) => item.status === "missing"));
  assert.equal(
    cloud.calls.filter((arguments_) => arguments_.includes("create")).length,
    0,
  );
});

test("production stays blocked without a committed approval", async () => {
  await assert.rejects(
    () => executeCloudState("verify", "production", fakeCloud().runner),
    /USER_ACTION_REQUIRED/u,
  );
});

test("CLI argument parser accepts pnpm separator and rejects extra input", () => {
  assert.deepEqual(
    parseStateArguments(["provision", "--", "--env", "staging"]),
    { operation: "provision", environment: "staging" },
  );
  assert.throws(
    () => parseStateArguments(["verify", "--env", "prod"]),
    /unsupported/u,
  );
  assert.throws(
    () => parseStateArguments(["provision", "--env", "staging", "extra"]),
    /usage/u,
  );
});
