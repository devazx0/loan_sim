import { z } from "zod";
export const createApplicationSchema = z.object({
  productId: z.string().uuid(),
  amountKobo: z.number().int().min(10000),
  tenorMonths: z.number().int().min(1).max(60),
  purpose: z.string().max(500).optional(),
});
export const reviewSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  reason: z.string().min(3).max(1000),
});
export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;
