import {
  artifactId,
  artifactSignatureMessage,
  encodeProjectGenesis,
  encodeSignatureRecord,
} from "@edgefoss/protocol";
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import worker, {
  type PublishArtifactInput,
  type RepositoryDO,
} from "../src/index";
import {
  authorityEvent,
  drainOutbox,
  insertOutboxEvent,
  validateAuthorityEvent,
} from "../src/outbox";

type RepositoryStub = DurableObjectStub<RepositoryDO>;

class FakeQueue implements Queue<unknown> {
  readonly bodies: unknown[] = [];

  constructor(readonly fails: boolean) {}

  async metrics(): Promise<QueueMetrics> {
    return { backlogBytes: 0, backlogCount: this.bodies.length };
  }

  async send(
    message: unknown,
    _options?: QueueSendOptions,
  ): Promise<QueueSendResponse> {
    return this.sendBatch([{ body: message }]);
  }

  async sendBatch(
    messages: Iterable<MessageSendRequest<unknown>>,
    _options?: QueueSendBatchOptions,
  ): Promise<QueueSendBatchResponse> {
    if (this.fails) throw new Error("synthetic_queue_failure");
    for (const message of messages) this.bodies.push(message.body);
    return {
      metadata: {
        metrics: { backlogBytes: 0, backlogCount: this.bodies.length },
      },
    };
  }
}

async function genesisInput(
  operationId: string,
): Promise<PublishArtifactInput> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  const actorKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const artifactBytes = encodeProjectGenesis({
    actorKey,
    createdAt: "2026-08-25T00:00:00Z",
    name: "P4d outbox test",
    nonce: new Uint8Array(32).fill(0x61),
  });
  const id = await artifactId(artifactBytes);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      pair.privateKey,
      artifactSignatureMessage(id),
    ),
  );
  return {
    artifactBytes: copyBuffer(artifactBytes),
    artifactId: id,
    expectedPolicyEpoch: 0,
    operationId,
    principalId: "owner",
    ref: null,
    signatureBytes: copyBuffer(
      encodeSignatureRecord({ actorKey, artifact: id, signature }),
    ),
  };
}

