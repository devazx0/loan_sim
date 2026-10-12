import { Hono } from "hono";
import { prisma } from "../../infrastructure/database/prisma";

export const healthRoutes = new Hono();
healthRoutes.get("/health", async (c) => c.json({ success: true, data: { status: "ok", time: new Date().toISOString() } }));
healthRoutes.get("/ready", async (c) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return c.json({ success: true, data: { status: "ready", db: "up" } });
  } catch {
    return c.json({ success: false, error: { code: "NOT_READY", message: "DB unavailable" } }, 503);
  }
});

