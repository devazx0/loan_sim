import type { Prisma } from "@prisma/client";
import { prisma } from "../../infrastructure/database/prisma";
import { NotFoundError, ForbiddenError, ValidationError, ConflictError } from "../../common/errors";
import { assertTransition, type AppStatus } from "./state-machine";
import type { CreateApplicationInput } from "./dto";
import { screenAml, assessFraud, assessCredit, checkAffordability } from "../risk/engines";
import { calculateFlatInterest, splitInstallments, calculateReducingInstallment, assertValidKobo } from "../../common/money";
import { audit, AUDIT_ACTIONS } from "../../common/audit";
import { queue } from "../../infrastructure/queue/queue";
import { stageEvent, publishEvent } from "../../common/events";
import { riskRules } from "../../config/index";

type TxClient = Prisma.TransactionClient;

function toDto(a: { publicId: string; amountKobo: number; tenorMonths: number; status: string; decision: string | null; decisionReason: string | null }) {
  return { id: a.publicId, amountKobo: a.amountKobo, tenorMonths: a.tenorMonths, status: a.status, decision: a.decision, decisionReason: a.decisionReason };
}

/**
 * Explicit single-step transition: asserts the edge exists, then persists it.
 * Automated flows must call this once PER edge — skipping intermediate states
 * without asserting each hop is forbidden (use chains below, never direct jumps).
 */
async function transition(tx: TxClient, id: number, from: AppStatus, to: AppStatus) {
  assertTransition(from, to);
  return tx.loanApplication.update({ where: { id }, data: { status: to, version: { increment: 1 } } });
}

/** Create draft application. */
export async function createApplication(userId: number, input: CreateApplicationInput, ctx: { requestId?: string }) {
  const customer = await prisma.customerProfile.findUnique({ where: { userId } });
  if (!customer) throw new NotFoundError("Customer profile not found");
  const product = await prisma.loanProduct.findUnique({ where: { publicId: input.productId } });
  if (!product || product.status !== "ACTIVE") throw new NotFoundError("Loan product not found");
  if (input.amountKobo < product.minAmountKobo || input.amountKobo > product.maxAmountKobo)
    throw new ValidationError(`Amount must be between ${product.minAmountKobo} and ${product.maxAmountKobo} kobo`);
  if (input.tenorMonths < product.minTenorMonths || input.tenorMonths > product.maxTenorMonths)
    throw new ValidationError("Tenor out of product bounds");
  // rate-limit applications: max N per day
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
  const recent = await prisma.loanApplication.count({ where: { customerId: customer.id, createdAt: { gte: dayAgo } } });
  if (recent >= riskRules.maxApplicationsPerDay) throw new ValidationError("Too many applications in 24h");
  // profile completeness
  if (customer.monthlyIncomeKobo <= 0) throw new ValidationError("Complete profile with income before applying");

  const { app, msg } = await prisma.$transaction(async (tx) => {
    const a = await tx.loanApplication.create({
      data: { customerId: customer.id, productId: product.id, amountKobo: input.amountKobo, tenorMonths: input.tenorMonths, purpose: input.purpose ?? null, status: "DRAFT" },
    });
    const staged = await stageEvent(tx, "loan.application.created", a.publicId, { applicationId: a.publicId });
    return { app: a, msg: staged };
  });
  await audit({ actor: customer.publicId, action: AUDIT_ACTIONS.LOAN_APPLIED, resource: "loan-application", resourceId: app.publicId, requestId: ctx.requestId, userId });
  await queue.publish(msg);
  return toDto(app);
}

