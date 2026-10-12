import { createHash, createHmac, timingSafeEqual, randomUUID } from "node:crypto";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function newPublicId(): string {
  return randomUUID();
}

export function stableHash(obj: unknown): string {
  return sha256(JSON.stringify(obj));
}

export function verifyHmacHex(secret: string, payload: string, hexSig: string): boolean {
  const expected = createHmacHex(secret, payload);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(hexSig, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createHmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}
