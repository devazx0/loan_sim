import { prisma } from "../../infrastructure/database/prisma";
import { assertLoanTransitionIfChanged, type LoanStatus } from "../loan-applications/state-machine";
import { queue } from "../../infrastructure/queue/queue";
import { stageEvent, publishEvent, type QueueMessage } from "../../common/events";
import { postLateFee } from "../ledger/service";
import { logger } from "../../common/logger";
import { riskRules } from "../../config/index";

/**
 * Overdue job: find unpaid schedules due before now -> mark OVERDUE, accrue late fee
 * once, update loan status, create collection case, queue notification.
 * Idempotent per schedule (re-check inside tx; late-fee guarded by explicit flag).
 */
export async function runOverdueJob(now = new Date()): Promise<{ marked: number; cases: number }> {
  const grace = new Date(now.getTime() - riskRules.lateFeeGraceDays * 24 * 3600 * 1000);
  const due = await prisma.repaymentSchedule.findMany({
    where: { dueDate: { lt: grace }, status: { in: ["PENDING", "PARTIALLY_PAID"] } },
    include: { loan: true },
    take: 500,
  });
  let marked = 0;
  for (const s of due) {
    // Re-check inside tx for concurrency safety; idempotent: already-OVERDUE rows are skipped.
    const messages: QueueMessage<unknown>[] = [];
    await prisma.$transaction(async (tx) => {
      const fresh = await tx.repaymentSchedule.findUnique({ where: { id: s.id } });
      if (!fresh || !["PENDING", "PARTIALLY_PAID"].includes(fresh.status)) return;
      const loanWithProduct = await tx.loan.findUnique({ where: { id: s.loanId }, include: { application: { include: { product: true } } } });
      const lateFee = loanWithProduct?.application.product.lateFeeKobo ?? 0;
      await tx.repaymentSchedule.update({ where: { id: s.id }, data: { status: "OVERDUE" } });
      // Explicit late-fee tracking: the lateFeeApplied flag (NOT feesKobo, which may
      // carry non-late fees) decides exactly-once accrual. The fee's financial effect
      // is a real ledger posting (Dr Receivable / Cr Fee Income), increasing outstanding.
      if (lateFee > 0 && !fresh.lateFeeApplied) {
        await tx.repaymentSchedule.update({
          where: { id: s.id },
          data: { feesKobo: { increment: lateFee }, totalDueKobo: fresh.totalDueKobo + lateFee, lateFeeApplied: true, lateFeeKobo: lateFee },
        });
        await tx.loan.update({ where: { id: s.loanId }, data: { outstandingKobo: { increment: lateFee } } });
        await postLateFee(tx, `ledger-latefee-${s.loanId}-${fresh.installmentNo}`, lateFee);
        messages.push(await stageEvent(tx, "repayment.late_fee_applied", s.loan.publicId, { loanId: s.loan.publicId, installmentNo: fresh.installmentNo, feeKobo: lateFee }));
      }
      // Only touch ACTIVE loans: a COMPLETED/DEFAULTED loan must not regress to OVERDUE.
      const loanRow = await tx.loan.findUniqueOrThrow({ where: { id: s.loanId } });
      if (loanRow.status === "ACTIVE") {
        assertLoanTransitionIfChanged(loanRow.status as LoanStatus, "OVERDUE");
        await tx.loan.update({ where: { id: s.loanId }, data: { status: "OVERDUE" } });
        await tx.loanApplication.updateMany({ where: { id: s.loan.applicationId, status: "ACTIVE" }, data: { status: "OVERDUE" } });
      }
      const daysOverdue = Math.floor((now.getTime() - fresh.dueDate.getTime()) / (24 * 3600 * 1000));
      const existing = await tx.collectionCase.findFirst({ where: { loanId: s.loanId, status: { in: ["OPEN", "IN_PROGRESS", "ESCALATED"] } } });
      if (!existing) {
        const kase = await tx.collectionCase.create({
          data: { loanId: s.loanId, customerId: loanRow.customerId, daysOverdue, outstandingKobo: loanRow.outstandingKobo, riskLevel: daysOverdue > 30 ? "HIGH" : daysOverdue > 7 ? "MEDIUM" : "LOW", status: "OPEN" },
        });
        await tx.collectionAction.create({ data: { caseId: kase.id, action: "REMINDER_SENT", note: "Auto reminder on overdue", actor: "SYSTEM" } });
        await tx.notification.create({ data: { customerId: loanRow.customerId, channel: "SMS", template: "overdue_reminder", payload: JSON.stringify({ loanId: loanRow.publicId, daysOverdue }), status: "QUEUED" } });
        messages.push(await stageEvent(tx, "notification.requested", kase.publicId, { template: "overdue_reminder", customerId: loanRow.customerId }));
        messages.push(await stageEvent(tx, "collection.case.created", kase.publicId, { caseId: kase.publicId, loanId: loanRow.publicId }));
      } else {
        await tx.collectionCase.update({ where: { id: existing.id }, data: { daysOverdue, outstandingKobo: loanRow.outstandingKobo } });
      }
      messages.push(await stageEvent(tx, "repayment.overdue", loanRow.publicId, { loanId: loanRow.publicId, installmentNo: fresh.installmentNo }));
    }).catch((e) => logger.error({ err: String(e), scheduleId: s.id }, "overdue item failed"));
    for (const m of messages) await queue.publish(m).catch((e) => logger.error({ err: String(e) }, "overdue event publish failed"));
    marked++;
  }
  // count new cases created this run (approx)
  const cases = await prisma.collectionCase.count({ where: { createdAt: { gte: new Date(now.getTime() - 60_000) } } }).catch(() => 0);
  await publishEvent("overdue.job.completed", "system", { marked });
  return { marked, cases };
}