/** Submit draft -> runs full decision pipeline transactionally. */
export async function submitApplication(userId: number, applicationPublicId: string, _ctx?: { requestId?: string }) {
  const app = await prisma.loanApplication.findUnique({
    where: { publicId: applicationPublicId },
    include: { customer: true, product: true },
  });
  if (!app) throw new NotFoundError("Application not found");
  if (app.customer.userId !== userId) throw new ForbiddenError("Not your application");
  assertTransition(app.status as AppStatus, "SUBMITTED");

  // Gather risk inputs (single batched reads — no N+1)
  const customerUser = await prisma.user.findUnique({ where: { id: app.customer.userId } });
  const [kyc, priorApps, activeLoans, completedLoans, defaultedLoans, samePhone, sameDevice, failedKyc] = await Promise.all([
    prisma.kycRecord.findFirst({ where: { customerId: app.customerId }, orderBy: { id: "desc" } }),
    prisma.loanApplication.count({ where: { customerId: app.customerId, createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } } }),
    prisma.loan.count({ where: { customerId: app.customerId, status: { in: ["ACTIVE", "OVERDUE"] } } }),
    prisma.loan.count({ where: { customerId: app.customerId, status: "COMPLETED" } }),
    prisma.loan.count({ where: { customerId: app.customerId, status: { in: ["DEFAULTED", "WRITTEN_OFF"] } } }),
    prisma.user.count({ where: { phone: customerUser?.phone ?? "__none__" } }),
    app.customer.deviceId ? prisma.customerProfile.count({ where: { deviceId: app.customer.deviceId } }) : Promise.resolve(1),
    prisma.kycRecord.count({ where: { customerId: app.customerId, status: "FAILED" } }),
  ]);

  const kycStatus = kyc?.status ?? "PENDING";
  const aml = screenAml({
    amountKobo: app.amountKobo, monthlyIncomeKobo: app.customer.monthlyIncomeKobo, kycStatus,
    recentApplicationCount: priorApps, bankAccountChanged: false, productMaxKobo: app.product.maxAmountKobo,
  });
  const fraud = assessFraud({
    samePhoneCount: samePhone, sameDeviceCount: sameDevice, failedKycAttempts: failedKyc,
    applicationsLast24h: priorApps, bankChangesLast30d: 0, failedLoginsLast24h: 0, suspiciousPayments: 0,
  });
  const credit = assessCredit({
    monthlyIncomeKobo: app.customer.monthlyIncomeKobo, obligationsKobo: app.customer.obligationsKobo,
    requestedKobo: app.amountKobo, requestedTenor: app.tenorMonths,
    activeLoans, previousDefaults: defaultedLoans, completedLoans,
    kycStatus, fraudLevel: fraud.riskLevel, amlStatus: aml.status, productMaxKobo: app.product.maxAmountKobo,
  });

  // Affordability: estimate installment
  const interest = calculateFlatInterest(app.amountKobo, app.product.interestRateBps);
  const total = app.amountKobo + interest + app.product.processingFeeKobo;
  const parts = splitInstallments(total, app.tenorMonths);
  const afford = checkAffordability({ monthlyIncomeKobo: app.customer.monthlyIncomeKobo, obligationsKobo: app.customer.obligationsKobo, installmentKobo: parts[0] ?? total });

  // Decision: mandatory failures block auto-approve
  let decision: "AUTO_APPROVE" | "AUTO_REJECT" | "MANUAL_REVIEW" = credit.decision;
  const reasons = [...credit.reasons];
  if (!afford.affordable && decision === "AUTO_APPROVE") { decision = "MANUAL_REVIEW"; reasons.push("unaffordable:" + afford.reason); }
  if (kycStatus !== "VERIFIED") {
    if (decision === "AUTO_APPROVE") { decision = "MANUAL_REVIEW"; reasons.push("kyc_not_verified"); }
  }
  if (aml.status !== "CLEAR" && decision === "AUTO_APPROVE") { decision = "MANUAL_REVIEW"; reasons.push(`aml:${aml.status}`); }

  const { updated, messages } = await prisma.$transaction(async (tx) => {
    const messages: Awaited<ReturnType<typeof stageEvent>>[] = [];
    // Explicit chain: DRAFT -> SUBMITTED -> UNDER_REVIEW (-> APPROVED -> OFFER_CREATED | -> REJECTED)
    let a = await transition(tx, app.id, app.status as AppStatus, "SUBMITTED");
    messages.push(await stageEvent(tx, "loan.application.submitted", a.publicId, { applicationId: a.publicId }));
    a = await transition(tx, app.id, "SUBMITTED", "UNDER_REVIEW");
    messages.push(await stageEvent(tx, "loan.application.under_review", a.publicId, { applicationId: a.publicId, decision }));
    a = await tx.loanApplication.update({
      where: { id: app.id },
      data: {
        decision,
        decisionReason: reasons.join(";"),
        decidedAt: decision === "MANUAL_REVIEW" ? null : new Date(),
        decidedBy: decision === "MANUAL_REVIEW" ? null : "SYSTEM",
      },
    });
    await tx.amlScreening.create({ data: { customerId: app.customerId, applicationId: app.id, status: aml.status, signals: JSON.stringify(aml.signals) } });
    await tx.fraudAssessment.create({ data: { customerId: app.customerId, applicationId: app.id, score: fraud.score, riskLevel: fraud.riskLevel, reasons: JSON.stringify(fraud.reasons) } });
    await tx.creditAssessment.create({
      data: {
        customerId: app.customerId, applicationId: app.id, score: credit.score, riskLevel: credit.riskLevel,
        recommendedAmountKobo: credit.recommendedAmountKobo, recommendedTenor: credit.recommendedTenor,
        decision, reasons: JSON.stringify(reasons), affordable: afford.affordable,
      },
    });
    if (decision === "AUTO_APPROVE") {
      a = await transition(tx, app.id, "UNDER_REVIEW", "APPROVED");
      messages.push(await stageEvent(tx, "loan.approved", a.publicId, { applicationId: a.publicId, decision, by: "SYSTEM" }));
      await createOfferRow(tx, { id: app.id, amountKobo: app.amountKobo, tenorMonths: app.tenorMonths }, app.product);
      a = await transition(tx, app.id, "APPROVED", "OFFER_CREATED");
      messages.push(await stageEvent(tx, "loan.offer.created", a.publicId, { applicationId: a.publicId }));
    } else if (decision === "AUTO_REJECT") {
      a = await transition(tx, app.id, "UNDER_REVIEW", "REJECTED");
      messages.push(await stageEvent(tx, "loan.rejected", a.publicId, { applicationId: a.publicId, decision }));
    }
    // MANUAL_REVIEW stays UNDER_REVIEW; staged under_review event covers the audit trail.
    return { updated: a, messages };
  });

  for (const m of messages) await queue.publish(m);
  await publishEvent("credit.assessment.requested", updated.publicId, { decision });
  return { ...toDto({ ...updated, decision, decisionReason: reasons.join(";") }), aml, fraud, credit: { ...credit, decision, reasons }, affordability: afford };
}

