# Architecture

Modular monolith. One process, one SQLite database, layered per module:

```
HTTP route -> handler (routes.ts) -> service (service.ts) -> Prisma -> SQLite
```

Business logic never lives in route handlers. Services never import fake providers
directly where an interface exists (KYC/Bank/Payment/Notification/Queue/Cache are interfaces;
fakes injected as module singletons, replaceable with real clients later).

## Modules (`src/modules`)

auth (register/login/refresh/rotation/logout), users/customers (profiles + object-level auth),
kyc, risk (pure AML/fraud/credit/affordability engines), loan-products (cached),
loan-applications (draft/submit/pipeline/review/offer/accept), loans (disbursement + schedules),
payments (initiate/confirm/allocate/reverse), webhooks (HMAC + idempotent processing),
ledger (double-entry), collections (overdue job + cases/actions), reports (+ reconciliation),
admin (paginated staff endpoints), health.

## Database (Prisma + SQLite)

Normalized schema in `prisma/schema.prisma` with FKs, unique constraints
(`providerRef`, `providerEventId`, `idempotencyKey`, `applicationId` on loan/offer),
and indexes on actual query patterns (status, customerId, loanId, dueDate, createdAt).
Migrations in `prisma/migrations`. Public API exposes `publicId` UUIDs only.

N+1 prevention: services use single batched reads (`Promise.all` of counts),
`select` projections, ordered schedule fetches, and DB aggregation for reports
(no full-table loads into JS for totals).

## Monetary integers

All money is integer kobo, capped at `MAX_MONEY_KOBO = 2,147,483,647` (≈ ₦21.4M).
Decision: keep Prisma `Int` rather than migrating to BigInt. Rationale: the cap fits
Prisma Int on every connector, stays exactly representable in JS (far below
`Number.MAX_SAFE_INTEGER`), serializes safely to JSON, and dwarfs the largest product
cap (₦5M). A BigInt migration would complicate DTOs, JSON APIs and SQLite handling for
ranges this simulation never needs. Enforced centrally in `assertValidKobo` (used by
every money util), at API DTO boundaries, and on product caps; boundary-tested.

## Financial transactions

Pattern: create PENDING row → commit → call provider OUTSIDE tx → transactionally finalize.
Finalization (`processSuccessfulPayment`, `confirmDisbursement`) is ONE Prisma `$transaction`:
verify-not-processed → update payment → allocate → update schedules/loan → ledger →
audit → outbox. Anything failing rolls back; nothing partial persists.

## Idempotency

`Idempotency-Key` header on payments/disbursements. `IdempotencyKey(key UNIQUE,
requestHash, response, expiresAt)` with lifecycle PROCESSING → COMPLETED | FAILED.
Same key + same body → replay stored response. Same key + different body → 422 in any
state. FAILED is set only when no financial commit happened (guarded to never clobber
COMPLETED), so the same key+body may retry; concurrent claims on PROCESSING poll briefly
then 409. Claim is concurrency-safe (`claimKey` catches the unique-violation race; the
loser polls for the winner's response).
Webhook `providerEventId` UNIQUE + SUCCESS-once guards give "N deliveries → 1 effect",
additionally serialized per event by an in-process mutex (SQLite single-writer).

## Queue / outbox / retries / DLQ

`MessageQueue` interface; `LocalQueue` in-process implementation. Business stages
`OutboxEvent` in the SAME tx as the state change via `stageEvent()` and publishes the
returned message AFTER commit — the row's `messageId` IS the queued `messageId` (single
ID invariant; `ProcessedEvent` deduplicates across immediate dispatch and relay).
`relayOutbox()` (2s ticker in `server.ts`) republishes PENDING rows by their stored IDs
and skips already-processed ones without redelivery. Consumers are idempotent via
`ProcessedEvent(messageId UNIQUE)` plus a same-process in-flight guard.
Retries: exponential backoff (50ms→…), max 5 attempts; transient vs permanent distinguished
(validation errors are not retried). Exhausted messages → `DeadLetter` + admin listing.

## Cache

`Cache` interface; `MemoryCache` (TTL map). Cached ONLY: loan products + reference data
(300s TTL, invalidated on admin write). NEVER cached: balances, loans, payments, schedules.
DB is the source of truth for financial state.

## Observability

`GET /health`, `GET /ready` (DB probe). Structured logs (pino) with `requestId` on every
request (`x-request-id` echo), sensitive fields redacted at the logger. AuditLog is
append-only (no update/delete endpoints). Background jobs log successes/failures.

## Background work

`server.ts` runs two tickers: outbox relay (2s) and overdue detection (60s, also
manually triggerable via `POST /api/v1/admin/jobs/overdue`).
