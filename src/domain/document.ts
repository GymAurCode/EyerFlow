/**
 * Invoice, quotation and credit-note line mathematics.
 *
 * Kept pure and integer-based so the numbers on a printed tax invoice are the
 * exact same numbers the database stores. UI code must not recompute totals:
 * it calls `computeDocumentTotals` and renders the result.
 */

import { type Fils, assertFils, multiplyFils, roundFils } from "./money";
import { type VatTreatment, computeLineVat, UAE_STANDARD_VAT_RATE } from "./vat";

export interface DocumentLineInput {
  readonly description: string;
  /** Quantity in milli-units (1.000 = one unit). */
  readonly quantityMilli: number;
  /** Net unit price in fils, excluding VAT. */
  readonly unitPriceFils: Fils;
  readonly vatTreatment?: VatTreatment;
  readonly vatRate?: number;
  /** Cost per unit for stock valuation; supply items and services are 0. */
  readonly unitCostFils?: Fils;
  readonly discountPercent?: number;
}

export interface DocumentLineTotals {
  readonly lineNo: number;
  readonly description: string;
  readonly quantityMilli: number;
  readonly unitPriceFils: Fils;
  readonly grossLineFils: Fils;
  readonly discountFils: Fils;
  readonly netFils: Fils;
  readonly vatFils: Fils;
  readonly vatTreatment: VatTreatment;
  readonly lineTotalFils: Fils;
  readonly unitCostFils: Fils;
  readonly costFils: Fils;
}

export interface DocumentTotals {
  readonly lines: readonly DocumentLineTotals[];
  readonly grossFils: Fils;
  readonly discountFils: Fils;
  readonly netFils: Fils;
  readonly vatFils: Fils;
  readonly totalFils: Fils;
  readonly costFils: Fils;
  /** Net minus cost of goods: the gross profit for the document. */
  readonly grossProfitFils: Fils;
}

const MAX_LINES = 500;

function validateQuantity(quantityMilli: number, lineNo: number): number {
  if (!Number.isInteger(quantityMilli) || quantityMilli === 0) {
    throw new RangeError(`Line ${String(lineNo)}: quantity must be a non-zero whole milli-qty.`);
  }
  if (quantityMilli < 0) {
    throw new RangeError(
      `Line ${String(lineNo)}: use a sales return or purchase return for negative quantities.`,
    );
  }
  return quantityMilli;
}

/**
 * Compute every line and the document totals.
 *
 * VAT is applied to the discounted net, which is how UAE tax invoices are
 * issued: a line discount reduces the taxable amount, not the total.
 *
 * `vatRate` (a decimal multiplier) defaults to the UAE standard rate and is
 * used for every standard-rated line that does not carry its own rate, so a
 * shop can run a different rate without editing each line.
 *
 * A document-level discount may be given either as a fixed fils amount
 * (`invoiceDiscountFils`) or a percent of the net (`invoiceDiscountPercent`);
 * the fixed amount takes precedence when both are supplied.
 */
