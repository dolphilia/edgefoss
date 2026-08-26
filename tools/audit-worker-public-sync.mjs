import { pathToFileURL } from "node:url";

const MAX_RESPONSE_BYTES = 4_096;

function fail(message) {
  throw new Error(`Worker public sync audit failed: ${message}`);
}

export function parseArguments(arguments_) {
  if (arguments_.length !== 2 || arguments_[0] !== "--origin") {
    fail("usage: audit-worker-public-sync --origin HTTPS_ORIGIN");
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
    origin.hash !== ""
  ) {
    fail("origin must be HTTPS without credentials, path, query, or fragment");
  }
  return origin;
}

export async function auditWorkerPublicSync(
  origin,
  fetchImplementation = fetch,
) {
  const url = new URL("api/v0/sync/hello", origin);
  url.searchParams.set("protocol", "0");
  url.searchParams.set("view", "public");

  let response;
  try {
    response = await fetchImplementation(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail("GET /api/v0/sync/hello request failed");
  }
  if (response.status !== 200) {
    fail(`GET /api/v0/sync/hello returned ${response.status}`);
  }
  verifyHeaders(response);

  let body;
  try {
    body = JSON.parse(await readBoundedText(response, MAX_RESPONSE_BYTES));
  } catch {
    fail("GET /api/v0/sync/hello body is not valid bounded JSON");
  }
  const hello = validateBody(body);
  return {
    cursorTtlSeconds: hello.capabilities.inventory.cursorTtlSeconds,
    maxPageItems: hello.capabilities.inventory.maxPageItems,
    projectId: hello.projectId,
    protocolVersion: hello.protocolVersion,
    transferGrantTtlSeconds: hello.capabilities.transfer.grantTtlSeconds,
    transferProfile: hello.capabilities.transfer.profiles[0],
    view: hello.view.id,
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
    fail("anonymous HELLO unexpectedly requested authentication");
  }
}

function validateBody(body) {
  if (!plainObject(body) || !exactKeys(body, ["hello"])) {
    fail("response envelope does not match the HELLO contract");
  }
  const hello = body.hello;
  if (
    !plainObject(hello) ||
    !exactKeys(hello, [
      "capabilities",
      "principalId",
      "projectId",
      "protocolVersion",
      "status",
      "view",
    ]) ||
    hello.principalId !== "anonymous" ||
    !/^sha256:[0-9a-f]{64}$/u.test(hello.projectId) ||
    hello.protocolVersion !== 0 ||
    hello.status !== "accepted"
  ) {
    fail("HELLO identity or protocol does not match the contract");
  }
  if (
    !plainObject(hello.view) ||
    !exactKeys(hello.view, ["id", "realms"]) ||
    hello.view.id !== "public" ||
    JSON.stringify(hello.view.realms) !== JSON.stringify(["public"])
  ) {
    fail("HELLO view does not match the public-only contract");
  }
  if (
    !plainObject(hello.capabilities) ||
    !exactKeys(hello.capabilities, ["inventory", "phases", "transfer"]) ||
    JSON.stringify(hello.capabilities.phases) !==
      JSON.stringify(["HELLO", "INVENTORY", "TRANSFER"])
  ) {
    fail("HELLO phases do not match the implemented contract");
  }
  const inventory = hello.capabilities.inventory;
  if (
    !plainObject(inventory) ||
    !exactKeys(inventory, [
      "cursor",
      "cursorTtlSeconds",
      "maxPageItems",
      "ordering",
    ]) ||
    inventory.cursor !== "opaque" ||
    inventory.cursorTtlSeconds !== 600 ||
    inventory.maxPageItems !== 1_000 ||
    inventory.ordering !== "artifact_id_asc"
  ) {
    fail("HELLO inventory capability does not match the contract");
  }
  const transfer = hello.capabilities.transfer;
  if (
    !plainObject(transfer) ||
    !exactKeys(transfer, [
      "grant",
      "grantTtlSeconds",
      "maxArtifactBytes",
      "maxArtifactItems",
      "maxBlobChunkBytes",
      "profiles",
    ]) ||
    transfer.grant !== "opaque" ||
    transfer.grantTtlSeconds !== 600 ||
    transfer.maxArtifactBytes !== 2_097_152 ||
    transfer.maxArtifactItems !== 16 ||
    transfer.maxBlobChunkBytes !== 1_048_576 ||
    JSON.stringify(transfer.profiles) !== JSON.stringify(["complete"])
  ) {
    fail("HELLO transfer capability does not match the contract");
  }
  return hello;
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
  const result = await auditWorkerPublicSync(origin);
  console.log(
    `Worker public sync audit passed; protocol=${result.protocolVersion}, view=${result.view}, max_page_items=${result.maxPageItems}, cursor_ttl_seconds=${result.cursorTtlSeconds}, transfer_profile=${result.transferProfile}, transfer_grant_ttl_seconds=${result.transferGrantTtlSeconds}, project=${result.projectId}`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
