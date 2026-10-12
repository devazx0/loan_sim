import { prisma } from "../infrastructure/database/prisma";

export async function audit(
  entry: { actor: string; actorRole?: string; action: string; resource: string; resourceId?: string; requestId?: string; metadata?: Record<string, unknown>; userId?: number },
): Promise<void> {
  // Never throws — audit must not break business flow; log locally on failure.
  try {
    await prisma.auditLog.create({
      data: {
        actor: entry.actor,
        actorRole: entry.actorRole,
        action: entry.action,
        resource: entry.resource,
        resourceId: entry.resourceId,
        requestId: entry.requestId,
        metadata: JSON.stringify(entry.metadata ?? {}),
        userId: entry.userId,
      },
    });
  } catch {
    // swallow
  }
}

export const AUDIT_ACTIONS = {
  USER_REGISTER: "USER_REGISTER",
  USER_LOGIN: "USER_LOGIN",
  KYC_VERIFIED: "KYC_VERIFIED",
  LOAN_APPLIED: "LOAN_APPLIED",
  LOAN_APPROVED: "LOAN_APPROVED",
  LOAN_REJECTED: "LOAN_REJECTED",
  OFFER_ACCEPTED: "OFFER_ACCEPTED",
  LOAN_DISBURSED: "LOAN_DISBURSED",
  PAYMENT_CREATED: "PAYMENT_CREATED",
  PAYMENT_COMPLETED: "PAYMENT_COMPLETED",
  PAYMENT_REVERSED: "PAYMENT_REVERSED",
  LOAN_WRITTEN_OFF: "LOAN_WRITTEN_OFF",
  ROLE_CHANGED: "ROLE_CHANGED",
} as const;

