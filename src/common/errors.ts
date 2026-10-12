export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export class ValidationError extends AppError { constructor(m: string) { super("VALIDATION_ERROR", m, 400); } }
export class UnauthorizedError extends AppError { constructor(m = "Unauthorized") { super("UNAUTHORIZED", m, 401); } }
export class ForbiddenError extends AppError { constructor(m = "Forbidden") { super("FORBIDDEN", m, 403); } }
export class NotFoundError extends AppError { constructor(m = "Not found") { super("NOT_FOUND", m, 404); } }
export class ConflictError extends AppError { constructor(m: string) { super("CONFLICT", m, 409); } }
export class InvalidStateTransitionError extends AppError { constructor(from: string, to: string) { super("INVALID_STATE_TRANSITION", `Cannot transition ${from} -> ${to}`, 422); } }
export class IdempotencyConflictError extends AppError { constructor(m = "Idempotency key reused with different payload") { super("IDEMPOTENCY_CONFLICT", m, 422); } }
export class PaymentProcessingError extends AppError { constructor(m: string) { super("PAYMENT_ERROR", m, 502); } }
export class RateLimitError extends AppError { constructor() { super("RATE_LIMITED", "Too many requests", 429); } }

export function errorToResponse(e: unknown): { status: number; body: { success: false; error: { code: string; message: string } } } {
  if (e instanceof AppError) return { status: e.status, body: { success: false, error: { code: e.code, message: e.message } } };
  return { status: 500, body: { success: false, error: { code: "INTERNAL_ERROR", message: "Internal server error" } } };
}
