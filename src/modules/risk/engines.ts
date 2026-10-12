// Deterministic rule-based engines. Pure functions (testable) + persistence wrappers.
import { riskRules } from "../../config/index";

export interface AmlSignal { code: string; detail: string; }
export interface AmlOutcome { status: "CLEAR" | "FLAGGED" | "REVIEW_REQUIRED"; signals: AmlSignal[]; }

/** AML: explainable flags. Flag = requires review, NOT a crime accusation. */
export function screenAml(input: {
  amountKobo: number; monthlyIncomeKobo: number; kycStatus: string;
  recentApplicationCount: number; bankAccountChanged: boolean; productMaxKobo: number;
}): AmlOutcome {
  const signals: AmlSignal[] = [];
  if (input.amountKobo >= riskRules.amlLargeAmountKobo)
    signals.push({ code: "LARGE_AMOUNT", detail: `Amount ${input.amountKobo} >= threshold ${riskRules.amlLargeAmountKobo}` });
  if (input.monthlyIncomeKobo > 0 && input.amountKobo > input.monthlyIncomeKobo * 12)
    signals.push({ code: "AMOUNT_VS_INCOME", detail: "Requested > 12x monthly income" });
  if (input.kycStatus !== "VERIFIED")
    signals.push({ code: "IDENTITY_UNVERIFIED", detail: `KYC=${input.kycStatus}` });
  if (input.recentApplicationCount >= 3)
    signals.push({ code: "HIGH_FREQUENCY", detail: `${input.recentApplicationCount} recent applications` });
  if (input.bankAccountChanged)
    signals.push({ code: "BANK_ACCOUNT_CHANGE", detail: "Bank account changed recently" });
  if (input.amountKobo === input.productMaxKobo)
    signals.push({ code: "ROUND_MAX_AMOUNT", detail: "Requested exact product maximum" });
  if (signals.length === 0) return { status: "CLEAR", signals };
  if (signals.some((s) => s.code === "LARGE_AMOUNT" || s.code === "IDENTITY_UNVERIFIED")) return { status: "REVIEW_REQUIRED", signals };
  return { status: "FLAGGED", signals };
}

export interface FraudOutcome { score: number; riskLevel: "LOW" | "MEDIUM" | "HIGH"; reasons: string[]; }

/** Fraud: additive rules, 0-100, explainable. */
export function assessFraud(input: {
  samePhoneCount: number; sameDeviceCount: number; failedKycAttempts: number;
  applicationsLast24h: number; bankChangesLast30d: number; failedLoginsLast24h: number;
  suspiciousPayments: number;
}): FraudOutcome {
  let score = 0;
  const reasons: string[] = [];
  const add = (pts: number, reason: string) => { score += pts; reasons.push(reason); };
  if (input.samePhoneCount > 1) add(20, `shared_phone:${input.samePhoneCount}`);
  if (input.sameDeviceCount > 1) add(25, `shared_device:${input.sameDeviceCount}`);
  if (input.failedKycAttempts >= 3) add(20, `failed_kyc:${input.failedKycAttempts}`);
  else if (input.failedKycAttempts >= 1) add(8, `failed_kyc:${input.failedKycAttempts}`);
  if (input.applicationsLast24h >= 3) add(20, `many_applications:${input.applicationsLast24h}`);
  else if (input.applicationsLast24h >= 2) add(10, `many_applications:${input.applicationsLast24h}`);
  if (input.bankChangesLast30d >= 2) add(15, `bank_changes:${input.bankChangesLast30d}`);
  else if (input.bankChangesLast30d >= 1) add(5, `bank_changes:${input.bankChangesLast30d}`);
  if (input.failedLoginsLast24h >= 5) add(10, `failed_logins:${input.failedLoginsLast24h}`);
  if (input.suspiciousPayments >= 1) add(15, `suspicious_payments:${input.suspiciousPayments}`);
  score = Math.min(100, score);
  const riskLevel = score >= riskRules.fraudAutoRejectScore ? "HIGH" : score >= riskRules.fraudReviewScore ? "MEDIUM" : "LOW";
  return { score, riskLevel, reasons };
}

export interface CreditOutcome {
  score: number; riskLevel: "LOW" | "MEDIUM" | "HIGH";
  recommendedAmountKobo: number; recommendedTenor: number;
  decision: "AUTO_APPROVE" | "AUTO_REJECT" | "MANUAL_REVIEW";
  reasons: string[];
}

