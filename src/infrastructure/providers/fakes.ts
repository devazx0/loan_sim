import type { BankProvider, TransferInput, TransferResult, PaymentProvider, PaymentInput, PaymentResult, NotificationProvider, NotificationInput } from "./interfaces";
import { randomUUID } from "node:crypto";

/** FakeBankProvider: deterministic; refs ending in "FAIL" fail, "PEND" stay pending, else success. */
export class FakeBankProvider implements BankProvider {
  readonly name = "FAKE_BANK";
  private ledger = new Map<string, TransferResult>();
  async transfer(input: TransferInput): Promise<TransferResult> {
    let r: TransferResult;
    if (input.reference.endsWith("FAIL") || input.accountRef.includes("FAIL"))
      r = { status: "FAILED", providerRef: `bank_${randomUUID().slice(0, 8)}`, failureReason: "account_invalid" };
    else if (input.reference.endsWith("PEND"))
      r = { status: "PENDING", providerRef: `bank_${randomUUID().slice(0, 8)}` };
    else r = { status: "SUCCESS", providerRef: `bank_${randomUUID().slice(0, 8)}` };
    this.ledger.set(input.reference, r);
    return r;
  }
  async verifyTransfer(reference: string): Promise<TransferResult> {
    const r = this.ledger.get(reference);
    if (!r) return { status: "PENDING", providerRef: `bank_${randomUUID().slice(0, 8)}` };
    // pending resolves to success on verify (simulates async settlement)
    if (r.status === "PENDING") {
      const s: TransferResult = { status: "SUCCESS", providerRef: r.providerRef };
      this.ledger.set(reference, s);
      return s;
    }
    return r;
  }
  /** Test hook: read internal record. */
  inspect(reference: string) { return this.ledger.get(reference); }
}

/** FakePaymentProvider: refs ending FAIL fail, PEND pending, REV reversed-on-refund. */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = "FAKE_PAY";
  private ledger = new Map<string, PaymentResult>();
  private byProviderRef = new Map<string, string>(); // providerRef -> initiate reference
  async initiatePayment(input: PaymentInput): Promise<PaymentResult> {
    let r: PaymentResult;
    if (input.reference.endsWith("FAIL"))
      r = { status: "FAILED", providerRef: `pay_${randomUUID().slice(0, 8)}`, failureReason: "insufficient_funds" };
    else if (input.reference.endsWith("PEND"))
      r = { status: "PENDING", providerRef: `pay_${randomUUID().slice(0, 8)}` };
    else r = { status: "PENDING", providerRef: `pay_${randomUUID().slice(0, 8)}` };
    this.ledger.set(input.reference, r);
    this.byProviderRef.set(r.providerRef, input.reference);
    return r;
  }
  private lookup(reference: string): PaymentResult | undefined {
    return this.ledger.get(reference) ?? (this.byProviderRef.has(reference) ? this.ledger.get(this.byProviderRef.get(reference)!) : undefined);
  }
  async verifyPayment(reference: string): Promise<PaymentResult> {
    const r = this.lookup(reference);
    if (!r) return { status: "FAILED", providerRef: `pay_unknown`, failureReason: "not_found" };
    if (r.status === "PENDING" && !reference.endsWith("PEND")) {
      const s: PaymentResult = { status: "SUCCESS", providerRef: r.providerRef };
      this.ledger.set(reference, s);
      // also update canonical record
      const canon = this.byProviderRef.get(r.providerRef);
      if (canon) this.ledger.set(canon, s);
      return s;
    }
    return r;
  }
  async refundPayment(reference: string): Promise<PaymentResult> {
    const r = this.lookup(reference);
    if (!r) return { status: "FAILED", providerRef: "pay_unknown", failureReason: "not_found" };
    const s: PaymentResult = { status: "REVERSED", providerRef: r.providerRef };
    this.ledger.set(reference, s);
    const canon = this.byProviderRef.get(r.providerRef);
    if (canon) this.ledger.set(canon, s);
    return s;
  }
  /** Force-settle a reference (test/demo helper). */
  settle(reference: string, status: "SUCCESS" | "FAILED" = "SUCCESS") {
    const r = this.ledger.get(reference);
    if (r) this.ledger.set(reference, { ...r, status });
  }
}

export class FakeNotificationProvider implements NotificationProvider {
  sent: NotificationInput[] = [];
  async send(input: NotificationInput): Promise<void> {
    this.sent.push(input);
  }
}

