import { z } from "zod";
export const productSchema = z.object({
  code: z.string().min(2).max(50),
  name: z.string().min(2).max(200),
  description: z.string().max(1000).optional(),
  minAmountKobo: z.number().int().min(10000),
  maxAmountKobo: z.number().int().min(10000),
  minTenorMonths: z.number().int().min(1).max(60),
  maxTenorMonths: z.number().int().min(1).max(60),
  interestRateBps: z.number().int().min(0).max(10000),
  interestMethod: z.enum(["FLAT", "REDUCING"]).default("FLAT"),
  processingFeeKobo: z.number().int().min(0).default(0),
  lateFeeKobo: z.number().int().min(0).default(0),
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
});
export type ProductInput = z.infer<typeof productSchema>;
