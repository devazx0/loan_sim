import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const pw = await bcrypt.hash("Password123!", 10);
  const products = [
    { code: "PERSONAL_LOAN", name: "Personal Loan", minAmountKobo: 50_000_00, maxAmountKobo: 2_000_000_00, minTenorMonths: 1, maxTenorMonths: 12, interestRateBps: 500, interestMethod: "FLAT", processingFeeKobo: 5_000_00, lateFeeKobo: 2_500_00, status: "ACTIVE" },
    { code: "DEVICE_FINANCING", name: "Device Financing", minAmountKobo: 20_000_00, maxAmountKobo: 500_000_00, minTenorMonths: 1, maxTenorMonths: 9, interestRateBps: 400, interestMethod: "FLAT", processingFeeKobo: 2_000_00, lateFeeKobo: 1_500_00, status: "ACTIVE" },
    { code: "BUSINESS_LOAN", name: "Business Loan", minAmountKobo: 100_000_00, maxAmountKobo: 5_000_000_00, minTenorMonths: 1, maxTenorMonths: 18, interestRateBps: 350, interestMethod: "REDUCING", processingFeeKobo: 10_000_00, lateFeeKobo: 5_000_00, status: "ACTIVE" },
  ];
  for (const p of products) {
    await prisma.loanProduct.upsert({ where: { code: p.code }, create: p, update: p });
  }
  const staff = [
    { email: "admin@lend.local", phone: "+234800000001", role: "ADMIN" },
    { email: "credit@lend.local", phone: "+234800000002", role: "CREDIT_ANALYST" },
    { email: "finance@lend.local", phone: "+234800000003", role: "FINANCE_OFFICER" },
    { email: "collections@lend.local", phone: "+234800000004", role: "COLLECTIONS_OFFICER" },
  ];
  for (const s of staff) {
    const u = await prisma.user.upsert({ where: { email: s.email }, create: { email: s.email, phone: s.phone, passwordHash: pw, role: s.role, status: "ACTIVE" }, update: {} });
    await prisma.customerProfile.upsert({ where: { userId: u.id }, create: { userId: u.id, firstName: "Staff", lastName: s.role, monthlyIncomeKobo: 500_000_00 }, update: {} });
  }
  for (const a of [
    { code: "CASH", name: "Cash / Settlement", type: "ASSET" },
    { code: "LOAN_RECEIVABLE", name: "Loan Receivable", type: "ASSET" },
    { code: "INTEREST_INCOME", name: "Interest Income", type: "INCOME" },
    { code: "FEE_INCOME", name: "Fee Income", type: "INCOME" },
  ]) {
    await prisma.ledgerAccount.upsert({ where: { code: a.code }, create: a, update: {} });
  }
  console.log("Test seed complete");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
