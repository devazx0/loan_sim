import { prisma } from "../../infrastructure/database/prisma";
import { NotFoundError, ForbiddenError, ValidationError } from "../../common/errors";
import { assertTransition, assertLoanTransition, type AppStatus, type LoanStatus } from "../loan-applications/state-machine";
import { FakeBankProvider } from "../../infrastructure/providers/fakes";
import { postDisbursement } from "../ledger/service";
import { splitInstallments, calculateFlatInterest } from "../../common/money";
import { stableHash } from "../../common/crypto";
import { claimKey, completeKey, failKey } from "../../common/idempotency";
import { audit, AUDIT_ACTIONS } from "../../common/audit";
import { queue } from "../../infrastructure/queue/queue";
import { stageEvent } from "../../common/events";

export const bankProvider = new FakeBankProvider();

function ensureIdempotencyHeader(key: string | undefined): string {
  if (!key) throw new ValidationError("Idempotency-Key header required");
  return key;
}

/** Request disbursement: create PENDING loan row, commit, call provider, finalize on webhook/verify. */
export async function requestDisbursement(userId: number, applicationPublicId: string, idempotencyKey: string | undefined, ctx: { requestId?: string }) {
  const key = ensureIdempotencyHeader(idempotencyKey);
  const app = await prisma.loanApplication.findUnique({ where: { publicId: applicationPublicId }, include: { customer: true, product: true, offer: true } });
  if (!app) throw new NotFoundError("Application not found");
  const requesterIsOwner = app.customer.userId === userId;
  const requester = await prisma.user.findUnique({ where: { id: userId } });
  const isStaff = requester && requester.role !== "CUSTOMER";
  if (!requesterIsOwner && !isStaff) throw new ForbiddenError("Not your application");
  if (app.status !== "OFFER_ACCEPTED") throw new ValidationError(`Cannot disburse from ${app.status}: offer must be accepted`);
  if (!app.offer || app.offer.status !== "ACCEPTED") throw new ValidationError("Offer not accepted");

  // Idempotency (concurrency-safe): same key+same hash -> replay; different hash -> 422
  const reqHash = stableHash({ app: applicationPublicId, amt: app.offer.approvedAmountKobo });
  const claim = await claimKey({ key, userId, endpoint: "disbursement.request", requestHash: reqHash });
  if (claim.replay) return claim.replay as { loanId: string; status: string };

  try {
    const existingLoan = await prisma.loan.findUnique({ where: { applicationId: app.id } });
    if (existingLoan) {
      // duplicate disbursement guard (invariant: one loan per accepted offer)
      const dto = { loanId: existingLoan.publicId, status: existingLoan.status };
      await completeKey(key, dto);
      return dto;
    }

    // Step 1: create pending loan + explicit transition (no provider call inside tx)
    const reference = `disb_${app.publicId.slice(0, 8)}_${Date.now()}`;
    const { loan, requestedMsg } = await prisma.$transaction(async (tx) => {
      const l = await tx.loan.create({
        data: {
          applicationId: app.id, customerId: app.customerId, principalKobo: app.offer!.approvedAmountKobo,
          outstandingKobo: app.offer!.totalRepaymentKobo, interestRateBps: app.offer!.interestRateBps,
          tenorMonths: app.offer!.tenorMonths, status: "PENDING", disbursementRef: reference,
        },
      });
      assertTransition(app.status as AppStatus, "DISBURSEMENT_PENDING");
      await tx.loanApplication.update({ where: { id: app.id }, data: { status: "DISBURSEMENT_PENDING", version: { increment: 1 } } });
      const staged = await stageEvent(tx, "loan.disbursement.requested", l.publicId, { loanId: l.publicId, reference });
      return { loan: l, requestedMsg: staged };
    });
    await queue.publish(requestedMsg);

    // Step 2: call fake bank OUTSIDE tx
    const result = await bankProvider.transfer({ reference, amountKobo: app.offer.approvedAmountKobo, accountRef: app.customer.bankAccountRef ?? "acct_default", narration: `Loan disbursement ${loan.publicId}` });

    // Step 3: finalize based on provider result
    if (result.status === "SUCCESS") {
      await confirmDisbursement(reference, result.providerRef, ctx);
    } else if (result.status === "FAILED") {
      // No money moved (provider-declared failure): record the outcome, fail the key
      // so the SAME key+body may safely retry later (it will hit existingLoan or re-run).
      const { failedMsg } = await prisma.$transaction(async (tx) => {
        await tx.loan.update({ where: { id: loan.id }, data: { status: "PENDING" } });
        const staged = await stageEvent(tx, "loan.disbursement.failed", loan.publicId, { loanId: loan.publicId, reason: result.failureReason });
        return { failedMsg: staged };
      });
      await queue.publish(failedMsg);
      await failKey(key, `provider: ${result.failureReason ?? "failed"}`);
      throw new ValidationError(`Disbursement failed: ${result.failureReason}`);
    }
    // PENDING: leave pending; webhook/verify will confirm (demo calls verify endpoint)

    const dto = { loanId: loan.publicId, status: result.status === "SUCCESS" ? "ACTIVE" : "PENDING", reference };
    await completeKey(key, dto);
    return dto;
  } catch (e) {
    // Failure recovery: only mark FAILED when no financial commit happened. All throws
    // above occur before confirmDisbursement commits; confirmDisbursement failures leave
    // the loan PENDING and verifiable via reference (safe to retry).
    await failKey(key, e instanceof Error ? e.message : String(e));
    throw e;
  }
}

