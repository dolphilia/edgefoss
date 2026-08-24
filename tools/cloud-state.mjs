import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPlan, loadManifest } from "./cloud-plan.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const operations = new Set(["provision", "verify"]);

function fail(message) {
  throw new Error(`cloud state failed: ${message}`);
}

function exactKeys(value, keys, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${path} keys must be exactly ${expected.join(", ")}`);
  }
}

export function parseStateArguments(arguments_) {
  const [operation, ...rest] = arguments_;
  if (!operations.has(operation)) {
    fail("usage: cloud-state provision|verify --env staging|production");
  }
  const normalized = rest[0] === "--" ? rest.slice(1) : rest;
  if (normalized.length !== 2 || normalized[0] !== "--env") {
    fail("usage: cloud-state provision|verify --env staging|production");
  }
  const environment = normalized[1];
  if (environment !== "staging" && environment !== "production") {
    fail(`unsupported environment: ${environment}`);
  }
  return { operation, environment };
}

function approvalPath(environment) {
  return resolve(repositoryRoot, `infra/approvals/${environment}-u2.json`);
}

export async function loadApproval(environment) {
  let source;
  try {
    source = await readFile(approvalPath(environment), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail(`USER_ACTION_REQUIRED: no committed U2 approval for ${environment}`);
    }
    throw error;
  }
  return JSON.parse(source);
}

export function validateApproval(approval, plan) {
  exactKeys(
    approval,
    [
      "format",
      "checkpoint",
      "environment",
      "status",
      "confirmedOn",
      "sourceCommit",
      "manifestDigest",
      "decisions",
    ],
    "approval",
  );
  if (
    approval.format !== "edgefossil-user-checkpoint-v0" ||
    approval.checkpoint !== "U2" ||
    approval.status !== "approved"
  ) {
    fail("USER_ACTION_REQUIRED: U2 approval is not approved");
  }
  if (approval.environment !== plan.environment) {
    fail("USER_ACTION_REQUIRED: approval environment does not match plan");
  }
  if (approval.manifestDigest !== plan.manifestDigest) {
    fail("USER_ACTION_REQUIRED: approved manifest digest does not match plan");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(approval.confirmedOn)) {
    fail("approval.confirmedOn must be an ISO date");
  }
  if (!/^[0-9a-f]{40}$/u.test(approval.sourceCommit)) {
    fail("approval.sourceCommit must be a full Git commit");
  }
  exactKeys(
    approval.decisions,
    [
      "r2Subscription",
      "legalOrContractualDataResidencyRequirement",
      "primaryUsageRegion",
      "r2Location",
      "r2Jurisdiction",
      "durableObjectJurisdiction",
      "durableObjectLocationHint",
      "resourceNamesAndBindings",
    ],
    "approval.decisions",
  );
  const policy = plan.resources.dataPolicy;
  if (
    approval.decisions.r2Subscription !== "verified" ||
    approval.decisions.legalOrContractualDataResidencyRequirement !== "none" ||
    approval.decisions.primaryUsageRegion !== "Japan" ||
    approval.decisions.r2Location !== policy.r2Location ||
    approval.decisions.r2Jurisdiction !== policy.r2Jurisdiction ||
    approval.decisions.durableObjectJurisdiction !==
      policy.durableObjectJurisdiction ||
    approval.decisions.durableObjectLocationHint !==
      policy.durableObjectLocationHint ||
    approval.decisions.resourceNamesAndBindings !== "approved"
  ) {
    fail("USER_ACTION_REQUIRED: U2 decisions do not match the resource plan");
  }
  return approval;
}

export function runWrangler(arguments_) {
  const result = spawnSync("wrangler", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      WRANGLER_LOG_PATH:
        process.env.WRANGLER_LOG_PATH ??
        resolve(tmpdir(), "edgefoss-wrangler.log"),
    },
  });
  if (result.error !== undefined) {
    fail(`could not start Wrangler for: ${arguments_.join(" ")}`);
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function combined(result) {
  return `${result.stdout}\n${result.stderr}`;
}

function commandFailed(arguments_, result) {
  fail(
    `Wrangler exited ${result.status} while running: wrangler ${arguments_.join(" ")}`,
  );
}

function inspectR2Bucket(bucket, runner) {
  const infoArguments = ["r2", "bucket", "info", bucket.name, "--json"];
  const info = runner(infoArguments);
  if (info.status !== 0) {
    if (combined(info).includes("[code: 10006]")) {
      return { kind: "r2", name: bucket.name, status: "missing" };
    }
    commandFailed(infoArguments, info);
  }

  let metadata;
  try {
    const start = info.stdout.indexOf("{");
    const end = info.stdout.lastIndexOf("}");
    metadata = JSON.parse(info.stdout.slice(start, end + 1));
  } catch {
    fail(`Wrangler returned invalid JSON for R2 bucket ${bucket.name}`);
  }
  if (metadata.name !== bucket.name) {
    fail(`R2 bucket info name mismatch for ${bucket.name}`);
  }

  const devArguments = ["r2", "bucket", "dev-url", "get", bucket.name];
  const dev = runner(devArguments);
  if (dev.status !== 0) commandFailed(devArguments, dev);
  const devUrlDisabled = combined(dev).includes(
    "Public access via the r2.dev URL is disabled.",
  );

  const domainArguments = ["r2", "bucket", "domain", "list", bucket.name];
  const domains = runner(domainArguments);
  if (domains.status !== 0) commandFailed(domainArguments, domains);
  const noCustomDomains = combined(domains).includes(
    "There are no custom domains connected to this bucket.",
  );

  return {
    kind: "r2",
    name: bucket.name,
    status:
      devUrlDisabled && noCustomDomains ? "ready" : "unsafe-public-access",
    publicAccess: {
      r2Dev: !devUrlDisabled,
      customDomain: !noCustomDomains,
    },
  };
}

function inspectQueue(name, runner) {
  const arguments_ = ["queues", "info", name];
  const result = runner(arguments_);
  if (result.status === 0) return { kind: "queue", name, status: "ready" };
  if (combined(result).includes(`Queue "${name}" does not exist.`)) {
    return { kind: "queue", name, status: "missing" };
  }
  commandFailed(arguments_, result);
}

export function inspectCloudResources(resources, runner = runWrangler) {
  return [
    ...resources.r2Buckets.map((bucket) => inspectR2Bucket(bucket, runner)),
    inspectQueue(resources.queue.name, runner),
    inspectQueue(resources.queue.deadLetterQueue.name, runner),
  ];
}

function createMissingResource(resource, runner) {
  const arguments_ =
    resource.kind === "r2"
      ? ["r2", "bucket", "create", resource.name]
      : ["queues", "create", resource.name];
  const result = runner(arguments_);
  if (result.status !== 0) commandFailed(arguments_, result);
  return { kind: resource.kind, name: resource.name, action: "created" };
}

export function provisionCloudResources(resources, runner = runWrangler) {
  const before = inspectCloudResources(resources, runner);
  const unsafe = before.filter(
    (resource) => resource.status === "unsafe-public-access",
  );
  if (unsafe.length > 0) {
    fail(
      `existing R2 bucket has public access: ${unsafe.map((resource) => resource.name).join(", ")}`,
    );
  }

  const actions = before.map((resource) =>
    resource.status === "missing"
      ? createMissingResource(resource, runner)
      : { kind: resource.kind, name: resource.name, action: "unchanged" },
  );
  const after = inspectCloudResources(resources, runner);
  if (after.some((resource) => resource.status !== "ready")) {
    fail(
      "resource verification failed after provisioning; rerun safely to resume",
    );
  }
  return { actions, resources: after };
}

export function verifyCloudResources(resources, runner = runWrangler) {
  const inspected = inspectCloudResources(resources, runner);
  return {
    ready: inspected.every((resource) => resource.status === "ready"),
    resources: inspected,
  };
}

export async function executeCloudState(operation, environment, runner) {
  const manifest = await loadManifest();
  const plan = createPlan(manifest, environment);
  const approval = validateApproval(await loadApproval(environment), plan);
  const result =
    operation === "provision"
      ? provisionCloudResources(plan.resources, runner)
      : verifyCloudResources(plan.resources, runner);
  return {
    format: "edgefossil-cloud-state-result-v0",
    operation,
    environment,
    manifestDigest: plan.manifestDigest,
    approval: {
      checkpoint: approval.checkpoint,
      status: approval.status,
      confirmedOn: approval.confirmedOn,
      sourceCommit: approval.sourceCommit,
    },
    effects: {
      mutating: operation === "provision",
      remoteReads: true,
      remoteWrites: operation === "provision",
    },
    durableObject: {
      className: plan.resources.durableObject.className,
      binding: plan.resources.durableObject.binding,
      status: "pending_worker_deploy",
    },
    readyForWorkerDeployment: operation === "provision" ? true : result.ready,
    ...result,
  };
}

async function main() {
  const { operation, environment } = parseStateArguments(process.argv.slice(2));
  const result = await executeCloudState(operation, environment);
  console.log(JSON.stringify(result, null, 2));
  if (operation === "verify" && !result.readyForWorkerDeployment) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
