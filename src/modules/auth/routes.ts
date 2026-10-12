import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { registerSchema, loginSchema, refreshSchema } from "./dto";
import * as service from "./service";
import { rateLimit, reqId } from "../../common/middleware";

export const authRoutes = new Hono();

authRoutes.post("/register", rateLimit(10, 60), zValidator("json", registerSchema), async (c) => {
  const input = c.req.valid("json");
  const result = await service.register(input, { ip: c.req.header("x-forwarded-for"), ua: c.req.header("user-agent"), requestId: reqId(c) });
  return c.json({ success: true, data: result }, 201);
});

authRoutes.post("/login", rateLimit(10, 60), zValidator("json", loginSchema), async (c) => {
  const input = c.req.valid("json");
  const result = await service.login(input, { ip: c.req.header("x-forwarded-for"), ua: c.req.header("user-agent"), requestId: reqId(c) });
  return c.json({ success: true, data: result });
});

authRoutes.post("/refresh", zValidator("json", refreshSchema), async (c) => {
  const { refreshToken } = c.req.valid("json");
  const result = await service.refresh(refreshToken);
  return c.json({ success: true, data: result });
});

authRoutes.post("/logout", zValidator("json", refreshSchema), async (c) => {
  const { refreshToken } = c.req.valid("json");
  await service.logout(refreshToken);
  return c.json({ success: true, data: { message: "Logged out" } });
});



