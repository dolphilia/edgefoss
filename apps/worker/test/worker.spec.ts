import { env } from "cloudflare:workers";
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
          schemaVersion: 4,
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
      schemaVersion: 4,
      status: "ok",
      storage: "sqlite",
    });
    await expect(repository.health()).resolves.toEqual({
      schemaVersion: 4,
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
