/**
 * UAE VAT (5% standard rate) calculation.
 *
 * VAT is computed per invoice line from the net amount, then summed. Computing
 * per line rather than on the invoice total means credit notes and returns can
 * reverse individual lines exactly, which is what the VAT return needs.
 */

import { type Fils, assertFils, multiplyFils, toFils } from "./money";

/** UAE standard VAT rate: 5%. Expressed as a decimal multiplier. */
export const UAE_STANDARD_VAT_RATE = 0.05;

/**
 * UAE VAT treatments.
 *
 * `standard`  - 5% output VAT, the default for goods such as purifiers, filters
 *               and spare parts.
 * `zero`      - zero-rated supplies under FTA Article 7.
 * `exempt`    - exempt supplies under FTA Article 9.
 * `outsideScope` - a supply that is neither taxable nor exempt, such as certain
 *               financial and insurance dealings under FTA Article 7(3). No VAT
 *               arises and the amount is still reported in the net figure.
 */
export type VatTreatment = "standard" | "zero" | "exempt" | "outsideScope";

export interface VatLineInput {
  /** Net (ex-VAT) amount in fils. */
  readonly netAmount: Fils;
  /** Defaults to standard (5%) when omitted. */
  readonly treatment?: VatTreatment;
  /** Overrides the standard rate for this line, as a decimal multiplier. */
  readonly rate?: number;
}

export interface VatLineResult {
  readonly netAmount: Fils;
  readonly vatAmount: Fils;
  readonly grossAmount: Fils;
  readonly treatment: VatTreatment;
  readonly appliedRate: number;
}

/**
 * VAT attributable to a single line.
 *
 * Half-up rounding at line level is deliberate: it matches how UAE tax invoices
 * are issued, and the per-line figures reconcile exactly to the invoice total.
 */
export function computeLineVat(line: VatLineInput): VatLineResult {
  assertFils(line.netAmount, "netAmount");

  const treatment: VatTreatment = line.treatment ?? "standard";
  const appliedRate = treatment === "standard" ? (line.rate ?? UAE_STANDARD_VAT_RATE) : 0;

  if (!Number.isFinite(appliedRate) || appliedRate < 0) {
    throw new RangeError(
      `VAT rate must be finite and non-negative, received ${String(appliedRate)}`,
    );
  }

  const vatAmount = multiplyFils(line.netAmount, appliedRate);
  return {
    netAmount: line.netAmount,
    vatAmount,
    grossAmount: line.netAmount + vatAmount,
    treatment,
    appliedRate,
  };
}

export interface VatSummary {
  readonly netTotal: Fils;
  readonly vatTotal: Fils;
  readonly grossTotal: Fils;
}

export function summariseVat(lines: readonly VatLineInput[]): VatSummary {
  let netTotal = 0;
  let vatTotal = 0;

  for (const line of lines) {
    const result = computeLineVat(line);
    netTotal += result.netAmount;
    vatTotal += result.vatAmount;
  }

  return { netTotal, vatTotal, grossTotal: netTotal + vatTotal };
}

/** Output and input VAT collected over a reporting period. */
export interface VatPeriodInput {
  readonly outputVat: Fils;
  readonly inputVat: Fils;
}

export interface VatPeriodTotals extends VatPeriodInput {
  readonly netPayable: Fils;
}

/**
 * Net VAT payable to the authority for a period.
 *
 * Output VAT (on sales) less input VAT (recoverable on purchases). A negative
 * result is a credit carried forward, which is valid and should be reported as
 * such rather than clamped to zero.
 */
export function computeNetVatPayable(totals: VatPeriodInput): VatPeriodTotals {
  assertFils(totals.outputVat, "outputVat");
  assertFils(totals.inputVat, "inputVat");

  return {
    outputVat: totals.outputVat,
    inputVat: totals.inputVat,
    netPayable: totals.outputVat - totals.inputVat,
  };
}

/**
 * Extract VAT from a VAT-inclusive gross amount (used when importing supplier
 * invoices from spreadsheets, which are often quoted gross).
 */
export function vatFromGross(
  grossAmount: number,
  rate: number = UAE_STANDARD_VAT_RATE,
): {
  netAmount: Fils;
  vatAmount: Fils;
} {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new RangeError(
      `Rate must be greater than zero to back out VAT, received ${String(rate)}`,
    );
  }
  const divisor = 1 + rate;
  return {
    netAmount: toFils(grossAmount / divisor),
    vatAmount: toFils(grossAmount - grossAmount / divisor),
  };
}
