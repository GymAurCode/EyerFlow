/**
 * Returns and stock adjustments.
 *
 * A return is not a negative invoice. It is a positive-amount document that
 * does the opposite thing, and it is recorded that way so the ledger can show
 * a sale and its return side by side rather than a single ambiguous figure.
 *
 * The treatments:
 *
 *  - A **credit note** reduces what the customer owes. Revenue is reversed
 *    through Sales Returns & Allowances (a debit inside income, so it reduces
 *    the period's sales rather than hiding them), the VAT is reversed out of
 *    Tax Payable, and the receivable is credited.
 *
 *  - A **purchase return** gives the stock back. The payable is debited and
 *    the inventory is credited at the cost it was bought in, so the stock
 *    leaves the balance sheet at the figure it entered it.
 *
 *  - A **stock adjustment** is a correction of the count. Stock found above
 *    the book value is other income; stock missing is an expense. Neither is
 *    a sale, and neither is a purchase.
 *
 * The cost side of a return matters as much as the revenue side: without it
 * the inventory account would keep the cost of goods that have left the
 * building, and the profit figure would be quietly wrong.
 */

import type { DocumentDto } from "../../shared/types";
import { SYSTEM_ACCOUNTS } from "./chart";
import type { EntrySpec } from "./sync";
import type { JournalLine } from "./posting";

/** The credit note: the sale, undone. */
export function returnEntrySpecs(
  document: DocumentDto,
  cashAccount: string,
): readonly EntrySpec[] {
  const grossFils = document.grossFils;
  const netFils = document.netFils;
  const vatFils = document.vatFils;
  if (grossFils <= 0) return [];

  const lines: JournalLine[] = [
    {
      accountCode: SYSTEM_ACCOUNTS.salesReturns,
      debitFils: netFils,
      description: `Goods returned ${document.number}`,
      partyId: document.partyId ?? undefined,
      documentId: document.id,
    },
  ];

  if (vatFils > 0) {
    lines.push({
      accountCode: SYSTEM_ACCOUNTS.taxPayable,
      creditFils: vatFils,
      description: "VAT reversed on the credit note",
      documentId: document.id,
    });
  }

  // The customer's balance is reduced. If they had already paid, this leaves
  // them with a credit, which is what a shop owes them and what a later
  // refund settles.
  lines.push({
    accountCode: SYSTEM_ACCOUNTS.accountsReceivable,
    creditFils: grossFils,
    description: document.number,
    partyId: document.partyId ?? undefined,
    documentId: document.id,
  });

  const specs: EntrySpec[] = [
    {
      baseKey: `creditnote:${String(document.id)}`,
      entryDate: document.issueDate,
      description: `Credit note ${document.number}`,
      source: "sale",
      lines,
    },
  ];

  // The goods come back into stock at the cost they left it.
  if (document.costFils > 0) {
    specs.push({
      baseKey: `creditnotecost:${String(document.id)}`,
      entryDate: document.issueDate,
      description: `Cost of returned goods ${document.number}`,
      source: "sale",
      lines: [
        {
          accountCode: SYSTEM_ACCOUNTS.inventory,
          debitFils: document.costFils,
          description: "Goods returned to stock",
          documentId: document.id,
        },
        {
          accountCode: SYSTEM_ACCOUNTS.costOfGoodsSold,
          creditFils: document.costFils,
          description: "Cost of goods sold reversed",
          documentId: document.id,
        },
      ],
    });
  }

  void cashAccount;
  return specs;
}

/** The purchase return: the stock goes back to the supplier. */
export function purchaseReturnEntrySpecs(document: DocumentDto): readonly EntrySpec[] {
  const grossFils = document.grossFils;
  const netFils = document.netFils;
  const vatFils = document.vatFils;
  if (grossFils <= 0) return [];

  const lines: JournalLine[] = [
    {
      accountCode: SYSTEM_ACCOUNTS.accountsPayable,
      debitFils: grossFils,
      description: `Goods returned to the supplier ${document.number}`,
      partyId: document.partyId ?? undefined,
      documentId: document.id,
    },
  ];

  if (vatFils > 0) {
    lines.push({
      accountCode: SYSTEM_ACCOUNTS.prepaidExpenses,
      creditFils: vatFils,
      description: "Recoverable VAT reversed",
      documentId: document.id,
    });
  }

  lines.push({
    accountCode: SYSTEM_ACCOUNTS.inventory,
    creditFils: netFils,
    description: `Stock returned ${document.number}`,
    documentId: document.id,
  });

  return [
    {
      baseKey: `purchasereturn:${String(document.id)}`,
      entryDate: document.issueDate,
      description: `Purchase return ${document.number}`,
      source: "purchase",
      lines,
    },
  ];
}

/**
 * A stock adjustment.
 *
 * The value of the correction is the cost of the goods, not their selling
 * price: the inventory account carries stock at cost, so the correction has
 * to be at cost too.
 */
export function stockAdjustmentEntrySpecs(
  document: DocumentDto,
  isIncrease: boolean,
): readonly EntrySpec[] {
  const costFils = Math.abs(document.costFils);
  if (costFils === 0) return [];

  const lines: JournalLine[] = isIncrease
    ? [
        {
          accountCode: SYSTEM_ACCOUNTS.inventory,
          debitFils: costFils,
          description: `Stock counted up ${document.number}`,
          documentId: document.id,
        },
        {
          accountCode: SYSTEM_ACCOUNTS.otherIncome,
          creditFils: costFils,
          description: "Stock overage",
          documentId: document.id,
        },
      ]
    : [
        {
          accountCode: SYSTEM_ACCOUNTS.miscellaneous,
          debitFils: costFils,
          description: "Stock shortage",
          documentId: document.id,
        },
        {
          accountCode: SYSTEM_ACCOUNTS.inventory,
          creditFils: costFils,
          description: `Stock counted down ${document.number}`,
          documentId: document.id,
        },
      ];

  return [
    {
      baseKey: `stock-adjustment:${String(document.id)}`,
      entryDate: document.issueDate,
      description: `Stock adjustment ${document.number}`,
      source: "adjustment",
      lines,
    },
  ];
}
