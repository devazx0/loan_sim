import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { authMiddleware, requirePerm } from "../../common/middleware";
import { productSchema } from "./dto";
import * as service from "./service";

export const productRoutes = new Hono();
productRoutes.use("*", authMiddleware);
productRoutes.get("/", async (c) => c.json({ success: true, data: await service.listActiveProducts() }));
productRoutes.get("/:id", async (c) => c.json({ success: true, data: await service.getProduct(c.req.param("id") ?? "") }));
productRoutes.post("/", requirePerm("product.manage"), zValidator("json", productSchema), async (c) => {
  return c.json({ success: true, data: await service.createProduct(c.req.valid("json")) }, 201);
});
productRoutes.patch("/:id", requirePerm("product.manage"), zValidator("json", productSchema.partial()), async (c) => {
  return c.json({ success: true, data: await service.updateProduct(c.req.param("id") ?? "", c.req.valid("json")) });
});


