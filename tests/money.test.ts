import { describe, expect, it } from "vitest";
import {
  allocateFils,
  assertFils,
  fromFils,
  isFils,
  multiplyFils,
  roundFils,
  sumFils,
  toFils,
} from "../src/domain/money";

describe("money primitives", () => {
  describe("toFils / fromFils", () => {
    it("converts major units to fils", () => {
      expect(toFils(12.34)).toBe(1234);
      expect(toFils(0)).toBe(0);
      expect(toFils(1000)).toBe(100_000);
    });

    it("rounds half away from zero in both directions", () => {
      expect(toFils(0.005)).toBe(1);
      expect(toFils(0.015)).toBe(2);
      // The float-representation trap: 1.005 is actually 1.00499... in binary.
      expect(toFils(1.005)).toBe(101);
      expect(toFils(2.675)).toBe(268);
    });

    it("rounds negative halves away from zero, not toward it", () => {
      // Math.round would give -0 here, silently losing a fil on a credit.
      expect(toFils(-0.005)).toBe(-1);
      expect(toFils(-0.015)).toBe(-2);
      expect(toFils(-12.345)).toBe(-1235);
    });

    it("round-trips through fils without drift", () => {
      for (const value of [0, 1, 99.99, 1234.56, 999_999.99]) {
        expect(fromFils(toFils(value))).toBeCloseTo(value, 2);
      }
    });

    it("rejects non-finite input", () => {
      expect(() => toFils(Number.NaN)).toThrow(TypeError);
      expect(() => toFils(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    });
  });

  describe("isFils / assertFils", () => {
    it("accepts only safe integers", () => {
      expect(isFils(0)).toBe(true);
      expect(isFils(-1500)).toBe(true);
      expect(isFils(10.5)).toBe(false);
      expect(isFils(Number.NaN)).toBe(false);
      expect(isFils("100")).toBe(false);
    });

    it("assertFils throws a labelled error", () => {
      expect(() => assertFils(1.5, "netAmount")).toThrow(/netAmount must be an integer/);
    });
  });

  describe("sumFils", () => {
    it("adds exactly with no float drift", () => {
      expect(sumFils([10, 20])).toBe(30);
      expect(sumFils([])).toBe(0);
      expect(sumFils([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(55);
    });

    it("rejects a fractional amount", () => {
      expect(() => sumFils([10, 0.5])).toThrow(TypeError);
    });
  });

  describe("multiplyFils", () => {
    it("handles whole quantities", () => {
      expect(multiplyFils(2500, 4)).toBe(10_000);
    });

    it("handles fractional quantities half-up in both directions", () => {
      expect(multiplyFils(100, 0.5)).toBe(50);
      expect(multiplyFils(333, 0.5)).toBe(167);
      expect(multiplyFils(-333, 0.5)).toBe(-167);
    });

    it("rejects a non-finite quantity", () => {
      expect(() => multiplyFils(100, Number.NaN)).toThrow(TypeError);
    });
  });

  describe("allocateFils", () => {
    it("always sums back to the input", () => {
      const cases: readonly [number, readonly number[]][] = [
        [100, [49, 49]],
        [101, [49, 49]],
        [1, [49, 49]],
        [999_999, [49, 49]],
        [10_000, [1, 1, 1, 1, 1, 1, 1]],
      ];
      for (const [total, weights] of cases) {
        const parts = allocateFils(total, weights);
        expect(parts.reduce((sum, part) => sum + part, 0)).toBe(total);
      }
    });

    it("splits an odd fils between equal partners without losing it", () => {
      const parts = allocateFils(101, [49, 49]);
      expect(parts.reduce((sum, part) => sum + part, 0)).toBe(101);
      expect(parts).toEqual([51, 50]);
    });

    it("preserves the negative sign and still balances", () => {
      const parts = allocateFils(-101, [49, 49]);
      expect(parts.reduce((sum, part) => sum + part, 0)).toBe(-101);
      expect(parts.every((part) => part <= 0)).toBe(true);
    });

    it("gives a zero weight nothing", () => {
      const parts = allocateFils(1000, [0, 50, 50]);
      expect(parts[0]).toBe(0);
      expect(parts.reduce((sum, part) => sum + part, 0)).toBe(1000);
    });

    it("returns nothing for a zero total with no weights", () => {
      expect(allocateFils(0, [])).toEqual([]);
    });

    it("rejects invalid weights", () => {
      expect(() => allocateFils(100, [-1, 2])).toThrow(RangeError);
      expect(() => allocateFils(100, [0, 0])).toThrow(RangeError);
      expect(() => allocateFils(100, [])).toThrow(RangeError);
      expect(() => allocateFils(100, [Number.NaN, 1])).toThrow(RangeError);
    });
  });

  describe("roundFils", () => {
    it("rounds halves away from zero", () => {
      expect(roundFils(4999.5)).toBe(5000);
      expect(roundFils(-4999.5)).toBe(-5000);
      expect(roundFils(0.4)).toBe(0);
      expect(roundFils(0.5)).toBe(1);
    });

    it("leaves exact integers untouched", () => {
      expect(roundFils(105)).toBe(105);
      expect(roundFils(-105)).toBe(-105);
    });

    it("rejects non-finite input", () => {
      expect(() => roundFils(Number.NaN)).toThrow(TypeError);
    });
  });
});
