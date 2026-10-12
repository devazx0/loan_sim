import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const pw = await bcrypt.hash("Password123!", 10);

  // Products
  const products = [
    { code: "PERSONAL_LOAN", name: "Personal Loan", description: "Unsecured personal loan", minAmountKobo: 50_000_00, maxAmountKobo: 2_000_000_00, minTenorMonths: 3, maxTenorMonths: 12, interestRateBps: 500, interestMethod: "FLAT", processingFeeKobo: 5_000_00, lateFeeKobo: 2_500_00, status: "ACTIVE" },
    { code: "DEVICE_FINANCING", name: "Device Financing", description: "Phone/laptop financing", minAmountKobo: 20_000_00, maxAmountKobo: 500_000_00, minTenorMonths: 3, maxTenorMonths: 9, interestRateBps: 400, interestMethod: "FLAT", processingFeeKobo: 2_000_00, lateFeeKobo: 1_500_00, status: "ACTIVE" },
    { code: "BUSINESS_LOAN", name: "Business Loan", description: "SME working capital", minAmountKobo: 100_000_00, maxAmountKobo: 5_000_000_00, minTenorMonths: 3, maxTenorMonths: 18, interestRateBps: 350, interestMethod: "REDUCING", processingFeeKobo: 10_000_00, lateFeeKobo: 5_000_00, status: "ACTIVE" },
  ];
  for (const p of products) {
    await prisma.loanProduct.upsert({ where: { code: p.code }, create: p, update: p });
  }

  // Admin + staff
  const staff: { email: string; phone: string; role: string; first: string; last: string }[] = [
    { email: "admin@lend.local", phone: "+234800000001", role: "ADMIN", first: "Ada", last: "Admin" },
    { email: "credit@lend.local", phone: "+234800000002", role: "CREDIT_ANALYST", first: "Chidi", last: "Credit" },
    { email: "finance@lend.local", phone: "+234800000003", role: "FINANCE_OFFICER", first: "Funmi", last: "Finance" },
    { email: "collections@lend.local", phone: "+234800000004", role: "COLLECTIONS_OFFICER", first: "Emeka", last: "Collect" },
  ];
  for (const s of staff) {
    const u = await prisma.user.upsert({ where: { email: s.email }, create: { email: s.email, phone: s.phone, passwordHash: pw, role: s.role, status: "ACTIVE" }, update: { role: s.role } });
    await prisma.customerProfile.upsert({ where: { userId: u.id }, create: { userId: u.id, firstName: s.first, lastName: s.last, monthlyIncomeKobo: 500_000_00, obligationsKobo: 50_000_00 }, update: {} });
  }

  // Demo customers with varied risk
  const customers = [
    { email: "low.risk@lend.local", phone: "+234801000001", income: 800_000_00, oblig: 100_000_00, first: "Low", last: "Risk" },
    { email: "medium.risk@lend.local", phone: "+234801000002", income: 350_000_00, oblig: 120_000_00, first: "Med", last: "Risk" },
    { email: "high.risk@lend.local", phone: "+234801000003", income: 150_000_00, oblig: 120_000_00, first: "High", last: "Risk" },
    { email: "demo@lend.local", phone: "+234801000004", income: 600_000_00, oblig: 80_000_00, first: "Demo", last: "Customer" },
    { email: "adaeze@lend.local", phone: "+234801000005", income: 450_000_00, oblig: 60_000_00, first: "Adaeze", last: "Okafor" },
    { email: "tunji@lend.local", phone: "+234801000006", income: 300_000_00, oblig: 40_000_00, first: "Tunji", last: "Bakare" },
  ];
  for (const c of customers) {
    const u = await prisma.user.upsert({ where: { email: c.email }, create: { email: c.email, phone: c.phone, passwordHash: pw, role: "CUSTOMER", status: "ACTIVE" }, update: {} });
    await prisma.customerProfile.upsert({ where: { userId: u.id }, create: { userId: u.id, firstName: c.first, lastName: c.last, monthlyIncomeKobo: c.income, obligationsKobo: c.oblig, bankAccountRef: `acct_${c.first.toLowerCase()}`, deviceId: `dev_${c.first.toLowerCase()}` }, update: { monthlyIncomeKobo: c.income, obligationsKobo: c.oblig } });
  }

  // Ledger seed accounts
  for (const a of [
    { code: "CASH", name: "Cash / Settlement", type: "ASSET" },
    { code: "LOAN_RECEIVABLE", name: "Loan Receivable", type: "ASSET" },
    { code: "INTEREST_INCOME", name: "Interest Income", type: "INCOME" },
    { code: "FEE_INCOME", name: "Fee Income", type: "INCOME" },
  ]) {
    await prisma.ledgerAccount.upsert({ where: { code: a.code }, create: a, update: {} });
  }

  console.log("Seed complete. Demo: demo@lend.local / Password123!, admin@lend.local / Password123!");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
