import { describe, expect, it } from "vitest";
import {
  computeGrossProfit,
  fromMilliQty,
  stockValue,
  toMilliQty,
} from "../src/domain/costing";
import { toFils } from "../src/domain/money";

describe("quantity conversion", () => {
  it("round-trips milli-quantities", () => {
    expect(toMilliQty(2.5)).toBe(2500);
    expect(fromMilliQty(2500)).toBe(2.5);
    expect(fromMilliQty(toMilliQty(0.125))).toBe(0.125);
  });

  it("rejects a fractional milli-quantity", () => {
    expect(() => fromMilliQty(1500.5)).toThrow(TypeError);
  });
});

describe("stockValue", () => {
  it("values on-hand stock at the reference cost", () => {
    expect(stockValue({ quantityMilli: 10_000, averageUnitCostFils: 4500 })).toBe(45_000);
    expect(stockValue({ quantityMilli: 0, averageUnitCostFils: 4500 })).toBe(0);
  });
});

describe("computeGrossProfit", () => {
  it("computes profit and margin", () => {
    const result = computeGrossProfit(toFils(850), toFils(450));
    expect(result.grossProfitFils).toBe(toFils(400));
    expect(result.grossMarginPercent).toBeCloseTo(47.06, 2);
  });

  it("returns a zero margin on zero revenue rather than NaN", () => {
    expect(computeGrossProfit(0, 500).grossMarginPercent).toBe(0);
  });

  it("reports a negative margin on a loss", () => {
    const result = computeGrossProfit(1000, 1200);
    expect(result.grossProfitFils).toBe(-200);
    expect(result.grossMarginPercent).toBeCloseTo(-20, 5);
  });
});
