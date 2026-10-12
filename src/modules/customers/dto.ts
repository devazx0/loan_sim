import { z } from "zod";
import { MAX_MONEY_KOBO } from "../../common/money";
export const updateProfileSchema = z.object({
  firstName: z.string().min(2).max(100).optional(),
  lastName: z.string().min(2).max(100).optional(),
  dateOfBirth: z.string().optional(),
  address: z.string().max(500).optional(),
  employmentStatus: z.string().max(100).optional(),
  monthlyIncomeKobo: z.number().int().min(0).max(MAX_MONEY_KOBO).optional(),
  obligationsKobo: z.number().int().min(0).max(MAX_MONEY_KOBO).optional(),
  bankAccountRef: z.string().max(100).optional(),
  deviceId: z.string().max(100).optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
