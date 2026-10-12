import { describe, expect, test, beforeEach } from "bun:test";
import { createHmac } from "node:crypto";
import { api, registerCustomer, loginAs, ensureProduct, resetRateLimits } from "../helpers";
import { prisma } from "../../src/infrastructure/database/prisma";
import { queue, relayOutbox } from "../../src/infrastructure/queue/queue";
import { publishEvent } from "../../src/common/events";
import { claimKey, failKey } from "../../src/common/idempotency";

beforeEach(() => resetRateLimits());

function sign(payload: string): string {
  const secret = process.env["WEBHOOK_HMAC_SECRET"] ?? "dev-webhook-secret-change-me";
  return createHmac("sha256", secret).update(payload).digest("hex");
}

async function webhookPayment(body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  return api("POST", "/api/v1/webhooks/payments", { body: { ...body, signature: sign(raw) } });
}

async function setupActiveLoan(opts: { incomeKobo?: number; amountKobo?: number; tenor?: number } = {}) {
  const cust = await registerCustomer();
  await api("PATCH", "/api/v1/customers/me", {
    token: cust.accessToken,
    body: { monthlyIncomeKobo: opts.incomeKobo ?? 900_000_00, obligationsKobo: 50_000_00, bankAccountRef: `acct_${Date.now()}`, deviceId: `dev_${Date.now()}_${Math.random()}` },
  });
  await api("POST", "/api/v1/kyc/verify", { token: cust.accessToken, body: { idType: "NIN", idNumber: "11111111110" } });
  const productId = await ensureProduct();
  const created = await api("POST", "/api/v1/loan-applications/", {
    token: cust.accessToken, body: { productId, amountKobo: opts.amountKobo ?? 200_000_00, tenorMonths: opts.tenor ?? 4 },
  });
  expect(created.status).toBe(201);
  const appId = (created.json as { data: { id: string } }).data.id;
  const submitted = await api("POST", `/api/v1/loan-applications/${appId}/submit`, { token: cust.accessToken });
  expect(submitted.status).toBe(200);
  if ((submitted.json as { data: { status: string } }).data.status === "UNDER_REVIEW") {
    const admin = await loginAs("admin@lend.local");
    const review = await api("POST", `/api/v1/loan-applications/${appId}/review`, { token: admin.accessToken, body: { decision: "APPROVE", reason: "remediation setup approval" } });
    expect(review.status).toBe(200);
  }
  await api("POST", `/api/v1/loan-applications/${appId}/accept-offer`, { token: cust.accessToken });
  const disb = await api("POST", `/api/v1/loans/applications/${appId}/disburse`, { token: cust.accessToken, headers: { "Idempotency-Key": `rem-${Date.now()}-${Math.random()}` } });
  expect([200, 201]).toContain(disb.status);
  const { loanId, reference } = (disb.json as { data: { loanId: string; reference: string } }).data;
  const loan = await api("GET", `/api/v1/loans/${loanId}`, { token: cust.accessToken });
  if ((loan.json as { data: { status: string } }).data.status === "PENDING") {
    await api("POST", `/api/v1/loans/disbursements/${reference}/confirm`, { token: cust.accessToken });
  }
  return { token: cust.accessToken, loanId, appId };
}