async function createOfferRow(tx: TxClient, app: { id: number; amountKobo: number; tenorMonths: number }, product: { interestRateBps: number; processingFeeKobo: number; interestMethod?: string }) {
  assertValidKobo(app.amountKobo, "amount");
  const interest = calculateFlatInterest(app.amountKobo, product.interestRateBps);
  const fees = product.processingFeeKobo;
  const total = app.amountKobo + interest + fees;
  let installment: number;
  if (product.interestMethod === "REDUCING") {
    installment = calculateReducingInstallment(app.amountKobo, product.interestRateBps, app.tenorMonths);
  } else {
    installment = splitInstallments(total, app.tenorMonths)[0]!;
  }
  const firstPaymentDate = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  const expiryDate = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  await tx.loanOffer.create({
    data: {
      applicationId: app.id, approvedAmountKobo: app.amountKobo, interestRateBps: product.interestRateBps,
      tenorMonths: app.tenorMonths, feesKobo: fees, totalRepaymentKobo: total, installmentKobo: installment,
      firstPaymentDate, expiryDate, status: "PENDING",
    },
  });
}

/** Admin manual review: approve or reject UNDER_REVIEW application. */
export async function reviewApplication(admin: { userPublicId: string; role: string }, applicationPublicId: string, decision: "APPROVE" | "REJECT", reason: string, ctx: { requestId?: string }) {
  const app = await prisma.loanApplication.findUnique({ where: { publicId: applicationPublicId }, include: { product: true, customer: true } });
  if (!app) throw new NotFoundError("Application not found");
  if (app.status !== "UNDER_REVIEW" && app.status !== "SUBMITTED") throw new ValidationError(`Cannot review application in ${app.status}`);
  if (decision === "APPROVE") {
    // Mandatory checks: KYC verified, no HIGH fraud unresolved, credit not auto-reject
    const [kyc, fraud, credit] = await Promise.all([
      prisma.kycRecord.findFirst({ where: { customerId: app.customerId }, orderBy: { id: "desc" } }),
      prisma.fraudAssessment.findFirst({ where: { applicationId: app.id }, orderBy: { id: "desc" } }),
      prisma.creditAssessment.findFirst({ where: { applicationId: app.id }, orderBy: { id: "desc" } }),
    ]);
    if (!kyc || kyc.status !== "VERIFIED") throw new ValidationError("Cannot approve: KYC not verified");
    if (fraud?.riskLevel === "HIGH") throw new ValidationError("Cannot approve: HIGH fraud risk requires resolution");
    if (credit?.decision === "AUTO_REJECT" && !reason.toLowerCase().includes("override"))
      throw new ValidationError("Credit auto-reject requires explicit override reason");
    const { updated, messages } = await prisma.$transaction(async (tx) => {
      const messages: Awaited<ReturnType<typeof stageEvent>>[] = [];
      // Explicit chain, each hop asserted: SUBMITTED -> UNDER_REVIEW -> APPROVED -> OFFER_CREATED
      if (app.status === "SUBMITTED") {
        await transition(tx, app.id, "SUBMITTED", "UNDER_REVIEW");
      }
      let a = await transition(tx, app.id, "UNDER_REVIEW", "APPROVED");
      messages.push(await stageEvent(tx, "loan.approved", a.publicId, { applicationId: a.publicId, by: admin.userPublicId }));
      await tx.loanApplication.update({ where: { id: app.id }, data: { decision: "AUTO_APPROVE", decisionReason: `manual_approve:${reason}`, decidedBy: admin.userPublicId, decidedAt: new Date() } });
      await createOfferRow(tx, { id: app.id, amountKobo: app.amountKobo, tenorMonths: app.tenorMonths }, app.product);
      a = await transition(tx, app.id, "APPROVED", "OFFER_CREATED");
      messages.push(await stageEvent(tx, "loan.offer.created", a.publicId, { applicationId: a.publicId }));
      return { updated: a, messages };
    });
    await audit({ actor: admin.userPublicId, actorRole: admin.role, action: AUDIT_ACTIONS.LOAN_APPROVED, resource: "loan-application", resourceId: updated.publicId, requestId: ctx.requestId });
    for (const m of messages) await queue.publish(m);
    return toDto({ ...updated, decision: "AUTO_APPROVE", decisionReason: `manual_approve:${reason}` });
  } else {
    assertTransition(app.status as AppStatus, "REJECTED");
    const { updated, msg } = await prisma.$transaction(async (tx) => {
      const a = await tx.loanApplication.update({ where: { id: app.id }, data: { status: "REJECTED", decision: "AUTO_REJECT", decisionReason: reason, decidedBy: admin.userPublicId, decidedAt: new Date(), version: { increment: 1 } } });
      const staged = await stageEvent(tx, "loan.rejected", a.publicId, { applicationId: a.publicId, reason });
      return { updated: a, msg: staged };
    });
    await audit({ actor: admin.userPublicId, actorRole: admin.role, action: AUDIT_ACTIONS.LOAN_REJECTED, resource: "loan-application", resourceId: updated.publicId, requestId: ctx.requestId });
    await queue.publish(msg);
    return toDto(updated);
  }
}

