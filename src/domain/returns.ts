/**
 * Sales returns / credit notes and purchase returns / debit notes.
 *
 * The critical property here is reversibility: a return must undo exactly what
 * the original document did, including VAT direction and the cost booked to
 * stock. Credit note numbers are sequential and gap-free per fiscal year, which
 * UAE tax authorities expect for a registered issuer.
 */

import { type Fils, assertFils, multiplyFils } from "./money";
import { type VatTreatment, computeLineVat, UAE_STANDARD_VAT_RATE } from "./vat";

/**
 * Format a sequential document number such as `CN-0001` / `INV-0042`.
 *
 * Sequential rather than random: tax invoice series must be continuous for
 * audit, and a gap invites questions that cost time at filing time.
 */
export function formatSequentialNumber(prefix: string, sequence: number, padWidth = 4): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new RangeError(`Sequence must be a positive integer, received ${String(sequence)}`);
  }
  if (!/^[A-Z][A-Z0-9]{0,9}$/.test(prefix)) {
    throw new RangeError(
      `Prefix must be 1-10 uppercase alphanumeric characters, received ${JSON.stringify(prefix)}`,
    );
  }
  return `${prefix}-${String(sequence).padStart(padWidth, "0")}`;
}

export type DocumentKind =
  | "invoice"
  | "quotation"
  | "deliveryNote"
  | "creditNote"
  | "purchaseInvoice"
  | "purchaseReturn"
  | "stockAdjustment";

export const DOCUMENT_PREFIXES: Readonly<Record<DocumentKind, string>> = {
  invoice: "INV",
  quotation: "QUO",
  deliveryNote: "DN",
  creditNote: "CN",
  purchaseInvoice: "PINV",
  purchaseReturn: "PR",
  stockAdjustment: "ADJ",
};

/** Next number in a per-year series. `lastUsed` of 0 starts the series at 1. */
export function nextDocumentNumber(kind: DocumentKind, lastUsed: number, padWidth = 4): string {
  return formatSequentialNumber(DOCUMENT_PREFIXES[kind], lastUsed + 1, padWidth);
}

export interface ReturnLineInput {
  /** Quantity being returned, in major units. */
  readonly quantity: number;
  /** Net amount per unit being returned, in fils. */
  readonly unitNetFils: Fils;
  readonly treatment?: VatTreatment;
  readonly rate?: number;
}

export interface ReturnLineResult {
  readonly netAmount: Fils;
  readonly vatAmount: Fils;
  readonly grossAmount: Fils;
}

/**
 * Value a sales return / credit note line.
 *
 * VAT is positive in magnitude here and reversed by the caller (output VAT
 * decreases by this amount). Keeping the sign decision at the posting layer
 * stops one sign error from silently inflating a VAT return.
 */
export function valueSalesReturnLine(line: ReturnLineInput): ReturnLineResult {
  if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
    throw new RangeError(
      `Return quantity must be greater than zero, received ${String(line.quantity)}`,
    );
  }
  assertFils(line.unitNetFils, "unitNetFils");

  const netAmount = multiplyFils(line.unitNetFils, line.quantity);
  const result = computeLineVat({
    netAmount,
    ...(line.treatment !== undefined ? { treatment: line.treatment } : {}),
    ...(line.rate !== undefined ? { rate: line.rate } : {}),
  });

  return { netAmount, vatAmount: result.vatAmount, grossAmount: result.grossAmount };
}

export interface PurchaseReturnResult {
  /** Cost value of goods leaving stock, in fils. */
  readonly costValueFils: Fils;
  /** Input VAT to be reclaimed, in fils. */
  readonly inputVatFils: Fils;
  /** Amount owed back by the supplier. */
  readonly creditAmountFils: Fils;
}

/**
 * Value a purchase return against the supplier.
 *
 * The credit is raised at the supplier's invoiced price (which is what is being
 * recovered from them), while input VAT is reversed by the same proportion so
 * the VAT position stays consistent.
 */
export function valuePurchaseReturn(
  netAmountFils: Fils,
  quantity: number,
  costValueFils: Fils,
  treatment: VatTreatment = "standard",
  rate: number = UAE_STANDARD_VAT_RATE,
): PurchaseReturnResult {
  assertFils(netAmountFils, "netAmountFils");
  assertFils(costValueFils, "costValueFils");
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new RangeError(`Return quantity must be greater than zero, received ${String(quantity)}`);
  }

  const vat = computeLineVat({
    netAmount: netAmountFils,
    treatment,
    rate: treatment === "standard" ? rate : 0,
  });

  return {
    costValueFils,
    inputVatFils: vat.vatAmount,
    creditAmountFils: vat.grossAmount,
  };
}

export interface ReturnEligibility {
  readonly eligible: boolean;
  readonly reason?: string;
}

/**
 * Guard against returning more than was invoiced.
 *
 * Without this check a mistyped quantity can credit a customer more than they
 * paid, which is a real cash-loss risk on a busy counter.
 */
export function checkReturnQuantity(
  returnedQuantity: number,
  originalInvoicedQuantity: number,
  alreadyReturnedQuantity: number,
  tolerance = 1e-9,
): ReturnEligibility {
  if (!Number.isFinite(returnedQuantity) || returnedQuantity <= 0) {
    return { eligible: false, reason: "Return quantity must be greater than zero." };
  }

  const remaining = originalInvoicedQuantity - alreadyReturnedQuantity;
  if (remaining <= tolerance) {
    return { eligible: false, reason: "Nothing remains to return on this invoice." };
  }

  if (returnedQuantity - remaining > tolerance) {
    return {
      eligible: false,
      reason: `Return quantity exceeds the remaining returnable quantity of ${remaining}.`,
    };
  }

  return { eligible: true };
}

/**
 * Credit note number for a fiscal year, continuing the sequence across the
 * previous year's final count so the issuer series never restarts.
 */
export function creditNoteNumberForYear(sequence: number, padWidth = 4): string {
  return formatSequentialNumber(DOCUMENT_PREFIXES.creditNote, sequence, padWidth);
}
