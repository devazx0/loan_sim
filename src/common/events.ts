import type { Prisma } from "@prisma/client";
import { prisma } from "../infrastructure/database/prisma";
import { queue, buildMessage, type QueueMessage } from "../infrastructure/queue/queue";

export type { QueueMessage };

/**
 * Single-ID event emission (fixes outbox/messageId desync).
 *
 * INVARIANT: the messageId stored on the OutboxEvent row MUST be the exact
 * messageId handed to the queue. Two IDs for one logical event breaks
 * ProcessedEvent deduplication across immediate dispatch and outbox relay.
 *
 * Usage:
 *   // inside a business transaction:
 *   const msg = await stageEvent(tx, "loan.approved", id, {...});
 *   // ... commit ...
 *   await queue.publish(msg);   // same ID
 */
export async function stageEvent<T>(
  tx: Prisma.TransactionClient,
  eventType: string,
  aggregateId: string,
  payload: T,
): Promise<QueueMessage<T>> {
  const msg = buildMessage(eventType, aggregateId, payload);
  await tx.outboxEvent.create({
    data: {
      messageId: msg.messageId,
      eventType,
      aggregateId,
      payload: JSON.stringify(payload),
      version: msg.version,
    },
  });
  return msg;
}

/** Stage (own transaction) + publish with the SAME messageId. For non-transactional contexts. */
export async function publishEvent<T>(eventType: string, aggregateId: string, payload: T): Promise<QueueMessage<T>> {
  const msg = await prisma.$transaction((tx) => stageEvent(tx, eventType, aggregateId, payload));
  await queue.publish(msg);
  return msg;
}
