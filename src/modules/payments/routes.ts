import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { authMiddleware, getAuth, requirePerm, rateLimit, reqId } from "../../common/middleware";
import { initiatePaymentSchema } from "./dto";
import * as service from "./service";

// NOTE: no .use("*", authMiddleware) here — this router is mounted at /api/v1
// and a wildcard would leak auth onto unrelated /api/v1/* routes (e.g. webhooks).
// Auth is attached per-route instead.
export const paymentRoutes = new Hono();

paymentRoutes.post("/loans/:loanId/payments", authMiddleware, rateLimit(30, 3600), zValidator("json", initiatePaymentSchema), async (c) => {
  const a = getAuth(c);
  const { amountKobo } = c.req.valid("json");
  const data = await service.initiatePayment(a.userId, c.req.param("loanId") ?? "", amountKobo, c.req.header("Idempotency-Key"), { requestId: reqId(c) });
  return c.json({ success: true, data }, 201);
});

paymentRoutes.post("/payments/:id/confirm", authMiddleware, rateLimit(30, 3600), async (c) => {
  const a = getAuth(c);
  const data = await service.confirmPaymentViaProvider({ userId: a.userId, role: a.role }, c.req.param("id") ?? "", { requestId: reqId(c) });
  return c.json({ success: true, data });
});

paymentRoutes.get("/payments/:id", authMiddleware, requirePerm("payment.read"), async (c) => {
  const a = getAuth(c);
  return c.json({ success: true, data: await service.getPayment({ userId: a.userId, role: a.role }, c.req.param("id") ?? "") });
});

paymentRoutes.post("/payments/:id/reverse", authMiddleware, requirePerm("payment.reverse"), async (c) => {
  const a = getAuth(c);
  const body = await c.req.json().catch(() => ({}));
  const reason = String((body as { reason?: string }).reason ?? "admin reversal");
  return c.json({ success: true, data: await service.reversePayment({ userPublicId: a.userPublicId, role: a.role }, c.req.param("id") ?? "", reason, { requestId: reqId(c) }) });
});
