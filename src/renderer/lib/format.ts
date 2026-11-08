/**
 * Formatting and parsing for money and quantities.
 *
 * Money crosses the bridge as integer fils and is formatted here, in one place,
 * so every screen shows "Rs 1,234.50" rather than four different spellings.
 * Parsing goes the other way: a typed "1,234.50" must become exactly 123450
 * fils, never 123449.9999 after a float round trip.
 *
 * The application trades in Pakistani Rupees and only in Pakistani Rupees. The
 * amounts in the database are plain integers with no currency attached to them,
 * so there is nothing to convert: the money a shop recorded is the money it
 * recorded, and the label on it is simply the right one.
 */

import { type Fils, formatPkr, fromFils, toFils } from "../../domain/money";
import { type MilliQty, fromMilliQty, toMilliQty } from "../../domain/costing";

/**
 * The one currency the application supports.
 *
 * It is a single-member type rather than a plain string so that a stray
 * currency cannot be introduced by a new screen: the type will not allow one.
 */
export type Currency = "PKR";

/**
 * The locale amounts are written in.
 *
 * `en-PK` gives Western digits, comma-separated thousands and the "Rs" label.
 */
export const CURRENCY_LOCALES: Record<Currency, string> = {
  PKR: "en-PK",
};

/**
 * Format fils as an amount of money: "Rs 1,234.50".
 *
 * The currency formatter separates the symbol from the figure with a
 * non-breaking space. That is replaced with an ordinary one so the result is
 * exactly "Rs 1,234.50" everywhere - in the interface, in a PDF and in a CSV
 * cell - and so nothing has to guess what the separator is.
 */
export function formatMoney(fils: Fils): string {
  return formatPkr(fils);
}

/**
 * Format fils compactly - "Rs 9.3K".
 *
 * Only for a figure that has to fit inside a small shape, such as the middle of
 * a donut ring, where the exact amount is one hover away and a truncated
 * "Rs 9,2..." is not. Anywhere the number can be read at full length, use
 * `formatMoney`.
 */
export function formatMoneyCompact(fils: Fils): string {
  return new Intl.NumberFormat(CURRENCY_LOCALES.PKR, {
    style: "currency",
    currency: "PKR",
    notation: "compact",
    maximumFractionDigits: 1,
  })
    .format(fromFils(fils))
    .replace(/\u00A0/g, " ");
}

/**
 * Format fils without the currency symbol, for table cells and totals boxes.
 *
 * The label is added by the column or the card around it, so a column of
 * figures stays aligned.
 */
export function formatAmount(fils: Fils): string {
  return new Intl.NumberFormat(CURRENCY_LOCALES.PKR, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(fromFils(fils));
}

/**
 * Parse a typed amount into fils.
 *
 * Handles Arabic-Indic and Eastern Arabic digits as well as Western ones,
 * because a keyboard can produce either. Returns null on anything unparseable
 * so the caller can show a validation message.
 */
export function parseAmount(input: string): Fils | null {
  const normalised = toWesternDigits(input).replace(/[^\d.,-]/g, "").trim();
  if (normalised.length === 0) return null;

  // Whichever separator appears last is the decimal point; this handles both
  // "1,234.50" and "1.234,50" without guessing.
  const lastComma = normalised.lastIndexOf(",");
  const lastDot = normalised.lastIndexOf(".");

  let canonical: string;
  if (lastComma === -1 && lastDot === -1) {
    canonical = normalised;
  } else if (lastComma > lastDot) {
    canonical = `${normalised.slice(0, lastComma).replace(/[.,]/g, "")}.${normalised.slice(lastComma + 1).replace(/[.,]/g, "")}`;
  } else {
    canonical = `${normalised.slice(0, lastDot).replace(/[.,]/g, "")}.${normalised.slice(lastDot + 1).replace(/[.,]/g, "")}`;
  }

  const value = Number(canonical);
  if (!Number.isFinite(value)) return null;

  return toFils(value);
}

/** Convert Arabic-Indic digits to Western ones so `parseAmount` can read them. */
export function toWesternDigits(input: string): string {
  let output = "";
  for (const character of input) {
    const code = character.codePointAt(0) ?? 0;
    // U+0660-U+0669 (Arabic-Indic) and U+06F0-U+06F9 (Extended Arabic-Indic).
    if (code >= 0x0660 && code <= 0x0669) {
      output += String(code - 0x0660);
    } else if (code >= 0x06f0 && code <= 0x06f9) {
      output += String(code - 0x06f0);
    } else {
      output += character;
    }
  }
  return output;
}

/** Format a quantity, trimming pointless decimals (1 not 1.000). */
export function formatQuantity(milli: MilliQty): string {
  const units = fromMilliQty(milli);

  return new Intl.NumberFormat("en-PK", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  }).format(units);
}

/** Parse a typed quantity into milli-units. */
export function parseQuantity(input: string): MilliQty | null {
  const normalised = toWesternDigits(input).replace(/[^\d.,-]/g, "").trim();
  if (normalised.length === 0) return null;

  const value = Number(normalised.replace(",", "."));
  if (!Number.isFinite(value)) return null;

  return toMilliQty(value);
}

/** Round a percentage for display, e.g. gross margin 42.5%. */
export function formatPercent(value: number): string {
  return new Intl.NumberFormat("en-PK", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatFileSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${new Intl.NumberFormat("en-GB", {
    maximumFractionDigits: 1,
  }).format(value)} ${units[index] ?? "B"}`;
}
