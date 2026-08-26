import {
  artifactId,
  artifactSignatureMessage,
  encodeProjectGenesis,
  encodeSignatureRecord,
  encodeTree,
} from "@edgefoss/protocol";
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import worker, {
  type PublishArtifactInput,
  type RepositoryDO,
} from "../src/index";
import { openPublicInventoryCursor } from "../src/sync-inventory";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
type RepositoryStub = DurableObjectStub<RepositoryDO>;

interface SigningIdentity {
  actorKey: Uint8Array;
  privateKey: CryptoKey;
}

interface InventoryHttpBody {
  inventory: {
    items: Array<{ artifactId: string; kind: string }>;
    nextCursor: string | null;
    status: "ok";
  };
}

let identity: SigningIdentity;
let projectId: string;
let publicId: string;
let hiddenId: string;

async function signingIdentity(): Promise<SigningIdentity> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  return {
    actorKey: new Uint8Array(
      await crypto.subtle.exportKey("raw", pair.publicKey),
    ),
    privateKey: pair.privateKey,
  };
}

async function publishInput(
  bytes: Uint8Array,
  identity: SigningIdentity,
  operationId: string,
): Promise<PublishArtifactInput> {
  const id = await artifactId(bytes);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      identity.privateKey,
      copyBuffer(artifactSignatureMessage(id)),
    ),
  );
  return {
    artifactBytes: copyBuffer(bytes),
    artifactId: id,
    expectedPolicyEpoch: 0,
    operationId,
    principalId: "owner",
    ref: null,
    signatureBytes: copyBuffer(
      encodeSignatureRecord({
        actorKey: identity.actorKey,
        artifact: id,
        signature,
      }),
    ),
  };
}

async function initializeProject(
  repository: RepositoryStub,
  identity: SigningIdentity,
  operationId: string,
): Promise<string> {
  const input = await publishInput(
    encodeProjectGenesis({
      actorKey: identity.actorKey,
      createdAt: "2026-08-25T00:00:00Z",
      name: "P5a adapter test project",
      nonce: new Uint8Array(32).fill(0x5b),
    }),
    identity,
    operationId,
  );
  await expect(repository.publishArtifact(input)).resolves.toMatchObject({
    status: "accepted",
  });
  return input.artifactId;
}

async function publishTree(
  repository: RepositoryStub,
  identity: SigningIdentity,
  projectId: string,
  realm: "members" | "public",
  logicalClock: bigint,
  operationId: string,
): Promise<string> {
  const input = await publishInput(
    encodeTree({
      actorKey: identity.actorKey,
      createdAt: `2026-08-25T00:00:${logicalClock.toString().padStart(2, "0")}Z`,
      entries: [],
      logicalClock,
      parents: [],
      project: projectId,
      realm,
    }),
    identity,
    operationId,
  );
  await expect(repository.publishArtifact(input)).resolves.toMatchObject({
    status: "accepted",
  });
  return input.artifactId;
}

