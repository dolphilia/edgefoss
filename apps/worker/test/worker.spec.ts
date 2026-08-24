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
    await expect(response.json()).resolves.toEqual({
      environment: "dev",
      service: "edgefoss",
      status: "ok",
    });
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
