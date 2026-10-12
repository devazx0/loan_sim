import { Hono } from "hono";
import { authMiddleware, getAuth, rateLimit, reqId } from "../../common/middleware";
import { prisma } from "../../infrastructure/database/prisma";
import * as loans from "./service";

export const loanRoutes = new Hono();
loanRoutes.use("*", authMiddleware);

loanRoutes.get("/", async (c) => {
  const a = getAuth(c);
  const customer = await prisma.customerProfile.findUnique({ where: { userId: a.userId } });
  const items = customer
    ? await prisma.loan.findMany({ where: { customerId: customer.id }, orderBy: { id: "desc" }, select: { publicId: true, principalKobo: true, outstandingKobo: true, status: true, disbursedAt: true } })
    : [];
  return c.json({ success: true, data: { items: items.map((l) => ({ id: l.publicId, principalKobo: l.principalKobo, outstandingKobo: l.outstandingKobo, status: l.status, disbursedAt: l.disbursedAt })) } });
});

loanRoutes.post("/applications/:id/disburse", rateLimit(10, 3600), async (c) => {
  const a = getAuth(c);
  const data = await loans.requestDisbursement(a.userId, c.req.param("id") ?? "", c.req.header("Idempotency-Key"), { requestId: reqId(c) });
  return c.json({ success: true, data }, 201);
});

loanRoutes.get("/:id", async (c) => {
  const a = getAuth(c);
  return c.json({ success: true, data: await loans.getLoan({ userId: a.userId, role: a.role }, c.req.param("id") ?? "") });
});

loanRoutes.post("/disbursements/:ref/confirm", async (c) => {
  // Demo/simulated confirmation (stands in for async bank settlement poll)
  const ref = c.req.param("ref") ?? "";
  const data = await loans.confirmDisbursement(ref, `verify_${ref}`, { requestId: reqId(c) });
  return c.json({ success: true, data });
});




