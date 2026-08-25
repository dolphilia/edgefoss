import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

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
          schemaVersion: 2,
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
      schemaVersion: 2,
      status: "ok",
      storage: "sqlite",
    });
    await expect(repository.health()).resolves.toEqual({
      schemaVersion: 2,
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
});
