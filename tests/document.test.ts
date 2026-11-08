import { describe, expect, it } from "vitest";
import {
  checkPaidAmount,
  computeDocumentTotals,
  computeOutstanding,
  derivePaymentStatus,
  type DocumentLineInput,
} from "../src/domain/document";
import { toFils } from "../src/domain/money";

function line(overrides: Partial<DocumentLineInput> = {}): DocumentLineInput {
  return {
    description: "RO membrane",
    quantityMilli: 1000,
    unitPriceFils: toFils(100),
    ...overrides,
  };
}

describe("document totals", () => {
  it("rejects a document with no lines", () => {
    expect(() => computeDocumentTotals([])).toThrow(RangeError);
  });

  it("rejects a zero or fractional quantity", () => {
    expect(() => computeDocumentTotals([line({ quantityMilli: 0 })])).toThrow(/non-zero/);
    expect(() => computeDocumentTotals([line({ quantityMilli: 1500.5 })])).toThrow(/whole milli-qty/);
  });

  it("points negative quantities at the return documents", () => {
    expect(() => computeDocumentTotals([line({ quantityMilli: -1000 })])).toThrow(
      /sales return or purchase return/,
    );
  });

  it("computes a single standard-rated line", () => {
    const totals = computeDocumentTotals([line()]);
    expect(totals.grossFils).toBe(toFils(100));
    expect(totals.netFils).toBe(toFils(100));
    expect(totals.vatFils).toBe(toFils(5));
    expect(totals.totalFils).toBe(toFils(105));
  });

  it("adds several lines exactly, with no lost fils", () => {
    const totals = computeDocumentTotals([
      line({ unitPriceFils: toFils(33.33), quantityMilli: 1_000 }),
      line({ unitPriceFils: toFils(66.67), quantityMilli: 2_000 }),
      line({ unitPriceFils: toFils(12.5), quantityMilli: 1_000 }),
    ]);
    expect(totals.grossFils).toBe(toFils(33.33 + 133.34 + 12.5));
    expect(totals.totalFils).toBe(totals.netFils + totals.vatFils);
    expect(
      totals.lines.reduce((sum, l) => sum + l.lineTotalFils, 0),
    ).toBe(totals.totalFils);
  });

  it("supports fractional quantities", () => {
    const totals = computeDocumentTotals([line({ quantityMilli: 1_500, unitPriceFils: toFils(10) })]);
    expect(totals.netFils).toBe(toFils(15));
  });

  it("applies a line discount before VAT", () => {
    const totals = computeDocumentTotals([line({ discountPercent: 10 })]);
    expect(totals.discountFils).toBe(toFils(10));
    expect(totals.netFils).toBe(toFils(90));
    // 90.00 * 5% = 4.50
    expect(totals.vatFils).toBe(toFils(4.5));
    expect(totals.totalFils).toBe(toFils(94.5));
  });

  it("rejects an out-of-range line discount", () => {
    expect(() => computeDocumentTotals([line({ discountPercent: 101 })])).toThrow(/between 0 and 100/);
    expect(() => computeDocumentTotals([line({ discountPercent: -1 })])).toThrow(
      /between 0 and 100/,
    );
    expect(() => computeDocumentTotals([line({ discountPercent: Number.NaN })])).toThrow(
      /between 0 and 100/,
    );
  });

  it("rejects an out-of-range invoice discount", () => {
    expect(() =>
      computeDocumentTotals([line()], { invoiceDiscountPercent: 150 }),
    ).toThrow(/Invoice discount/);
  });

  it("keeps line sums equal to the document total after an invoice discount", () => {
    const totals = computeDocumentTotals(
      [line({ unitPriceFils: toFils(10) }), line({ unitPriceFils: toFils(20) })],
      { invoiceDiscountPercent: 10 },
    );
    expect(totals.discountFils).toBe(toFils(3));
    expect(totals.netFils).toBe(toFils(27));
    expect(totals.vatFils).toBe(toFils(1.35));
    expect(totals.totalFils).toBe(toFils(28.35));
    expect(totals.lines.reduce((sum, l) => sum + l.lineTotalFils, 0)).toBe(totals.totalFils);
  });

  it("distributes an indivisible invoice discount without losing a fil", () => {
    // 3 fils gross across three lines, 50% = 1.5 fils which rounds to 2. The
    // extra fil must land on one of the lines, never be lost or invented.
    const totals = computeDocumentTotals(
      [
        line({ unitPriceFils: 1 }),
        line({ unitPriceFils: 1 }),
        line({ unitPriceFils: 1 }),
      ],
      { invoiceDiscountPercent: 50 },
    );
    expect(totals.discountFils).toBe(2);
    expect(totals.netFils).toBe(1);
    expect(totals.lines.reduce((sum, l) => sum + l.netFils, 0)).toBe(1);
    expect(totals.lines.reduce((sum, l) => sum + l.lineTotalFils, 0)).toBe(totals.totalFils);
  });

  it("rounds a sub-fil discount down to nothing rather than losing a fil", () => {
    // 2 fils gross at 5% is 0.1 fils.
    const totals = computeDocumentTotals(
      [line({ unitPriceFils: 1 }), line({ unitPriceFils: 1 })],
      { invoiceDiscountPercent: 5 },
    );
    expect(totals.discountFils).toBe(0);
    expect(totals.netFils).toBe(2);
  });

  it("spreads a discount proportionally across lines of unequal value", () => {
    const totals = computeDocumentTotals(
      [line({ unitPriceFils: 30_000 }), line({ unitPriceFils: 10_000 })],
      { invoiceDiscountPercent: 10 },
    );
    expect(totals.discountFils).toBe(4_000);
    expect(totals.lines[0]?.netFils).toBe(27_000);
    expect(totals.lines[1]?.netFils).toBe(9_000);
    expect(totals.netFils).toBe(36_000);
  });

  it("leaves a zero-value line at zero when a discount is applied", () => {
    const totals = computeDocumentTotals(
      [
        line({ unitPriceFils: 10_000 }),
        line({ unitPriceFils: 0, description: "Free item" }),
      ],
      { invoiceDiscountPercent: 10 },
    );
    expect(totals.discountFils).toBe(1_000);
    expect(totals.lines[1]?.netFils).toBe(0);
    expect(totals.netFils).toBe(9_000);
  });

  it("keeps every line sum matching the totals across many random documents", () => {
    // Deterministic pseudo-random so a failure is reproducible.
    let seed = 20_260_301;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };

    for (let iteration = 0; iteration < 300; iteration += 1) {
      const lineCount = 1 + Math.floor(next() * 6);
      const inputs = Array.from({ length: lineCount }, () =>
        line({
          quantityMilli: 1 + Math.floor(next() * 5_000),
          unitPriceFils: Math.floor(next() * 500_000),
          unitCostFils: Math.floor(next() * 300_000),
          discountPercent: next() < 0.3 ? Math.floor(next() * 40) : 0,
        }),
      );
      const invoiceDiscountPercent = next() < 0.4 ? Math.floor(next() * 20) : 0;
      const totals = computeDocumentTotals(inputs, { invoiceDiscountPercent });

      expect(totals.lines.reduce((s, l) => s + l.lineTotalFils, 0)).toBe(totals.totalFils);
      expect(totals.lines.reduce((s, l) => s + l.netFils, 0)).toBe(totals.netFils);
      expect(totals.lines.reduce((s, l) => s + l.vatFils, 0)).toBe(totals.vatFils);
      expect(totals.netFils + totals.vatFils).toBe(totals.totalFils);
      expect(totals.grossFils - totals.discountFils).toBe(totals.netFils);
      expect(totals.netFils - totals.costFils).toBe(totals.grossProfitFils);
      expect(Number.isInteger(totals.totalFils)).toBe(true);
      for (const l of totals.lines) {
        expect(l.lineTotalFils).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("excludes zero-rated, exempt and outside-scope supplies from output VAT", () => {
    const totals = computeDocumentTotals([
      line({ unitPriceFils: toFils(100), vatTreatment: "zero" }),
      line({ unitPriceFils: toFils(100), vatTreatment: "exempt" }),
      line({ unitPriceFils: toFils(100), vatTreatment: "outsideScope" }),
    ]);
    expect(totals.vatFils).toBe(0);
    expect(totals.totalFils).toBe(toFils(300));
    expect(totals.lines.map((l) => l.vatTreatment)).toEqual([
      "zero",
      "exempt",
      "outsideScope",
    ]);
  });

  it("supports a non-standard rate", () => {
    const totals = computeDocumentTotals([line({ unitPriceFils: toFils(100), vatRate: 0 })]);
    expect(totals.vatFils).toBe(0);
    expect(totals.totalFils).toBe(toFils(100));
  });

  it("reports gross profit from the supplied cost", () => {
    const totals = computeDocumentTotals([
      line({ unitPriceFils: toFils(100), unitCostFils: toFils(60) }),
      line({ unitPriceFils: toFils(50), unitCostFils: toFils(40) }),
    ]);
    expect(totals.costFils).toBe(toFils(100));
    expect(totals.grossProfitFils).toBe(toFils(50));
  });

  it("treats a service line with no cost as zero cost", () => {
    const totals = computeDocumentTotals([
      line({ description: "Installation", unitPriceFils: toFils(80) }),
    ]);
    expect(totals.costFils).toBe(0);
    expect(totals.grossProfitFils).toBe(toFils(80));
  });

  it("scales cost with a fractional quantity", () => {
    const totals = computeDocumentTotals([
      line({ quantityMilli: 1_500, unitPriceFils: toFils(10), unitCostFils: toFils(4) }),
    ]);
    expect(totals.costFils).toBe(toFils(6));
    expect(totals.grossProfitFils).toBe(toFils(9));
  });

  it("numbers lines from one in input order", () => {
    const totals = computeDocumentTotals([
      line({ description: "First" }),
      line({ description: "Second" }),
    ]);
    expect(totals.lines.map((l) => l.lineNo)).toEqual([1, 2]);
    expect(totals.lines.map((l) => l.description)).toEqual(["First", "Second"]);
  });

  it("rejects more than 500 lines", () => {
    const lines = Array.from({ length: 501 }, () => line());
    expect(() => computeDocumentTotals(lines)).toThrow(/more than 500/);
  });
});

describe("outstanding amount", () => {
  it("reports the unpaid balance", () => {
    const result = computeOutstanding(toFils(100), toFils(30));
    expect(result.outstandingFils).toBe(toFils(70));
    expect(result.isSettled).toBe(false);
  });

  it("settles on an exact payment", () => {
    const result = computeOutstanding(toFils(100), toFils(100));
    expect(result.outstandingFils).toBe(0);
    expect(result.isSettled).toBe(true);
  });

  it("keeps a negative outstanding for an over-payment but still counts as settled", () => {
    const result = computeOutstanding(toFils(100), toFils(120));
    expect(result.outstandingFils).toBe(toFils(-20));
    expect(result.isSettled).toBe(true);
  });

  it("is outstanding when nothing has been paid", () => {
    expect(computeOutstanding(toFils(100), 0).outstandingFils).toBe(toFils(100));
  });
});

describe("paid amount ceiling", () => {
  it("accepts an amount up to the total", () => {
    const exact = checkPaidAmount(toFils(100), toFils(100));
    expect(exact.ok).toBe(true);
    expect(exact.message).toBeNull();

    const partial = checkPaidAmount(toFils(100), toFils(30));
    expect(partial.ok).toBe(true);
    expect(partial.paidFils).toBe(toFils(30));

    const none = checkPaidAmount(toFils(100), 0);
    expect(none.ok).toBe(true);
  });

  it("refuses to pay more than the total", () => {
    const result = checkPaidAmount(toFils(100), toFils(100.01));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/cannot exceed the total/i);
  });

  it("refuses a negative amount", () => {
    const result = checkPaidAmount(toFils(100), toFils(-1));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/negative/i);
  });

  it("points an over-payment at the customer's account, not at the invoice", () => {
    // The message is shown to the person typing, so it has to say where the
    // money goes instead of merely refusing.
    expect(checkPaidAmount(toFils(100), toFils(150)).message).toMatch(/account/i);
  });

  it("is the rule both dialogs and the repository share", () => {
    // Exactly one fils over is still over: there is no rounding tolerance that
    // would let an over-payment through by a fraction.
    expect(checkPaidAmount(toFils(26_500), toFils(26_500) + 1).ok).toBe(false);
    expect(checkPaidAmount(toFils(26_500), toFils(26_500)).ok).toBe(true);
  });

  it("leaves the balance at zero rather than negative once paid", () => {
    // A paid document reports nothing outstanding; the figure is floored in
    // the dialog rather than shown as a negative balance.
    expect(computeOutstanding(toFils(100), toFils(100)).outstandingFils).toBe(0);
  });
});

describe("derivePaymentStatus", () => {
  it("leaves a draft a draft regardless of payments", () => {
    expect(derivePaymentStatus("draft", toFils(100), toFils(100))).toBe("draft");
    expect(derivePaymentStatus("draft", toFils(100), 0)).toBe("draft");
  });

  it("leaves a cancelled document cancelled", () => {
    expect(derivePaymentStatus("cancelled", toFils(100), toFils(50))).toBe("cancelled");
  });

  it("is issued when nothing is paid", () => {
    expect(derivePaymentStatus("issued", toFils(100), 0)).toBe("issued");
  });

  it("is partPaid in between", () => {
    expect(derivePaymentStatus("issued", toFils(100), toFils(1))).toBe("partPaid");
    expect(derivePaymentStatus("issued", toFils(100), toFils(99.99))).toBe("partPaid");
  });

  it("is paid at or above the gross amount", () => {
    expect(derivePaymentStatus("partPaid", toFils(100), toFils(100))).toBe("paid");
    expect(derivePaymentStatus("partPaid", toFils(100), toFils(100.01))).toBe("paid");
  });
});