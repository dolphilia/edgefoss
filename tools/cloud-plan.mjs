import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(repositoryRoot, "infra/cloud-resources.json");
const environments = new Set(["staging", "production"]);
const r2Bindings = ["PUBLIC_BLOBS", "RESTRICTED_BLOBS", "EXPORTS"];
const doLocationHints = new Set([
  "wnam",
  "enam",
  "sam",
  "weur",
  "eeur",
  "apac",
  "apac-ne",
  "apac-se",
  "oc",
  "afr",
  "me",
]);
const jurisdictions = new Set([null, "eu", "us", "fedramp"]);

function fail(message) {
  throw new Error(`cloud plan failed: ${message}`);
}

function object(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }
  return value;
}

function exactKeys(value, keys, path) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${path} keys must be exactly ${expected.join(", ")}`);
  }
}

function string(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${path} must be a non-empty string`);
  }
  return value;
}

function integer(value, path, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(`${path} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function cloudName(value, path, maximum = 63) {
  string(value, path);
  if (
    value.length < 3 ||
    value.length > maximum ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/u.test(value)
  ) {
    fail(`${path} is not a lowercase, hyphen-safe Cloudflare name`);
  }
  return value;
}

function binding(value, path) {
  string(value, path);
  if (!/^[A-Z][A-Z0-9_]*$/u.test(value)) {
    fail(`${path} is not an uppercase binding name`);
  }
  return value;
}

function validateEnvironment(environment, value) {
  object(value, environment);
  exactKeys(
    value,
    ["worker", "dataPolicy", "durableObject", "r2Buckets", "queue"],
    environment,
  );

  const worker = object(value.worker, `${environment}.worker`);
  exactKeys(worker, ["name"], `${environment}.worker`);
  cloudName(worker.name, `${environment}.worker.name`);

  const dataPolicy = object(value.dataPolicy, `${environment}.dataPolicy`);
  exactKeys(
    dataPolicy,
    [
      "r2Location",
      "r2Jurisdiction",
      "durableObjectJurisdiction",
      "durableObjectLocationHint",
    ],
    `${environment}.dataPolicy`,
  );
  if (dataPolicy.r2Location !== "automatic") {
    fail(`${environment}.dataPolicy.r2Location must be automatic in v0`);
  }
  for (const [name, jurisdiction] of [
    ["r2Jurisdiction", dataPolicy.r2Jurisdiction],
    ["durableObjectJurisdiction", dataPolicy.durableObjectJurisdiction],
  ]) {
    if (!jurisdictions.has(jurisdiction)) {
      fail(`${environment}.dataPolicy.${name} is unsupported`);
    }
  }
  if (dataPolicy.r2Jurisdiction !== dataPolicy.durableObjectJurisdiction) {
    fail(`${environment} R2 and Durable Object jurisdictions must match`);
  }
  if (!doLocationHints.has(dataPolicy.durableObjectLocationHint)) {
    fail(`${environment}.dataPolicy.durableObjectLocationHint is unsupported`);
  }

  const durableObject = object(
    value.durableObject,
    `${environment}.durableObject`,
  );
  exactKeys(
    durableObject,
    ["binding", "className", "export"],
    `${environment}.durableObject`,
  );
  if (
    binding(durableObject.binding, `${environment}.durableObject.binding`) !==
    "REPOSITORY"
  ) {
    fail(`${environment}.durableObject.binding must be REPOSITORY`);
  }
  if (durableObject.className !== "RepositoryDO") {
    fail(`${environment}.durableObject.className must be RepositoryDO`);
  }
  const exportedClass = object(
    durableObject.export,
    `${environment}.durableObject.export`,
  );
  exactKeys(
    exportedClass,
    ["type", "state", "storage"],
    `${environment}.durableObject.export`,
  );
  if (
    exportedClass.type !== "durable-object" ||
    exportedClass.state !== "created" ||
    exportedClass.storage !== "sqlite"
  ) {
    fail(
      `${environment}.durableObject.export must declare a created SQLite Durable Object`,
    );
  }

  if (!Array.isArray(value.r2Buckets) || value.r2Buckets.length !== 3) {
    fail(`${environment}.r2Buckets must contain exactly three buckets`);
  }
  const seenBucketNames = new Set();
  const seenBindings = [];
  for (const [index, candidate] of value.r2Buckets.entries()) {
    const bucket = object(candidate, `${environment}.r2Buckets[${index}]`);
    exactKeys(
      bucket,
      ["binding", "name", "publicAccess"],
      `${environment}.r2Buckets[${index}]`,
    );
    seenBindings.push(
      binding(bucket.binding, `${environment}.r2Buckets[${index}].binding`),
    );
    cloudName(bucket.name, `${environment}.r2Buckets[${index}].name`);
    if (!bucket.name.includes(`-${environment}-`)) {
      fail(`${environment} bucket name does not contain its environment`);
    }
    if (seenBucketNames.has(bucket.name)) {
      fail(`${environment} bucket names must be unique`);
    }
    seenBucketNames.add(bucket.name);
    if (bucket.publicAccess !== false) {
      fail(`${environment} buckets must remain private in v0`);
    }
  }
  if (JSON.stringify(seenBindings) !== JSON.stringify(r2Bindings)) {
    fail(
      `${environment} R2 bindings must be ${r2Bindings.join(", ")} in order`,
    );
  }

  const queue = object(value.queue, `${environment}.queue`);
  exactKeys(
    queue,
    ["binding", "name", "consumer", "deadLetterQueue"],
    `${environment}.queue`,
  );
  if (binding(queue.binding, `${environment}.queue.binding`) !== "EVENTS") {
    fail(`${environment}.queue.binding must be EVENTS`);
  }
  cloudName(queue.name, `${environment}.queue.name`);
  const consumer = object(queue.consumer, `${environment}.queue.consumer`);
  exactKeys(
    consumer,
    ["maxBatchSize", "maxBatchTimeoutSeconds", "maxRetries"],
    `${environment}.queue.consumer`,
  );
  integer(
    consumer.maxBatchSize,
    `${environment}.queue.consumer.maxBatchSize`,
    1,
    100,
  );
  integer(
    consumer.maxBatchTimeoutSeconds,
    `${environment}.queue.consumer.maxBatchTimeoutSeconds`,
    0,
    60,
  );
  integer(
    consumer.maxRetries,
    `${environment}.queue.consumer.maxRetries`,
    0,
    100,
  );
  const deadLetterQueue = object(
    queue.deadLetterQueue,
    `${environment}.queue.deadLetterQueue`,
  );
  exactKeys(deadLetterQueue, ["name"], `${environment}.queue.deadLetterQueue`);
  cloudName(deadLetterQueue.name, `${environment}.queue.deadLetterQueue.name`);
  if (queue.name === deadLetterQueue.name) {
    fail(`${environment} queue and dead-letter queue must differ`);
  }
}

export function validateManifest(manifest) {
  object(manifest, "manifest");
  exactKeys(manifest, ["format", "deployment", "environments"], "manifest");
  if (manifest.format !== "edgefossil-cloud-resources-v0") {
    fail("manifest.format is unsupported");
  }
  cloudName(manifest.deployment, "manifest.deployment");
  const values = object(manifest.environments, "manifest.environments");
  exactKeys(values, [...environments], "manifest.environments");
  for (const environment of environments) {
    validateEnvironment(environment, values[environment]);
  }

  const names = new Set();
  for (const [environment, value] of Object.entries(values)) {
    const prefix = `${manifest.deployment}-${environment}`;
    if (value.worker.name !== prefix) {
      fail(`${environment} Worker name must be ${prefix}`);
    }
    const resourceNames = [
      ...value.r2Buckets.map((bucket) => bucket.name),
      value.queue.name,
      value.queue.deadLetterQueue.name,
    ];
    for (const name of resourceNames) {
      if (!name.startsWith(`${prefix}-`)) {
        fail(
          `${environment} resource name is outside its environment: ${name}`,
        );
      }
      if (names.has(name)) fail(`resource name is reused: ${name}`);
      names.add(name);
    }
    names.add(value.worker.name);
  }
  return manifest;
}

export function parseArguments(arguments_) {
  const normalized = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  if (normalized.length !== 2 || normalized[0] !== "--env") {
    fail("usage: cloud-plan --env staging|production");
  }
  const environment = normalized[1];
  if (!environments.has(environment)) {
    fail(`unsupported environment: ${environment}`);
  }
  return environment;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function createPlan(manifest, environment) {
  validateManifest(manifest);
  if (!environments.has(environment))
    fail(`unsupported environment: ${environment}`);
  const resources = manifest.environments[environment];
  const reviewTarget = {
    format: manifest.format,
    deployment: manifest.deployment,
    environment,
    resources,
  };
  return {
    format: "edgefossil-cloud-plan-v0",
    operation: "plan",
    environment,
    manifestPath: "infra/cloud-resources.json",
    manifestDigest: digest(reviewTarget),
    effects: {
      mutating: false,
      remoteReads: false,
      remoteWrites: false,
    },
    preflight: {
      status: "USER_ACTION_REQUIRED",
      checkpoint: "U2",
      actions: [
        "Enable the R2 subscription if R2 Overview still shows checkout; do not create buckets in the Dashboard.",
        "Confirm that no legal or contractual data-residency requirement replaces the planned Automatic R2 location and unrestricted Durable Object jurisdiction.",
        "Review every resource name, binding, private bucket setting, Queue/DLQ policy, and Durable Object location hint in this plan.",
        "Record approval of this exact manifestDigest before any provisioning command is implemented or run.",
      ],
      provisioningCommandAvailable: false,
    },
    resources,
  };
}

export async function loadManifest() {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

async function main() {
  const environment = parseArguments(process.argv.slice(2));
  const manifest = await loadManifest();
  console.log(JSON.stringify(createPlan(manifest, environment), null, 2));
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
