const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
} as const;

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        environment: env.EDGEFOSS_ENV,
        service: "edgefoss",
        status: "ok",
      });
    }

    return jsonResponse(
      {
        error: {
          code: "not_found",
          message: "The requested resource does not exist.",
        },
      },
      404,
    );
  },
} satisfies ExportedHandler<Env>;
