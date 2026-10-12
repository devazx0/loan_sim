import { app } from "../src/app";
import { clearRateBuckets } from "../src/common/middleware";
import { prisma } from "../src/infrastructure/database/prisma";

// Guard: integration tests must run against an isolated test database, never dev/prod.
const dbUrl = process.env["DATABASE_URL"] ?? "";
if (!dbUrl.includes("test")) {
  throw new Error(`Refusing to run tests against non-test DATABASE_URL=${dbUrl}. Use DATABASE_URL=file:./test.db`);
}

let counter = 0;
function uniq(prefix: string): string {
  counter++;
  return `${prefix}_${Date.now()}_${counter}_${Math.floor(Math.random() * 1e6)}`;
}

export async function api(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": `test-${uniq("ip")}`,
    ...opts.headers,
  };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  const res = await app.request(path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

export async function registerCustomer(overrides: Partial<{ email: string; phone: string; password: string; firstName: string; lastName: string }> = {}) {
  const email = overrides.email ?? uniq("user") + "@test.local";
  const phone = overrides.phone ?? `+2349${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
  const res = await api("POST", "/api/v1/auth/register", {
    body: { email, phone, password: "Password123!", firstName: "Test", lastName: "User", ...overrides },
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.json)}`);
  const data = (res.json as { data: { accessToken: string; refreshToken: string; user: { id: string } } }).data;
  return { email, phone, ...data };
}

export async function loginAs(email: string, password = "Password123!") {
  const res = await api("POST", "/api/v1/auth/login", { body: { email, password } });
  if (res.status !== 200) throw new Error(`login failed: ${JSON.stringify(res.json)}`);
  return (res.json as { data: { accessToken: string; refreshToken: string } }).data;
}

export async function ensureProduct(): Promise<string> {
  const existing = await prisma.loanProduct.findFirst({ where: { status: "ACTIVE" } });
  if (existing) return existing.publicId;
  const p = await prisma.loanProduct.create({
    data: {
      code: "TEST_PERSONAL", name: "Test Personal", minAmountKobo: 10_000_00, maxAmountKobo: 2_000_000_00,
      minTenorMonths: 1, maxTenorMonths: 12, interestRateBps: 500, interestMethod: "FLAT",
      processingFeeKobo: 1_000_00, lateFeeKobo: 500_00, status: "ACTIVE",
    },
  });
  return p.publicId;
}

export function resetRateLimits() {
  clearRateBuckets();
}

