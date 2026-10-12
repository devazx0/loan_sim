-- CreateTable
CREATE TABLE "PaymentAllocation" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "paymentId" INTEGER NOT NULL,
    "scheduleId" INTEGER,
    "feesKobo" INTEGER NOT NULL DEFAULT 0,
    "interestKobo" INTEGER NOT NULL DEFAULT 0,
    "principalKobo" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Payment" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "publicId" TEXT NOT NULL,
    "loanId" INTEGER NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL DEFAULT 'FAKE',
    "providerRef" TEXT,
    "idempotencyKey" TEXT,
    "failureReason" TEXT,
    "verifiedAt" DATETIME,
    "appliedKobo" INTEGER NOT NULL DEFAULT 0,
    "leftoverKobo" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Payment_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Payment" ("amountKobo", "createdAt", "failureReason", "id", "idempotencyKey", "loanId", "provider", "providerRef", "publicId", "status", "updatedAt", "verifiedAt") SELECT "amountKobo", "createdAt", "failureReason", "id", "idempotencyKey", "loanId", "provider", "providerRef", "publicId", "status", "updatedAt", "verifiedAt" FROM "Payment";
DROP TABLE "Payment";
ALTER TABLE "new_Payment" RENAME TO "Payment";
CREATE UNIQUE INDEX "Payment_publicId_key" ON "Payment"("publicId");
CREATE UNIQUE INDEX "Payment_providerRef_key" ON "Payment"("providerRef");
CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");
CREATE INDEX "Payment_loanId_status_idx" ON "Payment"("loanId", "status");
CREATE INDEX "Payment_status_createdAt_idx" ON "Payment"("status", "createdAt");
CREATE TABLE "new_RepaymentSchedule" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "loanId" INTEGER NOT NULL,
    "installmentNo" INTEGER NOT NULL,
    "dueDate" DATETIME NOT NULL,
    "principalKobo" INTEGER NOT NULL,
    "interestKobo" INTEGER NOT NULL,
    "feesKobo" INTEGER NOT NULL DEFAULT 0,
    "totalDueKobo" INTEGER NOT NULL,
    "amountPaidKobo" INTEGER NOT NULL DEFAULT 0,
    "lateFeeApplied" BOOLEAN NOT NULL DEFAULT false,
    "lateFeeKobo" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "paidAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RepaymentSchedule_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_RepaymentSchedule" ("amountPaidKobo", "createdAt", "dueDate", "feesKobo", "id", "installmentNo", "interestKobo", "loanId", "paidAt", "principalKobo", "status", "totalDueKobo", "updatedAt") SELECT "amountPaidKobo", "createdAt", "dueDate", "feesKobo", "id", "installmentNo", "interestKobo", "loanId", "paidAt", "principalKobo", "status", "totalDueKobo", "updatedAt" FROM "RepaymentSchedule";
DROP TABLE "RepaymentSchedule";
ALTER TABLE "new_RepaymentSchedule" RENAME TO "RepaymentSchedule";
CREATE INDEX "RepaymentSchedule_loanId_status_idx" ON "RepaymentSchedule"("loanId", "status");
CREATE INDEX "RepaymentSchedule_status_dueDate_idx" ON "RepaymentSchedule"("status", "dueDate");
CREATE INDEX "RepaymentSchedule_dueDate_idx" ON "RepaymentSchedule"("dueDate");
CREATE UNIQUE INDEX "RepaymentSchedule_loanId_installmentNo_key" ON "RepaymentSchedule"("loanId", "installmentNo");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "PaymentAllocation_paymentId_idx" ON "PaymentAllocation"("paymentId");

-- CreateIndex
CREATE INDEX "PaymentAllocation_scheduleId_idx" ON "PaymentAllocation"("scheduleId");
