import { z } from "zod";
export const kycVerifySchema = z.object({
  idType: z.enum(["BVN", "NIN", "DRIVERS", "VOTERS"]),
  idNumber: z.string().min(4).max(30),
  dateOfBirth: z.string().optional(),
});
export type KycVerifyInput = z.infer<typeof kycVerifySchema>;
