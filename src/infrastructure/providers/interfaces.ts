// Provider interfaces — fake impls in infrastructure/providers, real ones later.
export type KycStatus = "PENDING" | "VERIFIED" | "FAILED";
export interface VerifyIdentityInput {
  customerPublicId: string;
  firstName: string;
  lastName: string;
  dateOfBirth?: string;
  idType: "BVN" | "NIN" | "DRIVERS" | "VOTERS";
  idNumber: string;
}
export interface KycResult {
  status: KycStatus;
  providerRef: string;
  reasons: string[];
}
export interface KycProvider {
  readonly name: string;
  verifyIdentity(input: VerifyIdentityInput): Promise<KycResult>;
}

export type TransferStatus = "PENDING" | "SUCCESS" | "FAILED";
export interface TransferInput {
  reference: string;
  amountKobo: number;
  accountRef: string;
  narration: string;
}
export interface TransferResult {
  status: TransferStatus;
  providerRef: string;
  failureReason?: string;
}
export interface BankProvider {
  readonly name: string;
  transfer(input: TransferInput): Promise<TransferResult>;
  verifyTransfer(reference: string): Promise<TransferResult>;
}

export type PaymentStatus = "PENDING" | "SUCCESS" | "FAILED" | "REVERSED";
export interface PaymentInput {
  reference: string;
  amountKobo: number;
  customerRef: string;
}
export interface PaymentResult {
  status: PaymentStatus;
  providerRef: string;
  failureReason?: string;
}
export interface PaymentProvider {
  readonly name: string;
  initiatePayment(input: PaymentInput): Promise<PaymentResult>;
  verifyPayment(reference: string): Promise<PaymentResult>;
  refundPayment(reference: string): Promise<PaymentResult>;
}

export interface NotificationInput {
  channel: "EMAIL" | "SMS" | "PUSH";
  to: string;
  template: string;
  payload: Record<string, unknown>;
}
export interface NotificationProvider {
  send(input: NotificationInput): Promise<void>;
}

// Queue abstraction
export interface QueueMessage<T = unknown> {
  messageId: string;
  eventType: string;
  occurredAt: string;
  aggregateId: string;
  payload: T;
  version: number;
}
export type MessageHandler<T = unknown> = (msg: QueueMessage<T>) => Promise<void>;
export interface MessageQueue {
  publish<T>(message: QueueMessage<T>): Promise<void>;
  consume<T>(topic: string, handler: MessageHandler<T>): Promise<void>;
  pendingCount(): number;
}

// Cache abstraction (NEVER source of truth for financial state)
export interface Cache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}
