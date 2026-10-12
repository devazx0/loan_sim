# Digital Lending Backend Simulation (Nigeria)

Simulated digital-lending backend built as a **modular monolith**: Bun + Hono + Prisma + SQLite, strict TypeScript.

> Simulation only. All banks, KYC/AML, credit-bureau, payment-gateway and notification
> providers are **fake in-process implementations** behind interfaces
> (`src/infrastructure/providers/interfaces.ts`). No real money, BVN/NIN, or SMS moves.

## Quick start

```bash
bun install
cp .env.example .env
bunx prisma migrate dev      # creates prisma/dev.db
bun run prisma/seed.ts       # products + staff + demo customers
bun run src/server.ts        # http://localhost:9256 (or next free port if busy)
```

Port precedence: `bun run src/server.ts --port N` > `PORT` env var > `9256` default.
If the chosen port is already in use, the server walks upward (9257, 9258, …) and logs the port it bound.

Health: `GET /health`, readiness: `GET /ready`.

## Tests

```bash
# isolated test database (never touches dev.db)
$env:DATABASE_URL="file:./test.db"   # powershell
bunx prisma migrate deploy
bun run prisma/seed-test.ts
bun test                              # 36 tests: unit + integration + e2e + failure
```

Unit: `tests/unit` (money, risk engines, state machine, allocation).
Integration: `tests/integration` (auth/RBAC/IDOR, full e2e, failure/invariant).

## Demo credentials (seeded)

| Role | Email | Password |
|---|---|---|
| Customer (demo) | `demo@lend.local` | `Password123!` |
| Admin | `admin@lend.local` | `Password123!` |
| Credit analyst | `credit@lend.local` | `Password123!` |
| Finance | `finance@lend.local` | `Password123!` |
| Collections | `collections@lend.local` | `Password123!` |

## Complete demo flow (₦300,000)

1. `POST /api/v1/auth/register` → tokens (+ auto customer profile)
2. `PATCH /api/v1/customers/me` → income ₦600,000, obligations ₦80,000, bank ref
3. `POST /api/v1/kyc/verify` `{"idType":"BVN","idNumber":"12345678901"}` → VERIFIED
   (fake rule: id ending 9 = FAILED, 7/8 = PENDING, else VERIFIED)
4. `GET /api/v1/loan-products/` → pick product id
5. `POST /api/v1/loan-applications/` `{"productId","amountKobo":30000000,"tenorMonths":6}`
6. `POST /api/v1/loan-applications/:id/submit` → runs KYC→AML→Fraud→Credit→Affordability pipeline
7. If `UNDER_REVIEW`: admin `POST /api/v1/loan-applications/:id/review` `{"decision":"APPROVE","reason":"..."}` → offer created
8. `POST /api/v1/loan-applications/:id/accept-offer` (offer + agreement v1 accepted)
9. `POST /api/v1/loans/applications/:id/disburse` with `Idempotency-Key` header → fake bank
10. If PENDING: `POST /api/v1/loans/disbursements/:ref/confirm` → loan ACTIVE + schedule generated
11. `GET /api/v1/loans/:id` → repayment schedule
12. `POST /api/v1/loans/:id/payments` `{"amountKobo":...}` with `Idempotency-Key` → PENDING payment
13. Payment webhook `POST /api/v1/webhooks/payments` (HMAC, see SECURITY.md) → SUCCESS → allocation + ledger + notification
14. `POST /api/v1/admin/jobs/overdue` (or wait 60s scheduler) → overdue detection + collection case
15. Repay in full → loan COMPLETED.

## API conventions

Base `/api/v1`. Success: `{"success":true,"data":{...}}`.
Error: `{"success":false,"error":{"code":"...","message":"..."}}` (never stack traces).
Public IDs are UUIDs (`id` fields); sequential DB ids are never exposed.
Cursor pagination: `?limit=&cursor=` → `{items, nextCursor}`.

Key endpoints: `/auth/*`, `/customers/me`, `/kyc/verify`, `/loan-products/`,
`/loan-applications/` (create/submit/accept-offer/review), `/loans/` (list/get/disburse),
`/loans/:id/payments`, `/payments/:id/{confirm,reverse}`, `/webhooks/{payments,bank}`,
`/admin/{customers,loans,payments,audit,webhooks,dead-letters,collections,kyc,jobs/overdue}`,
`/reports/{summary,reconciliation}`.

Money = integer **kobo** everywhere. Financial POSTs require `Idempotency-Key`.

## Docs

- `ARCHITECTURE.md` — modules, DB, queue/cache, providers, transactions, idempotency, outbox
- `SECURITY.md` — auth, RBAC, data handling, rate limits, webhooks, threat model
- `DOMAIN_RULES.md` — loan lifecycle, risk engines, collections
- `FINANCIAL_INVARIANTS.md` — the 12 guarantees + where each is enforced/tested
