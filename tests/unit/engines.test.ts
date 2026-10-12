import { describe, expect, test } from "bun:test";
import { screenAml, assessFraud, assessCredit, checkAffordability } from "../../src/modules/risk/engines";
import { canTransition } from "../../src/modules/loan-applications/state-machine";
import { allocateAcrossSchedules } from "../../src/modules/payments/service";

describe("aml", () => {
  test("clear for normal application", () => {
    const r = screenAml({ amountKobo: 300_000_00, monthlyIncomeKobo: 600_000_00, kycStatus: "VERIFIED", recentApplicationCount: 0, bankAccountChanged: false, productMaxKobo: 2_000_000_00 });
    expect(r.status).toBe("CLEAR");
  });
  test("large amount requires review", () => {
    const r = screenAml({ amountKobo: 6_000_000_00, monthlyIncomeKobo: 600_000_00, kycStatus: "VERIFIED", recentApplicationCount: 0, bankAccountChanged: false, productMaxKobo: 6_000_000_00 });
    expect(r.status).toBe("REVIEW_REQUIRED");
    expect(r.signals.length).toBeGreaterThan(0);
  });
  test("unverified identity flags", () => {
    const r = screenAml({ amountKobo: 100_000_00, monthlyIncomeKobo: 600_000_00, kycStatus: "PENDING", recentApplicationCount: 0, bankAccountChanged: false, productMaxKobo: 2_000_000_00 });
    expect(["FLAGGED", "REVIEW_REQUIRED"]).toContain(r.status);
  });
});

describe("fraud", () => {
  test("low risk baseline", () => {
    const r = assessFraud({ samePhoneCount: 1, sameDeviceCount: 1, failedKycAttempts: 0, applicationsLast24h: 1, bankChangesLast30d: 0, failedLoginsLast24h: 0, suspiciousPayments: 0 });
    expect(r.riskLevel).toBe("LOW");
    expect(r.score).toBe(0);
  });
  test("shared device + many applications escalates with reasons", () => {
    const r = assessFraud({ samePhoneCount: 3, sameDeviceCount: 4, failedKycAttempts: 3, applicationsLast24h: 5, bankChangesLast30d: 2, failedLoginsLast24h: 6, suspiciousPayments: 2 });
    expect(r.riskLevel).toBe("HIGH");
    expect(r.reasons.length).toBeGreaterThan(2);
    expect(r.score).toBeLessThanOrEqual(100);
  });
});

describe("credit + affordability", () => {
  test("strong profile auto-approves", () => {
    const r = assessCredit({ monthlyIncomeKobo: 800_000_00, obligationsKobo: 50_000_00, requestedKobo: 300_000_00, requestedTenor: 6, activeLoans: 0, previousDefaults: 0, completedLoans: 2, kycStatus: "VERIFIED", fraudLevel: "LOW", amlStatus: "CLEAR", productMaxKobo: 2_000_000_00 });
    expect(r.decision).toBe("AUTO_APPROVE");
    expect(r.score).toBeGreaterThanOrEqual(650);
  });
  test("defaults reject", () => {
    const r = assessCredit({ monthlyIncomeKobo: 150_000_00, obligationsKobo: 120_000_00, requestedKobo: 500_000_00, requestedTenor: 12, activeLoans: 3, previousDefaults: 2, completedLoans: 0, kycStatus: "PENDING", fraudLevel: "HIGH", amlStatus: "FLAGGED", productMaxKobo: 2_000_000_00 });
    expect(r.decision).toBe("AUTO_REJECT");
  });
  test("affordability cap", () => {
    const ok = checkAffordability({ monthlyIncomeKobo: 600_000_00, obligationsKobo: 80_000_00, installmentKobo: 60_000_00 });
    expect(ok.affordable).toBe(true);
    const bad = checkAffordability({ monthlyIncomeKobo: 150_000_00, obligationsKobo: 120_000_00, installmentKobo: 100_000_00 });
    expect(bad.affordable).toBe(false);
    const none = checkAffordability({ monthlyIncomeKobo: 0, obligationsKobo: 0, installmentKobo: 1000 });
    expect(none.affordable).toBe(false);
  });
});

describe("state machine", () => {
  test("valid lifecycle path", () => {
    expect(canTransition("DRAFT", "SUBMITTED")).toBe(true);
    expect(canTransition("SUBMITTED", "UNDER_REVIEW")).toBe(true);
    expect(canTransition("UNDER_REVIEW", "APPROVED")).toBe(true);
  });
  test("COMPLETED -> APPROVED forbidden", () => {
    expect(canTransition("COMPLETED", "APPROVED")).toBe(false);
    expect(canTransition("REJECTED", "APPROVED")).toBe(false);
    expect(canTransition("COMPLETED", "ACTIVE")).toBe(false);
  });
});

describe("allocation", () => {
  const sched = (id: number, p: number, i: number, f: number, paid = 0) => ({ id, principalKobo: p, interestKobo: i, feesKobo: f, amountPaidKobo: paid, totalDueKobo: p + i + f });
  test("exact payment fills oldest first", () => {
    const { allocations, leftover } = allocateAcrossSchedules([sched(1, 50000, 2500, 0), sched(2, 50000, 2500, 0)], 52500);
    expect(leftover).toBe(0);
    expect(allocations[0]!.total).toBe(52500);
    expect(allocations[0]!.interest).toBe(2500); // fees(0)->interest->principal order
    expect(allocations[0]!.principal).toBe(50000);
  });
  test("partial payment hits fees first", () => {
    const { allocations, leftover } = allocateAcrossSchedules([sched(1, 50000, 2500, 1000)], 500);
    expect(allocations[0]).toMatchObject({ fees: 500, interest: 0, principal: 0 });
    expect(leftover).toBe(0);
  });
  test("overpayment leaves leftover", () => {
    const { leftover } = allocateAcrossSchedules([sched(1, 50000, 2500, 0)], 100000);
    expect(leftover).toBe(47500);
  });
  test("skips fully paid schedules", () => {
    const { allocations } = allocateAcrossSchedules([sched(1, 100, 0, 0, 100), sched(2, 200, 0, 0)], 200);
    expect(allocations.length).toBe(1);
    expect(allocations[0]!.scheduleId).toBe(2);
  });
});
