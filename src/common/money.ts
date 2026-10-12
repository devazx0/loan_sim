// Money utilities — all amounts are integer kobo. Never use floats.
//
// INTEGER CEILING (decision, see ARCHITECTURE.md "Monetary integers"):
// Prisma `Int` is 32-bit on most connectors, so every monetary value is capped at
// INT32_MAX kobo (2,147,483,647 ≈ ₦21.4M) — far above the largest product cap
// (₦5M) yet guaranteed to fit Prisma Int on ANY connector, stay exactly
// representable in JS (<< Number.MAX_SAFE_INTEGER), and serialize safely to JSON.
// A BigInt migration was rejected: it would complicate JSON APIs, DTOs and
// SQLite handling for ranges this simulation never needs.
export const MAX_MONEY_KOBO = 2_147_483_647;

export function assertValidKobo(n: number, field = "amount"): void {
  if (!Number.isInteger(n)) throw new ValidationError(`${field} must be integer kobo`);
  if (n < 0) throw new ValidationError(`${field} must be >= 0`);
  if (n > MAX_MONEY_KOBO) throw new ValidationError(`${field} exceeds maximum of ${MAX_MONEY_KOBO} kobo`);
}

import { ValidationError } from "./errors";

export function toKobo(naira: number): number {
  // Accept decimal naira input at API boundary only, convert deterministically.
  const kobo = Math.round(naira * 100);
  assertValidKobo(kobo);
  return kobo;
}

export function fromKobo(kobo: number): string {
  assertValidKobo(kobo);
  return (kobo / 100).toFixed(2);
}

export function formatNGN(kobo: number): string {
  assertValidKobo(kobo);
  const n = (kobo / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `₦${n}`;
}

export function addMoney(a: number, b: number): number {
  assertValidKobo(a, "a"); assertValidKobo(b, "b");
  const r = a + b;
  if (r > MAX_MONEY_KOBO) throw new ValidationError("money overflow");
  return r;
}

export function subtractMoney(a: number, b: number): number {
  assertValidKobo(a, "a"); assertValidKobo(b, "b");
  if (b > a) throw new ValidationError("subtraction would go negative");
  return a - b;
}

/** Multiply money by rational num/den with half-up rounding. */
export function multiplyMoney(kobo: number, num: number, den = 1): number {
  assertValidKobo(kobo);
  if (!Number.isInteger(num) || !Number.isInteger(den) || den <= 0 || num < 0)
    throw new ValidationError("invalid multiply ratio");
  const r = Math.floor((kobo * num + den / 2) / den);
  assertValidKobo(r);
  return r;
}

/** Flat interest: principal * rateBps/10000, half-up. */
export function calculateFlatInterest(principalKobo: number, rateBps: number): number {
  assertValidKobo(principalKobo, "principal");
  if (!Number.isInteger(rateBps) || rateBps < 0) throw new ValidationError("invalid rateBps");
  return Math.floor((principalKobo * rateBps + 5000) / 10000);
}

/** Equal installments: ceil-divide total across n so sum == total (last adjusted). */
export function splitInstallments(totalKobo: number, n: number): number[] {
  assertValidKobo(totalKobo, "total");
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError("invalid installment count");
  const base = Math.floor(totalKobo / n);
  const rem = totalKobo % n;
  const parts = new Array<number>(n).fill(base);
  for (let i = 0; i < rem; i++) parts[i] = parts[i]! + 1;
  return parts;
}

/** Amortized monthly installment for REDUCING method (rounded half-up, integer). */
export function calculateReducingInstallment(principalKobo: number, monthlyRateBps: number, n: number): number {
  assertValidKobo(principalKobo, "principal");
  if (!Number.isInteger(monthlyRateBps) || monthlyRateBps < 0) throw new ValidationError("invalid rate");
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError("invalid tenor");
  if (monthlyRateBps === 0) return Math.ceil(principalKobo / n);
  const r = monthlyRateBps / 10000;
  const inst = (principalKobo * r) / (1 - Math.pow(1 + r, -n));
  return Math.round(inst);
}

