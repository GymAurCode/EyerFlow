import { describe, expect, it } from "vitest";
import {
  UAE_STANDARD_VAT_RATE,
  computeLineVat,
  computeNetVatPayable,
  summariseVat,
  vatFromGross,
} from "../src/domain/vat";
import { toFils } from "../src/domain/money";

describe("VAT calculation (UAE 5%)", () => {
  it("applies the standard rate by default", () => {
    const result = computeLineVat({ netAmount: toFils(100) });
    expect(result.vatAmount).toBe(toFils(5));
    expect(result.grossAmount).toBe(toFils(105));
    expect(result.appliedRate).toBe(UAE_STANDARD_VAT_RATE);
  });

  it("computes VAT on a net amount, not on the gross", () => {
    // The classic error is charging 5% on 105 instead of 100.
    const result = computeLineVat({ netAmount: 10_500 });
    expect(result.vatAmount).toBe(525);
    expect(result.grossAmount).toBe(11_025);
  });

  it("rounds half-up at line level", () => {
    // 33.50 net -> 1.675 VAT -> 1.68
    expect(computeLineVat({ netAmount: 3350 }).vatAmount).toBe(168);
    // 10.01 net -> 0.5005 -> 0.50
    expect(computeLineVat({ netAmount: 1001 }).vatAmount).toBe(50);
    // 19.99 net -> 0.9995 -> 1.00
    expect(computeLineVat({ netAmount: 1999 }).vatAmount).toBe(100);
  });

  it("produces no VAT for zero-rated and exempt lines", () => {
    for (const treatment of ["zero", "exempt"] as const) {
      const result = computeLineVat({ netAmount: 10_000, treatment });
      expect(result.vatAmount).toBe(0);
      expect(result.grossAmount).toBe(10_000);
      expect(result.appliedRate).toBe(0);
    }
  });

  it("supports a custom rate per line", () => {
    const result = computeLineVat({ netAmount: 10_000, rate: 0.1 });
    expect(result.vatAmount).toBe(1000);
  });

  it("handles negative net amounts for credit notes", () => {
    const result = computeLineVat({ netAmount: -10_000 });
    expect(result.vatAmount).toBe(-500);
    expect(result.grossAmount).toBe(-10_500);
  });

  it("rejects a negative rate", () => {
    expect(() => computeLineVat({ netAmount: 100, rate: -0.05 })).toThrow(RangeError);
  });

  describe("summariseVat", () => {
    it("sums per-line VAT so the total reconciles to the lines", () => {
      const summary = summariseVat([
        { netAmount: toFils(100) },
        { netAmount: toFils(250.5) },
        { netAmount: toFils(80), treatment: "zero" },
      ]);

      expect(summary.netTotal).toBe(toFils(430.5));
      expect(summary.vatTotal).toBe(toFils(5) + toFils(12.525) + 0);
      expect(summary.grossTotal).toBe(summary.netTotal + summary.vatTotal);
    });

    it("is zero for no lines", () => {
      expect(summariseVat([])).toEqual({ netTotal: 0, vatTotal: 0, grossTotal: 0 });
    });
  });

  describe("computeNetVatPayable", () => {
    it("nets output against input VAT", () => {
      expect(computeNetVatPayable({ outputVat: 5000, inputVat: 2000 }).netPayable).toBe(3000);
    });

    it("reports a credit as negative rather than clamping to zero", () => {
      // A refundable position is legitimate and must appear on the return.
      const result = computeNetVatPayable({ outputVat: 1000, inputVat: 4500 });
      expect(result.netPayable).toBe(-3500);
    });

    it("is zero when input and output match", () => {
      expect(computeNetVatPayable({ outputVat: 750, inputVat: 750 }).netPayable).toBe(0);
    });
  });

  describe("vatFromGross", () => {
    it("extracts VAT from a gross amount as quoted on supplier invoices", () => {
      const result = vatFromGross(105);
      expect(result.netAmount).toBe(toFils(100));
      expect(result.vatAmount).toBe(toFils(5));
    });

    it("keeps net plus vat equal to the gross", () => {
      for (const gross of [105, 12.5, 999.99, 1.05]) {
        const result = vatFromGross(gross);
        expect(result.netAmount + result.vatAmount).toBe(toFils(gross));
      }
    });

    it("rejects a non-positive rate", () => {
      expect(() => vatFromGross(105, 0)).toThrow(RangeError);
    });
  });
});
