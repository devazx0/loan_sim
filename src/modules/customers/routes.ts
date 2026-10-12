import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { authMiddleware, getAuth, reqId } from "../../common/middleware";
import { updateProfileSchema } from "./dto";
import * as service from "./service";

export const customerRoutes = new Hono();
customerRoutes.use("*", authMiddleware);

customerRoutes.get("/me", async (c) => {
  const a = getAuth(c);
  const data = await service.getMyProfile(a.userId);
  return c.json({ success: true, data });
});

customerRoutes.patch("/me", zValidator("json", updateProfileSchema), async (c) => {
  const a = getAuth(c);
  const data = await service.updateMyProfile(a.userId, c.req.valid("json"), { requestId: reqId(c), actorPublicId: a.userPublicId });
  return c.json({ success: true, data });
});

customerRoutes.get("/:id", async (c) => {
  const a = getAuth(c);
  const data = await service.getCustomerByPublicId(c.req.param("id") ?? "", { userId: a.userId, role: a.role });
  return c.json({ success: true, data });
});




