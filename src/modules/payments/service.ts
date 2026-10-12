import { prisma } from "../../infrastructure/database/prisma";
import { NotFoundError, ForbiddenError, ValidationError } from "../../common/errors";
import { FakePaymentProvider } from "../../infrastructure/providers/fakes";
import { postRepayment, postRepaymentReversal } from "../ledger/service";
import { stableHash } from "../../common/crypto";
import { assertLoanTransitionIfChanged, assertTransitionIfChanged, type LoanStatus, type AppStatus } from "../loan-applications/state-machine";
import { claimKey, completeKey, failKey } from "../../common/idempotency";
import { audit, AUDIT_ACTIONS } from "../../common/audit";
import { queue } from "../../infrastructure/queue/queue";
import { stageEvent } from "../../common/events";
import { riskRules } from "../../config/index";

export const paymentProvider = new FakePaymentProvider();

/** Allocation order: fees -> interest -> principal, oldest due first. Returns leftover (overpayment). */
export function allocateAcrossSchedules(
  schedules: { id: number; feesKobo: number; interestKobo: number; principalKobo: number; amountPaidKobo: number; totalDueKobo: number }[],
  paymentKobo: number,
): { allocations: { scheduleId: number; fees: number; interest: number; principal: number; total: number }[]; leftover: number } {
  let remaining = paymentKobo;
  const allocations: { scheduleId: number; fees: number; interest: number; principal: number; total: number }[] = [];
  // oldest first assumed pre-sorted
  for (const s of schedules) {
    if (remaining <= 0) break;
    const owed = s.totalDueKobo - s.amountPaidKobo;
    if (owed <= 0) continue;
    // Decompose paid-so-far into buckets to know what's left per bucket.
    // Paid is assumed to have filled fees, then interest, then principal.
    const feeOwed = Math.max(0, s.feesKobo - Math.min(s.amountPaidKobo, s.feesKobo));
    const paidAfterFees = Math.max(0, s.amountPaidKobo - s.feesKobo);
    const intOwed = Math.max(0, s.interestKobo - Math.min(paidAfterFees, s.interestKobo));
    const paidAfterInt = Math.max(0, paidAfterFees - s.interestKobo);
    const prinOwed = Math.max(0, s.principalKobo - Math.min(paidAfterInt, s.principalKobo));
    const f = Math.min(remaining, feeOwed); remaining -= f;
    const i = remaining > 0 ? Math.min(remaining, intOwed) : 0; remaining -= i;
    const p = remaining > 0 ? Math.min(remaining, prinOwed) : 0; remaining -= p;
    // Rounding-safe: any residual owed beyond buckets (shouldn't happen) goes to principal
    if (f + i + p > 0) allocations.push({ scheduleId: s.id, fees: f, interest: i, principal: p, total: f + i + p });
  }
  return { allocations, leftover: remaining };
}

export async function initiatePayment(userId: number, loanPublicId: string, amountKobo: number, idempotencyKey: string | undefined, ctx: { requestId?: string }) {
  if (!idempotencyKey) throw new ValidationError("Idempotency-Key header required");
  const loan = await prisma.loan.findUnique({ where: { publicId: loanPublicId }, include: { customer: true } });
  if (!loan) throw new NotFoundError("Loan not found");
  if (loan.customer.userId !== userId) throw new ForbiddenError("Not your loan");
  if (!["ACTIVE", "OVERDUE"].includes(loan.status)) throw new ValidationError(`Cannot pay loan in ${loan.status}`);
  if (amountKobo <= 0) throw new ValidationError("Amount must be positive");

  const reqHash = stableHash({ loan: loanPublicId, amountKobo });
  const claim = await claimKey({ key: idempotencyKey, userId, endpoint: "payment.initiate", requestHash: reqHash });
  if (claim.replay) return claim.replay as { paymentId: string; status: "PENDING"; providerRef: string };

  try {
    const { payment, msg } = await prisma.$transaction(async (tx) => {
      const p = await tx.payment.create({
        data: { loanId: loan.id, amountKobo, status: "PENDING", provider: paymentProvider.name, idempotencyKey },
      });
      const staged = await stageEvent(tx, "payment.initiated", p.publicId, { paymentId: p.publicId, loanId: loan.publicId, amountKobo });
      return { payment: p, msg: staged };
    });
    // Provider call OUTSIDE tx. On provider failure no money moved: fail the key so the
    // same key+body may retry (a fresh PENDING payment row is created; the abandoned
    // PENDING row is never applied and stays visible as FAILED-at-provider history).
    const res = await paymentProvider.initiatePayment({ reference: payment.publicId, amountKobo, customerRef: loan.customer.publicId });
    await prisma.payment.update({ where: { id: payment.id }, data: { providerRef: res.providerRef } });
    await prisma.paymentAttempt.create({ data: { paymentId: payment.id, providerRef: res.providerRef, status: res.status, response: JSON.stringify(res) } });

    const dto = { paymentId: payment.publicId, status: "PENDING" as const, providerRef: res.providerRef };
    await completeKey(idempotencyKey, dto);
    await audit({ actor: loan.customer.publicId, action: AUDIT_ACTIONS.PAYMENT_CREATED, resource: "payment", resourceId: payment.publicId, requestId: ctx.requestId, userId });
    await queue.publish(msg);
    return dto;
  } catch (e) {
    // Only safe because nothing above commits a financial effect before provider success;
    // the payment row (if created) stays PENDING and is never applied without a webhook.
    await failKey(idempotencyKey, e instanceof Error ? e.message : String(e));
    throw e;
  }
}

