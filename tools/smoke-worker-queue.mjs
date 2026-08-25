import {
  artifactId,
  artifactSignatureMessage,
  encodeProjectGenesis,
  encodeSignatureRecord,
  encodeTree,
} from "@edgefoss/protocol";
import { createHash, webcrypto } from "node:crypto";
import { pathToFileURL } from "node:url";

const OWNER_TOKEN_PATTERN = /^efoss_owner_v0_[A-Za-z0-9_-]{43}$/;
const STAGING_ORIGIN = "https://edgefoss-staging.miga-and-raia.workers.dev";
const REFERENCED_BLOB_ID =
  "sha256:d7fff80443a004a5fdbd4fdf058d7cb0b828a0d28cc4522f629bb60d841a4572";
const OPERATION_ID = "00000000-0000-4000-8000-000000000514";
const REPO_SEQUENCE = 4;
const DEFAULT_POLL = { attempts: 12, delayMilliseconds: 5_000 };
const MAX_RESPONSE_BYTES = 4_096;

function fail(message) {
  throw new Error(`Worker Queue smoke failed: ${message}`);
}

export function parseOrigin(argv) {
  if (argv.length !== 2 || argv[0] !== "--origin") {
    fail("usage: smoke-worker-queue --origin HTTPS_ORIGIN");
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

async function signingIdentity() {
  const seed = createHash("sha256")
    .update("edgefoss-p4c-staging-smoke-signing-fixture-v1")
    .digest();
  const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const privateKey = await webcrypto.subtle.importKey(
    "pkcs8",
    Buffer.concat([pkcs8Prefix, seed]),
    { name: "Ed25519" },
    true,
    ["sign"],
  );
  const jwk = await webcrypto.subtle.exportKey("jwk", privateKey);
  if (typeof jwk.x !== "string") fail("could not derive fixture public key");
  return { actorKey: Buffer.from(jwk.x, "base64url"), privateKey };
}

async function fixtureDeclaration() {
  const identity = await signingIdentity();
  const projectId = await artifactId(
    encodeProjectGenesis({
      actorKey: identity.actorKey,
      createdAt: "2026-08-25T00:00:00Z",
      name: "EdgeFossil staging smoke project",
      nonce: new Uint8Array(32).fill(0x53),
    }),
  );
  const bytes = encodeTree({
    actorKey: identity.actorKey,
    createdAt: "2026-08-25T00:00:03Z",
    entries: [{ mode: "file", name: "README.md", target: REFERENCED_BLOB_ID }],
    logicalClock: 3n,
    parents: [],
    project: projectId,
    realm: "public",
  });
  const id = await artifactId(bytes);
  const signature = new Uint8Array(
    await webcrypto.subtle.sign(
      "Ed25519",
      identity.privateKey,
      artifactSignatureMessage(id),
    ),
  );
  return {
    body: JSON.stringify({
      artifactBytes: Buffer.from(bytes).toString("base64url"),
      artifactId: id,
      expectedPolicyEpoch: 0,
      operationId: OPERATION_ID,
      ref: null,
      signatureBytes: Buffer.from(
        encodeSignatureRecord({
          actorKey: identity.actorKey,
          artifact: id,
          signature,
        }),
      ).toString("base64url"),
    }),
    id,
  };
}

async function readBoundedText(response) {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        fail(`response exceeded ${MAX_RESPONSE_BYTES} bytes`);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function requestJson(fetchImpl, url, init) {
  const response = await fetchImpl(url, init);
  if (response.status !== 200) {
    fail(
      `${init.method ?? "GET"} ${new URL(url).pathname} returned ${response.status}`,
    );
  }
  if (response.headers.get("cache-control") !== "no-store") {
    fail(`${new URL(url).pathname} did not return cache-control: no-store`);
  }
  try {
    return JSON.parse(await readBoundedText(response));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Worker Queue smoke")
    )
      throw error;
    fail(`${new URL(url).pathname} did not return bounded JSON`);
  }
}

function validateTotals(value) {
  if (
    !value ||
    !hasExactKeys(value, ["delivered", "enqueued", "pending"]) ||
    !Number.isSafeInteger(value.delivered) ||
    value.delivered < 0 ||
    !Number.isSafeInteger(value.enqueued) ||
    value.enqueued < 0 ||
    !Number.isSafeInteger(value.pending) ||
    value.pending < 0
  ) {
    fail("outbox totals are invalid");
  }
}

function observation(body) {
  if (!hasExactKeys(body, ["outbox"])) {
    fail("outbox response is invalid");
  }
  const outbox = body?.outbox;
  if (!hasExactKeys(outbox, ["event", "totals"])) {
    fail("outbox response is invalid");
  }
  validateTotals(outbox?.totals);
  if (outbox.event === null) return outbox;
  const event = outbox.event;
  const exactKeys = [
    "deliveredAt",
    "enqueuedAt",
    "lastSendAttemptAt",
    "phase",
    "repoSequence",
    "sendAttempts",
  ];
  if (
    !event ||
    !hasExactKeys(event, exactKeys) ||
    event.repoSequence !== REPO_SEQUENCE ||
    !["pending", "enqueued", "delivered"].includes(event.phase) ||
    !Number.isSafeInteger(event.sendAttempts) ||
    event.sendAttempts < 0 ||
    !validOptionalTime(event.lastSendAttemptAt) ||
    !validOptionalTime(event.enqueuedAt) ||
    !validOptionalTime(event.deliveredAt)
  ) {
    fail("outbox event observation is invalid");
  }
  if (
    (event.phase === "pending" &&
      (event.enqueuedAt !== null || event.deliveredAt !== null)) ||
    (event.phase === "enqueued" &&
      (event.sendAttempts < 1 ||
        event.enqueuedAt === null ||
        event.deliveredAt !== null)) ||
    (event.phase === "delivered" &&
      (event.sendAttempts < 1 ||
        event.enqueuedAt === null ||
        event.deliveredAt === null))
  ) {
    fail("outbox event phase is inconsistent");
  }
  return outbox;
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index])
  );
}

