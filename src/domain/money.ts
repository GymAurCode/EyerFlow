/**
 * Money primitives for the retail/distribution app.
 *
 * All monetary amounts are integer minor units ("fils", 1 Rs = 100 fils).
 * Floating point is never used for stored or arithmetic money values, which
 * removes the classic 0.1 + 0.2 problems from VAT and profit reporting.
 */

export type Fils = number;

/** Numeric guard for stored money: integer, finite, within safe range. */
export function isFils(value: unknown): value is Fils {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    Math.abs(value) <= Number.MAX_SAFE_INTEGER
  );
}

/** Assert a value is a valid fils amount, throwing on violation. */
export function assertFils(value: unknown, label = "amount"): asserts value is Fils {
  if (!isFils(value)) {
    throw new TypeError(`${label} must be an integer number of fils, received ${String(value)}`);
  }
}

/** Fils in one rupee. The Pakistani rupee has two decimal places. */
const FILS_PER_RUPEE = 100;

/**
 * Convert a major-unit value (e.g. Rs 12.34) to fils.
 *
 * Uses half-up rounding on the absolute value then restores the sign, so
 * -0.005 rounds to -0.01 rather than -0.00. JS `Math.round` biases negatives
 * toward zero, which would silently under-state credits and refunds.
 */
export function toFils(major: number): Fils {
  if (!Number.isFinite(major)) {
    throw new TypeError(`Cannot convert non-finite value to fils: ${String(major)}`);
  }
  const scaled = major * FILS_PER_RUPEE;
  const rounded =
    Math.sign(scaled) * Math.round(Math.abs(scaled) + Number.EPSILON * Math.abs(scaled));
  return Math.trunc(rounded);
}

/** Convert fils back to a major-unit number, for display and PDF rendering. */
export function fromFils(fils: Fils): number {
  assertFils(fils, "fils");
  return fils / FILS_PER_RUPEE;
}

/**
 * Round a fils-valued result half away from zero.
 *
 * Used wherever a computation produces a fractional fil (cost averaging, COGS
 * on a fractional unit) so intermediate rounding matches `toFils` rather than
 * silently truncating and losing half a fil per movement.
 */
export function roundFils(value: number): Fils {
  if (!Number.isFinite(value)) {
    throw new TypeError(`Cannot round non-finite value: ${String(value)}`);
  }
  return Math.trunc(Math.sign(value) * Math.round(Math.abs(value)));
}

export function sumFils(values: readonly Fils[]): Fils {
  return values.reduce<Fils>((total, value) => {
    assertFils(value, "value");
    return total + value;
  }, 0);
}

/** Multiply fils by a whole-unit quantity, half-up rounding. */
export function multiplyFils(fils: Fils, quantity: number): Fils {
  assertFils(fils, "fils");
  if (!Number.isFinite(quantity)) {
    throw new TypeError(`Quantity must be finite, received ${String(quantity)}`);
  }
  return roundFils(fils * quantity);
}

/**
 * Split an amount across weights so the parts sum exactly back to the input.
 *
 * Used for VAT line allocation and partner profit splits. The largest
 * fractional remainders receive the leftover fils, which keeps reports
 * internally consistent instead of drifting by a few fils per period.
 */
export function allocateFils(total: Fils, weights: readonly number[]): Fils[] {
  assertFils(total, "total");
  if (weights.length === 0) {
    if (total === 0) return [];
    throw new RangeError("Cannot allocate a non-zero amount across zero weights");
  }
  for (const weight of weights) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new RangeError(`Weights must be finite and non-negative, received ${String(weight)}`);
    }
  }

  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  if (weightTotal <= 0) {
    throw new RangeError("Sum of weights must be greater than zero");
  }

  const sign = Math.sign(total) || 1;
  const magnitude = Math.abs(total);

  // Work in integer micro-fils so remainders can be compared exactly without
  // reintroducing float drift.
  const MICRO = 1_000_000;
  const exactNumerators = weights.map((weight) =>
    Math.round((magnitude * weight * MICRO) / weightTotal),
  );
  const baseParts = exactNumerators.map((numerator) => Math.floor(numerator / MICRO));

  const assigned = baseParts.reduce((sum, part) => sum + part, 0);
  let leftover = magnitude - assigned;

  const remainderOrder = exactNumerators
    .map((numerator, index) => ({ index, remainder: numerator % MICRO }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  const parts = [...baseParts];
  let cursor = 0;
  while (leftover > 0 && remainderOrder.length > 0) {
    const target = remainderOrder[cursor % remainderOrder.length];
    if (target !== undefined) {
      parts[target.index] = (parts[target.index] ?? 0) + 1;
      leftover -= 1;
    }
    cursor += 1;
  }

  return parts.map((part) => sign * part);
}

/**
 * Format fils as an amount of money: "Rs 1,500.00".
 *
 * This is the one place an amount of money is written out, so the interface,
 * the printed documents, the exports and the messages the server sends all
 * say the same thing.
 *
 * The currency formatter separates the symbol from the figure with a
 * non-breaking space. That is replaced with an ordinary one so the result is
 * exactly "Rs 1,500.00" everywhere - in the interface, in a PDF and in a CSV
 * cell - and so nothing has to guess what the separator is.
 */
export function formatPkr(fils: Fils): string {
  assertFils(fils, "fils");

  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
    .format(fromFils(fils))
    .replace(/\u00A0/g, " ");
}

