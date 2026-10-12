import type { MessageQueue, MessageHandler, QueueMessage } from "../providers/interfaces";

export type { QueueMessage, MessageHandler, MessageQueue };
import { prisma } from "../database/prisma";
import { logger } from "../../common/logger";

/**
 * LocalQueue: in-memory handler registry + durable outbox relay.
 * Business code writes OutboxEvent in the same tx; relayOutbox() publishes.
 * Handlers must be idempotent (guarded by ProcessedEvent).
 */
type Handler = MessageHandler<unknown>;

export class LocalQueue implements MessageQueue {
  private handlers = new Map<string, Handler[]>();
  private pending: QueueMessage[] = [];
  private dead = new Map<string, { attempts: number }>();
  // Same-process execution guard: immediate dispatch and outbox relay share this
  // process, so a messageId already being handled is skipped instead of run twice.
  // (Cross-process deployments need a DB-backed claim; documented limitation.)
  private inflight = new Set<string>();

  async publish<T>(message: QueueMessage<T>): Promise<void> {
    this.pending.push(message as QueueMessage);
    // best-effort immediate dispatch (async, not blocking tx)
    void this.dispatch(message as QueueMessage);
  }

  async consume<T>(topic: string, handler: MessageHandler<T>): Promise<void> {
    const list = this.handlers.get(topic) ?? [];
    list.push(handler as Handler);
    this.handlers.set(topic, list);
  }

  pendingCount(): number { return this.pending.length; }

  private async dispatch(msg: QueueMessage): Promise<void> {
    if (this.inflight.has(msg.messageId)) return;
    this.inflight.add(msg.messageId);
    try {
      const handlers = this.handlers.get(msg.eventType) ?? this.handlers.get("*") ?? [];
      for (const h of handlers) {
        await this.handleWithRetry(msg, h);
      }
    } finally {
      this.inflight.delete(msg.messageId);
    }
  }

  private async handleWithRetry(msg: QueueMessage, h: Handler): Promise<void> {
    const maxAttempts = 5;
    // idempotency: skip if already processed
    const done = await prisma.processedEvent.findUnique({ where: { messageId: msg.messageId } }).catch(() => null);
    if (done) return;
    let attempt = 0;
    let delay = 50;
    while (attempt < maxAttempts) {
      try {
        await h(msg);
        await prisma.processedEvent.create({ data: { messageId: msg.messageId, eventType: msg.eventType } }).catch(() => null);
        await prisma.outboxEvent.updateMany({ where: { messageId: msg.messageId }, data: { status: "PUBLISHED", publishedAt: new Date() } }).catch(() => null);
        return;
      } catch (e) {
        attempt++;
        const transient = isTransient(e);
        if (!transient || attempt >= maxAttempts) {
          await prisma.deadLetter.upsert({
            where: { messageId: msg.messageId },
            create: { messageId: msg.messageId, eventType: msg.eventType, payload: JSON.stringify(msg.payload), error: String(e), attempts: attempt },
            update: { error: String(e), attempts: attempt },
          }).catch(() => null);
          logger.error({ eventType: msg.eventType, messageId: msg.messageId, attempt, err: String(e) }, "queue message dead-lettered");
          return;
        }
        await sleep(delay);
        delay *= 2;
      }
    }
  }
}

function isTransient(e: unknown): boolean {
  const s = String(e);
  if (s.includes("TRANSIENT")) return true;
  if (s.includes("ValidationError") || s.includes("VALIDATION")) return false;
  // default: retry DB/network-ish errors, not business validation
  return true;
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

export const queue = new LocalQueue();

/** Relay pending outbox rows (called by worker + inline after writes). */
export async function relayOutbox(limit = 50): Promise<number> {
  const rows = await prisma.outboxEvent.findMany({ where: { status: "PENDING" }, orderBy: { id: "asc" }, take: limit });
  for (const r of rows) {
    // Already executed via immediate dispatch? Mark published WITHOUT redelivering,
    // so the same messageId can never execute twice across both paths.
    const done = await prisma.processedEvent.findUnique({ where: { messageId: r.messageId } }).catch(() => null);
    if (done) {
      await prisma.outboxEvent.update({ where: { id: r.id }, data: { status: "PUBLISHED", publishedAt: new Date() } }).catch(() => null);
      continue;
    }
    await prisma.outboxEvent.update({ where: { id: r.id }, data: { attempts: { increment: 1 } } }).catch(() => null);
    await queue.publish({
      messageId: r.messageId,
      eventType: r.eventType,
      occurredAt: r.createdAt.toISOString(),
      aggregateId: r.aggregateId,
      payload: JSON.parse(r.payload),
      version: r.version,
    });
  }
  return rows.length;
}

export function buildMessage<T>(eventType: string, aggregateId: string, payload: T): QueueMessage<T> {
  return {
    messageId: crypto.randomUUID(),
    eventType,
    occurredAt: new Date().toISOString(),
    aggregateId,
    payload,
    version: 1,
  };
}

