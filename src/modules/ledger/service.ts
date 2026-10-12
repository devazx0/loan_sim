import type { Prisma } from "@prisma/client";
import { ValidationError } from "../../common/errors";
import { assertValidKobo } from "../../common/money";

type Tx = Prisma.TransactionClient;

async function ensureAccounts(tx: Tx) {
  const seeds = [
    { code: "CASH", name: "Cash / Settlement", type: "ASSET" },
    { code: "LOAN_RECEIVABLE", name: "Loan Receivable", type: "ASSET" },
    { code: "INTEREST_INCOME", name: "Interest Income", type: "INCOME" },
    { code: "FEE_INCOME", name: "Fee Income", type: "INCOME" },
  ];
  for (const s of seeds) {
    await tx.ledgerAccount.upsert({ where: { code: s.code }, create: s, update: {} });
  }
  const accounts = await tx.ledgerAccount.findMany({ where: { code: { in: seeds.map((s) => s.code) } } });
  const map = new Map(accounts.map((a) => [a.code, a.id]));
  return map;
}

/**
 * Post a balanced double-entry transaction. Throws if debits != credits.
 * Must be called INSIDE a business transaction.
 */
export async function postLedger(
  tx: Tx,
  input: { reference: string; type: string; description?: string; entries: { account: string; debitKobo?: number; creditKobo?: number }[] },
): Promise<number> {
  for (const e of input.entries) {
    assertValidKobo(e.debitKobo ?? 0, "debit");
    assertValidKobo(e.creditKobo ?? 0, "credit");
    if ((e.debitKobo ?? 0) > 0 && (e.creditKobo ?? 0) > 0) throw new ValidationError("Entry cannot be both debit and credit");
  }
  const debits = input.entries.reduce((s, e) => s + (e.debitKobo ?? 0), 0);
  const credits = input.entries.reduce((s, e) => s + (e.creditKobo ?? 0), 0);
  if (debits !== credits) throw new ValidationError(`Unbalanced ledger: debit ${debits} != credit ${credits}`);
  if (debits === 0) throw new ValidationError("Empty ledger transaction");
  const accounts = await ensureAccounts(tx);
  const lt = await tx.ledgerTransaction.create({ data: { reference: input.reference, type: input.type, description: input.description ?? null } });
  for (const e of input.entries) {
    const accountId = accounts.get(e.account);
    if (!accountId) throw new ValidationError(`Unknown account ${e.account}`);
    await tx.ledgerEntry.create({ data: { transactionId: lt.id, accountId, debitKobo: e.debitKobo ?? 0, creditKobo: e.creditKobo ?? 0 } });
  }
  return lt.id;
}

/** Disbursement: Debit Loan Receivable / Credit Cash. */
export async function postDisbursement(tx: Tx, reference: string, principalKobo: number) {
  return postLedger(tx, {
    reference, type: "LOAN_DISBURSEMENT", description: `Disbursement ${reference}`,
    entries: [
      { account: "LOAN_RECEIVABLE", debitKobo: principalKobo },
      { account: "CASH", creditKobo: principalKobo },
    ],
  });
}

/**
 * Repayment: Debit Cash (total) / Credit LOAN_RECEIVABLE (principal) /
 * Credit INTEREST_INCOME (interest) / Credit FEE_INCOME (fees).
 * Balanced by construction: debit total == sum of credits.
 */
export async function postRepayment(tx: Tx, reference: string, alloc: { feesKobo: number; interestKobo: number; principalKobo: number }) {
  const total = alloc.feesKobo + alloc.interestKobo + alloc.principalKobo;
  if (total <= 0) throw new ValidationError("Empty repayment");
  const entries: { account: string; debitKobo?: number; creditKobo?: number }[] = [{ account: "CASH", debitKobo: total }];
  if (alloc.principalKobo > 0) entries.push({ account: "LOAN_RECEIVABLE", creditKobo: alloc.principalKobo });
  if (alloc.interestKobo > 0) entries.push({ account: "INTEREST_INCOME", creditKobo: alloc.interestKobo });
  if (alloc.feesKobo > 0) entries.push({ account: "FEE_INCOME", creditKobo: alloc.feesKobo });
  return postLedger(tx, { reference, type: "REPAYMENT", description: `Repayment ${reference}`, entries });
}

/** Late fee accrual: Debit Loan Receivable / Credit Fee Income. Increases amount owed. */
export async function postLateFee(tx: Tx, reference: string, feeKobo: number) {
  if (feeKobo <= 0) throw new ValidationError("Empty late fee");
  return postLedger(tx, {
    reference, type: "FEE", description: `Late fee ${reference}`,
    entries: [
      { account: "LOAN_RECEIVABLE", debitKobo: feeKobo },
      { account: "FEE_INCOME", creditKobo: feeKobo },
    ],
  });
}

/** Reversal of a repayment: exact mirror of postRepayment.
 * Debit LOAN_RECEIVABLE (principal) / Debit INTEREST_INCOME (interest) /
 * Debit FEE_INCOME (fees) / Credit CASH (total).
 */
export async function postRepaymentReversal(tx: Tx, reference: string, alloc: { feesKobo: number; interestKobo: number; principalKobo: number }) {
  const total = alloc.feesKobo + alloc.interestKobo + alloc.principalKobo;
  if (total <= 0) throw new ValidationError("Empty reversal");
  const entries: { account: string; debitKobo?: number; creditKobo?: number }[] = [{ account: "CASH", creditKobo: total }];
  if (alloc.principalKobo > 0) entries.push({ account: "LOAN_RECEIVABLE", debitKobo: alloc.principalKobo });
  if (alloc.interestKobo > 0) entries.push({ account: "INTEREST_INCOME", debitKobo: alloc.interestKobo });
  if (alloc.feesKobo > 0) entries.push({ account: "FEE_INCOME", debitKobo: alloc.feesKobo });
  return postLedger(tx, { reference, type: "REVERSAL", description: `Reversal ${reference}`, entries });
}