export async function getApplication(requester: { userId: number; role: string }, publicId: string) {
  const app = await prisma.loanApplication.findUnique({
    where: { publicId },
    include: { product: { select: { publicId: true, code: true, name: true } }, offer: true, agreement: true, loan: { select: { publicId: true, status: true } } },
  });
  if (!app) throw new NotFoundError("Application not found");
  const customer = await prisma.customerProfile.findUnique({ where: { id: app.customerId } });
  const isOwner = customer?.userId === requester.userId;
  if (!isOwner && requester.role === "CUSTOMER") throw new ForbiddenError("Cannot access another customer's application");
  return {
    id: app.publicId, amountKobo: app.amountKobo, tenorMonths: app.tenorMonths, status: app.status,
    decision: app.decision, decisionReason: app.decisionReason, product: app.product,
    offer: app.offer ? { id: app.offer.publicId, approvedAmountKobo: app.offer.approvedAmountKobo, installmentKobo: app.offer.installmentKobo, totalRepaymentKobo: app.offer.totalRepaymentKobo, status: app.offer.status, expiryDate: app.offer.expiryDate } : null,
    agreement: app.agreement ? { id: app.agreement.publicId, version: app.agreement.version, acceptedAt: app.agreement.acceptedAt } : null,
    loan: app.loan,
  };
}