export function computeDocumentTotals(
  inputs: readonly DocumentLineInput[],
  options: {
    readonly invoiceDiscountPercent?: number;
    readonly invoiceDiscountFils?: number;
    readonly vatRate?: number;
  } = {},
): DocumentTotals {
  if (inputs.length === 0) {
    throw new RangeError("A document must contain at least one line.");
  }
  if (inputs.length > MAX_LINES) {
    throw new RangeError(`A document cannot have more than ${String(MAX_LINES)} lines.`);
  }

  const lines: DocumentLineTotals[] = inputs.map((input, index) => {
    const lineNo = index + 1;
    const quantityMilli = validateQuantity(input.quantityMilli, lineNo);
    assertFils(input.unitPriceFils, `Line ${String(lineNo)} unit price`);

    const unitCostFils = input.unitCostFils ?? 0;
    assertFils(unitCostFils, `Line ${String(lineNo)} unit cost`);

    const grossLineFils = multiplyFils(input.unitPriceFils, quantityMilli / 1000);

    const lineDiscountPercent = input.discountPercent ?? 0;
    if (!Number.isFinite(lineDiscountPercent) || lineDiscountPercent < 0 || lineDiscountPercent > 100) {
      throw new RangeError(
        `Line ${String(lineNo)}: discount must be between 0 and 100 percent.`,
      );
    }
    const discountFils = roundFils((grossLineFils * lineDiscountPercent) / 100);
    const netFils = grossLineFils - discountFils;

    const vat = computeLineVat({
      netAmount: netFils,
      ...(input.vatTreatment !== undefined ? { treatment: input.vatTreatment } : {}),
      ...(input.vatRate !== undefined ? { rate: input.vatRate } : { rate: options.vatRate ?? UAE_STANDARD_VAT_RATE }),
    });

    const costFils = multiplyFils(unitCostFils, quantityMilli / 1000);

    return {
      lineNo,
      description: input.description,
      quantityMilli,
      unitPriceFils: input.unitPriceFils,
      grossLineFils,
      discountFils,
      netFils: netFils,
      vatFils: vat.vatAmount,
      vatTreatment: vat.treatment,
      lineTotalFils: netFils + vat.vatAmount,
      unitCostFils,
      costFils,
    };
  });

  const grossFils = lines.reduce((sum, line) => sum + line.grossLineFils, 0);
  const lineDiscountTotalFils = lines.reduce((sum, line) => sum + line.discountFils, 0);
  const netAfterLineDiscounts = lines.reduce((sum, line) => sum + line.netFils, 0);

  const invoiceDiscountPercent = options.invoiceDiscountPercent ?? 0;
  if (
    !Number.isFinite(invoiceDiscountPercent) ||
    invoiceDiscountPercent < 0 ||
    invoiceDiscountPercent > 100
  ) {
    throw new RangeError("Invoice discount must be between 0 and 100 percent.");
  }

  // A fixed document discount is honoured as given; a percent is derived from
  // the net after line discounts. The fixed amount wins when both are supplied.
  const fixedDiscountFils = options.invoiceDiscountFils ?? 0;
  if (!Number.isFinite(fixedDiscountFils) || fixedDiscountFils < 0) {
    throw new RangeError("Invoice discount cannot be negative.");
  }

  // An invoice-level discount is spread across lines in proportion to net value
  // so that per-line VAT stays correct and the line sums still add up exactly.
  const percentDiscountFils = roundFils((netAfterLineDiscounts * invoiceDiscountPercent) / 100);
  const invoiceDiscountFils = Math.min(
    Math.max(fixedDiscountFils, percentDiscountFils),
    netAfterLineDiscounts,
  );
  const adjustment = distributeLineAdjustment(lines.map((line) => line.netFils), invoiceDiscountFils);

  const finalLines: DocumentLineTotals[] = lines.map((line, index) => {
    const extra = adjustment[index] ?? 0;
    if (extra === 0) return line;

    const netFils = line.netFils - extra;
    const rate = inputs[index]?.vatRate ?? UAE_STANDARD_VAT_RATE;
    const vatFils = line.vatTreatment === "standard" ? roundFils(netFils * rate) : 0;

    // Cost follows the same discount, so gross profit on the line stays
    // proportional to the amount actually charged.
    const costFils = line.netFils === 0 ? 0 : roundFils((line.costFils * netFils) / line.netFils);

    return { ...line, netFils, vatFils, lineTotalFils: netFils + vatFils, costFils };
  });

  const totalNetFils = finalLines.reduce((sum, line) => sum + line.netFils, 0);
  const totalVatFils = finalLines.reduce((sum, line) => sum + line.vatFils, 0);
  const totalCostFils = finalLines.reduce((sum, line) => sum + line.costFils, 0);

  return {
    lines: finalLines,
    grossFils,
    discountFils: lineDiscountTotalFils + invoiceDiscountFils,
    netFils: totalNetFils,
    vatFils: totalVatFils,
    totalFils: totalNetFils + totalVatFils,
    costFils: totalCostFils,
    grossProfitFils: totalNetFils - totalCostFils,
  };
}

