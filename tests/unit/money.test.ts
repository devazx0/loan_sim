import { describe, expect, test } from "bun:test";
import {
  addMoney, subtractMoney, multiplyMoney, calculateFlatInterest,
  splitInstallments, calculateReducingInstallment, toKobo, formatNGN,
} from "../../src/common/money";
import { ValidationError } from "../../src/common/errors";

describe("money", () => {
  test("add/subtract basic", () => {
    expect(addMoney(1_000_050, 500)).toBe(1_000_550);
    expect(subtractMoney(1_000_050, 50)).toBe(1_000_000);
  });
  test("zero values", () => {
    expect(addMoney(0, 0)).toBe(0);
    expect(calculateFlatInterest(0, 500)).toBe(0);
    expect(splitInstallments(0, 3)).toEqual([0, 0, 0]);
  });
  test("rejects negatives and floats", () => {
    expect(() => addMoney(-1, 5)).toThrow(ValidationError);
    expect(() => addMoney(1.5, 2)).toThrow(ValidationError);
    expect(() => subtractMoney(5, 10)).toThrow(ValidationError);
  });
  test("multiply with rounding half-up", () => {
    expect(multiplyMoney(100, 1, 3)).toBe(33); // 33.33 -> 33
    expect(multiplyMoney(150, 1, 3)).toBe(50);
    expect(multiplyMoney(101, 1, 2)).toBe(51); // 50.5 -> 51 half-up
  });
  test("flat interest", () => {
    // ₦300,000 @ 5% = ₦15,000
    expect(calculateFlatInterest(30_000_000, 500)).toBe(1_500_000);
    expect(calculateFlatInterest(101, 500)).toBe(5); // 5.05 -> 5
  });
  test("installment split sums exactly", () => {
    for (const total of [0, 1, 100, 10_000_001, 31_500_000]) {
      for (const n of [1, 3, 6, 12]) {
        const parts = splitInstallments(total, n);
        expect(parts.length).toBe(n);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
        expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
      }
    }
  });
  test("reducing installment sane", () => {
    const inst = calculateReducingInstallment(30_000_000, 500, 6);
    expect(inst).toBeGreaterThan(Math.ceil(30_000_000 / 6));
    expect(inst).toBeLessThan(30_000_000);
    expect(calculateReducingInstallment(12_000_000, 0, 12)).toBe(1_000_000);
  });
  test("large values within strict ceiling", () => {
    const big = 2_000_000_000; // ₦20M in kobo, under the Prisma Int ceiling
    expect(addMoney(big, 100)).toBe(big + 100);
    expect(addMoney(2_147_483_647, 0)).toBe(2_147_483_647);
    expect(() => addMoney(2_147_483_647, 1)).toThrow(ValidationError);
    expect(() => addMoney(Number.MAX_SAFE_INTEGER, 0)).toThrow(ValidationError);
  });
  test("toKobo/formatNGN", () => {
    expect(toKobo(10000.5)).toBe(1_000_050);
    expect(formatNGN(1_000_050)).toContain("10,000.50");
  });
});
