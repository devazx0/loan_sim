import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { webhookPaymentSchema, webhookBankSchema } from "../payments/dto";
import * as webhooks from "./service";
import { rateLimit, reqId } from "../../common/middleware";

// Canonical webhook signing: HMAC-SHA256 hex over JSON.stringify(payload WITHOUT the
// signature field), secret = WEBHOOK_HMAC_SECRET. See SECURITY.md.
function canonical(parsed: Record<string, unknown>): { payloadJson: string; signature: string | undefined } {
  const { signature, ...payload } = parsed;
  return { payloadJson: JSON.stringify(payload), signature: signature as string | undefined };
}

export const webhookRoutes = new Hono();

webhookRoutes.post("/payments", rateLimit(120, 60), zValidator("json", webhookPaymentSchema), async (c) => {
  const parsed = c.req.valid("json") as unknown as Record<string, unknown>;
  const { payloadJson, signature } = canonical(parsed);
  const data = await webhooks.handlePaymentWebhook(payloadJson, { ...(parsed as object), signature } as never, { requestId: reqId(c) });
  return c.json({ success: true, data });
});

webhookRoutes.post("/bank", rateLimit(120, 60), zValidator("json", webhookBankSchema), async (c) => {
  const parsed = c.req.valid("json") as unknown as Record<string, unknown>;
  const { payloadJson, signature } = canonical(parsed);
  const data = await webhooks.handleBankWebhook(payloadJson, { ...(parsed as object), signature } as never, { requestId: reqId(c) });
  return c.json({ success: true, data });
});
