import {
  artifactId,
  artifactSignatureMessage,
  encodeChange,
  encodeProjectGenesis,
  encodeSignatureRecord,
  encodeTree,
} from "@edgefoss/protocol";
import { createHash, webcrypto } from "node:crypto";
import { pathToFileURL } from "node:url";

const OWNER_TOKEN_PATTERN = /^efoss_owner_v0_[A-Za-z0-9_-]{43}$/u;
const STAGING_ORIGIN = "https://edgefoss-staging.miga-and-raia.workers.dev";
const REFERENCED_BLOB_ID =
  "sha256:d7fff80443a004a5fdbd4fdf058d7cb0b828a0d28cc4522f629bb60d841a4572";
const INITIAL_SEQUENCE = 4;
const FINAL_SEQUENCE = 5;
const INITIAL_GENERATION = 1;
const FINAL_GENERATION = 2;
const MAX_RESPONSE_BYTES = 32_768;
const DEFAULT_POLL = { attempts: 12, delayMilliseconds: 5_000 };

function fail(message) {
  throw new Error(`Worker public push smoke failed: ${message}`);
}

export function parseOrigin(arguments_) {
  const normalized = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  if (normalized.length !== 2 || normalized[0] !== "--origin") {
    fail("usage: smoke-worker-public-push --origin HTTPS_ORIGIN");
  }
  let origin;
  try {
    origin = new URL(normalized[1]);
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

async function operationId(fields) {
  const digest = new Uint8Array(
    await webcrypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `edgefoss:push-operation:v0\0${fields.join("\0")}`,
      ),
    ),
  );
  const id = digest.slice(0, 16);
  id[6] = (id[6] & 0x0f) | 0x50;
  id[8] = (id[8] & 0x3f) | 0x80;
  const hex = [...id]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function signedDeclaration(bytes, identity, projectId) {
  const id = await artifactId(bytes);
  const signature = new Uint8Array(
    await webcrypto.subtle.sign(
      "Ed25519",
      identity.privateKey,
      artifactSignatureMessage(id),
    ),
  );
  const derivedOperationId = await operationId([
    "publish",
    projectId,
    "public",
    id,
    "0",
    String(INITIAL_GENERATION),
  ]);
  return {
    body: JSON.stringify({
      artifactBytes: Buffer.from(bytes).toString("base64url"),
      artifactId: id,
      expectedPolicyEpoch: 0,
      operationId: derivedOperationId,
      ref: { expectedGeneration: INITIAL_GENERATION, name: "heads/main" },
      signatureBytes: Buffer.from(
        encodeSignatureRecord({
          actorKey: identity.actorKey,
          artifact: id,
          signature,
        }),
      ).toString("base64url"),
    }),
    id,
    operationId: derivedOperationId,
  };
}

export async function buildStagingPushFixture() {
  const identity = await signingIdentity();
  const genesisBytes = encodeProjectGenesis({
    actorKey: identity.actorKey,
    createdAt: "2026-08-25T00:00:00Z",
    name: "EdgeFossil staging smoke project",
    nonce: new Uint8Array(32).fill(0x53),
  });
  const projectId = await artifactId(genesisBytes);
  const treeId = await artifactId(
    encodeTree({
      actorKey: identity.actorKey,
      createdAt: "2026-08-25T00:00:01Z",
      entries: [
        { mode: "file", name: "README.md", target: REFERENCED_BLOB_ID },
      ],
      logicalClock: 1n,
      parents: [],
      project: projectId,
      realm: "public",
    }),
  );
  const previousHeadId = await artifactId(
    encodeChange({
      actorKey: identity.actorKey,
      createdAt: "2026-08-25T00:00:02Z",
      logicalClock: 2n,
      message: "Initialize staging through the P4c publish adapter",
      parents: [],
      project: projectId,
      realm: "public",
      root: treeId,
    }),
  );
  const accepted = await signedDeclaration(
    encodeChange({
      actorKey: identity.actorKey,
      createdAt: "2026-08-27T00:00:00Z",
      logicalClock: 3n,
      message: "P5b3 deterministic staging fast-forward",
      parents: [previousHeadId],
      project: projectId,
      realm: "public",
      root: treeId,
    }),
    identity,
    projectId,
  );
  const conflict = await signedDeclaration(
    encodeChange({
      actorKey: identity.actorKey,
      createdAt: "2026-08-27T00:00:01Z",
      logicalClock: 3n,
      message: "P5b3 deterministic stale sibling",
      parents: [previousHeadId],
      project: projectId,
      realm: "public",
      root: treeId,
    }),
    identity,
    projectId,
  );
  return { accepted, conflict, previousHeadId, projectId, treeId };
}

async function requestJson(fetchImplementation, url, init, expectedStatus) {
  let response;
  try {
    response = await fetchImplementation(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail(`${init.method ?? "GET"} ${new URL(url).pathname} request failed`);
  }
  if (response.status !== expectedStatus) {
    fail(
      `${init.method ?? "GET"} ${new URL(url).pathname} returned ${response.status}`,
    );
  }
  if (
    response.headers.get("cache-control") !== "no-store" ||
    response.headers.get("x-content-type-options") !== "nosniff" ||
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    fail(`${new URL(url).pathname} response headers are invalid`);
  }
  try {
    return JSON.parse(await readBoundedText(response, MAX_RESPONSE_BYTES));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Worker public push")
    ) {
      throw error;
    }
    fail(`${new URL(url).pathname} did not return bounded JSON`);
  }
}

async function preflight(fetchImplementation, origin, authorization, fixture) {
  const artifactIds = [fixture.accepted.id, fixture.conflict.id].sort();
  const body = await requestJson(
    fetchImplementation,
    `${origin}/api/v0/sync/push/preflight`,
    {
      body: JSON.stringify({
        artifactIds,
        blobIds: [],
        projectId: fixture.projectId,
        protocolVersion: 0,
        realm: "public",
      }),
      headers: { authorization, "content-type": "application/json" },
      method: "POST",
    },
    200,
  );
  const value = body?.preflight;
  if (
    !exactKeys(body, ["preflight"]) ||
    !exactKeys(value, [
      "limits",
      "missingArtifactIds",
      "missingBlobIds",
      "snapshot",
      "status",
    ]) ||
    value.status !== "ok" ||
    !exactKeys(value.limits, ["maxArtifactIds", "maxBlobIds"]) ||
    value.limits.maxArtifactIds !== 256 ||
    value.limits.maxBlobIds !== 256 ||
    !Array.isArray(value.missingArtifactIds) ||
    !Array.isArray(value.missingBlobIds) ||
    value.missingBlobIds.length !== 0 ||
    !exactKeys(value.snapshot, [
      "acceptedSequence",
      "policyEpoch",
      "projectId",
      "ref",
    ]) ||
    value.snapshot.policyEpoch !== 0 ||
    value.snapshot.projectId !== fixture.projectId
  ) {
    fail("preflight response does not match the P5b3 contract");
  }
  return value;
}

function classifyPreflight(value, fixture) {
  const initialMissing = [fixture.accepted.id, fixture.conflict.id].sort();
  if (
    value.snapshot.acceptedSequence === INITIAL_SEQUENCE &&
    sameRef(value.snapshot.ref, INITIAL_GENERATION, fixture.previousHeadId) &&
    sameStrings(value.missingArtifactIds, initialMissing)
  ) {
    return "initial";
  }
  if (
    value.snapshot.acceptedSequence === FINAL_SEQUENCE &&
    sameRef(value.snapshot.ref, FINAL_GENERATION, fixture.accepted.id) &&
    sameStrings(value.missingArtifactIds, [fixture.conflict.id])
  ) {
    return "converged";
  }
  fail("staging is not at the exact approved initial or converged state");
}

async function publishAccepted(
  fetchImplementation,
  origin,
  authorization,
  input,
) {
  const body = await requestJson(
    fetchImplementation,
    `${origin}/api/v0/artifacts`,
    {
      body: input.body,
      headers: { authorization, "content-type": "application/json" },
      method: "POST",
    },
    200,
  );
  const publication = body?.publication;
  if (
    !exactKeys(body, ["publication"]) ||
    !exactKeys(publication, [
      "artifactId",
      "kind",
      "policyEpoch",
      "realm",
      "ref",
      "repoSequence",
      "status",
    ]) ||
    publication.status !== "accepted" ||
    publication.artifactId !== input.id ||
    publication.kind !== "change" ||
    publication.policyEpoch !== 0 ||
    publication.realm !== "public" ||
    publication.repoSequence !== FINAL_SEQUENCE ||
    !sameRef(publication.ref, FINAL_GENERATION, input.id)
  ) {
    fail("fast-forward publication is invalid");
  }
  return publication;
}

async function publishConflict(
  fetchImplementation,
  origin,
  authorization,
  fixture,
) {
  const body = await requestJson(
    fetchImplementation,
    `${origin}/api/v0/artifacts`,
    {
      body: fixture.conflict.body,
      headers: { authorization, "content-type": "application/json" },
      method: "POST",
    },
    409,
  );
  const expected = {
    code: "ref_conflict",
    currentGeneration: FINAL_GENERATION,
    currentTargetArtifactId: fixture.accepted.id,
    status: "ref_conflict",
  };
  if (JSON.stringify(body) !== JSON.stringify({ publication: expected })) {
    fail("stale sibling did not return the exact ref conflict");
  }
  return body.publication;
}

async function outbox(fetchImplementation, origin, authorization) {
  const body = await requestJson(
    fetchImplementation,
    `${origin}/api/v0/outbox/${FINAL_SEQUENCE}`,
    { headers: { authorization }, method: "GET" },
    200,
  );
  if (
    !exactKeys(body, ["outbox"]) ||
    !exactKeys(body.outbox, ["event", "totals"])
  ) {
    fail("outbox response is invalid");
  }
  const { event, totals } = body.outbox;
  if (
    !exactKeys(totals, ["delivered", "enqueued", "pending"]) ||
    ![totals.delivered, totals.enqueued, totals.pending].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  ) {
    fail("outbox totals are invalid");
  }
  if (event === null) return body.outbox;
  if (
    !exactKeys(event, [
      "deliveredAt",
      "enqueuedAt",
      "lastSendAttemptAt",
      "phase",
      "repoSequence",
      "sendAttempts",
    ]) ||
    event.repoSequence !== FINAL_SEQUENCE ||
    !["pending", "enqueued", "delivered"].includes(event.phase) ||
    !Number.isSafeInteger(event.sendAttempts) ||
    event.sendAttempts < 0 ||
    !validOptionalTime(event.lastSendAttemptAt) ||
    !validOptionalTime(event.enqueuedAt) ||
    !validOptionalTime(event.deliveredAt) ||
    (event.phase === "pending" &&
      (event.sendAttempts !== 0 ||
        event.enqueuedAt !== null ||
        event.deliveredAt !== null)) ||
    (event.phase === "enqueued" &&
      (event.sendAttempts < 1 ||
        event.enqueuedAt === null ||
        event.deliveredAt !== null)) ||
    (event.phase === "delivered" &&
      (event.sendAttempts < 1 ||
        event.enqueuedAt === null ||
        event.deliveredAt === null))
  ) {
    fail("outbox event is invalid");
  }
  return body.outbox;
}

async function outboxMatch(
  fetchImplementation,
  origin,
  authorization,
  artifactId_,
) {
  const body = await requestJson(
    fetchImplementation,
    `${origin}/api/v0/outbox/${FINAL_SEQUENCE}/match`,
    {
      body: JSON.stringify({ artifactId: artifactId_ }),
      headers: { authorization, "content-type": "application/json" },
      method: "POST",
    },
    200,
  );
  if (
    !exactKeys(body, ["match"]) ||
    !exactKeys(body.match, ["exists", "matches", "repoSequence"]) ||
    typeof body.match.exists !== "boolean" ||
    typeof body.match.matches !== "boolean" ||
    body.match.repoSequence !== FINAL_SEQUENCE ||
    (!body.match.exists && body.match.matches)
  ) {
    fail("outbox artifact match is invalid");
  }
  return body.match;
}

export async function smokeWorkerPublicPush({
  origin,
  token,
  fetchImplementation = fetch,
  poll = DEFAULT_POLL,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  if (origin !== STAGING_ORIGIN) {
    fail("origin is not the approved staging Worker");
  }
  if (!OWNER_TOKEN_PATTERN.test(token)) {
    fail("owner token is missing or invalid");
  }
  if (
    !Number.isSafeInteger(poll.attempts) ||
    poll.attempts < 1 ||
    !Number.isSafeInteger(poll.delayMilliseconds) ||
    poll.delayMilliseconds < 0
  ) {
    fail("poll options are invalid");
  }
  const authorization = `Bearer ${token}`;
  const health = await requestJson(
    fetchImplementation,
    `${origin}/health`,
    { method: "GET" },
    200,
  );
  if (health?.components?.repository?.schemaVersion !== 5) {
    fail("health did not report repository schema version 5");
  }

  const fixture = await buildStagingPushFixture();
  const initial = await preflight(
    fetchImplementation,
    origin,
    authorization,
    fixture,
  );
  const initialState = classifyPreflight(initial, fixture);
  const initialOutbox = await outbox(
    fetchImplementation,
    origin,
    authorization,
  );
  const initialMatch = await outboxMatch(
    fetchImplementation,
    origin,
    authorization,
    fixture.accepted.id,
  );
  if (
    (initialState === "initial" &&
      (initialOutbox.event !== null || initialMatch.exists)) ||
    (initialState === "converged" &&
      (initialOutbox.event === null ||
        !initialMatch.exists ||
        !initialMatch.matches))
  ) {
    fail("sequence 5 outbox does not match the preflight state");
  }

  const accepted = await publishAccepted(
    fetchImplementation,
    origin,
    authorization,
    fixture.accepted,
  );
  const acceptedRetry = await publishAccepted(
    fetchImplementation,
    origin,
    authorization,
    fixture.accepted,
  );
  if (JSON.stringify(accepted) !== JSON.stringify(acceptedRetry)) {
    fail("fast-forward retry diverged");
  }
  const conflict = await publishConflict(
    fetchImplementation,
    origin,
    authorization,
    fixture,
  );
  const conflictRetry = await publishConflict(
    fetchImplementation,
    origin,
    authorization,
    fixture,
  );
  if (JSON.stringify(conflict) !== JSON.stringify(conflictRetry)) {
    fail("ref conflict retry diverged");
  }

  const final = await preflight(
    fetchImplementation,
    origin,
    authorization,
    fixture,
  );
  if (classifyPreflight(final, fixture) !== "converged") {
    fail("final preflight did not converge");
  }
  let latest;
  for (let attempt = 1; attempt <= poll.attempts; attempt += 1) {
    latest = await outbox(fetchImplementation, origin, authorization);
    const match = await outboxMatch(
      fetchImplementation,
      origin,
      authorization,
      fixture.accepted.id,
    );
    if (!match.exists || !match.matches) {
      fail("sequence 5 belongs to another artifact");
    }
    if (latest.event?.phase === "delivered") break;
    if (attempt < poll.attempts) await sleep(poll.delayMilliseconds);
  }
  if (latest?.event?.phase !== "delivered" || latest.event.sendAttempts < 1) {
    fail("sequence 5 Queue delivery did not converge");
  }

  return {
    acceptedSequence: FINAL_SEQUENCE,
    conflictArtifactAccepted: false,
    conflictRetryConverged: true,
    deliveryPhase: "delivered",
    initialState,
    newR2WritePerformed: false,
    policyEpoch: 0,
    refGeneration: FINAL_GENERATION,
    retryConverged: true,
    sendAttempts: latest.event.sendAttempts,
    state: "converged",
  };
}

function sameRef(value, generation, targetArtifactId) {
  return (
    exactKeys(value, ["generation", "name", "targetArtifactId"]) &&
    value.generation === generation &&
    value.name === "heads/main" &&
    value.targetArtifactId === targetArtifactId
  );
}

function sameStrings(left, right) {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function validOptionalTime(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
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
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        fail(`response exceeded ${maximumBytes} bytes`);
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

async function main() {
  const origin = parseOrigin(process.argv.slice(2));
  const result = await smokeWorkerPublicPush({
    origin,
    token: process.env.EDGEFOSS_OWNER_TOKEN ?? "",
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
