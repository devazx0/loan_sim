import { prisma } from "../../infrastructure/database/prisma";
import { ValidationError, ConflictError } from "../../common/errors";
import { verifyHmacHex } from "../../common/crypto";
import { config } from "../../config/index";
import { processSuccessfulPayment } from "../payments/service";
import { confirmDisbursement } from "../loans/service";
import { publishEvent } from "../../common/events";

/**
 * Per-event async mutex. SQLite allows a single writer, so simultaneous identical
 * deliveries would otherwise collide on the write lock (timeouts/500s). Serializing
 * per providerEventId means exactly one worker processes; the rest observe the
 * PROCESSED row and return DUPLICATE. Combined with DB uniqueness + idempotent
 * finalization, simultaneous identical webhooks yield one financial side effect.
 */
const webhookLocks = new Map<string, Promise<void>>();
async function withWebhookLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = webhookLocks.get(key);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const tail = (prev ?? Promise.resolve()).then(() => gate);
  webhookLocks.set(key, tail);
  try {
    await (prev ?? Promise.resolve());
    return await fn();
  } finally {
    release();
    if (webhookLocks.get(key) === tail) webhookLocks.delete(key);
  }
}

/** SQLite write contention is transient: signal retry (409) instead of 500. */
function isTransientDbError(e: unknown): boolean {
  const s = String(e);
  return (
    s.includes("Operations timed out") ||
    s.includes("Transaction already closed") ||
    s.includes("database is locked") ||
    s.includes("SQLITE_BUSY") ||
    s.includes("timed out")
  );
}

function verifySignature(rawBody: string, signature: string | undefined): void {
  if (!signature) throw new ValidationError("Missing webhook signature");
  if (!verifyHmacHex(config.webhookHmacSecret, rawBody, signature)) throw new ValidationError("Invalid webhook signature");
}

type Claim = { id: number; status: string };

/**
 * Concurrency-safe webhook claim. Two simultaneous identical deliveries must yield
 * exactly one financial side effect:
 * - The worker that performs the INSERT owns the event and processes it.
 * - A worker that loses the UNIQUE race NEVER processes blindly: it polls briefly
 *   for PROCESSED (→ DUPLICATE), else takes over only FAILED rows (previous attempt
 *   died or errored; reprocessing is safe because downstream finalization is
 *   idempotent), else 409s so the provider retries into an idempotent replay.
 * DB uniqueness is the source of truth — never application-level `if` checks alone.
 * Belt-and-braces: even if two workers ever entered processing together,
 * processSuccessfulPayment/confirmDisbursement are themselves idempotent.
 */
async function claimWebhookEvent(provider: string, providerEventId: string, eventType: string, rawBody: string, signature: string | undefined): Promise<{ event: Claim; duplicate: boolean }> {
  try {
    const created = await prisma.webhookEvent.create({
      data: { provider, providerEventId, eventType, payload: rawBody, signature, status: "RECEIVED" },
    });
    return { event: created, duplicate: false };
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    return resolveWebhookClaim(providerEventId);
  }
}

async function resolveWebhookClaim(providerEventId: string): Promise<{ event: Claim; duplicate: boolean }> {
  const existing = await prisma.webhookEvent.findUnique({ where: { providerEventId } });
  if (!existing) throw new ConflictError("Concurrent webhook delivery in progress, retry shortly");
  if (existing.status === "PROCESSED") return { event: existing, duplicate: true };
  for (let i = 0; i < 20; i++) {
    await sleep(100);
    const cur = await prisma.webhookEvent.findUnique({ where: { providerEventId } });
    if (cur?.status === "PROCESSED") return { event: cur, duplicate: true };
  }
  // Owner may have died: take over FAILED rows only (safe: downstream is idempotent).
  const taken = await prisma.webhookEvent.updateMany({
    where: { providerEventId, status: "FAILED" },
    data: { status: "RECEIVED", attempts: { increment: 1 } },
  });
  if (taken.count === 1) {
    const row = await prisma.webhookEvent.findUniqueOrThrow({ where: { providerEventId } });
    if (row.status === "PROCESSED") return { event: row, duplicate: true };
    return { event: row, duplicate: false };
  }
  throw new ConflictError("Concurrent webhook delivery in progress, retry shortly");
}

