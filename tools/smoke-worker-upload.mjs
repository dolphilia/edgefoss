import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const OWNER_TOKEN_PATTERN = /^efoss_owner_v0_[A-Za-z0-9_-]{43}$/;
const OPERATION_ID = "00000000-0000-4000-8000-000000000401";
const SMOKE_BYTES = new TextEncoder().encode("edgefoss-p4b-staging-smoke-v1\n");
const STAGING_ORIGIN = "https://edgefoss-staging.miga-and-raia.workers.dev";

function fail(message) {
  throw new Error(`Worker upload smoke failed: ${message}`);
}

export function parseOrigin(argv) {
  if (argv.length !== 2 || argv[0] !== "--origin") {
    fail("usage: smoke-worker-upload --origin HTTPS_ORIGIN");
  }
  const origin = new URL(argv[1]);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    fail("origin must be an HTTPS origin without credentials, path, or query");
  }
  if (origin.origin !== STAGING_ORIGIN) {
    fail("origin must be the approved EdgeFossil staging Worker");
  }
  return origin.origin;
}

async function requestJson(fetchImpl, url, init, expectedStatus = 200) {
  const response = await fetchImpl(url, init);
  if (response.status !== expectedStatus) {
    fail(
      `${init.method ?? "GET"} ${new URL(url).pathname} returned ${response.status}`,
    );
  }
  const cacheControl = response.headers.get("cache-control");
  if (cacheControl !== "no-store") {
    fail(`${new URL(url).pathname} did not return cache-control: no-store`);
  }
  return response.json();
}

function readUpload(body, expectedState) {
  const expectedStates = Array.isArray(expectedState)
    ? expectedState
    : [expectedState];
  const upload = body?.upload;
  if (
    !upload ||
    typeof upload.uploadId !== "string" ||
    typeof upload.blobId !== "string" ||
    !expectedStates.includes(upload.state)
  ) {
    fail(`upload response did not report state ${expectedStates.join(" or ")}`);
  }
  return upload;
}

export async function smokeWorkerUpload({ origin, token, fetchImpl = fetch }) {
  if (origin !== STAGING_ORIGIN)
    fail("origin is not the approved staging Worker");
  if (!OWNER_TOKEN_PATTERN.test(token))
    fail("owner token is missing or invalid");
  const authorization = `Bearer ${token}`;
  const blobId = `sha256:${createHash("sha256").update(SMOKE_BYTES).digest("hex")}`;
  const declarationBody = JSON.stringify({
    blobId,
    byteSize: SMOKE_BYTES.byteLength,
    operationId: OPERATION_ID,
    realm: "public",
  });
  const uploadRoot = `${origin}/api/v0/uploads`;
  const declarationInit = {
    body: declarationBody,
    headers: {
      authorization,
      "content-type": "application/json",
    },
    method: "POST",
  };

  const declared = readUpload(
    await requestJson(fetchImpl, uploadRoot, declarationInit),
    ["declared", "staged", "finalized"],
  );
  const declaredRetry = readUpload(
    await requestJson(fetchImpl, uploadRoot, declarationInit),
    ["declared", "staged", "finalized"],
  );
  if (declaredRetry.uploadId !== declared.uploadId) {
    fail("declaration retry returned a different upload");
  }

  const uploadUrl = `${uploadRoot}/${declared.uploadId}`;
  const contentInit = {
    body: SMOKE_BYTES,
    headers: { authorization, "content-type": "application/octet-stream" },
    method: "PUT",
  };
  readUpload(
    await requestJson(fetchImpl, `${uploadUrl}/content`, contentInit),
    ["staged", "finalized"],
  );
  readUpload(
    await requestJson(fetchImpl, `${uploadUrl}/content`, contentInit),
    ["staged", "finalized"],
  );

  const finalizeInit = { headers: { authorization }, method: "POST" };
  const finalized = readUpload(
    await requestJson(fetchImpl, `${uploadUrl}/finalize`, finalizeInit),
    "finalized",
  );
  const finalizedRetry = readUpload(
    await requestJson(fetchImpl, `${uploadUrl}/finalize`, finalizeInit),
    "finalized",
  );
  if (
    finalizedRetry.uploadId !== finalized.uploadId ||
    finalizedRetry.finalKey !== finalized.finalKey
  ) {
    fail("finalize retry returned a different result");
  }

  const status = readUpload(
    await requestJson(fetchImpl, uploadUrl, {
      headers: { authorization },
      method: "GET",
    }),
    "finalized",
  );
  if (status.blobId !== blobId || status.byteSize !== SMOKE_BYTES.byteLength) {
    fail("stored upload identity differs from the synthetic input");
  }

  const health = await requestJson(fetchImpl, `${origin}/health`, {
    method: "GET",
  });
  if (health?.components?.repository?.schemaVersion !== 3) {
    fail("health did not report repository schema version 3");
  }

  return {
    blobId,
    byteSize: SMOKE_BYTES.byteLength,
    operationId: OPERATION_ID,
    realm: "public",
    repositorySchemaVersion: 3,
    retryConverged: true,
    state: "finalized",
  };
}

async function main() {
  const origin = parseOrigin(process.argv.slice(2));
  const token = process.env.EDGEFOSS_OWNER_TOKEN ?? "";
  const result = await smokeWorkerUpload({ origin, token });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
