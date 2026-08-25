export const OUTBOX_BATCH_SIZE = 10;

export interface AuthorityEventV0 {
  artifact: {
    id: string;
    kind: "project.genesis" | "tree" | "change";
    realm: "public" | "members";
  };
  authorityId: "edgefoss-single-project-v0";
  eventId: string;
  format: "edgefoss-authority-event-v0";
  policyEpoch: number;
  ref: {
    generation: number;
    name: "heads/main";
    targetArtifactId: string;
  } | null;
  repoSequence: number;
}

export interface OutboxStatus {
  delivered: number;
  enqueued: number;
  pending: number;
}

export interface DrainOutboxResult {
  attempted: number;
  enqueued: number;
  remaining: number;
}

interface OutboxRow extends Record<string, SqlStorageValue> {
  event_id: string;
  event_json: string;
}

export function authorityEvent(input: {
  artifactId: string;
  kind: AuthorityEventV0["artifact"]["kind"];
  policyEpoch: number;
  realm: AuthorityEventV0["artifact"]["realm"];
  ref: AuthorityEventV0["ref"];
  repoSequence: number;
}): AuthorityEventV0 {
  return {
    artifact: {
      id: input.artifactId,
      kind: input.kind,
      realm: input.realm,
    },
    authorityId: "edgefoss-single-project-v0",
    eventId: `edgefoss-single-project-v0:${input.repoSequence}`,
    format: "edgefoss-authority-event-v0",
    policyEpoch: input.policyEpoch,
    ref: input.ref,
    repoSequence: input.repoSequence,
  };
}

export function insertOutboxEvent(
  sql: SqlStorage,
  event: AuthorityEventV0,
): void {
  validateAuthorityEvent(event);
  sql.exec(
    `INSERT INTO authority_outbox (
       event_id, repo_seq, event_json, state, attempts, last_attempt_at,
       enqueued_at
     ) VALUES (?, ?, ?, 'pending', 0, NULL, NULL)`,
    event.eventId,
    event.repoSequence,
    JSON.stringify(event),
  );
}

export function readOutboxStatus(storage: DurableObjectStorage): OutboxStatus {
  const counts = storage.sql
    .exec<{ count: number; state: "pending" | "enqueued" }>(
      `SELECT state, COUNT(*) AS count
         FROM authority_outbox
        GROUP BY state`,
    )
    .toArray();
  const delivered = storage.sql
    .exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM authority_event_deliveries",
    )
    .one().count;
  return {
    delivered,
    enqueued: counts.find((row) => row.state === "enqueued")?.count ?? 0,
    pending: counts.find((row) => row.state === "pending")?.count ?? 0,
  };
}

export async function drainOutbox(
  storage: DurableObjectStorage,
  queue: Queue<unknown>,
  attemptedAt: number,
): Promise<DrainOutboxResult> {
  if (!Number.isSafeInteger(attemptedAt) || attemptedAt < 0) {
    throw new Error("outbox_attempt_time_invalid");
  }
  const rows = storage.sql
    .exec<OutboxRow>(
      `SELECT event_id, event_json
         FROM authority_outbox
        WHERE state = 'pending'
        ORDER BY repo_seq
        LIMIT ?`,
      OUTBOX_BATCH_SIZE,
    )
    .toArray();
  if (rows.length === 0) {
    return { attempted: 0, enqueued: 0, remaining: 0 };
  }

  const events = rows.map((row) => parseAuthorityEvent(row.event_json));
  storage.transactionSync(() => {
    for (const row of rows) {
      storage.sql.exec(
        `UPDATE authority_outbox
            SET attempts = attempts + 1, last_attempt_at = ?
          WHERE event_id = ? AND state = 'pending'`,
        attemptedAt,
        row.event_id,
      );
    }
  });

  await queue.sendBatch(events.map((body) => ({ body, contentType: "json" })));

  storage.transactionSync(() => {
    for (const row of rows) {
      storage.sql.exec(
        `UPDATE authority_outbox
            SET state = 'enqueued', enqueued_at = ?
          WHERE event_id = ? AND state = 'pending'`,
        attemptedAt,
        row.event_id,
      );
    }
  });
  const remaining = storage.sql
    .exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM authority_outbox WHERE state = 'pending'",
    )
    .one().count;
  return { attempted: rows.length, enqueued: rows.length, remaining };
}

export function recordAuthorityEventDelivery(
  storage: DurableObjectStorage,
  event: AuthorityEventV0,
  deliveredAt: number,
): "accepted" | "duplicate" | "unknown" {
  validateAuthorityEvent(event);
  if (!Number.isSafeInteger(deliveredAt) || deliveredAt < 0) {
    throw new Error("event_delivery_time_invalid");
  }
  const outbox = storage.sql
    .exec<{ event_json: string; repo_seq: number }>(
      `SELECT repo_seq, event_json
         FROM authority_outbox
        WHERE event_id = ?`,
      event.eventId,
    )
    .toArray()[0];
  if (
    !outbox ||
    outbox.repo_seq !== event.repoSequence ||
    JSON.stringify(parseAuthorityEvent(outbox.event_json)) !==
      JSON.stringify(event)
  ) {
    return "unknown";
  }
  const existing = storage.sql
    .exec<{ event_id: string }>(
      "SELECT event_id FROM authority_event_deliveries WHERE event_id = ?",
      event.eventId,
    )
    .toArray()[0];
  if (existing) return "duplicate";
  storage.sql.exec(
    `INSERT INTO authority_event_deliveries (event_id, repo_seq, delivered_at)
     VALUES (?, ?, ?)`,
    event.eventId,
    event.repoSequence,
    deliveredAt,
  );
  return "accepted";
}

export function parseAuthorityEvent(json: string): AuthorityEventV0 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("authority_event_invalid");
  }
  validateAuthorityEvent(parsed);
  return parsed;
}

export function validateAuthorityEvent(
  value: unknown,
): asserts value is AuthorityEventV0 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "artifact",
      "authorityId",
      "eventId",
      "format",
      "policyEpoch",
      "ref",
      "repoSequence",
    ])
  ) {
    throw new Error("authority_event_invalid");
  }
  if (
    value.format !== "edgefoss-authority-event-v0" ||
    value.authorityId !== "edgefoss-single-project-v0" ||
    !Number.isSafeInteger(value.repoSequence) ||
    (value.repoSequence as number) < 1 ||
    value.eventId !== `edgefoss-single-project-v0:${value.repoSequence}` ||
    !Number.isSafeInteger(value.policyEpoch) ||
    (value.policyEpoch as number) < 0 ||
    !isRecord(value.artifact) ||
    !hasExactKeys(value.artifact, ["id", "kind", "realm"]) ||
    !/^sha256:[0-9a-f]{64}$/u.test(String(value.artifact.id)) ||
    (value.artifact.kind !== "project.genesis" &&
      value.artifact.kind !== "tree" &&
      value.artifact.kind !== "change") ||
    (value.artifact.realm !== "public" && value.artifact.realm !== "members") ||
    (value.artifact.kind === "change") !== (value.ref !== null)
  ) {
    throw new Error("authority_event_invalid");
  }
  if (value.ref !== null) {
    if (
      !isRecord(value.ref) ||
      !hasExactKeys(value.ref, ["generation", "name", "targetArtifactId"]) ||
      value.ref.name !== "heads/main" ||
      !Number.isSafeInteger(value.ref.generation) ||
      (value.ref.generation as number) < 1 ||
      value.ref.targetArtifactId !== value.artifact.id
    ) {
      throw new Error("authority_event_invalid");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index])
  );
}