export async function listApplications(requester: { userId: number; role: string }, opts: { limit: number; cursorId?: number }) {
  let where: { customerId?: number } = {};
  if (requester.role === "CUSTOMER") {
    const c = await prisma.customerProfile.findUnique({ where: { userId: requester.userId } });
    if (!c) throw new NotFoundError("Customer profile not found");
    where = { customerId: c.id };
  }
  const items = await prisma.loanApplication.findMany({
    where,
    orderBy: { id: "asc" },
    take: opts.limit + 1,
    ...(opts.cursorId ? { cursor: { id: opts.cursorId }, skip: 1 } : {}),
    select: { id: true, publicId: true, amountKobo: true, tenorMonths: true, status: true, createdAt: true },
  });
  const hasMore = items.length > opts.limit;
  const page = hasMore ? items.slice(0, opts.limit) : items;
  return { items: page.map((a) => ({ id: a.publicId, amountKobo: a.amountKobo, tenorMonths: a.tenorMonths, status: a.status, createdAt: a.createdAt })), nextCursor: hasMore ? String(page[page.length - 1]!.id) : null };
}

/** Customer accepts offer + agreement (explicit, versioned). */
export async function acceptOffer(userId: number, applicationPublicId: string, ctx: { requestId?: string }) {
  const app = await prisma.loanApplication.findUnique({ where: { publicId: applicationPublicId }, include: { offer: true, customer: true } });
  if (!app) throw new NotFoundError("Application not found");
  if (app.customer.userId !== userId) throw new ForbiddenError("Not your application");
  if (!app.offer) throw new ValidationError("No offer to accept");
  if (app.offer.status !== "PENDING") throw new ConflictError("Offer already processed");
  if (app.offer.expiryDate < new Date()) throw new ValidationError("Offer expired");
  assertTransition(app.status as AppStatus, "OFFER_ACCEPTED");
  const { updated, msg } = await prisma.$transaction(async (tx) => {
    const existing = await tx.loan.findUnique({ where: { applicationId: app.id } });
    if (existing) throw new ConflictError("Loan already created for this offer"); // invariant 6
    await tx.loanOffer.update({ where: { id: app.offer!.id }, data: { status: "ACCEPTED", acceptedAt: new Date() } });
    const a = await tx.loanApplication.update({ where: { id: app.id }, data: { status: "OFFER_ACCEPTED", version: { increment: 1 } } });
    await tx.loanAgreement.upsert({
      where: { applicationId: app.id },
      create: { applicationId: app.id, version: "v1", acceptedAt: new Date(), acceptedBy: app.customer.publicId },
      update: { version: "v1", acceptedAt: new Date(), acceptedBy: app.customer.publicId },
    });
    const staged = await stageEvent(tx, "loan.offer.accepted", a.publicId, { applicationId: a.publicId });
    return { updated: a, msg: staged };
  });
  await audit({ actor: app.customer.publicId, action: AUDIT_ACTIONS.OFFER_ACCEPTED, resource: "loan-application", resourceId: updated.publicId, requestId: ctx.requestId, userId });
  await queue.publish(msg);
  return toDto(updated);
}