/** Confirm disbursement (called by bank webhook or verify poll): tx finalize, schedule, ledger. */
export async function confirmDisbursement(reference: string, providerRef: string, ctx: { requestId?: string }) {
  const loan = await prisma.loan.findFirst({ where: { disbursementRef: reference }, include: { application: { include: { offer: true, product: true } } } });
  if (!loan) throw new NotFoundError("Loan for disbursement reference not found");
  if (loan.status === "ACTIVE") return { loanId: loan.publicId, status: "ACTIVE" as const }; // idempotent replay
  if (loan.status !== "PENDING") throw new ValidationError(`Cannot confirm from ${loan.status}`);

  const offer = loan.application.offer!;
  // Split total into principal/interest/fee portions per installment (sums provably equal totals).
  const principalParts = splitInstallments(offer.approvedAmountKobo, offer.tenorMonths);
  const interestTotal = calculateFlatInterest(offer.approvedAmountKobo, offer.interestRateBps);
  const interestParts = splitInstallments(interestTotal, offer.tenorMonths);
  const feeParts = splitInstallments(offer.feesKobo, offer.tenorMonths);

  const { messages } = await prisma.$transaction(async (tx) => {
    const messages: Awaited<ReturnType<typeof stageEvent>>[] = [];
    assertLoanTransition(loan.status as LoanStatus, "ACTIVE");
    await tx.loan.update({ where: { id: loan.id }, data: { status: "ACTIVE", disbursedAt: new Date(), version: { increment: 1 } } });
    // Explicit application chain: DISBURSEMENT_PENDING -> DISBURSED -> ACTIVE (each hop asserted)
    assertTransition(loan.application.status as AppStatus, "DISBURSED");
    await tx.loanApplication.update({ where: { id: loan.applicationId }, data: { status: "DISBURSED", version: { increment: 1 } } });
    messages.push(await stageEvent(tx, "loan.disbursement.confirmed", loan.publicId, { loanId: loan.publicId, providerRef }));
    // Schedules
    for (let i = 0; i < offer.tenorMonths; i++) {
      const due = new Date(offer.firstPaymentDate);
      due.setMonth(due.getMonth() + i);
      const p = principalParts[i]!, ins = interestParts[i]!, f = feeParts[i]!;
      await tx.repaymentSchedule.create({
        data: {
          loanId: loan.id, installmentNo: i + 1, dueDate: due,
          principalKobo: p, interestKobo: ins, feesKobo: f,
          totalDueKobo: p + ins + f, status: "PENDING",
        },
      });
    }
    await postDisbursement(tx, `ledger-disb-${loan.publicId}`, offer.approvedAmountKobo);
    assertTransition("DISBURSED", "ACTIVE");
    await tx.loanApplication.update({ where: { id: loan.applicationId }, data: { status: "ACTIVE", version: { increment: 1 } } });
    messages.push(await stageEvent(tx, "loan.disbursed", loan.publicId, { loanId: loan.publicId, providerRef }));
    return { messages };
  });
  await audit({ actor: "SYSTEM", action: AUDIT_ACTIONS.LOAN_DISBURSED, resource: "loan", resourceId: loan.publicId, requestId: ctx.requestId });
  for (const m of messages) await queue.publish(m);
  return { loanId: loan.publicId, status: "ACTIVE" as const };
}

export async function getLoan(requester: { userId: number; role: string }, publicId: string) {
  const loan = await prisma.loan.findUnique({
    where: { publicId },
    include: { schedules: { orderBy: { installmentNo: "asc" } }, application: { select: { publicId: true, customerId: true } } },
  });
  if (!loan) throw new NotFoundError("Loan not found");
  const customer = await prisma.customerProfile.findUnique({ where: { id: loan.customerId } });
  const isOwner = customer?.userId === requester.userId;
  if (!isOwner && requester.role === "CUSTOMER") throw new ForbiddenError("Cannot access another customer's loan");
  return {
    id: loan.publicId, principalKobo: loan.principalKobo, outstandingKobo: loan.outstandingKobo,
    status: loan.status, disbursedAt: loan.disbursedAt, tenorMonths: loan.tenorMonths,
    schedules: loan.schedules.map((s) => ({ n: s.installmentNo, dueDate: s.dueDate, principalKobo: s.principalKobo, interestKobo: s.interestKobo, feesKobo: s.feesKobo, totalDueKobo: s.totalDueKobo, amountPaidKobo: s.amountPaidKobo, status: s.status })),
  };
}
export { assertTransition };
