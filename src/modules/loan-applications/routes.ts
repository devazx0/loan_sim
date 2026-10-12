import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { authMiddleware, getAuth, requirePerm, requireRole, rateLimit, reqId } from "../../common/middleware";
import { createApplicationSchema, reviewSchema } from "./dto";
import * as service from "./service";

export const applicationRoutes = new Hono();
applicationRoutes.use("*", authMiddleware);

applicationRoutes.post("/", rateLimit(20, 3600), zValidator("json", createApplicationSchema), async (c) => {
  const a = getAuth(c);
  const data = await service.createApplication(a.userId, c.req.valid("json"), { requestId: reqId(c) });
  return c.json({ success: true, data }, 201);
});

applicationRoutes.post("/:id/submit", rateLimit(20, 3600), async (c) => {
  const a = getAuth(c);
  const data = await service.submitApplication(a.userId, c.req.param("id") ?? "", { requestId: reqId(c) });
  return c.json({ success: true, data });
});

applicationRoutes.post("/:id/accept-offer", async (c) => {
  const a = getAuth(c);
  const data = await service.acceptOffer(a.userId, c.req.param("id") ?? "", { requestId: reqId(c) });
  return c.json({ success: true, data });
});

applicationRoutes.get("/", async (c) => {
  const a = getAuth(c);
  const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 100);
  const cursor = c.req.query("cursor");
  const cursorId = cursor ? Number(cursor) : undefined;
  return c.json({ success: true, data: await service.listApplications({ userId: a.userId, role: a.role }, { limit, cursorId }) });
});

applicationRoutes.get("/:id", async (c) => {
  const a = getAuth(c);
  return c.json({ success: true, data: await service.getApplication({ userId: a.userId, role: a.role }, c.req.param("id") ?? "") });
});

// Admin review
applicationRoutes.post("/:id/review", requireRole("CREDIT_ANALYST", "ADMIN", "SUPER_ADMIN"), requirePerm("loan.approve"), zValidator("json", reviewSchema), async (c) => {
  const a = getAuth(c);
  const { decision, reason } = c.req.valid("json");
  const data = await service.reviewApplication({ userPublicId: a.userPublicId, role: a.role }, c.req.param("id") ?? "", decision, reason, { requestId: reqId(c) });
  return c.json({ success: true, data });
});

export const adminReviewSchema = z.object({ decision: z.enum(["APPROVE", "REJECT"]), reason: z.string().min(3) });