async function fetchWorker(url: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(
    new IncomingRequest(url, init),
    env,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

function inventoryUrl(
  projectId: string,
  limit: number,
  cursor?: string,
): string {
  const url = new URL("https://edgefoss.test/api/v0/inventory");
  url.searchParams.set("project", projectId);
  url.searchParams.set("protocol", "0");
  url.searchParams.set("view", "public");
  url.searchParams.set("limit", String(limit));
  if (cursor !== undefined) url.searchParams.set("cursor", cursor);
  return url.toString();
}

describe("anonymous public sync HTTP adapter", () => {
  beforeAll(async () => {
    const repository = env.REPOSITORY.getByName("edgefoss-single-project-v0");
    identity = await signingIdentity();
    projectId = await initializeProject(
      repository,
      identity,
      "74000000-0000-4000-8000-000000000001",
    );
    publicId = await publishTree(
      repository,
      identity,
      projectId,
      "public",
      1n,
      "74000000-0000-4000-8000-000000000002",
    );
    hiddenId = await publishTree(
      repository,
      identity,
      projectId,
      "members",
      2n,
      "74000000-0000-4000-8000-000000000003",
    );
  });

  it("negotiates the exact implemented capability without authentication", async () => {
    const response = await fetchWorker(
      "https://edgefoss.test/api/v0/sync/hello?protocol=0&view=public",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("www-authenticate")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      hello: {
        capabilities: {
          inventory: {
            cursor: "opaque",
            cursorTtlSeconds: 600,
            maxPageItems: 1_000,
            ordering: "artifact_id_asc",
          },
          phases: ["HELLO", "INVENTORY", "TRANSFER"],
          transfer: {
            grant: "opaque",
            grantTtlSeconds: 600,
            maxArtifactBytes: 2_097_152,
            maxArtifactItems: 16,
            maxBlobChunkBytes: 1_048_576,
            profiles: ["complete"],
          },
        },
        principalId: "anonymous",
        projectId,
        protocolVersion: 0,
        status: "accepted",
        view: { id: "public", realms: ["public"] },
      },
    });

    const duplicate = await fetchWorker(
      "https://edgefoss.test/api/v0/sync/hello?protocol=0&protocol=0&view=public",
    );
    expect(duplicate.status).toBe(400);
    const method = await fetchWorker(
      "https://edgefoss.test/api/v0/sync/hello?protocol=0&view=public",
      { method: "POST" },
    );
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET");
  });

  it("returns public-only pages with an encrypted and authenticated cursor", async () => {
    const repository = env.REPOSITORY.getByName("edgefoss-single-project-v0");

    const first = await fetchWorker(inventoryUrl(projectId, 1));
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const firstBody = await first.json<InventoryHttpBody>();
    expect(firstBody.inventory.items).toHaveLength(1);
    const cursor = firstBody.inventory.nextCursor;
    expect(cursor).toMatch(/^efoss_cursor_v0_[A-Za-z0-9_-]+$/u);
    if (cursor === null) throw new Error("expected opaque cursor");
    expect(cursor).not.toContain("sha256");
    expect(cursor).not.toContain(projectId);
    expect(cursor).not.toContain(publicId);
    expect(cursor).not.toContain(hiddenId);

    const second = await fetchWorker(inventoryUrl(projectId, 1, cursor));
    expect(second.status).toBe(200);
    const secondBody = await second.json<InventoryHttpBody>();
    const visible = [
      ...firstBody.inventory.items,
      ...secondBody.inventory.items,
    ].map((item) => item.artifactId);
    expect(visible.sort()).toEqual([projectId, publicId].sort());
    expect(visible).not.toContain(hiddenId);
    expect(secondBody.inventory.nextCursor).toBeNull();

    await runInDurableObject(repository, async (_instance, state) => {
      const keys = state.storage.sql
        .exec<{ key: string }>(
          "SELECT key FROM edgefoss_meta WHERE key = 'sync_cursor_key_v0'",
        )
        .toArray();
      expect(keys).toEqual([{ key: "sync_cursor_key_v0" }]);
      await expect(
        openPublicInventoryCursor(
          state.storage.sql,
          cursor,
          Number.MAX_SAFE_INTEGER,
        ),
      ).resolves.toEqual({ code: "cursor_expired", status: "rejected" });
      expect(
        state.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM edgefoss_meta WHERE key = 'schema_version'",
          )
          .one().value,
      ).toBe("5");
    });
  });

  it("rejects tampered and stale cursors without cryptographic detail", async () => {
    const repository = env.REPOSITORY.getByName("edgefoss-single-project-v0");
    const page = await fetchWorker(inventoryUrl(projectId, 1));
    const body = await page.json<InventoryHttpBody>();
    const cursor = body.inventory.nextCursor;
    if (cursor === null) throw new Error("expected opaque cursor");
    const replacement = cursor.endsWith("A") ? "B" : "A";
    const tamperedCursor = `${cursor.slice(0, -1)}${replacement}`;
    const tampered = await fetchWorker(
      inventoryUrl(projectId, 1, tamperedCursor),
    );
    expect(tampered.status).toBe(400);
    await expect(tampered.json()).resolves.toEqual({
      error: {
        code: "cursor_invalid",
        message: "The inventory cursor cannot be used.",
      },
    });

    await repository.advancePolicyEpoch({
      expectedPolicyEpoch: 0,
      operationId: "74000000-0000-4000-8000-000000000004",
      principalId: "owner",
    });
    const stale = await fetchWorker(inventoryUrl(projectId, 1, cursor));
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({
      error: {
        code: "cursor_stale",
        message: "The inventory cursor cannot be used.",
      },
    });
  });

  it("fails closed on malformed, duplicate, and unbounded inventory queries", async () => {
    for (const url of [
      inventoryUrl(projectId, 1_001),
      `${inventoryUrl(projectId, 1)}&limit=1`,
      `${inventoryUrl(projectId, 1)}&realm=members`,
      `${inventoryUrl(projectId, 1)}&cursor=`,
    ]) {
      const response = await fetchWorker(url);
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const method = await fetchWorker(inventoryUrl(projectId, 1), {
      method: "HEAD",
    });
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET");
  });
});

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}
