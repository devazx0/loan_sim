import { prisma } from "../../infrastructure/database/prisma";
import { NotFoundError } from "../../common/errors";
import { FakeKycProvider } from "../../infrastructure/providers/fake-kyc";
import { audit, AUDIT_ACTIONS } from "../../common/audit";
import { queue } from "../../infrastructure/queue/queue";
import { stageEvent } from "../../common/events";
import type { KycVerifyInput } from "./dto";

const provider = new FakeKycProvider();

export async function verifyKyc(userId: number, input: KycVerifyInput, ctx: { requestId?: string; actorPublicId: string }) {
  const customer = await prisma.customerProfile.findUnique({ where: { userId } });
  if (!customer) throw new NotFoundError("Customer profile not found");
  const result = await provider.verifyIdentity({
    customerPublicId: customer.publicId,
    firstName: customer.firstName,
    lastName: customer.lastName,
    dateOfBirth: input.dateOfBirth,
    idType: input.idType,
    idNumber: input.idNumber,
  });
  // Minimal storage: no raw idNumber persisted.
  const { rec: record, msg } = await prisma.$transaction(async (tx) => {
    const prior = await tx.kycRecord.findFirst({ where: { customerId: customer.id }, orderBy: { id: "desc" } });
    const rec = await tx.kycRecord.create({
      data: {
        customerId: customer.id,
        status: result.status,
        provider: provider.name,
        providerRef: result.providerRef,
        attempts: (prior?.attempts ?? 0) + 1,
        verifiedAt: result.status === "VERIFIED" ? new Date() : null,
        metadata: JSON.stringify({ idType: input.idType, reasons: result.reasons }),
      },
    });
    const msg = await stageEvent(tx, "kyc.verification.requested", customer.publicId, { customerId: customer.publicId, status: result.status });
    return { rec, msg };
  });
  if (result.status === "VERIFIED") {
    await audit({ actor: ctx.actorPublicId, action: AUDIT_ACTIONS.KYC_VERIFIED, resource: "kyc", resourceId: record.publicId, requestId: ctx.requestId, userId });
  }
  await queue.publish(msg);
  return { id: record.publicId, status: record.status, providerRef: record.providerRef, verifiedAt: record.verifiedAt };
}

export async function latestKycStatus(userId: number) {
  const customer = await prisma.customerProfile.findUnique({ where: { userId } });
  if (!customer) throw new NotFoundError("Customer profile not found");
  const rec = await prisma.kycRecord.findFirst({ where: { customerId: customer.id }, orderBy: { id: "desc" } });
  return rec ? { id: rec.publicId, status: rec.status, verifiedAt: rec.verifiedAt } : { id: null, status: "NONE" as const, verifiedAt: null };
}