function isUniqueViolation(e: unknown): boolean {
  const s = String(e);
  return s.includes("Unique constraint") || s.includes("P2002");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Payment webhook: authenticated, validated, stored, idempotent (5x delivery => 1 effect). */
export async function handlePaymentWebhook(rawBody: string, body: { providerEventId: string; reference: string; status: string; amountKobo?: number; signature?: string }, ctx: { requestId?: string }) {
  verifySignature(rawBody, body.signature);
  return withWebhookLock(`pay:${body.providerEventId}`, async () => {
    const { event, duplicate } = await claimWebhookEvent("PAYMENT", body.providerEventId, "payment.webhook.received", rawBody, body.signature);
    if (duplicate || event.status === "PROCESSED") {
      return { paymentId: null as string | null, status: "DUPLICATE" as const };
    }
    try {
      // Resolve payment by publicId OR providerRef
      const payment = await prisma.payment.findFirst({ where: { OR: [{ publicId: body.reference }, { providerRef: body.reference }] } });
      if (!payment) throw new ValidationError("Unknown payment reference");
      if (body.amountKobo !== undefined && body.amountKobo !== payment.amountKobo) {
        await prisma.webhookEvent.update({ where: { id: event.id }, data: { status: "FAILED", lastError: "amount_mismatch", attempts: { increment: 1 } } });
        throw new ValidationError("Amount mismatch — flagged for review, not applied");
      }
      let result: unknown = null;
      if (body.status === "SUCCESS") {
        result = await processSuccessfulPayment(payment.publicId, { requestId: ctx.requestId, providerEventId: body.providerEventId });
      } else if (body.status === "FAILED") {
        if (payment.status === "PENDING") {
          await prisma.payment.update({ where: { id: payment.id }, data: { status: "FAILED", failureReason: "provider_webhook_failed" } });
        }
        result = { paymentId: payment.publicId, status: payment.status };
      }
      await prisma.webhookEvent.update({ where: { id: event.id }, data: { status: "PROCESSED", processedAt: new Date() } });
      await publishEvent("payment.webhook.received", body.providerEventId, { reference: body.reference });
      return { ...(result as Record<string, unknown>), webhook: "PROCESSED" };
    } catch (e) {
      await prisma.webhookEvent.update({ where: { id: event.id }, data: { status: "FAILED", lastError: String(e), attempts: { increment: 1 } } }).catch(() => null);
      // Commit-ambiguous storage contention: the tx may or may not have committed.
      // FAILED permits safe takeover/replay (downstream is idempotent); 409 asks the
      // provider to redeliver into an idempotent replay instead of surfacing a 500.
      if (isTransientDbError(e)) throw new ConflictError("Transient storage contention, retry shortly");
      throw e;
    }
  });
}

/** Bank webhook: confirms disbursement idempotently. */
export async function handleBankWebhook(rawBody: string, body: { providerEventId: string; reference: string; status: string; signature?: string }, ctx: { requestId?: string }) {
  verifySignature(rawBody, body.signature);
  return withWebhookLock(`bank:${body.providerEventId}`, async () => {
    const { event, duplicate } = await claimWebhookEvent("BANK", body.providerEventId, "bank.webhook.received", rawBody, body.signature);
    if (duplicate || event.status === "PROCESSED") return { status: "DUPLICATE" as const };
    try {
      if (body.status === "SUCCESS") {
        const loan = await prisma.loan.findFirst({ where: { disbursementRef: body.reference } });
        if (!loan) throw new ValidationError("Unknown disbursement reference");
        await confirmDisbursement(body.reference, body.providerEventId, ctx);
      } else if (body.status === "FAILED") {
        const loan = await prisma.loan.findFirst({ where: { disbursementRef: body.reference } });
        if (loan && loan.status === "PENDING") {
          await prisma.loan.update({ where: { id: loan.id }, data: { status: "PENDING" } });
        }
      }
      await prisma.webhookEvent.update({ where: { id: event.id }, data: { status: "PROCESSED", processedAt: new Date() } });
      await publishEvent("bank.webhook.received", body.providerEventId, { reference: body.reference });
      return { status: "PROCESSED" as const };
    } catch (e) {
      await prisma.webhookEvent.update({ where: { id: event.id }, data: { status: "FAILED", lastError: String(e), attempts: { increment: 1 } } }).catch(() => null);
      if (isTransientDbError(e)) throw new ConflictError("Transient storage contention, retry shortly");
      throw e;
    }
  });
}
