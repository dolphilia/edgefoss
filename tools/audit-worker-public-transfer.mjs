import { pathToFileURL } from "node:url";

import { auditWorkerPublicSync } from "./audit-worker-public-sync.mjs";

const MAX_RESPONSE_BYTES = 4_096;
const STAGING_ORIGIN = "https://edgefoss-staging.miga-and-raia.workers.dev";

function fail(message) {
  throw new Error(`Worker public transfer audit failed: ${message}`);
}

export function parseArguments(arguments_) {
  if (arguments_.length !== 2 || arguments_[0] !== "--origin") {
    fail("usage: audit-worker-public-transfer --origin HTTPS_ORIGIN");
  }
  let origin;
  try {
    origin = new URL(arguments_[1]);
  } catch {
    fail("origin is not a valid URL");
  }
  if (
    origin.protocol !== "https:" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    origin.origin !== STAGING_ORIGIN
  ) {
    fail("origin must be the exact approved HTTPS staging Worker");
  }
  return origin;
}

export async function auditWorkerPublicTransfer(
  origin,
  fetchImplementation = fetch,
) {
  if (origin.origin !== STAGING_ORIGIN) {
    fail("origin is not the approved staging Worker");
  }
  const hello = await auditWorkerPublicSync(origin, fetchImplementation);
  const url = new URL("api/v0/sync/transfers", origin);
  url.searchParams.set("profile", "complete");
  url.searchParams.set("project", hello.projectId);
  url.searchParams.set("protocol", "0");
  url.searchParams.set("view", "public");

  let response;
  try {
    response = await fetchImplementation(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail("POST /api/v0/sync/transfers request failed");
  }
  if (response.status !== 409) {
    fail(`POST /api/v0/sync/transfers returned ${response.status}`);
  }
  verifyHeaders(response);

  let body;
  try {
    body = JSON.parse(await readBoundedText(response, MAX_RESPONSE_BYTES));
  } catch {
    fail("POST /api/v0/sync/transfers body is not valid bounded JSON");
  }
  if (
    !plainObject(body) ||
    !exactKeys(body, ["error"]) ||
    !plainObject(body.error) ||
    !exactKeys(body.error, ["code", "message"]) ||
    body.error.code !== "clone_profile_unsupported" ||
    body.error.message !== "The public transfer plan is unavailable."
  ) {
    fail("transfer plan rejection does not match the expected staging state");
  }

  return {
    artifactReadPerformed: false,
    blobReadPerformed: false,
    planStatus: "clone_profile_unsupported",
    projectId: hello.projectId,
    remoteWritePerformed: false,
  };
}

function verifyHeaders(response) {
  if (response.headers.get("cache-control") !== "no-store") {
    fail("Cache-Control is not no-store");
  }
  if (response.headers.get("x-content-type-options") !== "nosniff") {
    fail("X-Content-Type-Options is not nosniff");
  }
  if (
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    fail("Content-Type is not application/json");
  }
  if (response.headers.has("www-authenticate")) {
    fail("anonymous transfer plan unexpectedly requested authentication");
  }
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

async function readBoundedText(response, maximumBytes) {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        fail(`response body exceeds ${maximumBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function main() {
  const origin = parseArguments(process.argv.slice(2));
  const result = await auditWorkerPublicTransfer(origin);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
