import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { type RepositoryDO } from "../src/index";
import {
  authorityEvent,
  drainOutbox,
  insertOutboxEvent,
  type AuthorityEventV0,
} from "../src/outbox";
import { consumeAuthorityEventMessage } from "../src/queue-consumer";

type RepositoryStub = DurableObjectStub<RepositoryDO>;

class FailureQueue implements Queue<unknown> {
  readonly bodies: unknown[] = [];

  constructor(readonly failure: "response_lost" | null) {}

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
    for (const message of messages) this.bodies.push(message.body);
    if (this.failure === "response_lost") {
      throw new Error("synthetic_queue_response_lost");
    }
    return {
      metadata: {
        metrics: { backlogBytes: 0, backlogCount: this.bodies.length },
      },
    };
  }
}

function event(repoSequence: number): AuthorityEventV0 {
  return authorityEvent({
    artifactId: `sha256:${repoSequence.toString(16).padStart(64, "0")}`,
    kind: "tree",
    policyEpoch: 0,
    realm: "public",
    ref: null,
    repoSequence,
  });
}

async function seedOutbox(
  repository: RepositoryStub,
  events: readonly AuthorityEventV0[],
): Promise<void> {
  await repository.health();
  await runInDurableObject(repository, (_instance, state) => {
    state.storage.transactionSync(() => {
      for (const value of events) insertOutboxEvent(state.storage.sql, value);
    });
  });
}

async function consumeBatch(
  repository: RepositoryStub,
  batch: MessageBatch<unknown>,
) {
  const context = createExecutionContext();
  for (const message of batch.messages) {
    await consumeAuthorityEventMessage(message, repository, batch.queue);
  }
  return getQueueResult(batch, context);
}

describe("P4d bounded Queue failure matrix", () => {
  it("converges after Queue acceptance response loss without a second canonical effect", async () => {
    const repository = env.REPOSITORY.getByName("outbox-queue-response-loss");
    const storedEvent = event(1);
    await seedOutbox(repository, [storedEvent]);

    const lostResponseQueue = new FailureQueue("response_lost");
    await expect(
      runInDurableObject(repository, (_instance, state) =>
        drainOutbox(state.storage, lostResponseQueue, 1_000),
      ),
    ).rejects.toThrow("synthetic_queue_response_lost");
    expect(lostResponseQueue.bodies).toEqual([storedEvent]);
    await expect(repository.outboxObservation(1)).resolves.toMatchObject({
      event: { phase: "pending", sendAttempts: 1 },
      totals: { delivered: 0, enqueued: 0, pending: 1 },
    });

    const firstDelivery = createMessageBatch("edgefoss-dev-events", [
      {
        attempts: 1,
        body: lostResponseQueue.bodies[0],
        id: "response-lost-message",
        timestamp: new Date(1_000),
      },
    ]);
    await expect(
      consumeBatch(repository, firstDelivery),
    ).resolves.toMatchObject({
      explicitAcks: ["response-lost-message"],
      retryMessages: [],
    });
    await expect(repository.outboxObservation(1)).resolves.toMatchObject({
      event: { phase: "delivered", sendAttempts: 1 },
      totals: { delivered: 1, enqueued: 0, pending: 1 },
    });

    const recoveryQueue = new FailureQueue(null);
    await expect(
      runInDurableObject(repository, (_instance, state) =>
        drainOutbox(state.storage, recoveryQueue, 2_000),
      ),
    ).resolves.toEqual({ attempted: 1, enqueued: 1, remaining: 0 });
    expect(recoveryQueue.bodies).toEqual([storedEvent]);

    const duplicateDelivery = createMessageBatch("edgefoss-dev-events", [
      {
        attempts: 2,
        body: recoveryQueue.bodies[0],
        id: "duplicate-message",
        timestamp: new Date(2_000),
      },
    ]);
    await expect(
      consumeBatch(repository, duplicateDelivery),
    ).resolves.toMatchObject({
      explicitAcks: ["duplicate-message"],
      retryMessages: [],
    });
    await expect(repository.outboxObservation(1)).resolves.toMatchObject({
      event: { phase: "delivered", sendAttempts: 2 },
      totals: { delivered: 1, enqueued: 1, pending: 0 },
    });

    await runInDurableObject(repository, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            `SELECT
               (SELECT COUNT(*) FROM artifacts) +
               (SELECT COUNT(*) FROM operations) +
               (SELECT COUNT(*) FROM receipts) AS count`,
          )
          .one().count,
      ).toBe(0);
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM authority_outbox",
          )
          .one().count,
      ).toBe(1);
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM authority_event_deliveries",
          )
          .one().count,
      ).toBe(1);
    });
  });

  it("isolates out-of-order successes from invalid retries through the DLQ budget", async () => {
    const repository = env.REPOSITORY.getByName("outbox-queue-reorder");
    const first = event(1);
    const second = event(2);
    await seedOutbox(repository, [first, second]);
    const queue = new FailureQueue(null);
    await runInDurableObject(repository, (_instance, state) =>
      drainOutbox(state.storage, queue, 3_000),
    );

    const invalidBody = { privateArtifactId: `sha256:${"f".repeat(64)}` };
    const mixedBatch = createMessageBatch("edgefoss-dev-events", [
      {
        attempts: 1,
        body: second,
        id: "message-sequence-2",
        timestamp: new Date(3_002),
      },
      {
        attempts: 1,
        body: invalidBody,
        id: "invalid-message-1",
        timestamp: new Date(3_001),
      },
      {
        attempts: 1,
        body: first,
        id: "message-sequence-1",
        timestamp: new Date(3_000),
      },
    ]);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await consumeBatch(repository, mixedBatch);
    expect(result.explicitAcks).toEqual([
      "message-sequence-2",
      "message-sequence-1",
    ]);
    expect(result.retryMessages).toEqual([{ msgId: "invalid-message-1" }]);

    for (let attempts = 2; attempts <= 4; attempts += 1) {
      const retry = createMessageBatch("edgefoss-dev-events", [
        {
          attempts,
          body: invalidBody,
          id: `invalid-message-${attempts}`,
          timestamp: new Date(3_000 + attempts),
        },
      ]);
      const retryResult = await consumeBatch(repository, retry);
      expect(retryResult.explicitAcks).toEqual([]);
      expect(retryResult.retryMessages).toEqual([
        { msgId: `invalid-message-${attempts}` },
      ]);
    }
    const logs = errorLog.mock.calls.map((call) => String(call[0])).join("\n");
    errorLog.mockRestore();
    expect(logs).not.toContain(invalidBody.privateArtifactId);
    expect(logs).not.toContain("privateArtifactId");

    await expect(repository.outboxObservation(1)).resolves.toMatchObject({
      event: { phase: "delivered", repoSequence: 1 },
    });
    await expect(repository.outboxObservation(2)).resolves.toMatchObject({
      event: { phase: "delivered", repoSequence: 2 },
      totals: { delivered: 2, enqueued: 2, pending: 0 },
    });

    const duplicate = createMessageBatch("edgefoss-dev-events", [
      {
        attempts: 2,
        body: second,
        id: "message-sequence-2-duplicate",
        timestamp: new Date(4_000),
      },
    ]);
    await expect(consumeBatch(repository, duplicate)).resolves.toMatchObject({
      explicitAcks: ["message-sequence-2-duplicate"],
      retryMessages: [],
    });
    await expect(repository.outboxStatus()).resolves.toEqual({
      delivered: 2,
      enqueued: 2,
      pending: 0,
    });
  });
});
