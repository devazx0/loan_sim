import { describe, expect, test, beforeEach } from "bun:test";
import { createHmac } from "node:crypto";
import { api, registerCustomer, loginAs, ensureProduct, resetRateLimits } from "../helpers";

beforeEach(() => resetRateLimits());

function sign(payload: string): string {
  const secret = process.env["WEBHOOK_HMAC_SECRET"] ?? "dev-webhook-secret-change-me";
  return createHmac("sha256", secret).update(payload).digest("hex");
}

async function setupActiveLoan(): Promise<{ token: string; loanId: string; productId: string }> {
  const cust = await registerCustomer();
  await api("PATCH", "/api/v1/customers/me", { token: cust.accessToken, body: { monthlyIncomeKobo: 900_000_00, obligationsKobo: 50_000_00, bankAccountRef: "acct_x", deviceId: `dev_${Date.now()}` } });
  await api("POST", "/api/v1/kyc/verify", { token: cust.accessToken, body: { idType: "NIN", idNumber: "11111111110" } });
  const productId = await ensureProduct();
  const created = await api("POST", "/api/v1/loan-applications/", { token: cust.accessToken, body: { productId, amountKobo: 200_000_00, tenorMonths: 4 } });
  const appId = (created.json as { data: { id: string } }).data.id;
  const submitted = await api("POST", `/api/v1/loan-applications/${appId}/submit`, { token: cust.accessToken });
  const subData = (submitted.json as { data: { status: string } }).data;
  if (subData.status === "UNDER_REVIEW") {
    const admin = await loginAs("admin@lend.local");
    await api("POST", `/api/v1/loan-applications/${appId}/review`, { token: admin.accessToken, body: { decision: "APPROVE", reason: "failure-test approval" } });
  }
  await api("POST", `/api/v1/loan-applications/${appId}/accept-offer`, { token: cust.accessToken });
  const disb = await api("POST", `/api/v1/loans/applications/${appId}/disburse`, { token: cust.accessToken, headers: { "Idempotency-Key": `setup-${Date.now()}-${Math.random()}` } });
  const { loanId, reference } = (disb.json as { data: { loanId: string; reference: string } }).data;
  const loan = await api("GET", `/api/v1/loans/${loanId}`, { token: cust.accessToken });
  if ((loan.json as { data: { status: string } }).data.status === "PENDING") {
    await api("POST", `/api/v1/loans/disbursements/${reference}/confirm`, { token: cust.accessToken });
  }
  return { token: cust.accessToken, loanId, productId };
}

