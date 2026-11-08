/**
 * The documents records print as.
 *
 * Every printable record builds its document through the shared template
 * layer, so a product record and an invoice leave the app the same way:
 * company header, the record's own data, and the attribution footer.
 *
 * Each builder returns the document as a string. The screen shows it in the
 * print dialog first and the printer receives exactly that string, so what was
 * checked is what comes out.
 */

import type { ExpenseDto, PartyDto, ProductDto, StockMovementDto } from "../../shared/types";
import type {
  CashBookDto,
  GeneralLedgerDto,
  JournalEntryDetailDto,
  PartyStatementDto,
} from "../../shared/finance";
import {
  renderCashBookDocument,
  renderExpenseDocument,
  renderJournalEntryDocument,
  renderLedgerDocument,
  renderPartyDocument,
  renderProductDocument,
  renderStatementDocument,
  renderStockMovementsDocument,
} from "../components/print/record-templates";
import { companyProfile } from "../components/print/company-document";
import type { PrintContext } from "./print";

function recordOptions(context: PrintContext): {
  profile: ReturnType<typeof companyProfile>;
  currency: PrintContext["settings"]["currency"];
  logoDataUrl: string | null | undefined;
  generatedAt: Date;
} {
  return {
    profile: companyProfile(context.settings, context.logoDataUrl),
    currency: context.settings.currency,
    logoDataUrl: context.logoDataUrl,
    generatedAt: new Date(),
  };
}

/* -------------------------------------------------------------------------- */
/* product                                                                     */
/* -------------------------------------------------------------------------- */

/** The product record as a document. */
export function productDocumentHtml(product: ProductDto, context: PrintContext): string {
  return renderProductDocument(product, recordOptions(context));
}

/* -------------------------------------------------------------------------- */
/* expense                                                                     */
/* -------------------------------------------------------------------------- */

/** The expense voucher as a document. */
export function expenseDocumentHtml(expense: ExpenseDto, context: PrintContext): string {
  return renderExpenseDocument(expense, recordOptions(context));
}

/* -------------------------------------------------------------------------- */
/* party                                                                       */
/* -------------------------------------------------------------------------- */

/** The customer or supplier record as a document. */
export function partyDocumentHtml(party: PartyDto, context: PrintContext): string {
  return renderPartyDocument(party, recordOptions(context));
}

/* -------------------------------------------------------------------------- */
/* journal entry                                                               */
/* -------------------------------------------------------------------------- */

/** The journal entry as a document. */
export function journalEntryDocumentHtml(
  entry: JournalEntryDetailDto,
  context: PrintContext,
): string {
  return renderJournalEntryDocument(entry, recordOptions(context));
}

/* -------------------------------------------------------------------------- */
/* statement                                                                   */
/* -------------------------------------------------------------------------- */

/** The account statement as a document. */
export function statementDocumentHtml(statement: PartyStatementDto, context: PrintContext): string {
  return renderStatementDocument(statement, recordOptions(context));
}

/* -------------------------------------------------------------------------- */
/* general ledger                                                              */
/* -------------------------------------------------------------------------- */

/** The general ledger as a document. */
export function ledgerDocumentHtml(ledger: GeneralLedgerDto, context: PrintContext): string {
  return renderLedgerDocument(ledger, recordOptions(context));
}

/* -------------------------------------------------------------------------- */
/* cash book                                                                   */
/* -------------------------------------------------------------------------- */

/** The cash book as a document. */
export function cashBookDocumentHtml(book: CashBookDto, context: PrintContext): string {
  return renderCashBookDocument(book, recordOptions(context));
}

/* -------------------------------------------------------------------------- */
/* stock movements                                                             */
/* -------------------------------------------------------------------------- */

/** The stock adjustment record as a document. */
export function stockMovementsDocumentHtml(
  product: { readonly sku: string; readonly name: string; readonly unit: string },
  movements: readonly StockMovementDto[],
  context: PrintContext,
): string {
  return renderStockMovementsDocument(product, movements, recordOptions(context));
}
