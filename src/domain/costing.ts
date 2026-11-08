/**
 * Inventory costing primitives.
 *
 * The costing model is "last cost, cost at sale": a purchase sets the
 * product's reference cost to the price just paid, and a sale stores the cost
 * entered on the line (cost_at_sale) which is what profit and COGS reports use.
 * No weighted average is computed. What remains here is the shared arithmetic:
 * milli-quantity conversion, stock valuation, and gross profit.
 */

import { type Fils, assertFils, roundFils } from "./money";

/**
 * Quantities are held as integer milli-units to avoid float drift on fractional
 * stock (a 0.5 L cartridge, cut-to-length tubing).
 */
export type MilliQty = number;

const MILLI = 1000;

export function toMilliQty(major: number): MilliQty {
  if (!Number.isFinite(major)) {
    throw new TypeError(`Quantity must be finite, received ${String(major)}`);
  }
  return Math.trunc(major * MILLI);
}

export function fromMilliQty(milli: MilliQty): number {
  if (!Number.isInteger(milli)) {
    throw new TypeError(`Milli-quantity must be an integer, received ${String(milli)}`);
  }
  return milli / MILLI;
}

export interface StockPosition {
  /** On-hand quantity in milli-units. */
  readonly quantityMilli: MilliQty;
  /** Reference unit cost in fils per whole unit (the last purchase cost). */
  readonly averageUnitCostFils: Fils;
}

/** Stock value on hand. */
export function stockValue(position: StockPosition): Fils {
  return roundFils((position.quantityMilli * position.averageUnitCostFils) / MILLI);
}

export interface GrossProfitResult {
  readonly revenueFils: Fils;
  readonly costOfGoodsFils: Fils;
  readonly grossProfitFils: Fils;
  readonly grossMarginPercent: number;
}

/** Gross profit for a sale, using the cost recorded on the document line. */
export function computeGrossProfit(revenueFils: Fils, costOfGoodsFils: Fils): GrossProfitResult {
  assertFils(revenueFils, "revenueFils");
  assertFils(costOfGoodsFils, "costOfGoodsFils");

  const grossProfitFils = revenueFils - costOfGoodsFils;
  const grossMarginPercent = revenueFils === 0 ? 0 : (grossProfitFils / revenueFils) * 100;

  return { revenueFils, costOfGoodsFils, grossProfitFils, grossMarginPercent };
}