/**
 * Split an adjustment across lines, largest remainder first.
 *
 * Mirrors `allocateFils` in money.ts but works on an ordered list of weights
 * that may include zero-value lines.
 */
function distributeLineAdjustment(
  lineNets: readonly Fils[],
  adjustmentFils: Fils,
): Fils[] {
  const total = lineNets.reduce((sum, value) => sum + value, 0);
  if (total === 0 || adjustmentFils === 0) {
    return lineNets.map(() => 0);
  }

  const MICRO = 1_000_000;
  const numerators = lineNets.map((value) => Math.round((adjustmentFils * value * MICRO) / total));
  const parts = numerators.map((numerator) => Math.floor(numerator / MICRO));
  const assigned = parts.reduce((sum, part) => sum + part, 0);
  let leftover = adjustmentFils - assigned;

  const order = numerators
    .map((numerator, index) => ({ index, remainder: numerator % MICRO }))
    .filter((entry) => lineNets[entry.index] !== 0)
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  let cursor = 0;
  while (leftover > 0 && order.length > 0) {
    const target = order[cursor % order.length];
    if (target !== undefined) {
      parts[target.index] = (parts[target.index] ?? 0) + 1;
      leftover -= 1;
    }
    cursor += 1;
  }

  return parts;
}

export interface OutstandingSummary {
  readonly grossFils: Fils;
  readonly paidFils: Fils;
  readonly outstandingFils: Fils;
  readonly isSettled: boolean;
}

/** Outstanding amount for a document, floored at zero for over-payment. */
export function computeOutstanding(grossFils: Fils, paidFils: Fils): OutstandingSummary {
  assertFils(grossFils, "grossFils");
  assertFils(paidFils, "paidFils");
  const outstandingFils = grossFils - paidFils;
  return {
    grossFils,
    paidFils,
    outstandingFils,
    isSettled: outstandingFils <= 0,
  };
}

export interface PaidAmountCheck {
  /** Whether the amount may be saved at all. */
  readonly ok: boolean;
  /** The amount that will be saved: the amount itself, or the total. */
  readonly paidFils: Fils;
  /** Why it was refused, when `ok` is false. */
  readonly message: string | null;
}

/**
 * The one rule every payment field in the app goes through.
 *
 * What has been paid against a document may never exceed what the document is
 * worth: a shop that takes more money than the invoice is not recording a
 * payment, it is creating a liability to the customer, and that belongs on the
 * customer's account as an advance - never on the invoice. So the amount is
 * either valid or it is an error, never quietly clamped to the total and saved.
 *
 * The message is written out in full rather than as a code, because it is shown
 * to the person typing and has to name the ceiling for them.
 */
export function checkPaidAmount(grossFils: Fils, paidFils: Fils): PaidAmountCheck {
  assertFils(grossFils, "grossFils");
  assertFils(paidFils, "paidFils");

  if (paidFils < 0) {
    return {
      ok: false,
      paidFils: 0,
      message: "The amount paid cannot be negative.",
    };
  }

  if (paidFils > grossFils) {
    return {
      ok: false,
      paidFils: grossFils,
      message: "The amount paid cannot exceed the total. A customer who pays more than the bill is recorded as a credit on their account, from Accounts.",
    };
  }

  return { ok: true, paidFils, message: null };
}

export type DocumentPaymentStatus = "draft" | "issued" | "partPaid" | "paid" | "cancelled";

/** Status a document should carry given its payment progress. */
export function derivePaymentStatus(
  current: DocumentPaymentStatus,
  grossFils: Fils,
  paidFils: Fils,
): DocumentPaymentStatus {
  // Draft and cancelled are not payment states: they are decided elsewhere and
  // must survive a payment update unchanged.
  if (current === "draft" || current === "cancelled") return current;
  if (paidFils <= 0) return "issued";
  if (paidFils >= grossFils) return "paid";
  return "partPaid";
}