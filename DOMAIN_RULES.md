# Domain rules

## Loan lifecycle (explicit state machine, `state-machine.ts`)

```
DRAFT -> SUBMITTED -> UNDER_REVIEW -> APPROVED -> OFFER_CREATED -> OFFER_ACCEPTED
  -> DISBURSEMENT_PENDING -> DISBURSED -> ACTIVE -> (OVERDUE) -> COMPLETED
UNDER_REVIEW -> REJECTED | APPROVED ; ACTIVE/OVERDUE -> DEFAULTED -> WRITTEN_OFF
```

Every hop is asserted via `assertTransition` — automated flows walk the full chain
(submit: DRAFT→SUBMITTED→UNDER_REVIEW→APPROVED→OFFER_CREATED; confirm:
DISBURSEMENT_PENDING→DISBURSED→ACTIVE), staging one outbox event per hop so the audit
trail shows each step. `assertTransition` rejects anything else (e.g.
COMPLETED→APPROVED, REJECTED→disburse). The sole COMPLETED→ACTIVE path is payment
reversal of the completing payment (audited LOAN_REOPENED, mirror ledger entries).

## Decision pipeline (`submitApplication`)

1. KYC (FakeKycProvider; mandatory VERIFIED for any approval)
2. AML (`screenAml`) — large-amount / income-mismatch / unverified-identity / frequency /
   bank-change / round-max signals. Flag = **requires review**, never an accusation.
3. Fraud (`assessFraud`) — additive 0–100 score (shared phone/device, failed KYC,
   application velocity, bank changes, failed logins, suspicious payments) → LOW/MEDIUM/HIGH
   with `reasons[]`. HIGH blocks approval.
4. Credit (`assessCredit`) — 300–850 scorecard (DTI, defaults, history, active loans,
   KYC/fraud/AML, size-vs-income) → AUTO_APPROVE (≥650 + all clear) / AUTO_REJECT (<500 or
   fraud HIGH) / MANUAL_REVIEW, with recommended amount/tenor and `reasons[]`.
5. Affordability (`checkAffordability`) — installment ≤ 40% of disposable income
   (`affordabilityMaxDtiBps`, configurable in `src/config`). Unaffordable vetoes auto-approve.
6. Manual review records decision + reason + actor + timestamp; credit auto-reject needs an
   explicit "override" reason to approve.

All thresholds live in `riskRules` (`src/config/index.ts`), not scattered in code.

## Offer & agreement

Offer: approvedAmount, rateBps, tenor, fees, totalRepayment, installment, firstPaymentDate,
7-day expiry. Customer must explicitly accept; acceptance is one-loan-per-offer guarded
(`loan.applicationId` UNIQUE). Agreement v1 acceptance stored with version/actor/timestamp
(software simulation, not legal advice).

## Disbursement

Offer accepted → PENDING loan (committed) → FakeBank.transfer (outside tx) →
SUCCESS → schedules + balanced ledger + ACTIVE; FAILED → stays pending with failure event;
PENDING → confirm later via verify/webhook. Loan is never ACTIVE before confirmation.

## Repayments

Schedule generated at disbursement (principal/interest/fee splits sum exactly to totals).
Allocation order: **fees → interest → principal**, oldest-due first, persisted per schedule
in immutable `PaymentAllocation` rows (overpayment tracked schedule-less). Statuses
PENDING/PARTIALLY_PAID/PAID/OVERDUE. Overpayment reduces outstanding as prepayment.
Full repayment → loan COMPLETED (application follows). Reversal reads the allocation rows
to exactly undo schedules, balances, and ledger; a REVERSED payment cannot be reversed
again. Corrections use REVERSAL entries; history is never edited or deleted.

## Late fees

Accrued at most once per schedule, guarded by the explicit `lateFeeApplied` flag plus
`lateFeeKobo` (never inferred from `feesKobo`, which may carry non-late fees). Each
accrual posts a real ledger entry (Dr LOAN_RECEIVABLE / Cr FEE_INCOME) raising
`outstanding`, and emits `repayment.late_fee_applied`. The overdue job is idempotent
per schedule and never regresses COMPLETED/DEFAULTED loans to OVERDUE.

## Overdue & collections

Scheduler (60s, + manual admin trigger): schedules past due (+1-day grace) → OVERDUE,
one-time late fee, loan OVERDUE, collection case (OPEN, daysOverdue, outstanding, risk),
auto REMINDER_SENT + SMS (simulated) + events. Actions (REMINDER/EMAIL/SMS/CALL/PROMISE/
ESCALATED) are auditable; ESCALATED moves case status.

## Reporting

`totalRepaidKobo` sums `appliedKobo` over SUCCESS payments only (REVERSED excluded,
PENDING/FAILED never applied) — never `principal − outstanding`, which breaks once
outstanding carries interest and fees.

## Products

PERSONAL_LOAN / DEVICE_FINANCING / BUSINESS_LOAN with amount/tenor bounds, rateBps,
FLAT or REDUCING method, processing + late fees, ACTIVE/INACTIVE. Validated at application
time; never hardcoded in services.