/**
 * Core financial finalization — single ACID transaction:
 * verify not processed -> mark success -> allocate -> persist allocations ->
 * update schedules/loan -> ledger -> audit -> outbox.
 * Idempotent: replaying same providerEventId or already-SUCCESS payment => single effect.
 */
export async function processSuccessfulPayment(paymentPublicId: string, ctx: { requestId?: string; providerEventId?: string }) {
  const { result, messages } = await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({ where: { publicId: paymentPublicId }, include: { loan: true } });
    if (!payment) throw new NotFoundError("Payment not found");
    if (payment.status === "SUCCESS") return { result: { paymentId: payment.publicId, status: "SUCCESS" as const, duplicate: true }, messages: [] as Awaited<ReturnType<typeof stageEvent>>[] };
    if (payment.status === "REVERSED") throw new ValidationError("Cannot complete reversed payment");
    if (!["ACTIVE", "OVERDUE"].includes(payment.loan.status)) throw new ValidationError(`Loan is ${payment.loan.status}`);

    const schedules = await tx.repaymentSchedule.findMany({
      where: { loanId: payment.loanId, status: { in: ["PENDING", "PARTIALLY_PAID", "OVERDUE"] } },
      orderBy: [{ dueDate: "asc" }, { installmentNo: "asc" }],
    });
    const { allocations, leftover } = allocateAcrossSchedules(schedules, payment.amountKobo);
    let totF = 0, totI = 0, totP = 0;
    for (const a of allocations) {
      totF += a.fees; totI += a.interest; totP += a.principal;
      const s = schedules.find((x) => x.id === a.scheduleId)!;
      const newPaid = s.amountPaidKobo + a.total;
      const status = newPaid >= s.totalDueKobo ? "PAID" : newPaid > 0 ? "PARTIALLY_PAID" : s.status;
      await tx.repaymentSchedule.update({ where: { id: s.id }, data: { amountPaidKobo: newPaid, status, paidAt: status === "PAID" ? new Date() : s.paidAt } });
      await tx.paymentAllocation.create({
        data: { paymentId: payment.id, scheduleId: s.id, feesKobo: a.fees, interestKobo: a.interest, principalKobo: a.principal },
      });
    }
    if (leftover > 0) {
      // Overpayment: applied directly against outstanding (principal prepayment), tracked
      // as a schedule-less allocation so reversal can exactly undo it.
      totP += leftover;
      await tx.paymentAllocation.create({
        data: { paymentId: payment.id, scheduleId: null, feesKobo: 0, interestKobo: 0, principalKobo: leftover },
      });
    }
    const applied = totF + totI + totP;
    const newOutstanding = Math.max(0, payment.loan.outstandingKobo - applied);
    // Loan status: completed if fully repaid, else ACTIVE (clear OVERDUE if no overdue schedules remain)
    const remainingOverdue = await tx.repaymentSchedule.count({ where: { loanId: payment.loanId, status: "OVERDUE" } });
    let loanStatus = payment.loan.status;
    if (newOutstanding === 0) loanStatus = "COMPLETED";
    else if (remainingOverdue === 0 && loanStatus === "OVERDUE") loanStatus = "ACTIVE";
    // Note: overdue flag job may set OVERDUE again if other installments past due.

    await tx.payment.update({ where: { id: payment.id }, data: { status: "SUCCESS", verifiedAt: new Date(), appliedKobo: applied, leftoverKobo: leftover } });
    assertLoanTransitionIfChanged(payment.loan.status as LoanStatus, loanStatus as LoanStatus);
    await tx.loan.update({ where: { id: payment.loanId }, data: { outstandingKobo: newOutstanding, status: loanStatus, completedAt: loanStatus === "COMPLETED" ? new Date() : null, version: { increment: 1 } } });
    if (loanStatus === "COMPLETED") {
      assertTransitionIfChanged(payment.loan.status as AppStatus, "COMPLETED");
      await tx.loanApplication.update({ where: { id: payment.loan.applicationId }, data: { status: "COMPLETED" } });
    }
    await postRepayment(tx, `ledger-pay-${payment.publicId}`, { feesKobo: totF, interestKobo: totI, principalKobo: totP });
    const completedMsg = await stageEvent(tx, "payment.completed", payment.publicId, { paymentId: payment.publicId, applied, leftover });
    await tx.notification.create({ data: { customerId: payment.loan.customerId, channel: "SMS", template: "payment_received", payload: JSON.stringify({ paymentId: payment.publicId, applied }), status: "QUEUED" } });
    const notifMsg = await stageEvent(tx, "notification.requested", payment.publicId, { template: "payment_received", customerId: payment.loan.customerId });
    return { result: { paymentId: payment.publicId, status: "SUCCESS" as const, duplicate: false, applied, leftover, loanStatus }, messages: [completedMsg, notifMsg] };
  });
  if (!result.duplicate) {
    await audit({ actor: "SYSTEM", action: AUDIT_ACTIONS.PAYMENT_COMPLETED, resource: "payment", resourceId: result.paymentId, requestId: ctx.requestId });
    for (const m of messages) await queue.publish(m);
  }
  return result;
}

