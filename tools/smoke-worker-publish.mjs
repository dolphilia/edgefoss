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

const OWNER_TOKEN_PATTERN = /^efoss_owner_v0_[A-Za-z0-9_-]{43}$/;
const STAGING_ORIGIN = "https://edgefoss-staging.miga-and-raia.workers.dev";
const REFERENCED_BLOB_ID =
  "sha256:d7fff80443a004a5fdbd4fdf058d7cb0b828a0d28cc4522f629bb60d841a4572";
const OPERATIONS = [
  "00000000-0000-4000-8000-000000000511",
  "00000000-0000-4000-8000-000000000512",
  "00000000-0000-4000-8000-000000000513",
];

function fail(message) {
  throw new Error(`Worker publish smoke failed: ${message}`);
}

export function parseOrigin(argv) {
  if (argv.length !== 2 || argv[0] !== "--origin") {
    fail("usage: smoke-worker-publish --origin HTTPS_ORIGIN");
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
  return {
    actorKey: Buffer.from(jwk.x, "base64url"),
    privateKey,
  };
}

async function declaration(bytes, identity, operationId, ref) {
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
      operationId,
      ref,
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
  return response.json();
}

function accepted(body, expectedId, expectedSequence) {
  const publication = body?.publication;
  if (
    publication?.status !== "accepted" ||
    publication.artifactId !== expectedId ||
    publication.repoSequence !== expectedSequence
  ) {
    fail(`publication did not accept sequence ${expectedSequence}`);
  }
  return publication;
}

async function publishTwice(fetchImpl, origin, authorization, input, sequence) {
  const init = {
    body: input.body,
    headers: { authorization, "content-type": "application/json" },
    method: "POST",
  };
  const first = accepted(
    await requestJson(fetchImpl, `${origin}/api/v0/artifacts`, init),
    input.id,
    sequence,
  );
  const retry = accepted(
    await requestJson(fetchImpl, `${origin}/api/v0/artifacts`, init),
    input.id,
    sequence,
  );
  if (JSON.stringify(first) !== JSON.stringify(retry)) {
    fail(`publication retry diverged at sequence ${sequence}`);
  }
  return first;
}

export async function smokeWorkerPublish({ origin, token, fetchImpl = fetch }) {
  if (origin !== STAGING_ORIGIN)
    fail("origin is not the approved staging Worker");
  if (!OWNER_TOKEN_PATTERN.test(token))
    fail("owner token is missing or invalid");
  const authorization = `Bearer ${token}`;
  const health = await requestJson(fetchImpl, `${origin}/health`, {
    method: "GET",
  });
  if (health?.components?.repository?.schemaVersion !== 5) {
    fail("health did not report repository schema version 5");
  }

  const identity = await signingIdentity();
  const genesisBytes = encodeProjectGenesis({
    actorKey: identity.actorKey,
    createdAt: "2026-08-25T00:00:00Z",
    name: "EdgeFossil staging smoke project",
    nonce: new Uint8Array(32).fill(0x53),
  });
  const genesisInput = await declaration(
    genesisBytes,
    identity,
    OPERATIONS[0],
    null,
  );
  const genesis = await publishTwice(
    fetchImpl,
    origin,
    authorization,
    genesisInput,
    1,
  );

  const treeInput = await declaration(
    encodeTree({
      actorKey: identity.actorKey,
      createdAt: "2026-08-25T00:00:01Z",
      entries: [
        { mode: "file", name: "README.md", target: REFERENCED_BLOB_ID },
      ],
      logicalClock: 1n,
      parents: [],
      project: genesis.artifactId,
      realm: "public",
    }),
    identity,
    OPERATIONS[1],
    null,
  );
  const tree = await publishTwice(
    fetchImpl,
    origin,
    authorization,
    treeInput,
    2,
  );

  const changeInput = await declaration(
    encodeChange({
      actorKey: identity.actorKey,
      createdAt: "2026-08-25T00:00:02Z",
      logicalClock: 2n,
      message: "Initialize staging through the P4c publish adapter",
      parents: [],
      project: genesis.artifactId,
      realm: "public",
      root: tree.artifactId,
    }),
    identity,
    OPERATIONS[2],
    { expectedGeneration: 0, name: "heads/main" },
  );
  const change = await publishTwice(
    fetchImpl,
    origin,
    authorization,
    changeInput,
    3,
  );
  if (
    change.ref?.generation !== 1 ||
    change.ref.targetArtifactId !== change.artifactId
  ) {
    fail("heads/main did not advance to generation 1");
  }

  return {
    byteSize: 30,
    changeId: change.artifactId,
    projectId: genesis.artifactId,
    r2WritePerformed: false,
    realm: "public",
    refGeneration: change.ref.generation,
    referencedBlobId: REFERENCED_BLOB_ID,
    repositorySchemaVersion: 5,
    repoSequence: change.repoSequence,
    retryConverged: true,
    state: "published",
    treeId: tree.artifactId,
  };
}

async function main() {
  const origin = parseOrigin(process.argv.slice(2));
  const token = process.env.EDGEFOSS_OWNER_TOKEN ?? "";
  const result = await smokeWorkerPublish({ origin, token });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
