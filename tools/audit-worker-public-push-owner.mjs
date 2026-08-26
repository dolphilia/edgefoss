import { pathToFileURL } from "node:url";

import { auditWorkerPublicSync } from "./audit-worker-public-sync.mjs";
import { parseArguments } from "./audit-worker-public-push.mjs";

const MAX_RESPONSE_BYTES = 32_768;
const STAGING_ORIGIN = "https://edgefoss-staging.miga-and-raia.workers.dev";
const OWNER_TOKEN_PATTERN = /^efoss_owner_v0_[A-Za-z0-9_-]{43}$/u;
const ARTIFACT_ID = /^sha256:[0-9a-f]{64}$/u;

function fail(message) {
  throw new Error(`Worker owner push audit failed: ${message}`);
}

export async function auditWorkerPublicPushOwner(
  origin,
  ownerToken,
  fetchImplementation = fetch,
) {
  if (origin.origin !== STAGING_ORIGIN) {
    fail("origin is not the approved staging Worker");
  }
  if (!OWNER_TOKEN_PATTERN.test(ownerToken)) {
    fail("EDGEFOSS_OWNER_TOKEN is missing or invalid");
  }
  const hello = await auditWorkerPublicSync(origin, fetchImplementation);
  let response;
  try {
    response = await fetchImplementation(
      new URL("api/v0/sync/push/preflight", origin),
      {
        body: JSON.stringify({
          artifactIds: [],
          blobIds: [],
          projectId: hello.projectId,
          protocolVersion: 0,
          realm: "public",
        }),
        headers: {
          authorization: `Bearer ${ownerToken}`,
          "content-type": "application/json",
        },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    fail("authenticated POST /api/v0/sync/push/preflight request failed");
  }
  if (response.status !== 200) {
    fail(`authenticated preflight returned ${response.status}`);
  }
  verifyHeaders(response);

  let body;
  try {
    body = JSON.parse(await readBoundedText(response, MAX_RESPONSE_BYTES));
  } catch {
    fail("authenticated preflight body is not valid bounded JSON");
  }
  const preflight = body?.preflight;
  const snapshot = preflight?.snapshot;
  if (
    !plainObject(body) ||
    !exactKeys(body, ["preflight"]) ||
    !plainObject(preflight) ||
    !exactKeys(preflight, [
      "limits",
      "missingArtifactIds",
      "missingBlobIds",
      "snapshot",
      "status",
    ]) ||
    preflight.status !== "ok" ||
    !plainObject(preflight.limits) ||
    !exactKeys(preflight.limits, ["maxArtifactIds", "maxBlobIds"]) ||
    preflight.limits.maxArtifactIds !== 256 ||
    preflight.limits.maxBlobIds !== 256 ||
    !Array.isArray(preflight.missingArtifactIds) ||
    preflight.missingArtifactIds.length !== 0 ||
    !Array.isArray(preflight.missingBlobIds) ||
    preflight.missingBlobIds.length !== 0 ||
    !validSnapshot(snapshot, hello.projectId)
  ) {
    fail("authenticated preflight does not match the read-only contract");
  }

  return {
    acceptedSequence: snapshot.acceptedSequence,
    policyEpoch: snapshot.policyEpoch,
    projectId: snapshot.projectId,
    ref: snapshot.ref,
    remoteWritePerformed: false,
  };
}

function validSnapshot(snapshot, projectId) {
  if (
    !plainObject(snapshot) ||
    !exactKeys(snapshot, [
      "acceptedSequence",
      "policyEpoch",
      "projectId",
      "ref",
    ]) ||
    !Number.isSafeInteger(snapshot.acceptedSequence) ||
    snapshot.acceptedSequence < 1 ||
    !Number.isSafeInteger(snapshot.policyEpoch) ||
    snapshot.policyEpoch < 0 ||
    snapshot.projectId !== projectId
  ) {
    return false;
  }
  if (snapshot.ref === null) return true;
  return (
    plainObject(snapshot.ref) &&
    exactKeys(snapshot.ref, ["generation", "name", "targetArtifactId"]) &&
    Number.isSafeInteger(snapshot.ref.generation) &&
    snapshot.ref.generation > 0 &&
    snapshot.ref.name === "heads/main" &&
    typeof snapshot.ref.targetArtifactId === "string" &&
    ARTIFACT_ID.test(snapshot.ref.targetArtifactId)
  );
}

function verifyHeaders(response) {
  if (
    response.headers.get("cache-control") !== "no-store" ||
    response.headers.get("x-content-type-options") !== "nosniff" ||
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json") ||
    response.headers.has("www-authenticate")
  ) {
    fail("authenticated preflight response headers are invalid");
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
  const result = await auditWorkerPublicPushOwner(
    origin,
    process.env.EDGEFOSS_OWNER_TOKEN ?? "",
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