/**
 * Full reversal: exactly undoes processSuccessfulPayment using stored allocations.
 * - Only SUCCESS payments; a REVERSED payment can never be reversed again.
 * - Schedules: amountPaidKobo reduced, status recalculated (PAID/PARTIALLY_PAID/
 *   PENDING, or OVERDUE if still past the grace window).
 * - Loan/application: COMPLETED reopens to ACTIVE via the explicit, audited
 *   reversal path (LOAN_REOPENED); balances restored by the applied amount.
 * - Ledger: exact mirror entries (Dr Receivable/InterestIncome/FeeIncome, Cr Cash).
 */
export async function reversePayment(admin: { userPublicId: string; role: string }, paymentPublicId: string, reason: string, ctx: { requestId?: string }) {
  const payment = await prisma.payment.findUnique({ where: { publicId: paymentPublicId }, include: { loan: true } });
  if (!payment) throw new NotFoundError("Payment not found");
  if (payment.status !== "SUCCESS") throw new ValidationError("Only SUCCESS payments can be reversed");
  const res = await paymentProvider.refundPayment(payment.providerRef ?? payment.publicId);
  if (res.status !== "REVERSED") throw new ValidationError("Provider refund failed");
  const { result, messages, reopened } = await prisma.$transaction(async (tx) => {
    const messages: Awaited<ReturnType<typeof stageEvent>>[] = [];
    const fresh = await tx.payment.findUnique({ where: { id: payment.id }, include: { allocations: true, loan: true } });
    if (!fresh) throw new NotFoundError("Payment not found");
    if (fresh.status !== "SUCCESS") throw new ValidationError("Only SUCCESS payments can be reversed");
    let totF = 0, totI = 0, totP = 0;
    const graceCutoff = new Date(Date.now() - riskRules.lateFeeGraceDays * 24 * 3600 * 1000);
    for (const alloc of fresh.allocations) {
      totF += alloc.feesKobo; totI += alloc.interestKobo; totP += alloc.principalKobo;
      if (alloc.scheduleId === null) continue; // overpayment: outstanding-only, restored below
      const s = await tx.repaymentSchedule.findUniqueOrThrow({ where: { id: alloc.scheduleId } });
      const undone = alloc.feesKobo + alloc.interestKobo + alloc.principalKobo;
      const newPaid = Math.max(0, s.amountPaidKobo - undone);
      const status = newPaid >= s.totalDueKobo ? "PAID"
        : newPaid > 0 ? "PARTIALLY_PAID"
        : s.dueDate < graceCutoff ? "OVERDUE" : "PENDING";
      await tx.repaymentSchedule.update({
        where: { id: s.id },
        data: { amountPaidKobo: newPaid, status, paidAt: status === "PAID" ? s.paidAt : null },
      });
    }
    const applied = totF + totI + totP;
    const loan = await tx.loan.findUniqueOrThrow({ where: { id: payment.loanId } });
    const wasCompleted = loan.status === "COMPLETED";
    await tx.payment.update({ where: { id: payment.id }, data: { status: "REVERSED" } });
    await tx.loan.update({
      where: { id: payment.loanId },
      data: {
        outstandingKobo: loan.outstandingKobo + applied,
        status: wasCompleted ? "ACTIVE" : loan.status,
        completedAt: wasCompleted ? null : loan.completedAt,
        version: { increment: 1 },
      },
    });
    if (wasCompleted) {
      // Explicit audited reopen (the ONLY path COMPLETED -> ACTIVE; see state machine notes)
      await tx.loanApplication.update({ where: { id: loan.applicationId }, data: { status: "ACTIVE" } });
      messages.push(await stageEvent(tx, "loan.reopened", loan.publicId, { loanId: loan.publicId, reason: `reversal:${payment.publicId}` }));
    }
    await postRepaymentReversal(tx, `ledger-rev-${payment.publicId}`, { feesKobo: totF, interestKobo: totI, principalKobo: totP });
    messages.push(await stageEvent(tx, "payment.reversed", payment.publicId, { paymentId: payment.publicId, reason, restored: applied }));
    return { result: { paymentId: payment.publicId, status: "REVERSED" as const, restored: applied }, messages, reopened: wasCompleted };
  });
  await audit({ actor: admin.userPublicId, actorRole: admin.role, action: AUDIT_ACTIONS.PAYMENT_REVERSED, resource: "payment", resourceId: payment.publicId, requestId: ctx.requestId });
  if (reopened) {
    await audit({ actor: admin.userPublicId, actorRole: admin.role, action: "LOAN_REOPENED", resource: "loan", resourceId: payment.loan.publicId, requestId: ctx.requestId, metadata: { reason, restored: result.restored } });
  }
  for (const m of messages) await queue.publish(m);
  return result;
}

