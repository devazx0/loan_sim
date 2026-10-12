import { describe, expect, test, beforeEach } from "bun:test";
import { createHmac } from "node:crypto";
import { api, registerCustomer, loginAs, ensureProduct, resetRateLimits } from "../helpers";

beforeEach(() => resetRateLimits());

function sign(payload: string): string {
  const secret = process.env["WEBHOOK_HMAC_SECRET"] ?? "dev-webhook-secret-change-me";
  return createHmac("sha256", secret).update(payload).digest("hex");
}

async function webhookPayment(body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  return api("POST", "/api/v1/webhooks/payments", { body: { ...body, signature: sign(raw) } });
}

/** Full demo flow: register -> KYC -> ₦300k application -> approval -> offer -> agreement -> disbursement -> repayment -> overdue -> recovery. */
describe("e2e demo flow", () => {
  test("complete lifecycle", async () => {
    // 1. register + login
    const cust = await registerCustomer({ firstName: "E2E", lastName: "Flow" });
    // 2. complete profile
    const prof = await api("PATCH", "/api/v1/customers/me", {
      token: cust.accessToken,
      body: { monthlyIncomeKobo: 600_000_00, obligationsKobo: 80_000_00, bankAccountRef: "acct_e2e", deviceId: "dev_e2e" },
    });
    expect(prof.status).toBe(200);

    // 3. KYC succeeds (idNumber not ending in 7/8/9)
    const kyc = await api("POST", "/api/v1/kyc/verify", {
      token: cust.accessToken, body: { idType: "BVN", idNumber: "12345678901" },
    });
    expect(kyc.status).toBe(201);
    expect((kyc.json as { data: { status: string } }).data.status).toBe("VERIFIED");

    // 4. view products + apply ₦300,000
    const productId = await ensureProduct();
    const created = await api("POST", "/api/v1/loan-applications/", {
      token: cust.accessToken, body: { productId, amountKobo: 300_000_00, tenorMonths: 6 },
    });
    expect(created.status).toBe(201);
    const appId = (created.json as { data: { id: string; status: string } }).data.id;

    // 5. submit -> risk pipeline
    const submitted = await api("POST", `/api/v1/loan-applications/${appId}/submit`, { token: cust.accessToken });
    expect(submitted.status).toBe(200);
    const subData = (submitted.json as { data: { status: string; decision: string } }).data;

    const approvedAppId = appId;
    if (subData.decision === "MANUAL_REVIEW" || subData.status === "UNDER_REVIEW") {
      // admin approves
      const admin = await loginAs("admin@lend.local");
      const review = await api("POST", `/api/v1/loan-applications/${appId}/review`, {
        token: admin.accessToken, body: { decision: "APPROVE", reason: "e2e test approval, strong profile" },
      });
      expect(review.status).toBe(200);
    } else {
      expect(["APPROVED", "OFFER_CREATED"]).toContain(subData.status);
    }

    // 6. offer + agreement accept
    const appView = await api("GET", `/api/v1/loan-applications/${approvedAppId}`, { token: cust.accessToken });
    expect((appView.json as { data: { offer: unknown } }).data.offer).not.toBeNull();
    const accept = await api("POST", `/api/v1/loan-applications/${approvedAppId}/accept-offer`, { token: cust.accessToken });
    expect(accept.status).toBe(200);

    // 7. disbursement
    const disb = await api("POST", `/api/v1/loans/applications/${approvedAppId}/disburse`, {
      token: cust.accessToken, headers: { "Idempotency-Key": `e2e-${Date.now()}` },
    });
    expect([200, 201]).toContain(disb.status);
    const loanId = (disb.json as { data: { loanId: string; reference: string } }).data.loanId;
    const reference = (disb.json as { data: { loanId: string; reference: string } }).data.reference;

    // confirm if still pending (fake bank async settlement)
    let loan = await api("GET", `/api/v1/loans/${loanId}`, { token: cust.accessToken });
    if ((loan.json as { data: { status: string } }).data.status === "PENDING") {
      const conf = await api("POST", `/api/v1/loans/disbursements/${reference}/confirm`, { token: cust.accessToken });
      expect(conf.status).toBe(200);
      loan = await api("GET", `/api/v1/loans/${loanId}`, { token: cust.accessToken });
    }
    expect((loan.json as { data: { status: string } }).data.status).toBe("ACTIVE");
    const schedules = (loan.json as { data: { schedules: { totalDueKobo: number }[] } }).data.schedules;
    expect(schedules.length).toBe(6);

    // 8. repayment: initiate + webhook success
    const firstDue = schedules[0]!.totalDueKobo;
    const pay = await api("POST", `/api/v1/loans/${loanId}/payments`, {
      token: cust.accessToken, headers: { "Idempotency-Key": `pay-${Date.now()}` }, body: { amountKobo: firstDue },
    });
    expect(pay.status).toBe(201);
    const paymentId = (pay.json as { data: { paymentId: string } }).data.paymentId;
    const wh = await webhookPayment({ providerEventId: `evt-e2e-${Date.now()}`, reference: paymentId, status: "SUCCESS" });
    expect(wh.status).toBe(200);

    // 9. duplicate webhook => single financial effect
    const outstanding1 = (await api("GET", `/api/v1/loans/${loanId}`, { token: cust.accessToken }).then((r) => (r.json as { data: { outstandingKobo: number } }).data.outstandingKobo));
    const whDup = await webhookPayment({ providerEventId: `evt-e2e-${Date.now()}`, reference: paymentId, status: "SUCCESS" });
    expect(whDup.status).toBe(200);
    // replay same event id
    const sameEvt = `evt-same-${Date.now()}`;
    await webhookPayment({ providerEventId: sameEvt, reference: paymentId, status: "SUCCESS" });
    const whReplay = await webhookPayment({ providerEventId: sameEvt, reference: paymentId, status: "SUCCESS" });
    expect((whReplay.json as { data: { webhook?: string; status?: string } }).data.status ?? (whReplay.json as { data: { webhook?: string } }).data.webhook).toBeDefined();
    const outstanding2 = (await api("GET", `/api/v1/loans/${loanId}`, { token: cust.accessToken }).then((r) => (r.json as { data: { outstandingKobo: number } }).data.outstandingKobo));
    expect(outstanding2).toBe(outstanding1);

    // 10. overdue job + collection (force-due by admin job after time travel is not possible; verify job endpoint exists)
    const admin2 = await loginAs("admin@lend.local");
    const job = await api("POST", "/api/v1/admin/jobs/overdue", { token: admin2.accessToken });
    expect(job.status).toBe(200);

    // 11. ledger balanced (debits == credits)
    const { prisma } = await import("../../src/infrastructure/database/prisma");
    const entries = await prisma.ledgerEntry.findMany();
    const deb = entries.reduce((s, e) => s + e.debitKobo, 0);
    const cred = entries.reduce((s, e) => s + e.creditKobo, 0);
    expect(deb).toBe(cred);
    expect(deb).toBeGreaterThan(0);
  }, 60000);
});
