import { validateAuthorityEvent, type AuthorityEventV0 } from "./outbox.js";

export const QUEUE_RETRY_DELAY_SECONDS = 30;

export interface AuthorityEventDeliveryRecorder {
  recordEventDelivery(
    event: AuthorityEventV0,
  ): Promise<{ status: "accepted" | "duplicate" | "unknown" }>;
}

export async function consumeAuthorityEventMessage(
  message: Message<unknown>,
  repository: AuthorityEventDeliveryRecorder,
  queueName: string,
): Promise<"acknowledged" | "retried"> {
  try {
    validateAuthorityEvent(message.body);
    const result = await repository.recordEventDelivery(message.body);
    if (result.status === "unknown") {
      throw new Error("authority_event_unknown");
    }
    message.ack();
    return "acknowledged";
  } catch (error) {
    console.error(
      JSON.stringify({
        attempts: message.attempts,
        error: error instanceof Error ? error.message : "unknown_error",
        message: "authority event delivery failed",
        queue: queueName,
      }),
    );
    message.retry({ delaySeconds: QUEUE_RETRY_DELAY_SECONDS });
    return "retried";
  }
}
