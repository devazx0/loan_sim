import { Hono } from "hono";
import { authMiddleware, requirePerm, getAuth, reqId } from "../../common/middleware";
import { audit } from "../../common/audit";
import * as reports from "./service";
import { paymentProvider } from "../payments/service";
import { prisma } from "../../infrastructure/database/prisma";

export const reportRoutes = new Hono();
reportRoutes.use("*", authMiddleware);
reportRoutes.get("/summary", requirePerm("report.read"), async (c) => {
  return c.json({ success: true, data: await reports.summaryReport() });
});
reportRoutes.get("/reconciliation", requirePerm("report.read"), async (c) => {
  // Simulated: build provider records from internal provider refs + injected anomalies = none by default.
  // In production this would fetch from provider API; here we mirror internal state.
  const internals = await prisma.payment.findMany({ select: { publicId: true, amountKobo: true, status: true } });
  const providerRecords = internals.map((p) => ({ reference: p.publicId, amountKobo: p.amountKobo, status: p.status === "SUCCESS" ? "SUCCESS" : p.status }));
  void paymentProvider;
  return c.json({ success: true, data: await reports.reconcilePayments(providerRecords) });
});

// Reconciliation workflow is detect -> flag -> review -> resolve -> audit.
// Findings are computed (never auto-mutating); acknowledging records the review decision.
reportRoutes.post("/reconciliation/acknowledge", requirePerm("report.read"), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const a = getAuth(c);
  await audit({
    actor: a.userPublicId, actorRole: a.role, action: "RECONCILIATION_REVIEWED",
    resource: "reconciliation", requestId: reqId(c), metadata: body as Record<string, unknown>,
  });
  return c.json({ success: true, data: { acknowledged: true } });
});

