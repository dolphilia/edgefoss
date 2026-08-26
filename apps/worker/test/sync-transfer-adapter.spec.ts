import {
  artifactId,
  artifactSignatureMessage,
  decodeBundleManifest,
  decodeSignatureRecord,
  encodeSignatureRecord,
  encodeTree,
  verifyBundleObjects,
} from "@edgefoss/protocol";
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import vector from "../../../spec/vectors/public-clone-v0.json";
import worker, {
  type PublishArtifactInput,
  type RepositoryDO,
} from "../src/index";
import { openPublicTransferGrant } from "../src/sync-grant";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
type RepositoryStub = DurableObjectStub<RepositoryDO>;

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(
    hex.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
}

function base64url(value: string): Uint8Array {
  const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function vectorObjects(): Map<string, Uint8Array> {
  return new Map(
    Object.entries(vector.files).map(([path, body]) => [path, bytes(body)]),
  );
}

async function publishVectorArtifact(
  repository: RepositoryStub,
  artifactIdValue: string,
  operationId: string,
): Promise<void> {
  const objects = vectorObjects();
  const artifactBytes = objects.get(
    `artifacts/${artifactIdValue.slice(7)}.cbor`,
  );
  const signatureBytes = [...objects.entries()]
    .filter(([path]) => path.startsWith("signatures/"))
    .map(([, body]) => body)
    .find((body) => decodeSignatureRecord(body).artifact === artifactIdValue);
  if (artifactBytes === undefined || signatureBytes === undefined) {
    throw new Error("vector publication object missing");
  }
  await expect(
    repository.publishArtifact({
      artifactBytes: copyBuffer(artifactBytes),
      artifactId: artifactIdValue,
      expectedPolicyEpoch: 0,
      operationId,
      principalId: "owner",
      ref:
        artifactIdValue === vector.head_artifact_id
          ? { expectedGeneration: 0, name: "heads/main" }
          : null,
      signatureBytes: copyBuffer(signatureBytes),
    }),
  ).resolves.toMatchObject({ status: "accepted" });
}

async function publishDanglingTree(
  repository: RepositoryStub,
): Promise<string> {
  const actorKey = bytes(vector.actor_key_hex);
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    {
      crv: "Ed25519",
      d: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
      ext: true,
      key_ops: ["sign"],
      kty: "OKP",
      x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
    },
    "Ed25519",
    false,
    ["sign"],
  );
  const artifactBytes = encodeTree({
    actorKey,
    createdAt: "2026-08-26T12:00:03Z",
    entries: [],
    logicalClock: 1n,
    parents: [],
    project: vector.project_id,
    realm: "public",
  });
  const artifactIdValue = await artifactId(artifactBytes);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      privateKey,
      artifactSignatureMessage(artifactIdValue),
    ),
  );
  const input: PublishArtifactInput = {
    artifactBytes: copyBuffer(artifactBytes),
    artifactId: artifactIdValue,
    expectedPolicyEpoch: 0,
    operationId: "7a000000-0000-4000-8000-000000000005",
    principalId: "owner",
    ref: null,
    signatureBytes: copyBuffer(
      encodeSignatureRecord({
        actorKey,
        artifact: artifactIdValue,
        signature,
      }),
    ),
  };
  const result = await repository.publishArtifact(input);
  if (result.status !== "accepted") {
    throw new Error(`dangling publication failed: ${JSON.stringify(result)}`);
  }
  return artifactIdValue;
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

function planUrl(): string {
  const url = new URL("https://edgefoss.test/api/v0/sync/transfers");
  url.searchParams.set("profile", "complete");
  url.searchParams.set("project", vector.project_id);
  url.searchParams.set("protocol", "0");
  url.searchParams.set("view", "public");
  return url.toString();
}