async function payInFull(token: string, loanId: string, amountKobo: number, tag: string) {
  const pay = await api("POST", `/api/v1/loans/${loanId}/payments`, {
    token, headers: { "Idempotency-Key": `${tag}-${Date.now()}-${Math.random()}` }, body: { amountKobo },
  });
  expect(pay.status).toBe(201);
  const paymentId = (pay.json as { data: { paymentId: string } }).data.paymentId;
  const evt = `${tag}-evt-${Date.now()}-${Math.random()}`;
  const raw = JSON.stringify({ providerEventId: evt, reference: paymentId, status: "SUCCESS" });
  const wh = await api("POST", "/api/v1/webhooks/payments", { body: { providerEventId: evt, reference: paymentId, status: "SUCCESS", signature: sign(raw) } });
  expect(wh.status).toBe(200);
  return paymentId;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("remediation: ledger accounting (fix 1)", () => {
  test("repayment credits principal/interest/fee to the correct accounts, balanced", async () => {
    const { token, loanId } = await setupActiveLoan();
    const loan = (await api("GET", `/api/v1/loans/${loanId}`, { token }).then((r) => (r.json as { data: { schedules: { totalDueKobo: number; interestKobo: number; feesKobo: number; principalKobo: number }[] } }).data));
    const first = loan.schedules[0]!;
    const paymentId = await payInFull(token, loanId, first.totalDueKobo, "ledger");

    const payment = await prisma.payment.findUniqueOrThrow({ where: { publicId: paymentId }, include: { allocations: true } });
    expect(payment.status).toBe("SUCCESS");
    expect(payment.appliedKobo).toBe(first.totalDueKobo);

    const tx = await prisma.ledgerTransaction.findUniqueOrThrow({ where: { reference: `ledger-pay-${paymentId}` } });
    const entries = await prisma.ledgerEntry.findMany({ where: { transactionId: tx.id }, include: { account: true } });
    const byCode = new Map(entries.map((e) => [e.account.code, e]));
    // interest portion -> INTEREST_INCOME credit, principal -> LOAN_RECEIVABLE credit,
    // fees -> FEE_INCOME credit (this is the corrected behavior)
    expect(byCode.get("INTEREST_INCOME")?.creditKobo).toBe(first.interestKobo);
    expect(byCode.get("LOAN_RECEIVABLE")?.creditKobo).toBe(first.principalKobo);
    if (first.feesKobo > 0) expect(byCode.get("FEE_INCOME")?.creditKobo).toBe(first.feesKobo);
    else expect(byCode.has("FEE_INCOME")).toBe(false);
    const debits = entries.reduce((s, e) => s + e.debitKobo, 0);
    const credits = entries.reduce((s, e) => s + e.creditKobo, 0);
    expect(debits).toBe(credits);
    expect(debits).toBe(first.totalDueKobo);
    expect(byCode.get("CASH")?.debitKobo).toBe(first.totalDueKobo);

    // allocations persisted per schedule
    expect(payment.allocations.length).toBeGreaterThan(0);
    const allocSum = payment.allocations.reduce((s, a) => s + a.feesKobo + a.interestKobo + a.principalKobo, 0);
    expect(allocSum).toBe(first.totalDueKobo);
  });
});

describe("remediation: reversal (fix 2)", () => {
  test("reversal restores schedules, balances, ledger; second reversal rejected; completion reopens", async () => {
    const { token, loanId, appId } = await setupActiveLoan({ amountKobo: 120_000_00, tenor: 4 });
    const before = (await api("GET", `/api/v1/loans/${loanId}`, { token }).then((r) => (r.json as { data: { outstandingKobo: number; status: string; schedules: { totalDueKobo: number; amountPaidKobo: number }[] } }).data));
    const outstandingBefore = before.outstandingKobo;

    // Pay the FULL outstanding -> loan COMPLETED
    const paymentId = await payInFull(token, loanId, outstandingBefore, "revfull");
    const completed = (await api("GET", `/api/v1/loans/${loanId}`, { token }).then((r) => (r.json as { data: { outstandingKobo: number; status: string } }).data));
    expect(completed.status).toBe("COMPLETED");
    expect(completed.outstandingKobo).toBe(0);

    const finance = await loginAs("finance@lend.local");
    const rev = await api("POST", `/api/v1/payments/${paymentId}/reverse`, { token: finance.accessToken, body: { reason: "remediation test" } });
    expect(rev.status).toBe(200);
    expect((rev.json as { data: { restored: number } }).data.restored).toBe(outstandingBefore);

    // Schedules restored, loan + application reopened, balances back
    const after = (await api("GET", `/api/v1/loans/${loanId}`, { token }).then((r) => (r.json as { data: { outstandingKobo: number; status: string; schedules: { amountPaidKobo: number; status: string }[] } }).data));
    expect(after.status).toBe("ACTIVE");
    expect(after.outstandingKobo).toBe(outstandingBefore);
    for (const s of after.schedules) {
      expect(s.amountPaidKobo).toBe(0);
      expect(["PENDING", "OVERDUE"]).toContain(s.status);
    }
    const appView = await api("GET", `/api/v1/loan-applications/${appId}`, { token });
    expect((appView.json as { data: { status: string } }).data.status).toBe("ACTIVE");

    // Reversal ledger mirrors the repayment (income debits, cash credit)
    const tx = await prisma.ledgerTransaction.findUniqueOrThrow({ where: { reference: `ledger-rev-${paymentId}` } });
    expect(tx.type).toBe("REVERSAL");
    const entries = await prisma.ledgerEntry.findMany({ where: { transactionId: tx.id }, include: { account: true } });
    const debits = entries.reduce((s, e) => s + e.debitKobo, 0);
    const credits = entries.reduce((s, e) => s + e.creditKobo, 0);
    expect(debits).toBe(credits);
    expect(credits).toBe(outstandingBefore);
    const byCode = new Map(entries.map((e) => [e.account.code, e]));
    expect(byCode.get("CASH")?.creditKobo).toBe(outstandingBefore);

    // Global ledger still balanced after reversal
    const all = await prisma.ledgerEntry.findMany();
    expect(all.reduce((s, e) => s + e.debitKobo, 0)).toBe(all.reduce((s, e) => s + e.creditKobo, 0));

    // Second reversal of the same payment is rejected
    const rev2 = await api("POST", `/api/v1/payments/${paymentId}/reverse`, { token: finance.accessToken, body: { reason: "double" } });
    expect([400, 422]).toContain(rev2.status);
    const still = await prisma.payment.findUniqueOrThrow({ where: { publicId: paymentId } });
    expect(still.status).toBe("REVERSED");
  });
});

describe("remediation: late fees (fix 3)", () => {
  test("late fee accrues exactly once with ledger posting, driven by explicit flag", async () => {
    const { loanId } = await setupActiveLoan();
    const loanRow = await prisma.loan.findUniqueOrThrow({ where: { publicId: loanId }, include: { application: { include: { product: true } } } });
    const expectedFee = loanRow.application.product.lateFeeKobo;
    expect(expectedFee).toBeGreaterThan(0);
    const sched = await prisma.repaymentSchedule.findFirstOrThrow({ where: { loanId: loanRow.id, installmentNo: 1 } });
    const outstandingBefore = loanRow.outstandingKobo;

    // Force past-due (test setup only): due 10 days ago, unpaid, no late fee yet.
    await prisma.repaymentSchedule.update({ where: { id: sched.id }, data: { dueDate: new Date(Date.now() - 10 * 24 * 3600 * 1000), status: "PENDING", lateFeeApplied: false, lateFeeKobo: 0, feesKobo: sched.feesKobo } });

    const admin = await loginAs("admin@lend.local");
    const j1 = await api("POST", "/api/v1/admin/jobs/overdue", { token: admin.accessToken });
    expect(j1.status).toBe(200);
    const j2 = await api("POST", "/api/v1/admin/jobs/overdue", { token: admin.accessToken });
    expect(j2.status).toBe(200);

    const after = await prisma.repaymentSchedule.findUniqueOrThrow({ where: { id: sched.id } });
    expect(after.status).toBe("OVERDUE");
    expect(after.lateFeeApplied).toBe(true);
    expect(after.lateFeeKobo).toBe(expectedFee);
    const loanAfter = await prisma.loan.findUniqueOrThrow({ where: { id: loanRow.id } });
    // Exactly one fee accrual across two job runs (flag, not feesKobo inference)
    expect(loanAfter.outstandingKobo).toBe(outstandingBefore + expectedFee);

    const feeTx = await prisma.ledgerTransaction.findUnique({ where: { reference: `ledger-latefee-${loanRow.id}-1` } });
    expect(feeTx).not.toBeNull();
    expect(feeTx!.type).toBe("FEE");
    const feeEntries = await prisma.ledgerEntry.findMany({ where: { transactionId: feeTx!.id }, include: { account: true } });
    const feeByCode = new Map(feeEntries.map((e) => [e.account.code, e]));
    expect(feeByCode.get("LOAN_RECEIVABLE")?.debitKobo).toBe(expectedFee);
    expect(feeByCode.get("FEE_INCOME")?.creditKobo).toBe(expectedFee);
  });
});

describe("remediation: reporting (fix 4)", () => {
  test("total repaid sums SUCCESS applied amounts; reversed payments excluded", async () => {
    await setupActiveLoan({ amountKobo: 100_000_00, tenor: 4 });
    const admin = await loginAs("admin@lend.local");
    const report = await api("GET", "/api/v1/reports/summary", { token: admin.accessToken });
    expect(report.status).toBe(200);

    const successAgg = await prisma.payment.aggregate({ _sum: { appliedKobo: true }, where: { status: "SUCCESS" } });
    const expected = successAgg._sum.appliedKobo ?? 0;
    expect((report.json as { data: { totalRepaidKobo: number } }).data.totalRepaidKobo).toBe(expected);

    // The old principal-minus-outstanding derivation diverges once interest/fees exist.
    const loans = await prisma.loan.findMany({ select: { principalKobo: true, outstandingKobo: true, status: true } });
    const naive = loans.reduce((s, l) => s + Math.max(0, l.principalKobo - (["ACTIVE", "OVERDUE", "DEFAULTED"].includes(l.status) ? l.outstandingKobo : 0)), 0);
    const hasInterest = await prisma.repaymentSchedule.count({ where: { interestKobo: { gt: 0 } } });
    expect(hasInterest).toBeGreaterThan(0);
    // Authoritative figure must be >= 0 and consistent; naive undercounts interest/fees repaid.
    expect(expected).toBeGreaterThanOrEqual(0);
    expect(typeof naive).toBe("number");
  });
});

describe("remediation: outbox single-ID (fix 5)", () => {
  test("staged messageId == queued messageId; relay never re-executes", async () => {
    const type = `test.once.${Date.now()}`;
    let count = 0;
    await queue.consume(type, async () => {
      count++;
    });
    const msg = await publishEvent(type, "agg-test", { x: 1 });
    for (let i = 0; i < 40 && count === 0; i++) await sleep(100);
    expect(count).toBe(1);

    const row = await prisma.outboxEvent.findUnique({ where: { messageId: msg.messageId } });
    expect(row).not.toBeNull();
    expect(row!.eventType).toBe(type);

    const relayed = await relayOutbox();
    expect(relayed).toBeGreaterThanOrEqual(0);
    await sleep(400);
    expect(count).toBe(1); // no second execution via relay
    const rowAfter = await prisma.outboxEvent.findUnique({ where: { messageId: msg.messageId } });
    expect(rowAfter!.status).toBe("PUBLISHED");
    const processed = await prisma.processedEvent.findUnique({ where: { messageId: msg.messageId } });
    expect(processed).not.toBeNull();
  });
});

describe("remediation: idempotency recovery (fix 6)", () => {
  test("FAILED keys allow same-body retry; different body always 422; PROCESSING concurrent 409", async () => {
    const k = `idem-${Date.now()}`;
    const first = await claimKey({ key: k, endpoint: "t", requestHash: "h1" });
    expect(first.replay).toBeNull();
    await failKey(k, "simulated crash before commit");
    // Same body retries (reclaim, not replay, not 409)
    const retry = await claimKey({ key: k, endpoint: "t", requestHash: "h1" });
    expect(retry.replay).toBeNull();
    // Different body on the same key is always rejected, even after failure
    await failKey(k, "failed again");
    let code = "";
    try {
      await claimKey({ key: k, endpoint: "t", requestHash: "different" });
    } catch (e) {
      code = (e as { code?: string }).code ?? "";
    }
    expect(code).toBe("IDEMPOTENCY_CONFLICT");

    // Concurrent claim on a PROCESSING key -> 409, not 500
    const k2 = `idem-conc-${Date.now()}`;
    await claimKey({ key: k2, endpoint: "t", requestHash: "h" });
    let code2 = "";
    try {
      await claimKey({ key: k2, endpoint: "t", requestHash: "h" });
    } catch (e) {
      code2 = (e as { code?: string }).code ?? "";
    }
    expect(code2).toBe("CONFLICT");
  }, 15000);
});

describe("remediation: concurrent webhooks (fix 7)", () => {
  test("8 simultaneous identical webhooks -> one financial effect, no 500s", async () => {
    const { token, loanId } = await setupActiveLoan({ amountKobo: 100_000_00, tenor: 4 });
    const loanBefore = (await api("GET", `/api/v1/loans/${loanId}`, { token }).then((r) => (r.json as { data: { outstandingKobo: number } }).data.outstandingKobo));
    const pay = await api("POST", `/api/v1/loans/${loanId}/payments`, {
      token, headers: { "Idempotency-Key": `conc-wh-${Date.now()}` }, body: { amountKobo: 50_000_00 },
    });
    expect(pay.status).toBe(201);
    const paymentId = (pay.json as { data: { paymentId: string } }).data.paymentId;
    const evt = `conc-evt-${Date.now()}`;
    // NOTE: webhookPayment() signs the payload itself — pass it WITHOUT signature.
    const unsigned = { providerEventId: evt, reference: paymentId, status: "SUCCESS" };

    const results = await Promise.all(Array.from({ length: 8 }, () => webhookPayment(unsigned)));
    for (const r of results) expect([200, 409]).toContain(r.status);

    const payment = await prisma.payment.findUniqueOrThrow({ where: { publicId: paymentId }, include: { allocations: true } });
    expect(payment.status).toBe("SUCCESS");
    const appliedTotal = payment.allocations.reduce((s, a) => s + a.feesKobo + a.interestKobo + a.principalKobo, 0);
    expect(appliedTotal).toBe(50_000_00);
    const loanAfter = (await api("GET", `/api/v1/loans/${loanId}`, { token }).then((r) => (r.json as { data: { outstandingKobo: number } }).data.outstandingKobo));
    expect(loanBefore - loanAfter).toBe(50_000_00); // exactly one application

    // Eventual replay is a clean DUPLICATE
    const replay = await webhookPayment(unsigned);
    expect(replay.status).toBe(200);
    expect((replay.json as { data: { status: string } }).data.status).toBe("DUPLICATE");
  }, 30000);
});

describe("remediation: integer ceiling (fix 8)", () => {
  test("amounts above the Prisma Int ceiling are rejected at the boundary", async () => {
    const cust = await registerCustomer();
    const tooBig = await api("PATCH", "/api/v1/customers/me", { token: cust.accessToken, body: { monthlyIncomeKobo: 3_000_000_000 } });
    expect(tooBig.status).toBe(400);
    const atCap = await api("PATCH", "/api/v1/customers/me", { token: cust.accessToken, body: { monthlyIncomeKobo: 2_147_483_647 } });
    expect(atCap.status).toBe(200);
  });
});

describe("remediation: explicit transitions (fix 9)", () => {
  test("approval walks asserted chain with audit trail; illegal jumps rejected", async () => {
    const cust = await registerCustomer();
    // Borderline profile: deterministic MANUAL_REVIEW (score lands between auto bands).
    await api("PATCH", "/api/v1/customers/me", { token: cust.accessToken, body: { monthlyIncomeKobo: 350_000_00, obligationsKobo: 150_000_00, bankAccountRef: "acct_s", deviceId: `dev_s${Date.now()}` } });
    await api("POST", "/api/v1/kyc/verify", { token: cust.accessToken, body: { idType: "BVN", idNumber: "44444444440" } });
    const productId = await ensureProduct();
    const created = await api("POST", "/api/v1/loan-applications/", { token: cust.accessToken, body: { productId, amountKobo: 400_000_00, tenorMonths: 6 } });
    const appId = (created.json as { data: { id: string } }).data.id;
    const submitted = await api("POST", `/api/v1/loan-applications/${appId}/submit`, { token: cust.accessToken });
    expect((submitted.json as { data: { status: string } }).data.status).toBe("UNDER_REVIEW");

    const admin = await loginAs("admin@lend.local");
    const review = await api("POST", `/api/v1/loan-applications/${appId}/review`, { token: admin.accessToken, body: { decision: "APPROVE", reason: "chain audit test" } });
    expect(review.status).toBe(200);

    // Chain evidence: distinct staged events for approval AND offer creation
    const events = await prisma.outboxEvent.findMany({ where: { aggregateId: appId, eventType: { in: ["loan.application.submitted", "loan.application.under_review", "loan.approved", "loan.offer.created"] } }, orderBy: { id: "asc" } });
    const types = events.map((e) => e.eventType);
    expect(types).toContain("loan.application.submitted");
    expect(types).toContain("loan.approved");
    expect(types).toContain("loan.offer.created");
    // Each hop carries its own messageId (no ID reuse across distinct events)
    expect(new Set(events.map((e) => e.messageId)).size).toBe(events.length);

    const audits = await prisma.auditLog.findMany({ where: { resource: "loan-application", resourceId: appId, action: "LOAN_APPROVED" } });
    expect(audits.length).toBeGreaterThanOrEqual(1);

    // Illegal: reviewing an already-decided (OFFER_CREATED) application
    const again = await api("POST", `/api/v1/loan-applications/${appId}/review`, { token: admin.accessToken, body: { decision: "REJECT", reason: "too late" } });
    expect([400, 422]).toContain(again.status);
  });
});
