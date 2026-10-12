import { InvalidStateTransitionError } from "../../common/errors";

// Canonical application lifecycle (superset used across application+loan for audit clarity)
export type AppStatus =
  | "DRAFT" | "SUBMITTED" | "UNDER_REVIEW" | "APPROVED" | "REJECTED" | "CANCELLED"
  | "OFFER_CREATED" | "OFFER_ACCEPTED" | "DISBURSEMENT_PENDING" | "DISBURSED"
  | "ACTIVE" | "OVERDUE" | "DEFAULTED" | "COMPLETED" | "WRITTEN_OFF";

const TRANSITIONS: Record<AppStatus, AppStatus[]> = {
  DRAFT: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["UNDER_REVIEW", "CANCELLED"],
  UNDER_REVIEW: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["OFFER_CREATED", "REJECTED", "CANCELLED"],
  REJECTED: [],
  CANCELLED: [],
  OFFER_CREATED: ["OFFER_ACCEPTED", "CANCELLED"],
  OFFER_ACCEPTED: ["DISBURSEMENT_PENDING", "CANCELLED"],
  DISBURSEMENT_PENDING: ["DISBURSED", "CANCELLED"],
  DISBURSED: ["ACTIVE"],
  ACTIVE: ["OVERDUE", "COMPLETED", "DEFAULTED"],
  OVERDUE: ["ACTIVE", "COMPLETED", "DEFAULTED"],
  DEFAULTED: ["WRITTEN_OFF", "COMPLETED"],
  COMPLETED: [],
  WRITTEN_OFF: [],
};

export function canTransition(from: AppStatus, to: AppStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: AppStatus, to: AppStatus): void {
  if (!canTransition(from, to)) throw new InvalidStateTransitionError(from, to);
}

/** Assert only when the status actually changes (self-transitions are no-ops). */
export function assertTransitionIfChanged(from: AppStatus, to: AppStatus): void {
  if (from !== to) assertTransition(from, to);
}

export type LoanStatus = "PENDING" | "ACTIVE" | "OVERDUE" | "DEFAULTED" | "COMPLETED" | "WRITTEN_OFF";
const LOAN_TRANSITIONS: Record<LoanStatus, LoanStatus[]> = {
  PENDING: ["ACTIVE"],
  ACTIVE: ["OVERDUE", "COMPLETED", "DEFAULTED"],
  OVERDUE: ["ACTIVE", "COMPLETED", "DEFAULTED"],
  DEFAULTED: ["WRITTEN_OFF", "COMPLETED"],
  COMPLETED: [],
  WRITTEN_OFF: [],
};
export function assertLoanTransition(from: LoanStatus, to: LoanStatus): void {
  if (!LOAN_TRANSITIONS[from]?.includes(to)) throw new InvalidStateTransitionError(from, to);
}

/**
 * Assert only when the status actually changes.
 * NOTE: COMPLETED -> ACTIVE is intentionally NOT an edge. The sole reopen path is
 * payment reversal, which performs a direct, audited update (LOAN_REOPENED) rather
 * than passing through this guard.
 */
export function assertLoanTransitionIfChanged(from: LoanStatus, to: LoanStatus): void {
  if (from !== to) assertLoanTransition(from, to);
}

