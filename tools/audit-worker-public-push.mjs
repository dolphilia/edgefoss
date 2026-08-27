import { pathToFileURL } from "node:url";

const MAX_RESPONSE_BYTES = 4_096;
const STAGING_ORIGIN = "https://edgefoss-staging.miga-and-raia.workers.dev";

function fail(message) {
  throw new Error(`Worker public push audit failed: ${message}`);
}

export function parseArguments(arguments_) {
  const normalizedArguments =
    arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  if (
    normalizedArguments.length !== 2 ||
    normalizedArguments[0] !== "--origin"
  ) {
    fail("usage: audit-worker-public-push --origin HTTPS_ORIGIN");
  }
  let origin;
  try {
    origin = new URL(normalizedArguments[1]);
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

export async function auditWorkerPublicPush(
  origin,
  fetchImplementation = fetch,
) {
  if (origin.origin !== STAGING_ORIGIN) {
    fail("origin is not the approved staging Worker");
  }
  let response;
  try {
    response = await fetchImplementation(
      new URL("api/v0/sync/push/preflight", origin),
      {
        body: "not json",
        headers: { "content-type": "application/json" },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    fail("POST /api/v0/sync/push/preflight request failed");
  }
  if (response.status !== 401) {
    fail(`POST /api/v0/sync/push/preflight returned ${response.status}`);
  }
  verifyHeaders(response);

  let body;
  try {
    body = JSON.parse(await readBoundedText(response, MAX_RESPONSE_BYTES));
  } catch {
    fail("preflight authentication body is not valid bounded JSON");
  }
  if (
    !plainObject(body) ||
    !exactKeys(body, ["error"]) ||
    !plainObject(body.error) ||
    !exactKeys(body.error, ["code", "message"]) ||
    body.error.code !== "unauthorized" ||
    body.error.message !== "A valid owner bearer token is required."
  ) {
    fail("preflight authentication boundary does not match the contract");
  }

  return {
    authenticatedPreflightPerformed: false,
    remoteWritePerformed: false,
    status: "owner_auth_required",
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
  if (response.headers.get("www-authenticate") !== 'Bearer realm="edgefoss"') {
    fail("WWW-Authenticate does not match the owner realm");
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
  const result = await auditWorkerPublicPush(origin);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
