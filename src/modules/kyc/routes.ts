import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { authMiddleware, getAuth, rateLimit, reqId } from "../../common/middleware";
import { kycVerifySchema } from "./dto";
import * as service from "./service";

export const kycRoutes = new Hono();
kycRoutes.use("*", authMiddleware);
kycRoutes.post("/verify", rateLimit(10, 3600), zValidator("json", kycVerifySchema), async (c) => {
  const a = getAuth(c);
  const data = await service.verifyKyc(a.userId, c.req.valid("json"), { requestId: reqId(c), actorPublicId: a.userPublicId });
  return c.json({ success: true, data }, 201);
});
kycRoutes.get("/status", async (c) => {
  const a = getAuth(c);
  return c.json({ success: true, data: await service.latestKycStatus(a.userId) });
});



