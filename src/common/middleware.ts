import type { Context, Next } from "hono";
import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { config } from "../config/index";
import { UnauthorizedError, ForbiddenError, RateLimitError } from "./errors";
import { prisma } from "../infrastructure/database/prisma";
import { sha256 } from "./crypto";

export type Role = "CUSTOMER" | "LOAN_OFFICER" | "CREDIT_ANALYST" | "FINANCE_OFFICER" | "COLLECTIONS_OFFICER" | "ADMIN" | "SUPER_ADMIN";

export interface AuthCtx {
  userId: number;
  userPublicId: string;
  role: Role;
  email: string;
}

export type AppEnv = {
  Variables: {
    auth: AuthCtx;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    user: any;
    requestId: string;
  };
};

export function reqId(c: Context): string | undefined {
  try {
    return (c.get as unknown as (k: string) => unknown)("requestId") as string | undefined;
  } catch {
    return undefined;
  }
}

function setVar(c: Context, key: string, value: unknown): void {
  (c.set as unknown as (k: string, v: unknown) => void)(key, value);
}

const accessKey = new TextEncoder().encode(config.jwtAccessSecret);

export async function signAccessToken(auth: AuthCtx): Promise<string> {
  return await new SignJWT({ role: auth.role, email: auth.email, sub: auth.userPublicId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(auth.userPublicId)
    .setIssuedAt()
    .setExpirationTime(`${config.accessTokenTtlSec}s`)
    .sign(accessKey);
}

export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 10);
}
export async function verifyPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}

export function newRefreshToken(): { token: string; hash: string } {
  const token = randomUUID() + randomUUID().replace(/-/g, "");
  return { token, hash: sha256(token) };
}

export async function authMiddleware(c: Context, next: Next) {
  const header = c.req.header("authorization") ?? "";
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) throw new UnauthorizedError("Missing bearer token");
  try {
    const { payload } = await jwtVerify(m[1]!, accessKey);
    const sub = String(payload.sub ?? "");
    const user = await prisma.user.findUnique({ where: { publicId: sub } });
    if (!user || user.status !== "ACTIVE") throw new UnauthorizedError("Invalid session");
    setVar(c, "auth", { userId: user.id, userPublicId: user.publicId, role: user.role as Role, email: user.email } satisfies AuthCtx);
    setVar(c, "user", user);
    await next();
  } catch (e) {
    if (e instanceof UnauthorizedError) throw e;
    throw new UnauthorizedError("Invalid or expired token");
  }
}

export function getAuth(c: Context): AuthCtx {
  const a = (c.get as unknown as (k: string) => unknown)("auth") as AuthCtx | undefined;
  if (!a) throw new UnauthorizedError();
  return a;
}

const PERMS: Record<string, Role[]> = {
  "loan.read": ["CUSTOMER", "LOAN_OFFICER", "CREDIT_ANALYST", "FINANCE_OFFICER", "COLLECTIONS_OFFICER", "ADMIN", "SUPER_ADMIN"],
  "loan.approve": ["CREDIT_ANALYST", "ADMIN", "SUPER_ADMIN"],
  "loan.reject": ["CREDIT_ANALYST", "ADMIN", "SUPER_ADMIN"],
  "loan.disburse": ["FINANCE_OFFICER", "ADMIN", "SUPER_ADMIN"],
  "payment.read": ["CUSTOMER", "FINANCE_OFFICER", "ADMIN", "SUPER_ADMIN"],
  "payment.reverse": ["FINANCE_OFFICER", "ADMIN", "SUPER_ADMIN"],
  "collection.manage": ["COLLECTIONS_OFFICER", "ADMIN", "SUPER_ADMIN"],
  "user.manage": ["ADMIN", "SUPER_ADMIN"],
  "role.manage": ["SUPER_ADMIN"],
  "report.read": ["ADMIN", "SUPER_ADMIN", "FINANCE_OFFICER", "CREDIT_ANALYST"],
  "product.manage": ["ADMIN", "SUPER_ADMIN"],
};

export function requirePerm(perm: string) {
  return async (c: Context, next: Next) => {
    const a = getAuth(c);
    const allowed = PERMS[perm] ?? [];
    if (!allowed.includes(a.role)) throw new ForbiddenError(`Requires ${perm}`);
    await next();
  };
}

export function requireRole(...roles: Role[]) {
  return async (c: Context, next: Next) => {
    const a = getAuth(c);
    if (!roles.includes(a.role)) throw new ForbiddenError("Insufficient role");
    await next();
  };
}

export async function requestIdMiddleware(c: Context, next: Next) {
  const rid = c.req.header("x-request-id") ?? randomUUID();
  setVar(c, "requestId", rid);
  c.header("x-request-id", rid);
  await next();
}

// Simple in-memory token-bucket rate limiter (per key+route)
const buckets = new Map<string, { count: number; resetAt: number }>();
export function rateLimit(max: number, windowSec: number, keyFn?: (c: Context) => string) {
  return async (c: Context, next: Next) => {
    const key = `${c.req.path}:${keyFn ? keyFn(c) : (c.req.header("x-forwarded-for") ?? "anon")}`;
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || now > b.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowSec * 1000 });
      await next();
      return;
    }
    b.count++;
    if (b.count > max) throw new RateLimitError();
    await next();
  };
}
export function clearRateBuckets() { buckets.clear(); }

