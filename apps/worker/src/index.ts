import { DurableObject } from "cloudflare:workers";

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
} as const;

const SINGLE_PROJECT_AUTHORITY = "edgefoss-single-project-v0";
const REPOSITORY_SCHEMA_VERSION = 1;

export interface RepositoryHealth {
  schemaVersion: number;
  status: "ok";
  storage: "sqlite";
}

export class RepositoryDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS edgefoss_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT
    `);
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO edgefoss_meta (key, value) VALUES (?, ?)",
      "schema_version",
      String(REPOSITORY_SCHEMA_VERSION),
    );
  }

  health(): RepositoryHealth {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM edgefoss_meta WHERE key = ?",
        "schema_version",
      )
      .one();

    if (row.value !== String(REPOSITORY_SCHEMA_VERSION)) {
      throw new Error("RepositoryDO schema version is unsupported.");
    }

    return {
      schemaVersion: REPOSITORY_SCHEMA_VERSION,
      status: "ok",
      storage: "sqlite",
    };
  }
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (
      (request.method === "GET" || request.method === "HEAD") &&
      url.pathname === "/health"
    ) {
      const repository = env.REPOSITORY.getByName(SINGLE_PROJECT_AUTHORITY, {
        locationHint: "apac-ne",
      });
      const repositoryHealth = await repository.health();
      const body = {
        components: {
          repository: repositoryHealth,
          r2: {
            exports: "bound",
            publicBlobs: "bound",
            restrictedBlobs: "bound",
          },
        },
        edition: "single",
        environment: env.EDGEFOSS_ENV,
        service: "edgefoss",
        status: "ok",
      };

      if (request.method === "HEAD") {
        return new Response(null, { headers: JSON_HEADERS });
      }

      return jsonResponse(body);
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
