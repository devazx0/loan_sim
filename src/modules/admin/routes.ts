import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { authMiddleware, requireRole, requirePerm, reqId, getAuth } from "../../common/middleware";
import { prisma } from "../../infrastructure/database/prisma";
import * as collections from "../collections/actions";
import { runOverdueJob } from "../collections/service";

export const adminRoutes = new Hono();
adminRoutes.use("*", authMiddleware);

const collectionActionSchema = z.object({ action: z.string(), note: z.string().optional() });

// Paginated listings (cursor)
function cursorOpts(c: { req: { query: (k: string) => string | undefined } }) {
  const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 100);
  const cursor = c.req.query("cursor");
  return { limit, cursorId: cursor ? Number(cursor) : undefined };
}

adminRoutes.get("/customers", requireRole("ADMIN", "SUPER_ADMIN", "LOAN_OFFICER"), async (c) => {
  const { limit, cursorId } = cursorOpts(c);
  const items = await prisma.customerProfile.findMany({
    orderBy: { id: "asc" }, take: limit + 1, ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    select: { id: true, publicId: true, firstName: true, lastName: true, monthlyIncomeKobo: true, createdAt: true },
  });
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  return c.json({ success: true, data: { items: page, nextCursor: hasMore ? String(page[page.length - 1]!.id) : null } });
});

adminRoutes.get("/loans", requirePerm("loan.read"), async (c) => {
  const { limit, cursorId } = cursorOpts(c);
  const items = await prisma.loan.findMany({
    orderBy: { id: "asc" }, take: limit + 1, ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    select: { id: true, publicId: true, principalKobo: true, outstandingKobo: true, status: true, createdAt: true },
  });
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  return c.json({ success: true, data: { items: page.map((l) => ({ id: l.publicId, principalKobo: l.principalKobo, outstandingKobo: l.outstandingKobo, status: l.status, createdAt: l.createdAt })), nextCursor: hasMore ? String(page[page.length - 1]!.id) : null } });
});

adminRoutes.get("/payments", requirePerm("payment.read"), async (c) => {
  const { limit, cursorId } = cursorOpts(c);
  const items = await prisma.payment.findMany({
    orderBy: { id: "asc" }, take: limit + 1, ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    select: { id: true, publicId: true, amountKobo: true, status: true, createdAt: true },
  });
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  return c.json({ success: true, data: { items: page.map((p) => ({ id: p.publicId, amountKobo: p.amountKobo, status: p.status, createdAt: p.createdAt })), nextCursor: hasMore ? String(page[page.length - 1]!.id) : null } });
});

adminRoutes.get("/audit", requireRole("ADMIN", "SUPER_ADMIN"), async (c) => {
  const { limit, cursorId } = cursorOpts(c);
  const items = await prisma.auditLog.findMany({
    orderBy: { id: "desc" }, take: limit + 1, ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
  });
  const hasMore = items.length > limit;
  const page = (hasMore ? items.slice(0, limit) : items).map((a) => ({ ...a, metadata: a.metadata }));
  return c.json({ success: true, data: { items: page, nextCursor: hasMore ? String(page[page.length - 1]!.id) : null } });
});

adminRoutes.get("/webhooks", requireRole("ADMIN", "SUPER_ADMIN", "FINANCE_OFFICER"), async (c) => {
  const { limit, cursorId } = cursorOpts(c);
  const items = await prisma.webhookEvent.findMany({
    orderBy: { id: "desc" }, take: limit + 1, ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
  });
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  return c.json({ success: true, data: { items: page, nextCursor: hasMore ? String(page[page.length - 1]!.id) : null } });
});

adminRoutes.get("/dead-letters", requireRole("ADMIN", "SUPER_ADMIN"), async (c) => {
  const items = await prisma.deadLetter.findMany({ orderBy: { id: "desc" }, take: 50 });
  return c.json({ success: true, data: { items } });
});

adminRoutes.get("/collections", requirePerm("collection.manage"), async (c) => {
  const { limit, cursorId } = cursorOpts(c);
  return c.json({ success: true, data: await collections.listCollectionCases({ limit, cursorId }) });
});

adminRoutes.post("/collections/:id/actions", requirePerm("collection.manage"), zValidator("json", collectionActionSchema), async (c) => {
  const a = getAuth(c);
  const { action, note } = c.req.valid("json");
  return c.json({ success: true, data: await collections.addCollectionAction({ userPublicId: a.userPublicId, role: a.role }, c.req.param("id") ?? "", action, note, { requestId: reqId(c) }) }, 201);
});

adminRoutes.post("/jobs/overdue", requireRole("ADMIN", "SUPER_ADMIN", "COLLECTIONS_OFFICER"), async (c) => {
  return c.json({ success: true, data: await runOverdueJob() });
});

adminRoutes.get("/kyc", requireRole("ADMIN", "SUPER_ADMIN", "LOAN_OFFICER"), async (c) => {
  const items = await prisma.kycRecord.findMany({ orderBy: { id: "desc" }, take: 50, select: { publicId: true, status: true, provider: true, attempts: true, createdAt: true, customerId: true } });
  return c.json({ success: true, data: { items } });
});




