# Security

## Authentication

- Passwords: bcrypt (cost 10), never stored/logged/returned. DTO mappers strip hashes.
- Access: JWT HS256 (`jose`), 15 min TTL, `sub` = user publicId.
- Refresh: opaque random tokens, SHA-256 hashed at rest, 30-day TTL, single-use rotation
  (old session revoked on refresh), revocation on logout. Suspended users rejected.
- Rate limits (in-memory bucket): register/login 10/min, KYC 10/h, applications 20/h,
  payments 30/h, webhooks 120/min. Test helper uses unique IPs; production would use Redis.

## Authorization

- RBAC roles: CUSTOMER, LOAN_OFFICER, CREDIT_ANALYST, FINANCE_OFFICER,
  COLLECTIONS_OFFICER, ADMIN, SUPER_ADMIN. Permissions (`loan.approve`, `payment.reverse`,
  `collection.manage`, `report.read`, …) enforced server-side via `requirePerm/requireRole`.
- Object-level auth: every customer resource checks ownership (`customer.userId === auth.userId`)
  or staff role. Tested: customer B gets 403 on customer A's application/loan/payment.
- Payment confirm/reverse and loan reads all enforce ownership.

## Data protection

- Public IDs are UUIDs (no enumeration). Sequential ids never leave the server.
- Minimal KYC storage: raw ID numbers are NEVER persisted (only idType + provider ref + reasons).
- Logger redacts password/token/secret/otp/authorization fields. No stack traces to clients.
- Security headers via Hono `secureHeaders`; CORS restricted to needed headers.
- Secrets via env (`.env.example` provided); no secrets committed.

## Webhooks

Canonical signing: `HMAC-SHA256(secret, JSON.stringify(payload-without-signature))` hex.
Missing/invalid signature → 400/422, no state change. Every delivery stored in
`WebhookEvent`; replays de-duplicated by `providerEventId`. Amount mismatches are
flagged, never auto-applied.

## Threat model (handled)

SQL injection (Prisma parameterized, no raw SQL in app code), IDOR (ownership checks),
privilege escalation (server-side RBAC), brute force (rate limits + bcrypt),
token misuse (short TTL + rotation + revocation), replay (idempotency + webhook dedupe),
duplicate financial ops (idempotency keys + unique constraints + tx guards),
forged webhooks (HMAC). Assumption documented: single-process deployment — for multi-instance,
replace in-memory rate limiter/queue/cache with Redis-backed implementations.

## Audit

Append-only `AuditLog(actor, actorRole, action, resource, resourceId, requestId, metadata)`.
Covered: register/login, KYC, apply/approve/reject/disburse, payments created/completed/reversed,
collections actions, reconciliation reviews. No user-facing mutation endpoints.
