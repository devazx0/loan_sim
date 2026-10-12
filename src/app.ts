import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { requestIdMiddleware, reqId } from "./common/middleware";
import { errorToResponse } from "./common/errors";
import { logger } from "./common/logger";
import { authRoutes } from "./modules/auth/routes";
import { customerRoutes } from "./modules/customers/routes";
import { kycRoutes } from "./modules/kyc/routes";
import { productRoutes } from "./modules/loan-products/routes";
import { applicationRoutes } from "./modules/loan-applications/routes";
import { loanRoutes } from "./modules/loans/routes";
import { paymentRoutes } from "./modules/payments/routes";
import { webhookRoutes } from "./modules/webhooks/routes";
import { adminRoutes } from "./modules/admin/routes";
import { reportRoutes } from "./modules/reports/routes";
import { healthRoutes } from "./modules/health/routes";
import { queue } from "./infrastructure/queue/queue";
import { prisma } from "./infrastructure/database/prisma";
import { FakeNotificationProvider } from "./infrastructure/providers/fakes";

export const notificationOutbox = new FakeNotificationProvider();

// Background consumers (idempotent): notifications + audit fan-out
queue.consume("payment.completed", async (msg) => {
  const p = msg.payload as { applied?: number };
  notificationOutbox.send({ channel: "SMS", to: "customer", template: "payment_completed", payload: { messageId: msg.messageId, applied: p.applied } }).catch(() => null);
});
queue.consume("loan.disbursed", async (msg) => {
  notificationOutbox.send({ channel: "SMS", to: "customer", template: "loan_disbursed", payload: { messageId: msg.messageId } }).catch(() => null);
});
// Mark queued notifications sent (simulated async sender)
queue.consume("notification.requested", async (msg) => {
  await prisma.notification.updateMany({ where: { status: "QUEUED" }, data: { status: "SENT", sentAt: new Date() } }).catch(() => null);
  void msg;
});

export function createApp() {
  const app = new Hono({ strict: false });
  app.use("*", secureHeaders());
  app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"], allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "x-request-id"] }));
  app.use("*", requestIdMiddleware);

  app.onError((err, c) => {
    const { status, body } = errorToResponse(err);
    if (status >= 500) logger.error({ err: String(err), path: c.req.path, requestId: reqId(c) }, "unhandled error");
    return c.json(body, status as never);
  });

  app.route("/", healthRoutes);
  app.route("/api/v1/auth", authRoutes);
  app.route("/api/v1/customers", customerRoutes);
  app.route("/api/v1/kyc", kycRoutes);
  app.route("/api/v1/loan-products", productRoutes);
  app.route("/api/v1/loan-applications", applicationRoutes);
  app.route("/api/v1/loans", loanRoutes);
  app.route("/api/v1", paymentRoutes);
  app.route("/api/v1/webhooks", webhookRoutes);
  app.route("/api/v1/admin", adminRoutes);
  app.route("/api/v1/reports", reportRoutes);

  app.notFound((c) => c.json({ success: false, error: { code: "NOT_FOUND", message: "Route not found" } }, 404));
  return app;
}

export const app = createApp();
export type App = ReturnType<typeof createApp>;