describe("RepositoryDO transactional authority outbox", () => {
  it("keeps failed sends pending and marks a confirmed batch enqueued exactly once", async () => {
    const repository = env.REPOSITORY.getByName("outbox-failure-recovery");
    const input = await genesisInput("40000000-0000-4000-8000-000000000001");
    const accepted = await repository.publishArtifact(input);
    await expect(repository.publishArtifact(input)).resolves.toEqual(accepted);
    await expect(repository.outboxStatus()).resolves.toEqual({
      delivered: 0,
      enqueued: 0,
      pending: 1,
    });
    await expect(repository.outboxObservation(1)).resolves.toEqual({
      event: {
        deliveredAt: null,
        enqueuedAt: null,
        lastSendAttemptAt: null,
        phase: "pending",
        repoSequence: 1,
        sendAttempts: 0,
      },
      totals: { delivered: 0, enqueued: 0, pending: 1 },
    });
    await expect(
      repository.outboxArtifactMatch(1, input.artifactId),
    ).resolves.toEqual({ exists: true, matches: true, repoSequence: 1 });
    await expect(
      repository.outboxArtifactMatch(2, input.artifactId),
    ).resolves.toEqual({ exists: false, matches: false, repoSequence: 2 });

    const failingQueue = new FakeQueue(true);
    await expect(
      runInDurableObject(repository, (_instance, state) =>
        drainOutbox(state.storage, failingQueue, 1_000),
      ),
    ).rejects.toThrow("synthetic_queue_failure");
    await runInDurableObject(repository, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ attempts: number; state: string }>(
            "SELECT attempts, state FROM authority_outbox",
          )
          .one(),
      ).toEqual({ attempts: 1, state: "pending" });
    });
    await expect(repository.outboxObservation(1)).resolves.toMatchObject({
      event: {
        lastSendAttemptAt: 1_000,
        phase: "pending",
        sendAttempts: 1,
      },
    });

    const queue = new FakeQueue(false);
    await expect(
      runInDurableObject(repository, (_instance, state) =>
        drainOutbox(state.storage, queue, 2_000),
      ),
    ).resolves.toEqual({ attempted: 1, enqueued: 1, remaining: 0 });
    expect(queue.bodies).toHaveLength(1);
    await expect(repository.outboxStatus()).resolves.toEqual({
      delivered: 0,
      enqueued: 1,
      pending: 0,
    });
    await expect(repository.outboxObservation(1)).resolves.toMatchObject({
      event: {
        deliveredAt: null,
        enqueuedAt: 2_000,
        lastSendAttemptAt: 2_000,
        phase: "enqueued",
        repoSequence: 1,
        sendAttempts: 2,
      },
    });
    await runInDurableObject(repository, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ attempts: number; state: string }>(
            "SELECT attempts, state FROM authority_outbox",
          )
          .one(),
      ).toEqual({ attempts: 2, state: "enqueued" });
    });
  });

  it("drains a scheduled bounded batch through the local Queue producer binding", async () => {
    const repository = env.REPOSITORY.getByName("outbox-alarm");
    await repository.health();
    await runInDurableObject(repository, (_instance, state) => {
      state.storage.transactionSync(() => {
        for (let sequence = 1; sequence <= 11; sequence += 1) {
          insertOutboxEvent(
            state.storage.sql,
            authorityEvent({
              artifactId: `sha256:${sequence.toString(16).padStart(64, "0")}`,
              kind: "tree",
              policyEpoch: 0,
              realm: "public",
              ref: null,
              repoSequence: sequence,
            }),
          );
        }
      });
    });
    await repository.armOutbox();

    await expect(runDurableObjectAlarm(repository)).resolves.toBe(true);
    await expect(repository.outboxStatus()).resolves.toEqual({
      delivered: 0,
      enqueued: 10,
      pending: 1,
    });
    await expect(runDurableObjectAlarm(repository)).resolves.toBe(true);
    await expect(repository.outboxStatus()).resolves.toEqual({
      delivered: 0,
      enqueued: 11,
      pending: 0,
    });
    await expect(runDurableObjectAlarm(repository)).resolves.toBe(false);
  });

  it("idempotently records Queue consumer delivery and explicitly acknowledges it", async () => {
    const repository = env.REPOSITORY.getByName("edgefoss-single-project-v0", {
      locationHint: "apac-ne",
    });
    await repository.publishArtifact(
      await genesisInput("40000000-0000-4000-8000-000000000003"),
    );
    const queue = new FakeQueue(false);
    await runInDurableObject(repository, (_instance, state) =>
      drainOutbox(state.storage, queue, 3_000),
    );
    const event = queue.bodies[0];
    validateAuthorityEvent(event);
    const batch = createMessageBatch("edgefoss-dev-events", [
      {
        attempts: 1,
        body: event,
        id: "event-message-1",
        timestamp: new Date("2026-08-25T00:00:00Z"),
      },
    ]);
    const context = createExecutionContext();
    await worker.queue?.(batch, env, context);
    const result = await getQueueResult(batch, context);
    expect(result.explicitAcks).toEqual(["event-message-1"]);

    await expect(repository.recordEventDelivery(event)).resolves.toEqual({
      status: "duplicate",
    });
    await expect(repository.outboxStatus()).resolves.toMatchObject({
      delivered: 1,
    });
    await expect(repository.outboxObservation(1)).resolves.toMatchObject({
      event: {
        phase: "delivered",
        repoSequence: 1,
        sendAttempts: 1,
      },
      totals: { delivered: 1, enqueued: 1, pending: 0 },
    });
    await expect(repository.outboxObservation(2)).resolves.toEqual({
      event: null,
      totals: { delivered: 1, enqueued: 1, pending: 0 },
    });

    const unknownEvent = {
      ...event,
      eventId: "edgefoss-single-project-v0:2",
      repoSequence: 2,
    };
    const retryBatch = createMessageBatch("edgefoss-dev-events", [
      {
        attempts: 1,
        body: unknownEvent,
        id: "event-message-2",
        timestamp: new Date("2026-08-25T00:00:01Z"),
      },
    ]);
    const retryContext = createExecutionContext();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    await worker.queue?.(retryBatch, env, retryContext);
    errorLog.mockRestore();
    const retryResult = await getQueueResult(retryBatch, retryContext);
    expect(retryResult.retryMessages).toEqual([{ msgId: "event-message-2" }]);
  });
});

function copyBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const result = new ArrayBuffer(source.byteLength);
  new Uint8Array(result).set(source);
  return result;
}
