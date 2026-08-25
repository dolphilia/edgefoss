import { env } from "cloudflare:workers";
import {
  artifactId,
  artifactSignatureMessage,
  encodeChange,
  encodeProjectGenesis,
  encodeSignatureRecord,
  encodeTree,
} from "@edgefoss/protocol";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const OWNER_TOKEN =
  "efoss_owner_v0_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

async function blobId(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function authorizedHeaders(additional?: HeadersInit): Headers {
  const headers = new Headers(additional);
  headers.set("authorization", `Bearer ${OWNER_TOKEN}`);
  return headers;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function publishBody(
  bytes: Uint8Array,
  privateKey: CryptoKey,
  actorKey: Uint8Array,
  operationId: string,
  ref: { expectedGeneration: number; name: "heads/main" } | null,
): Promise<string> {
  const id = await artifactId(bytes);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      privateKey,
      artifactSignatureMessage(id),
    ),
  );
  return JSON.stringify({
    artifactBytes: base64Url(bytes),
    artifactId: id,
    expectedPolicyEpoch: 0,
    operationId,
    ref,
    signatureBytes: base64Url(
      encodeSignatureRecord({ actorKey, artifact: id, signature }),
    ),
  });
}

async function publishRequest(body: string): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(
    new IncomingRequest("https://edgefoss.test/api/v0/artifacts", {
      body,
      headers: authorizedHeaders({ "content-type": "application/json" }),
      method: "POST",
    }),
    env,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

describe("EdgeFossil Worker", () => {
  it("reports health without exposing deployment secrets", async () => {
    const request = new IncomingRequest("https://edgefoss.test/health");
    const context = createExecutionContext();

    const response = await worker.fetch(request, env, context);
    await waitOnExecutionContext(context);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({
      components: {
        repository: {
          schemaVersion: 5,
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
      environment: "dev",
      service: "edgefoss",
      status: "ok",
    });
    expect(JSON.stringify(body)).not.toContain("edgefoss-dev");
  });

  it("initializes one SQLite-backed repository authority idempotently", async () => {
    const repository = env.REPOSITORY.getByName("edgefoss-single-project-v0", {
      locationHint: "apac-ne",
    });

    await expect(repository.health()).resolves.toEqual({
      schemaVersion: 5,
      status: "ok",
      storage: "sqlite",
    });
    await expect(repository.health()).resolves.toEqual({
      schemaVersion: 5,
      status: "ok",
      storage: "sqlite",
    });
  });

  it("supports a bodyless HEAD health probe", async () => {
    const request = new IncomingRequest("https://edgefoss.test/health", {
      method: "HEAD",
    });
    const context = createExecutionContext();

    const response = await worker.fetch(request, env, context);
    await waitOnExecutionContext(context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it("returns a structured 404 for unknown paths", async () => {
    const request = new IncomingRequest("https://edgefoss.test/unknown");
    const context = createExecutionContext();

    const response = await worker.fetch(request, env, context);
    await waitOnExecutionContext(context);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "not_found",
        message: "The requested resource does not exist.",
      },
    });
  });

  it("rejects upload API access without the owner bearer token", async () => {
    const request = new IncomingRequest(
      "https://edgefoss.test/api/v0/uploads",
      {
        method: "POST",
      },
    );
    const context = createExecutionContext();

    const response = await worker.fetch(request, env, context);
    await waitOnExecutionContext(context);

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer realm="edgefoss"',
    );
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "unauthorized",
        message: "A valid owner bearer token is required.",
      },
    });
  });

  it("rejects publish API access before reading an unauthenticated body", async () => {
    const context = createExecutionContext();
    const response = await worker.fetch(
      new IncomingRequest("https://edgefoss.test/api/v0/artifacts", {
        body: "not json",
        method: "POST",
      }),
      env,
      context,
    );
    await waitOnExecutionContext(context);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "unauthorized" },
    });
  });

  it("publishes a signed genesis, tree, and change through the owner API", async () => {
    const pair = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    const actorKey = new Uint8Array(
      await crypto.subtle.exportKey("raw", pair.publicKey),
    );
    const genesisBytes = encodeProjectGenesis({
      actorKey,
      createdAt: "2026-08-25T00:00:00Z",
      name: "HTTP adapter test",
      nonce: new Uint8Array(32).fill(0x51),
    });
    const genesisBody = await publishBody(
      genesisBytes,
      pair.privateKey,
      actorKey,
      "00000000-0000-4000-8000-000000000501",
      null,
    );
    const genesisResponse = await publishRequest(genesisBody);
    expect(genesisResponse.status).toBe(200);
    const genesis = await genesisResponse.json<{
      publication: { artifactId: string; repoSequence: number };
    }>();
    expect(genesis.publication.repoSequence).toBe(1);

    const blobBytes = new TextEncoder().encode("HTTP adapter blob");
    const repository = env.REPOSITORY.getByName("edgefoss-single-project-v0", {
      locationHint: "apac-ne",
    });
    const blob = await blobId(blobBytes);
    const upload = await repository.beginUpload({
      blobId: blob,
      byteSize: blobBytes.byteLength,
      operationId: "00000000-0000-4000-8000-000000000502",
      principalId: "owner",
      realm: "public",
    });
    expect(upload.status).toBe("ok");
    if (upload.status !== "ok") throw new Error("unexpected upload conflict");
    await repository.stageUpload(
      "owner",
      upload.upload.uploadId,
      blobBytes.buffer,
    );
    await repository.finalizeUpload("owner", upload.upload.uploadId);

    const treeBytes = encodeTree({
      actorKey,
      createdAt: "2026-08-25T00:00:01Z",
      entries: [{ mode: "file", name: "README.md", target: blob }],
      logicalClock: 1n,
      parents: [],
      project: genesis.publication.artifactId,
      realm: "public",
    });
    const treeResponse = await publishRequest(
      await publishBody(
        treeBytes,
        pair.privateKey,
        actorKey,
        "00000000-0000-4000-8000-000000000503",
        null,
      ),
    );
    expect(treeResponse.status).toBe(200);
    const tree = await treeResponse.json<{
      publication: { artifactId: string; repoSequence: number };
    }>();
    expect(tree.publication.repoSequence).toBe(2);

    const changeBytes = encodeChange({
      actorKey,
      createdAt: "2026-08-25T00:00:02Z",
      logicalClock: 2n,
      message: "Publish through HTTP",
      parents: [],
      project: genesis.publication.artifactId,
      realm: "public",
      root: tree.publication.artifactId,
    });
    const changeBody = await publishBody(
      changeBytes,
      pair.privateKey,
      actorKey,
      "00000000-0000-4000-8000-000000000504",
      { expectedGeneration: 0, name: "heads/main" },
    );
    const changeResponse = await publishRequest(changeBody);
    expect(changeResponse.status).toBe(200);
    const accepted = await changeResponse.json();
    expect(accepted).toMatchObject({
      publication: {
        kind: "change",
        ref: { generation: 1, name: "heads/main" },
        repoSequence: 3,
        status: "accepted",
      },
    });
    const retryResponse = await publishRequest(changeBody);
    expect(retryResponse.status).toBe(200);
    await expect(retryResponse.json()).resolves.toEqual(accepted);

    const staleBody = await publishBody(
      changeBytes,
      pair.privateKey,
      actorKey,
      "00000000-0000-4000-8000-000000000506",
      { expectedGeneration: 0, name: "heads/main" },
    );
    const staleResponse = await publishRequest(staleBody);
    expect(staleResponse.status).toBe(409);
    await expect(staleResponse.json()).resolves.toMatchObject({
      publication: {
        code: "ref_conflict",
        currentGeneration: 1,
        status: "ref_conflict",
      },
    });

    const invalid = JSON.parse(changeBody) as Record<string, unknown>;
    invalid.artifactId = `sha256:${"0".repeat(64)}`;
    invalid.operationId = "00000000-0000-4000-8000-000000000507";
    const rejectedResponse = await publishRequest(JSON.stringify(invalid));
    expect(rejectedResponse.status).toBe(422);
    await expect(rejectedResponse.json()).resolves.toMatchObject({
      publication: { code: "artifact_invalid", status: "rejected" },
    });
  });

  it("strictly rejects malformed publish transport input", async () => {
    const response = await publishRequest(
      JSON.stringify({
        artifactBytes: "AA==",
        artifactId: "sha256:invalid",
        expectedPolicyEpoch: 0,
        operationId: "00000000-0000-4000-8000-000000000505",
        ref: null,
        signatureBytes: "AA",
        unexpected: true,
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "publish_declaration_invalid" },
    });

    const context = createExecutionContext();
    const oversized = await worker.fetch(
      new IncomingRequest("https://edgefoss.test/api/v0/artifacts", {
        body: "{}",
        headers: authorizedHeaders({
          "content-length": String(2 * 1024 * 1024 + 1),
          "content-type": "application/json",
        }),
        method: "POST",
      }),
      env,
      context,
    );
    await waitOnExecutionContext(context);
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      error: { code: "request_body_too_large" },
    });
  });

  it("stages and finalizes a bounded public blob through the authenticated API", async () => {
    const bytes = new TextEncoder().encode("authenticated public blob");
    const declarationRequest = new IncomingRequest(
      "https://edgefoss.test/api/v0/uploads",
      {
        body: JSON.stringify({
          blobId: await blobId(bytes),
          byteSize: bytes.byteLength,
          operationId: "00000000-0000-4000-8000-000000000101",
          realm: "public",
        }),
        headers: authorizedHeaders({ "content-type": "application/json" }),
        method: "POST",
      },
    );
    const declarationContext = createExecutionContext();
    const declarationResponse = await worker.fetch(
      declarationRequest,
      env,
      declarationContext,
    );
    await waitOnExecutionContext(declarationContext);
    expect(declarationResponse.status).toBe(200);
    const declaration = await declarationResponse.json<{
      upload: { uploadId: string };
    }>();

    const contentContext = createExecutionContext();
    const contentResponse = await worker.fetch(
      new IncomingRequest(
        `https://edgefoss.test/api/v0/uploads/${declaration.upload.uploadId}/content`,
        {
          body: bytes,
          headers: authorizedHeaders({
            "content-type": "application/octet-stream",
          }),
          method: "PUT",
        },
      ),
      env,
      contentContext,
    );
    await waitOnExecutionContext(contentContext);
    expect(contentResponse.status).toBe(200);
    await expect(contentResponse.json()).resolves.toMatchObject({
      upload: { failure: null, state: "staged" },
    });

    const finalizeContext = createExecutionContext();
    const finalizeResponse = await worker.fetch(
      new IncomingRequest(
        `https://edgefoss.test/api/v0/uploads/${declaration.upload.uploadId}/finalize`,
        { headers: authorizedHeaders(), method: "POST" },
      ),
      env,
      finalizeContext,
    );
    await waitOnExecutionContext(finalizeContext);
    expect(finalizeResponse.status).toBe(200);
    const finalized = await finalizeResponse.json<{
      upload: { finalKey: string; state: string };
    }>();
    expect(finalized.upload.state).toBe("finalized");
    await expect(
      env.PUBLIC_BLOBS.get(finalized.upload.finalKey).then((object) =>
        object?.text(),
      ),
    ).resolves.toBe("authenticated public blob");
  });
});
