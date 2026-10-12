import type { KycProvider, VerifyIdentityInput, KycResult } from "./interfaces";
import { randomUUID } from "node:crypto";

/**
 * FakeKycProvider — deterministic simulation.
 * Rules (documented): idNumber ending in:
 *  - "0".."6" => VERIFIED
 *  - "7","8" => PENDING
 *  - "9" => FAILED (simulates bad identity)
 * Never calls real BVN/NIN.
 */
export class FakeKycProvider implements KycProvider {
  readonly name = "FAKE_KYC";
  async verifyIdentity(input: VerifyIdentityInput): Promise<KycResult> {
    const last = (input.idNumber.trim().slice(-1) || "0");
    const providerRef = `kyc_${randomUUID().slice(0, 8)}`;
    if (last === "9") return { status: "FAILED", providerRef, reasons: ["identity_not_matched"] };
    if (last === "7" || last === "8") return { status: "PENDING", providerRef, reasons: ["manual_document_check"] };
    if (input.firstName.length < 2 || input.lastName.length < 2)
      return { status: "FAILED", providerRef, reasons: ["name_too_short"] };
    return { status: "VERIFIED", providerRef, reasons: [] };
  }
}

export class AlwaysVerifyKycProvider implements KycProvider {
  readonly name = "FAKE_KYC_ALWAYS";
  async verifyIdentity(_input: VerifyIdentityInput): Promise<KycResult> {
    return { status: "VERIFIED", providerRef: `kyc_${randomUUID().slice(0, 8)}`, reasons: [] };
  }
}

