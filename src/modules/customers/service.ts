import { prisma } from "../../infrastructure/database/prisma";
import { NotFoundError, ForbiddenError } from "../../common/errors";
import type { UpdateProfileInput } from "./dto";
import { audit } from "../../common/audit";

export function toCustomerDto(c: { publicId: string; firstName: string; lastName: string; monthlyIncomeKobo: number; obligationsKobo: number; address: string | null; employmentStatus: string | null; bankAccountRef: string | null }) {
  return { id: c.publicId, firstName: c.firstName, lastName: c.lastName, monthlyIncomeKobo: c.monthlyIncomeKobo, obligationsKobo: c.obligationsKobo, address: c.address, employmentStatus: c.employmentStatus, bankAccountRef: c.bankAccountRef };
}

export async function getMyProfile(userId: number) {
  const c = await prisma.customerProfile.findUnique({ where: { userId } });
  if (!c) throw new NotFoundError("Customer profile not found");
  return toCustomerDto(c);
}

export async function updateMyProfile(userId: number, input: UpdateProfileInput, ctx: { requestId?: string; actorPublicId: string }) {
  const c = await prisma.customerProfile.findUnique({ where: { userId } });
  if (!c) throw new NotFoundError("Customer profile not found");
  const updated = await prisma.customerProfile.update({
    where: { userId },
    data: {
      ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
      ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
      ...(input.dateOfBirth !== undefined ? { dateOfBirth: new Date(input.dateOfBirth) } : {}),
      ...(input.address !== undefined ? { address: input.address } : {}),
      ...(input.employmentStatus !== undefined ? { employmentStatus: input.employmentStatus } : {}),
      ...(input.monthlyIncomeKobo !== undefined ? { monthlyIncomeKobo: input.monthlyIncomeKobo } : {}),
      ...(input.obligationsKobo !== undefined ? { obligationsKobo: input.obligationsKobo } : {}),
      ...(input.bankAccountRef !== undefined ? { bankAccountRef: input.bankAccountRef } : {}),
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    },
  });
  await audit({ actor: ctx.actorPublicId, action: "CUSTOMER_UPDATED", resource: "customer", resourceId: c.publicId, requestId: ctx.requestId, userId });
  return toCustomerDto(updated);
}

/** Object-level auth: load customer by publicId, ensure owner or staff. */
export async function getCustomerByPublicId(publicId: string, requester: { userId: number; role: string }) {
  const c = await prisma.customerProfile.findUnique({ where: { publicId }, include: { user: true } });
  if (!c) throw new NotFoundError("Customer not found");
  const isOwner = c.userId === requester.userId;
  const isStaff = requester.role !== "CUSTOMER";
  if (!isOwner && !isStaff) throw new ForbiddenError("Cannot access another customer's profile");
  return toCustomerDto(c);
}

