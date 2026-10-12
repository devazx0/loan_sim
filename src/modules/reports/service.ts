import { prisma } from "../../infrastructure/database/prisma";

export async function summaryReport() {
  const [
    totalCustomers, totalApplications, approved, rejected,
    disbursedAgg, loans, overdueAgg, defaultCount,
    paySuccess, payTotal, completedLoans, repaidAgg,
  ] = await Promise.all([
    prisma.customerProfile.count(),
    prisma.loanApplication.count(),
    prisma.loanApplication.count({ where: { status: { in: ["APPROVED", "OFFER_CREATED", "OFFER_ACCEPTED", "DISBURSEMENT_PENDING", "DISBURSED", "ACTIVE", "OVERDUE", "COMPLETED"] } } }),
    prisma.loanApplication.count({ where: { status: "REJECTED" } }),
    prisma.loan.aggregate({ _sum: { principalKobo: true }, where: { status: { in: ["ACTIVE", "OVERDUE", "DEFAULTED", "COMPLETED", "WRITTEN_OFF"] } } }),
    prisma.loan.findMany({ select: { outstandingKobo: true, status: true } }),
    prisma.repaymentSchedule.aggregate({ _sum: { totalDueKobo: true, amountPaidKobo: true }, where: { status: "OVERDUE" } }),
    prisma.loan.count({ where: { status: { in: ["DEFAULTED", "WRITTEN_OFF"] } } }),
    prisma.payment.count({ where: { status: "SUCCESS" } }),
    prisma.payment.count(),
    prisma.loan.count({ where: { status: "COMPLETED" } }),
    // Authoritative repaid total: sum of applied amounts on SUCCESS payments only.
    // REVERSED payments excluded (their effect was undone); PENDING/FAILED never applied.
    // Must NOT use principal - outstanding: outstanding carries interest + fees.
    prisma.payment.aggregate({ _sum: { appliedKobo: true }, where: { status: "SUCCESS" } }),
  ]);
  const totalDisbursed = disbursedAgg._sum.principalKobo ?? 0;
  const outstanding = loans.reduce((s, l) => s + (["ACTIVE", "OVERDUE", "DEFAULTED"].includes(l.status) ? l.outstandingKobo : 0), 0);
  const totalRepaid = repaidAgg._sum.appliedKobo ?? 0;
  const overdueAmount = (overdueAgg._sum.totalDueKobo ?? 0) - (overdueAgg._sum.amountPaidKobo ?? 0);
  return {
    totalCustomers, totalApplications,
    approvalRate: totalApplications ? approved / totalApplications : 0,
    rejectionRate: totalApplications ? rejected / totalApplications : 0,
    totalDisbursedKobo: totalDisbursed,
    totalRepaidKobo: totalRepaid,
    outstandingPrincipalKobo: outstanding,
    overdueAmountKobo: overdueAmount,
    defaultCount,
    defaultRate: loans.length ? defaultCount / loans.length : 0,
    paymentSuccessRate: payTotal ? paySuccess / payTotal : 0,
    completedLoans,
  };
}

/** Reconciliation: compare internal payments vs fake provider records. Detect-only, never auto-mutate. */
export async function reconcilePayments(providerRecords: { reference: string; amountKobo: number; status: string }[]) {
  const byRef = new Map(providerRecords.map((r) => [r.reference, r]));
  const internals = await prisma.payment.findMany({ select: { publicId: true, providerRef: true, amountKobo: true, status: true } });
  const findings: { kind: string; paymentId?: string; reference?: string; detail: string }[] = [];
  for (const p of internals) {
    const key = p.publicId;
    const prov = byRef.get(key) ?? (p.providerRef ? byRef.get(p.providerRef) : undefined);
    if (!prov) {
      if (p.status === "SUCCESS") findings.push({ kind: "MISSING_PROVIDER_RECORD", paymentId: p.publicId, detail: "internal SUCCESS without provider record" });
      continue;
    }
    if (prov.amountKobo !== p.amountKobo) findings.push({ kind: "AMOUNT_MISMATCH", paymentId: p.publicId, reference: prov.reference, detail: `internal ${p.amountKobo} vs provider ${prov.amountKobo}` });
    const norm = p.status === "SUCCESS" ? "SUCCESS" : p.status;
    if (prov.status !== norm && !(p.status === "PENDING" && prov.status === "PENDING")) {
      // PENDING internal vs SUCCESS provider => needs review (webhook maybe missing)
      findings.push({ kind: "STATUS_MISMATCH", paymentId: p.publicId, reference: prov.reference, detail: `internal ${p.status} vs provider ${prov.status}` });
    }
  }
  // Unknown provider payments
  const internalRefs = new Set(internals.flatMap((p) => [p.publicId, p.providerRef].filter(Boolean) as string[]));
  for (const r of providerRecords) {
    if (!internalRefs.has(r.reference)) findings.push({ kind: "UNKNOWN_PROVIDER_PAYMENT", reference: r.reference, detail: "provider record without internal payment" });
  }
  // Duplicate provider refs
  const seen = new Set<string>();
  for (const r of providerRecords) {
    if (seen.has(r.reference)) findings.push({ kind: "DUPLICATE_REFERENCE", reference: r.reference, detail: "duplicate provider reference" });
    seen.add(r.reference);
  }
  return { checkedInternal: internals.length, checkedProvider: providerRecords.length, findings };
}