/** Credit: explainable scorecard 300-850. */
export function assessCredit(input: {
  monthlyIncomeKobo: number; obligationsKobo: number; requestedKobo: number; requestedTenor: number;
  activeLoans: number; previousDefaults: number; completedLoans: number;
  kycStatus: string; fraudLevel: string; amlStatus: string; productMaxKobo: number;
}): CreditOutcome {
  const reasons: string[] = [];
  let score = 600;
  const dti = input.monthlyIncomeKobo > 0 ? input.obligationsKobo / input.monthlyIncomeKobo : 2;
  if (dti < 0.2) { score += 60; reasons.push("low_dti"); }
  else if (dti < 0.4) { score += 20; reasons.push("moderate_dti"); }
  else if (dti < 0.6) { score -= 40; reasons.push("high_dti"); }
  else { score -= 100; reasons.push("very_high_dti"); }

  if (input.previousDefaults > 0) { score -= 120 * input.previousDefaults; reasons.push(`defaults:${input.previousDefaults}`); }
  if (input.completedLoans > 0) { score += Math.min(60, 20 * input.completedLoans); reasons.push(`completed:${input.completedLoans}`); }
  if (input.activeLoans >= 2) { score -= 50; reasons.push(`many_active:${input.activeLoans}`); }
  if (input.kycStatus !== "VERIFIED") { score -= 80; reasons.push(`kyc:${input.kycStatus}`); }
  if (input.fraudLevel === "HIGH") { score -= 150; reasons.push("fraud_high"); }
  else if (input.fraudLevel === "MEDIUM") { score -= 50; reasons.push("fraud_medium"); }
  if (input.amlStatus === "FLAGGED" || input.amlStatus === "REVIEW_REQUIRED") { score -= 60; reasons.push(`aml:${input.amlStatus}`); }
  const ratio = input.monthlyIncomeKobo > 0 ? input.requestedKobo / (input.monthlyIncomeKobo * 6) : 2;
  if (ratio > 1) { score -= 40; reasons.push("large_vs_income"); }

  score = Math.max(300, Math.min(850, Math.round(score)));
  const riskLevel = score >= 700 ? "LOW" : score >= 600 ? "MEDIUM" : "HIGH";
  const recommendedAmountKobo = Math.min(input.requestedKobo, input.productMaxKobo, Math.max(0, input.monthlyIncomeKobo * 6 - input.obligationsKobo * 3));
  const recommendedTenor = Math.min(input.requestedTenor, 12);
  let decision: CreditOutcome["decision"] = "MANUAL_REVIEW";
  if (score >= riskRules.creditAutoApproveScore && input.fraudLevel !== "HIGH" && input.amlStatus === "CLEAR" && input.kycStatus === "VERIFIED") decision = "AUTO_APPROVE";
  else if (score < riskRules.creditAutoRejectScore || input.fraudLevel === "HIGH") decision = "AUTO_REJECT";
  if (decision === "AUTO_APPROVE") reasons.push("auto_approve");
  else if (decision === "AUTO_REJECT") reasons.push("auto_reject");
  else reasons.push("manual_review");
  return { score, riskLevel, recommendedAmountKobo: Math.max(0, recommendedAmountKobo), recommendedTenor, decision, reasons };
}

export interface AffordOutcome { affordable: boolean; dtiBps: number; maxAffordableKobo: number; reason: string; }

/** Affordability: installment <= maxDti of disposable income. */
export function checkAffordability(input: { monthlyIncomeKobo: number; obligationsKobo: number; installmentKobo: number }): AffordOutcome {
  const disposable = Math.max(0, input.monthlyIncomeKobo - input.obligationsKobo);
  const maxAffordableKobo = Math.floor((disposable * riskRules.affordabilityMaxDtiBps) / 10000);
  const dtiBps = input.monthlyIncomeKobo > 0 ? Math.floor((input.installmentKobo * 10000) / input.monthlyIncomeKobo) : 100000;
  const affordable = input.installmentKobo <= maxAffordableKobo && disposable > 0;
  return {
    affordable,
    dtiBps,
    maxAffordableKobo,
    reason: affordable ? "within_dti_cap" : disposable <= 0 ? "no_disposable_income" : `installment_${input.installmentKobo}_exceeds_cap_${maxAffordableKobo}`,
  };
}

