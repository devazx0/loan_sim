export function getEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing env var ${name}`);
  return v;
}

export const DEFAULT_PORT = 9256;

/** Port precedence: `--port N` CLI arg > `PORT` env var > 9256. Throws on invalid values. */
function resolvePort(): number {
  const cliFlag = Bun.argv.indexOf("--port");
  const raw = cliFlag !== -1 ? Bun.argv[cliFlag + 1] : process.env["PORT"];
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port "${raw}": expected integer 1-65535`);
  }
  return port;
}

export const config = {
  port: resolvePort(),
  nodeEnv: process.env["NODE_ENV"] ?? "development",
  logLevel: process.env["LOG_LEVEL"] ?? "info",
  dbUrl: getEnv("DATABASE_URL", "file:./dev.db"),
  jwtAccessSecret: getEnv("JWT_ACCESS_SECRET", "dev-access-secret-change-me-min-32-chars-please"),
  webhookHmacSecret: getEnv("WEBHOOK_HMAC_SECRET", "dev-webhook-secret-change-me"),
  accessTokenTtlSec: 15 * 60,
  refreshTokenTtlDays: 30,
  idempotencyTtlSec: 24 * 3600,
};

// Configurable risk rules (documented in DOMAIN_RULES.md)
export const riskRules = {
  affordabilityMaxDtiBps: 4000, // 40% of disposable income
  creditAutoApproveScore: 650,
  creditAutoRejectScore: 500,
  fraudAutoRejectScore: 75,
  fraudReviewScore: 40,
  amlLargeAmountKobo: 5_000_000_00, // ₦5,000,000
  maxApplicationsPerDay: 3,
  lateFeeGraceDays: 1,
};
