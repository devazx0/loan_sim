import { prisma } from "../infrastructure/database/prisma";
import { ConflictError, IdempotencyConflictError } from "./errors";
import { config } from "../config/index";

/**
 * Claim an idempotency key or replay a previous response.
 * Concurrency-safe: two simultaneous claims for the same key resolve to ONE execution;
 * the loser polls briefly for the winner's response instead of crashing on unique violation.
 *
 * Key lifecycle: PROCESSING -> COMPLETED (success, replay forever until expiry)
 *                             -> FAILED (no financial commit; same key+body may retry)
 * A FAILED key with the SAME request hash is reclaimed for a fresh attempt.
 * A key reused with a DIFFERENT body always fails with 422, whatever its state.
 */
export async function claimKey(opts: {
  key: string;
  userId?: number;
  endpoint: string;
  requestHash: string;
}): Promise<{ replay: unknown | null }> {
  const { key, userId, endpoint, requestHash } = opts;
  try {
    await prisma.idempotencyKey.create({
      data: {
        key, userId, endpoint, requestHash, status: "PROCESSING",
        expiresAt: new Date(Date.now() + config.idempotencyTtlSec * 1000),
      },
    });
    return { replay: null };
  } catch (e) {
    const msg = String(e);
    if (!msg.includes("Unique constraint") && !msg.includes("P2002")) throw e;
    return { replay: await resolveExisting(key, requestHash) };
  }
}

async function resolveExisting(key: string, requestHash: string): Promise<unknown> {
  const existing = await prisma.idempotencyKey.findUnique({ where: { key } });
  if (!existing) throw new ConflictError("Concurrent request in progress, retry shortly");
  if (existing.requestHash !== requestHash) throw new IdempotencyConflictError();
  if (existing.status === "COMPLETED" && existing.response) return JSON.parse(existing.response);
  if (existing.status === "FAILED") {
    // Safe retry: FAILED is only ever set when no financial commit happened
    // (see failKey). Reclaim the key for a fresh attempt with the same body.
    await prisma.idempotencyKey.update({
      where: { key },
      data: { status: "PROCESSING", response: null, expiresAt: new Date(Date.now() + config.idempotencyTtlSec * 1000) },
    });
    return null;
  }
  if (existing.response) return JSON.parse(existing.response);
  // Winner still processing: poll briefly (same-process concurrency), then give up with 409.
  for (let i = 0; i < 20; i++) {
    await sleep(100);
    const cur = await prisma.idempotencyKey.findUnique({ where: { key } });
    if (!cur) throw new ConflictError("Concurrent request in progress, retry shortly");
    if (cur.requestHash !== requestHash) throw new IdempotencyConflictError();
    if (cur.status === "COMPLETED" && cur.response) return JSON.parse(cur.response);
    if (cur.status === "FAILED") {
      await prisma.idempotencyKey.update({
        where: { key },
        data: { status: "PROCESSING", response: null, expiresAt: new Date(Date.now() + config.idempotencyTtlSec * 1000) },
      });
      return null;
    }
  }
  throw new ConflictError("Concurrent request in progress, retry shortly");
}

export async function completeKey(key: string, response: unknown): Promise<void> {
  await prisma.idempotencyKey.update({ where: { key }, data: { status: "COMPLETED", response: JSON.stringify(response) } }).catch(() => null);
}

/**
 * Mark a claimed key FAILED after an operation aborted WITHOUT committing any
 * financial effect. Guarded: only transitions PROCESSING -> FAILED, so a
 * concurrently-completed key can never be clobbered. Never call this if the
 * financial transaction may have committed — a FAILED key permits same-body
 * retry, which would double-apply a committed operation.
 */
export async function failKey(key: string, error: string): Promise<void> {
  await prisma.idempotencyKey.updateMany({
    where: { key, status: "PROCESSING" },
    data: { status: "FAILED", response: JSON.stringify({ error }) },
  }).catch(() => null);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
