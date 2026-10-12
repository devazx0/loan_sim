# Financial invariants

1. **A successful payment cannot be applied twice.** `processSuccessfulPayment` checks
   `status === SUCCESS` first inside the tx and returns `duplicate:true`; webhook replays
   hit the same guard. Tested: duplicate + replayed webhooks leave `outstanding` unchanged.
2. **Webhooks may redeliver; one financial effect.** `WebhookEvent.providerEventId` UNIQUE;
   PROCESSED events short-circuit to DUPLICATE before any mutation. Simultaneous identical
   deliveries are additionally serialized by a per-event mutex; SQLite write contention
   surfaces as retryable 409, never 500. Tested with 8-way concurrent delivery.
3. **Ledger debits equal credits, posted to the correct accounts.** `postLedger` throws on
   imbalance or empty transactions. Repayment: Dr CASH / Cr LOAN_RECEIVABLE (principal) /
   Cr INTEREST_INCOME (interest) / Cr FEE_INCOME (fees). Disbursement: Dr RECEIVABLE /
   Cr CASH. Late fees: Dr RECEIVABLE / Cr FEE_INCOME. Reversals mirror exactly.
   Regression-tested per account, including global balance after reversal.
4. **A completed loan cannot return to ACTIVE — except via the explicit audited reversal
   path.** The state machine has no COMPLETED→ACTIVE edge; the ONLY exception is reversing
   the payment that completed the loan, which restores schedules/balances, posts mirror
   ledger entries, emits `loan.reopened`, and audits LOAN_REOPENED. Tested.
5. **A rejected application cannot be disbursed.** Disbursement requires `OFFER_ACCEPTED` +
   accepted offer; review of non-reviewable states rejected. Tested.
6. **An accepted offer cannot create multiple loans.** `loan.applicationId` UNIQUE +
   pre-check inside claim; duplicate disbursement returns the existing loan. Tested.
7. **Financial history is never silently deleted.** No delete endpoints for payments/ledger/
   schedules/audit; allocations are immutable; corrections are reversal entries. AuditLog has
   no mutation routes.
8. **Money never uses floats and never exceeds the Prisma Int ceiling.** Integer kobo +
   `src/common/money.ts` (half-up rounding, overflow guards), capped at INT32_MAX kobo
   (≈ ₦21.4M — fits Prisma Int on any connector, exact in JS/JSON). Boundary-tested.
9. **Customers cannot access each other's records.** Ownership checks on applications, loans,
   payments, profiles (+ confirm). Tested IDOR → 403.
10. **Concurrent financial operations cannot corrupt balances.** Single-tx finalization,
    unique constraints (idempotency keys, provider refs, event ids), optimistic `version`
    counters, race-safe claiming (loser replays winner), and per-event webhook serialization.
    Tested: concurrent same-key payments → one payment; concurrent webhooks → one effect.
11. **Provider references are unique where appropriate.** `providerRef` UNIQUE on Payment;
    `disbursementRef` UNIQUE on Loan; `providerEventId` UNIQUE on WebhookEvent.
12. **Idempotency keys cannot be reused for different requests — and failures are recoverable.**
    `requestHash` compared on every reuse; mismatch → 422 `IDEMPOTENCY_CONFLICT` in any key
    state. Lifecycle: PROCESSING → COMPLETED (replay forever) or FAILED (same-body retry
    allowed; FAILED is only set when no financial commit happened; COMPLETED is never
    clobbered). Concurrent claims on PROCESSING → 409. Tested: success, failure, retry,
    duplicate, different-body, and concurrent cases.