export async function getPayment(requester: { userId: number; role: string }, publicId: string) {
  const p = await prisma.payment.findUnique({ where: { publicId }, include: { loan: { include: { customer: true } }, allocations: true } });
  if (!p) throw new NotFoundError("Payment not found");
  if (requester.role === "CUSTOMER" && p.loan.customer.userId !== requester.userId) throw new ForbiddenError("Cannot access another customer's payment");
  return {
    id: p.publicId, loanId: p.loan.publicId, amountKobo: p.amountKobo, status: p.status,
    providerRef: p.providerRef, appliedKobo: p.appliedKobo, leftoverKobo: p.leftoverKobo,
    allocations: p.allocations.map((a) => ({ scheduleId: a.scheduleId, feesKobo: a.feesKobo, interestKobo: a.interestKobo, principalKobo: a.principalKobo })),
    createdAt: p.createdAt,
  };
}

export async function confirmPaymentViaProvider(requester: { userId: number; role: string }, paymentPublicId: string, ctx: { requestId?: string }) {
  const p = await prisma.payment.findUnique({ where: { publicId: paymentPublicId }, include: { loan: { include: { customer: true } } } });
  if (!p) throw new NotFoundError("Payment not found");
  if (requester.role === "CUSTOMER" && p.loan.customer.userId !== requester.userId) throw new ForbiddenError("Not your payment");
  if (p.status === "SUCCESS") return { paymentId: p.publicId, status: "SUCCESS" as const, duplicate: true };
  const res = await paymentProvider.verifyPayment(p.publicId);
  if (res.status === "SUCCESS") return processSuccessfulPayment(paymentPublicId, ctx);
  if (res.status === "FAILED") {
    await prisma.payment.update({ where: { id: p.id }, data: { status: "FAILED", failureReason: res.failureReason } });
    return { paymentId: p.publicId, status: "FAILED" as const };
  }
  return { paymentId: p.publicId, status: "PENDING" as const };
}