function validOptionalTime(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function accepted(body, expectedId) {
  const publication = body?.publication;
  if (
    publication?.status !== "accepted" ||
    publication.artifactId !== expectedId ||
    publication.kind !== "tree" ||
    publication.realm !== "public" ||
    publication.ref !== null ||
    publication.repoSequence !== REPO_SEQUENCE
  ) {
    fail(`publication did not accept sequence ${REPO_SEQUENCE}`);
  }
  return publication;
}

function artifactMatch(body) {
  if (
    !hasExactKeys(body, ["match"]) ||
    !hasExactKeys(body.match, ["exists", "matches", "repoSequence"]) ||
    typeof body.match.exists !== "boolean" ||
    typeof body.match.matches !== "boolean" ||
    body.match.repoSequence !== REPO_SEQUENCE ||
    (!body.match.exists && body.match.matches)
  ) {
    fail("outbox artifact match is invalid");
  }
  return body.match;
}

export async function smokeWorkerQueue({
  origin,
  token,
  fetchImpl = fetch,
  poll = DEFAULT_POLL,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  if (origin !== STAGING_ORIGIN)
    fail("origin is not the approved staging Worker");
  if (!OWNER_TOKEN_PATTERN.test(token))
    fail("owner token is missing or invalid");
  if (
    !Number.isSafeInteger(poll.attempts) ||
    poll.attempts < 1 ||
    !Number.isSafeInteger(poll.delayMilliseconds) ||
    poll.delayMilliseconds < 0
  ) {
    fail("poll options are invalid");
  }
  const authorization = `Bearer ${token}`;
  const health = await requestJson(fetchImpl, `${origin}/health`, {
    method: "GET",
  });
  if (health?.components?.repository?.schemaVersion !== 5) {
    fail("health did not report repository schema version 5");
  }

  const input = await fixtureDeclaration();
  const observationUrl = `${origin}/api/v0/outbox/${REPO_SEQUENCE}`;
  const initial = observation(
    await requestJson(fetchImpl, observationUrl, {
      headers: { authorization },
      method: "GET",
    }),
  );
  const preflightMatch = artifactMatch(
    await requestJson(fetchImpl, `${observationUrl}/match`, {
      body: JSON.stringify({ artifactId: input.id }),
      headers: { authorization, "content-type": "application/json" },
      method: "POST",
    }),
  );
  if (
    (initial.event === null && preflightMatch.exists) ||
    (initial.event !== null && !preflightMatch.exists)
  ) {
    fail("outbox preflight changed during observation");
  }
  if (preflightMatch.exists && !preflightMatch.matches) {
    fail(`sequence ${REPO_SEQUENCE} belongs to a different artifact`);
  }

  const publishInit = {
    body: input.body,
    headers: { authorization, "content-type": "application/json" },
    method: "POST",
  };
  const first = accepted(
    await requestJson(fetchImpl, `${origin}/api/v0/artifacts`, publishInit),
    input.id,
  );
  const retry = accepted(
    await requestJson(fetchImpl, `${origin}/api/v0/artifacts`, publishInit),
    input.id,
  );
  if (JSON.stringify(first) !== JSON.stringify(retry)) {
    fail("publication retry diverged");
  }

  let latest;
  for (let attempt = 1; attempt <= poll.attempts; attempt += 1) {
    latest = observation(
      await requestJson(fetchImpl, observationUrl, {
        headers: { authorization },
        method: "GET",
      }),
    );
    if (latest.event?.phase === "delivered") break;
    if (attempt < poll.attempts) await sleep(poll.delayMilliseconds);
  }
  if (latest?.event?.phase !== "delivered") {
    fail(
      latest?.event === null
        ? "published event is absent from the outbox"
        : `delivery did not converge from ${latest.event.phase}`,
    );
  }
  if (
    latest.event.sendAttempts < 1 ||
    latest.event.enqueuedAt === null ||
    latest.event.deliveredAt === null ||
    latest.totals.pending !== 0 ||
    latest.totals.enqueued < 1 ||
    latest.totals.delivered < 1
  ) {
    fail("delivered observation is inconsistent");
  }

  return {
    deliveryPhase: latest.event.phase,
    newR2WritePerformed: false,
    realm: "public",
    repoSequence: REPO_SEQUENCE,
    retryConverged: true,
    sendAttempts: latest.event.sendAttempts,
    state: "delivered",
  };
}

async function main() {
  const origin = parseOrigin(process.argv.slice(2));
  const token = process.env.EDGEFOSS_OWNER_TOKEN ?? "";
  const result = await smokeWorkerQueue({ origin, token });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