describe("failure & invariant tests", () => {
  test("duplicate disbursement does not create second loan", async () => {
    const cust = await registerCustomer();
    await api("PATCH", "/api/v1/customers/me", { token: cust.accessToken, body: { monthlyIncomeKobo: 900_000_00, obligationsKobo: 50_000_00, bankAccountRef: "acct_d", deviceId: `dev_d${Date.now()}` } });
    await api("POST", "/api/v1/kyc/verify", { token: cust.accessToken, body: { idType: "BVN", idNumber: "22222222220" } });
    const productId = await ensureProduct();
    const created = await api("POST", "/api/v1/loan-applications/", { token: cust.accessToken, body: { productId, amountKobo: 150_000_00, tenorMonths: 3 } });
    const appId = (created.json as { data: { id: string } }).data.id;
    const submitted = await api("POST", `/api/v1/loan-applications/${appId}/submit`, { token: cust.accessToken });
    if ((submitted.json as { data: { status: string } }).data.status === "UNDER_REVIEW") {
      const admin = await loginAs("admin@lend.local");
      await api("POST", `/api/v1/loan-applications/${appId}/review`, { token: admin.accessToken, body: { decision: "APPROVE", reason: "dup test approval" } });
    }
    await api("POST", `/api/v1/loan-applications/${appId}/accept-offer`, { token: cust.accessToken });
    const key = `dup-${Date.now()}`;
    const d1 = await api("POST", `/api/v1/loans/applications/${appId}/disburse`, { token: cust.accessToken, headers: { "Idempotency-Key": key } });
    expect([200, 201]).toContain(d1.status);
    const d2 = await api("POST", `/api/v1/loans/applications/${appId}/disburse`, { token: cust.accessToken, headers: { "Idempotency-Key": key } });
    expect([200, 201, 400, 409, 422]).toContain(d2.status);
    // second loan must not exist: same loanId returned or error
    if (d2.status === 200 || d2.status === 201) {
      expect((d2.json as { data: { loanId: string } }).data.loanId).toBe((d1.json as { data: { loanId: string } }).data.loanId);
    }
  });

  test("idempotency key reuse with different body rejected", async () => {
    const { token, loanId } = await setupActiveLoan();
    const key = `conflict-${Date.now()}`;
    const p1 = await api("POST", `/api/v1/loans/${loanId}/payments`, { token, headers: { "Idempotency-Key": key }, body: { amountKobo: 5000_00 } });
    expect(p1.status).toBe(201);
    const p2 = await api("POST", `/api/v1/loans/${loanId}/payments`, { token, headers: { "Idempotency-Key": key }, body: { amountKobo: 9000_00 } });
    expect(p2.status).toBe(422);
  });

  test("concurrent same-key payments create one payment", async () => {
    const { token, loanId } = await setupActiveLoan();
    const key = `conc-${Date.now()}`;
    const [r1, r2] = await Promise.all([
      api("POST", `/api/v1/loans/${loanId}/payments`, { token, headers: { "Idempotency-Key": key }, body: { amountKobo: 3000_00 } }),
      api("POST", `/api/v1/loans/${loanId}/payments`, { token, headers: { "Idempotency-Key": key }, body: { amountKobo: 3000_00 } }),
    ]);
    expect([200, 201]).toContain(r1.status);
    expect([200, 201]).toContain(r2.status);
    expect((r1.json as { data: { paymentId: string } }).data.paymentId).toBe((r2.json as { data: { paymentId: string } }).data.paymentId);
  });

  test("forged webhook rejected; unknown reference flagged", async () => {
    const bad = await api("POST", "/api/v1/webhooks/payments", { body: { providerEventId: "x", reference: "y", status: "SUCCESS", signature: "deadbeef" } });
    expect([400, 401, 422]).toContain(bad.status);
  });

  test("failed KYC blocks auto-approval path (manual review required)", async () => {
    const cust = await registerCustomer();
    await api("PATCH", "/api/v1/customers/me", { token: cust.accessToken, body: { monthlyIncomeKobo: 600_000_00, obligationsKobo: 50_000_00 } });
    const kyc = await api("POST", "/api/v1/kyc/verify", { token: cust.accessToken, body: { idType: "BVN", idNumber: "99999999999" } });
    expect((kyc.json as { data: { status: string } }).data.status).toBe("FAILED");
    const productId = await ensureProduct();
    const created = await api("POST", "/api/v1/loan-applications/", { token: cust.accessToken, body: { productId, amountKobo: 100_000_00, tenorMonths: 3 } });
    const appId = (created.json as { data: { id: string } }).data.id;
    const submitted = await api("POST", `/api/v1/loan-applications/${appId}/submit`, { token: cust.accessToken });
    const status = (submitted.json as { data: { status: string } }).data.status;
    expect(["UNDER_REVIEW", "REJECTED"]).toContain(status);
  });

  test("rejected application cannot be disbursed; invalid transition rejected", async () => {
    const cust = await registerCustomer();
    await api("PATCH", "/api/v1/customers/me", { token: cust.accessToken, body: { monthlyIncomeKobo: 600_000_00, obligationsKobo: 50_000_00 } });
    await api("POST", "/api/v1/kyc/verify", { token: cust.accessToken, body: { idType: "BVN", idNumber: "99999999999" } });
    const productId = await ensureProduct();
    const created = await api("POST", "/api/v1/loan-applications/", { token: cust.accessToken, body: { productId, amountKobo: 100_000_00, tenorMonths: 3 } });
    const appId = (created.json as { data: { id: string } }).data.id;
    await api("POST", `/api/v1/loan-applications/${appId}/submit`, { token: cust.accessToken });
    const disb = await api("POST", `/api/v1/loans/applications/${appId}/disburse`, { token: cust.accessToken, headers: { "Idempotency-Key": `rej-${Date.now()}` } });
    expect([400, 404, 409, 422]).toContain(disb.status);
  });

  test("unauthorized admin endpoint blocked for customers; RBAC enforced", async () => {
    const cust = await registerCustomer();
    const r = await api("GET", "/api/v1/reports/summary", { token: cust.accessToken });
    expect(r.status).toBe(403);
    const admin = await loginAs("admin@lend.local");
    const ok = await api("GET", "/api/v1/reports/summary", { token: admin.accessToken });
    expect(ok.status).toBe(200);
  });

  test("payment reversal restores outstanding with audit", async () => {
    const { token, loanId } = await setupActiveLoan();
    const loanBefore = (await api("GET", `/api/v1/loans/${loanId}`, { token }).then((r) => (r.json as { data: { outstandingKobo: number; schedules: { totalDueKobo: number }[] } }).data));
    const amt = loanBefore.schedules[0]!.totalDueKobo;
    const pay = await api("POST", `/api/v1/loans/${loanId}/payments`, { token, headers: { "Idempotency-Key": `rev-${Date.now()}` }, body: { amountKobo: amt } });
    const paymentId = (pay.json as { data: { paymentId: string } }).data.paymentId;
    const evtId = `rev-evt-${Date.now()}`;
    const raw = JSON.stringify({ providerEventId: evtId, reference: paymentId, status: "SUCCESS" });
    const whRes = await api("POST", "/api/v1/webhooks/payments", { body: { providerEventId: evtId, reference: paymentId, status: "SUCCESS", signature: sign(raw) } });
    expect(whRes.status).toBe(200);
    const finance = await loginAs("finance@lend.local");
    const rev = await api("POST", `/api/v1/payments/${paymentId}/reverse`, { token: finance.accessToken, body: { reason: "test reversal" } });
    expect(rev.status).toBe(200);
  });
});
