import pino from "pino";
import { config } from "../config/index";

const sensitiveKeys = ["password", "passwordHash", "token", "refresh", "jwt", "otp", "secret", "authorization"];

function redact(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (sensitiveKeys.some((s) => k.toLowerCase().includes(s))) out[k] = "[REDACTED]";
    else out[k] = redact(v);
  }
  return out;
}

export const logger = pino({
  level: config.logLevel,
  base: undefined,
  formatters: {
    log(obj) {
      return redact(obj) as Record<string, unknown>;
    },
  },
});

export function childLogger(requestId: string) {
  return logger.child({ requestId });
}

