import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

async function blobId(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

describe("RepositoryDO small blob uploads", () => {
  it("declares uploads idempotently and rejects operation reuse", async () => {
    const repository = env.REPOSITORY.getByName("upload-declare");
    const input = {
      blobId: `sha256:${"11".repeat(32)}`,
      byteSize: 12,
      operationId: "00000000-0000-4000-8000-000000000001",
      principalId: "owner",
      realm: "public" as const,
    };

    const first = await repository.beginUpload(input);
    expect(first.status).toBe("ok");
    await expect(repository.beginUpload(input)).resolves.toEqual(first);
    await expect(
      repository.beginUpload({ ...input, byteSize: 13 }),
    ).resolves.toEqual({ code: "operation_conflict", status: "conflict" });
  });

  it("verifies and finalizes a public small blob idempotently", async () => {
    const repository = env.REPOSITORY.getByName("upload-public");
    const bytes = new TextEncoder().encode("public edgefoss blob");
    const expectedBlobId = await blobId(bytes);
    const declaration = await repository.beginUpload({
      blobId: expectedBlobId,
      byteSize: bytes.byteLength,
      operationId: "00000000-0000-4000-8000-000000000003",
      principalId: "owner",
      realm: "public",
    });
    if (declaration.status !== "ok") throw new Error("unexpected conflict");
    const declared = declaration.upload;
    await env.PUBLIC_BLOBS.put(declared.stagingKey, bytes);

    const finalized = await repository.finalizeUpload(
      "owner",
      declared.uploadId,
    );
    expect(finalized).toMatchObject({
      blobId: expectedBlobId,
      failure: null,
      state: "finalized",
    });
    expect(finalized.finalKey).toContain(
      `/public/sha256/${expectedBlobId.slice(7, 9)}/${expectedBlobId.slice(7)}`,
    );
    await expect(
      repository.finalizeUpload("owner", declared.uploadId),
    ).resolves.toEqual(finalized);
    await expect(
      env.PUBLIC_BLOBS.get(finalized.finalKey!).then((object) =>
        object?.text(),
      ),
    ).resolves.toBe("public edgefoss blob");
  });

  it("keeps members blob keys and bytes out of the public bucket", async () => {
    const repository = env.REPOSITORY.getByName("upload-members");
    const bytes = new TextEncoder().encode("members edgefoss blob");
    const expectedBlobId = await blobId(bytes);
    const declaration = await repository.beginUpload({
      blobId: expectedBlobId,
      byteSize: bytes.byteLength,
      operationId: "00000000-0000-4000-8000-000000000004",
      principalId: "owner",
      realm: "members",
    });
    if (declaration.status !== "ok") throw new Error("unexpected conflict");
    const declared = declaration.upload;
    await env.RESTRICTED_BLOBS.put(declared.stagingKey, bytes);

    const finalized = await repository.finalizeUpload(
      "owner",
      declared.uploadId,
    );
    expect(finalized.finalKey).toBe(
      `objects/edgefoss-single-project-v0/members/${declared.uploadId}`,
    );
    expect(finalized.finalKey).not.toContain(expectedBlobId.slice(7));
    await expect(
      env.PUBLIC_BLOBS.head(finalized.finalKey!),
    ).resolves.toBeNull();
    await expect(
      env.RESTRICTED_BLOBS.get(finalized.finalKey!).then((object) =>
        object?.text(),
      ),
    ).resolves.toBe("members edgefoss blob");
  });

  it("linearizes concurrent finalize retries to one public blob", async () => {
    const repository = env.REPOSITORY.getByName("upload-concurrent");
    const bytes = new TextEncoder().encode("concurrent edgefoss blob");
    const declaration = await repository.beginUpload({
      blobId: await blobId(bytes),
      byteSize: bytes.byteLength,
      operationId: "00000000-0000-4000-8000-000000000006",
      principalId: "owner",
      realm: "public",
    });
    if (declaration.status !== "ok") throw new Error("unexpected conflict");
    await env.PUBLIC_BLOBS.put(declaration.upload.stagingKey, bytes);

    const results = await Promise.all([
      repository.finalizeUpload("owner", declaration.upload.uploadId),
      repository.finalizeUpload("owner", declaration.upload.uploadId),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ failure: null, state: "finalized" });
  });

  it("persists terminal checksum rejection without creating a final blob", async () => {
    const repository = env.REPOSITORY.getByName("upload-rejected");
    const expected = new TextEncoder().encode("expected bytes");
    const corrupt = new TextEncoder().encode("corrupted byte");
    expect(corrupt.byteLength).toBe(expected.byteLength);
    const declaration = await repository.beginUpload({
      blobId: await blobId(expected),
      byteSize: expected.byteLength,
      operationId: "00000000-0000-4000-8000-000000000005",
      principalId: "owner",
      realm: "public",
    });
    if (declaration.status !== "ok") throw new Error("unexpected conflict");
    const declared = declaration.upload;
    await env.PUBLIC_BLOBS.put(declared.stagingKey, corrupt);

    const rejected = await repository.finalizeUpload(
      "owner",
      declared.uploadId,
    );
    expect(rejected).toMatchObject({
      failure: "hash_mismatch",
      finalKey: null,
      state: "rejected",
    });
    await expect(
      repository.finalizeUpload("owner", declared.uploadId),
    ).resolves.toEqual(rejected);
  });
});
