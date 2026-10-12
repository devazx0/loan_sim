import { z } from "zod";
export const initiatePaymentSchema = z.object({
  amountKobo: z.number().int().min(100),
});
export const webhookPaymentSchema = z.object({
  providerEventId: z.string().min(3).max(200),
  reference: z.string().min(3), // our payment publicId OR provider reference
  status: z.enum(["SUCCESS", "FAILED", "PENDING"]),
  amountKobo: z.number().int().min(0).optional(),
  signature: z.string().optional(),
});
export const webhookBankSchema = z.object({
  providerEventId: z.string().min(3).max(200),
  reference: z.string().min(3), // disbursement reference
  status: z.enum(["SUCCESS", "FAILED", "PENDING"]),
  signature: z.string().optional(),
});