describe("anonymous public transfer HTTP adapter", () => {
  it("resumes an exact clone with an opaque bounded grant and fails closed", async () => {
    const repository = env.REPOSITORY.getByName("edgefoss-single-project-v0");
    await publishVectorArtifact(
      repository,
      vector.publish_order[0]!,
      "7a000000-0000-4000-8000-000000000001",
    );
    const objects = vectorObjects();
    const blobEntry = [...objects.entries()].find(([path]) =>
      path.startsWith("blobs/"),
    );
    if (blobEntry === undefined) throw new Error("vector blob missing");
    const [blobPath, blobBytes] = blobEntry;
    const blobId = `sha256:${blobPath.slice(6, -4)}`;
    const begun = await repository.beginUpload({
      blobId,
      byteSize: blobBytes.byteLength,
      operationId: "7a000000-0000-4000-8000-000000000002",
      principalId: "owner",
      realm: "public",
    });
    if (begun.status !== "ok") throw new Error("vector upload conflict");
    await repository.stageUpload(
      "owner",
      begun.upload.uploadId,
      copyBuffer(blobBytes),
    );
    await repository.finalizeUpload("owner", begun.upload.uploadId);
    await publishVectorArtifact(
      repository,
      vector.publish_order[1]!,
      "7a000000-0000-4000-8000-000000000003",
    );
    await publishVectorArtifact(
      repository,
      vector.publish_order[2]!,
      "7a000000-0000-4000-8000-000000000004",
    );
    const danglingId = await publishDanglingTree(repository);

    const planned = await fetchWorker(planUrl(), { body: "", method: "POST" });
    expect(planned.status).toBe(200);
    expect(planned.headers.get("cache-control")).toBe("no-store");
    const body = await planned.json<{
      transfer: {
        expiresAt: number;
        grant: string;
        grantTtlSeconds: number;
        plan: {
          artifactIds: string[];
          blobs: Array<{ blobId: string; byteSize: number }>;
          manifestCbor: string;
          profile: string;
          ref: { generation: number; name: string; targetArtifactId: string };
          semanticRoot: string;
          signatureIds: string[];
        };
        status: string;
      };
    }>();
    const { grant, plan } = body.transfer;
    expect(grant).toMatch(/^efoss_transfer_v0_[A-Za-z0-9_-]+$/u);
    expect(grant).not.toContain("sha256");
    expect(grant).not.toContain(vector.project_id);
    expect(body.transfer.grantTtlSeconds).toBe(600);
    expect(plan.artifactIds).not.toContain(danglingId);
    expect(base64url(plan.manifestCbor)).toEqual(
      bytes(vector.manifest_cbor_hex),
    );

    await runInDurableObject(repository, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ key: string }>(
            "SELECT key FROM edgefoss_meta WHERE key = 'sync_cursor_key_v0'",
          )
          .toArray(),
      ).toEqual([{ key: "sync_cursor_key_v0" }]);
      await expect(
        openPublicTransferGrant(
          state.storage.sql,
          grant,
          Number.MAX_SAFE_INTEGER,
        ),
      ).resolves.toEqual({
        code: "transfer_grant_expired",
        status: "rejected",
      });
    });

    const artifactRequest = {
      body: JSON.stringify({ artifactIds: plan.artifactIds }),
      headers: {
        authorization: `Bearer ${grant}`,
        "content-type": "application/json",
      },
      method: "POST",
    };
    const transferred = await fetchWorker(
      "https://edgefoss.test/api/v0/sync/transfers/artifacts",
      artifactRequest,
    );
    expect(transferred.status).toBe(200);
    const transferredText = await transferred.text();
    const replay = await fetchWorker(
      "https://edgefoss.test/api/v0/sync/transfers/artifacts",
      artifactRequest,
    );
    expect(await replay.text()).toBe(transferredText);
    const artifactBody = JSON.parse(transferredText) as {
      transfer: {
        items: Array<{
          artifactCbor: string;
          artifactId: string;
          signatureCbor: string;
        }>;
      };
    };
    const assembled = new Map<string, Uint8Array>();
    for (const item of artifactBody.transfer.items) {
      const artifactBytes = base64url(item.artifactCbor);
      const signatureBytes = base64url(item.signatureCbor);
      assembled.set(
        `artifacts/${item.artifactId.slice(7)}.cbor`,
        artifactBytes,
      );
      assembled.set(
        `signatures/${(await artifactId(signatureBytes)).slice(7)}.cbor`,
        signatureBytes,
      );
    }

    const firstLength = 10;
    const blobUrl = (offset: number, length: number) =>
      `https://edgefoss.test/api/v0/sync/transfers/blobs/${blobId}?length=${length}&offset=${offset}`;
    const first = await fetchWorker(blobUrl(0, firstLength), {
      headers: { authorization: `Bearer ${grant}` },
    });
    const second = await fetchWorker(
      blobUrl(firstLength, blobBytes.byteLength - firstLength),
      { headers: { authorization: `Bearer ${grant}` } },
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("application/octet-stream");
    expect(first.headers.get("x-edgefoss-offset")).toBe("0");
    expect(first.headers.get("x-edgefoss-complete")).toBe("false");
    expect(second.headers.get("x-edgefoss-complete")).toBe("true");
    const restoredBlob = new Uint8Array(blobBytes.byteLength);
    restoredBlob.set(new Uint8Array(await first.arrayBuffer()), 0);
    const secondBytes = new Uint8Array(await second.arrayBuffer());
    restoredBlob.set(secondBytes, firstLength);
    const secondReplay = await fetchWorker(
      blobUrl(firstLength, blobBytes.byteLength - firstLength),
      { headers: { authorization: `Bearer ${grant}` } },
    );
    expect(new Uint8Array(await secondReplay.arrayBuffer())).toEqual(
      secondBytes,
    );
    assembled.set(blobPath, restoredBlob);
    await expect(
      verifyBundleObjects(
        decodeBundleManifest(bytes(vector.manifest_cbor_hex)),
        assembled,
      ),
    ).resolves.toBeUndefined();

    const unavailable = await fetchWorker(
      "https://edgefoss.test/api/v0/sync/transfers/artifacts",
      {
        body: JSON.stringify({ artifactIds: [danglingId] }),
        headers: {
          authorization: `Bearer ${grant}`,
          "content-type": "application/json",
        },
        method: "POST",
      },
    );
    expect(unavailable.status).toBe(404);

    const noGrant = await fetchWorker(blobUrl(0, firstLength));
    const replacement = grant.endsWith("A") ? "B" : "A";
    const tampered = await fetchWorker(blobUrl(0, firstLength), {
      headers: {
        authorization: `Bearer ${grant.slice(0, -1)}${replacement}`,
      },
    });
    expect(noGrant.status).toBe(401);
    expect(tampered.status).toBe(401);
    expect(await noGrant.json()).toEqual(await tampered.json());
    expect(noGrant.headers.get("www-authenticate")).toBe(
      'Bearer realm="edgefoss-public-transfer"',
    );

    await repository.advancePolicyEpoch({
      expectedPolicyEpoch: 0,
      operationId: "7a000000-0000-4000-8000-000000000006",
      principalId: "owner",
    });
    const stale = await fetchWorker(
      "https://edgefoss.test/api/v0/sync/transfers/artifacts",
      artifactRequest,
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      error: { code: "snapshot_stale" },
    });

    const duplicate = await fetchWorker(`${planUrl()}&profile=complete`, {
      method: "POST",
    });
    const wrongMethod = await fetchWorker(planUrl());
    const nonemptyBody = await fetchWorker(planUrl(), {
      body: "x",
      method: "POST",
    });
    expect(duplicate.status).toBe(400);
    expect(wrongMethod.status).toBe(405);
    expect(nonemptyBody.status).toBe(413);
    await expect(nonemptyBody.json()).resolves.toMatchObject({
      error: { code: "request_body_too_large" },
    });
    await expect(repository.health()).resolves.toMatchObject({
      schemaVersion: 5,
    });
  });
});

function copyBuffer(value: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(value.byteLength);
  new Uint8Array(result).set(value);
  return result;
}
