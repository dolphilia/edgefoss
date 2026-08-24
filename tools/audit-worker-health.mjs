import { pathToFileURL } from "node:url";

const EXPECTED_BODY = {
  components: {
    repository: {
      schemaVersion: 1,
      status: "ok",
      storage: "sqlite",
    },
    r2: {
      exports: "bound",
      publicBlobs: "bound",
      restrictedBlobs: "bound",
    },
  },
  edition: "single",
  environment: "staging",
  service: "edgefoss",
  status: "ok",
};

function fail(message) {
  throw new Error(`Worker health audit failed: ${message}`);
}

export function parseArguments(arguments_) {
  if (arguments_.length !== 2 || arguments_[0] !== "--origin") {
    fail("usage: audit-worker-health --origin HTTPS_ORIGIN");
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
}

async function request(fetchImplementation, url, method) {
  try {
    return await fetchImplementation(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail(`${method} /health request failed`);
  }
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

export async function auditWorkerHealth(origin, fetchImplementation = fetch) {
  const healthUrl = new URL("health", origin);
  const getResponse = await request(fetchImplementation, healthUrl, "GET");
  if (getResponse.status !== 200) {
    fail(`GET /health returned ${getResponse.status}`);
  }
  verifyHeaders(getResponse);

  let body;
  try {
    body = JSON.parse(await readBoundedText(getResponse, 4096));
  } catch {
    fail("GET /health body is not valid JSON");
  }
  if (JSON.stringify(body) !== JSON.stringify(EXPECTED_BODY)) {
    fail("GET /health body does not match the staging contract");
  }

  const headResponse = await request(fetchImplementation, healthUrl, "HEAD");
  if (headResponse.status !== 200) {
    fail(`HEAD /health returned ${headResponse.status}`);
  }
  verifyHeaders(headResponse);
  if ((await readBoundedText(headResponse, 4096)) !== "") {
    fail("HEAD /health returned a body");
  }

  return {
    edition: body.edition,
    environment: body.environment,
    schemaVersion: body.components.repository.schemaVersion,
  };
}

async function main() {
  const origin = parseArguments(process.argv.slice(2));
  const result = await auditWorkerHealth(origin);
  console.log(
    `Worker health audit passed; environment=${result.environment}, edition=${result.edition}, schema_version=${result.schemaVersion}`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
