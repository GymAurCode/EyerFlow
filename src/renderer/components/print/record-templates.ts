/**
 * Documents for individual records.
 *
 * An invoice, a receipt, an expense, a journal entry: each is a business
 * document with its own shape, but they all share the same header, the same
 * typography and the same attribution, which come from the shared shell.
 */

import type {
  DocumentDto,
  ExpenseDto,
  PaymentDto,
  ProductDto,
  StockMovementDto,
} from "../../../shared/types";
import type {
  CashBookRowDto,
  JournalEntryDetailDto,
  LedgerLineDto,
  PartyStatementRowDto,
} from "../../../shared/finance";
import { formatAmount, formatQuantity } from "../../lib/format";
import { formatDate } from "../../lib/utils";
import { renderDocumentShell, renderDocumentInfo, type CompanyProfile } from "./company-document";
import { escapeHtml } from "./html";

/** A labelled row in the totals box. */
export interface TotalRow {
  readonly label: string;
  readonly value: string;
  /** The row the document adds up to. */
  readonly grand?: boolean | undefined;
}

function renderTotals(rows: readonly TotalRow[]): string {
  if (rows.length === 0) return "";
  return `
    <div class="doc-totals">
      <div class="doc-totals-box">
        ${rows
          .map(
            (row) => `
          <div class="doc-totals-row${row.grand === true ? " is-grand" : ""}">
            <span class="label">${escapeHtml(row.label)}</span>
            <span class="value">${escapeHtml(row.value)}</span>
          </div>`,
          )
          .join("")}
      </div>
    </div>`;
}

/** The status of a document, as a stamp. */
function statusStamp(status: DocumentDto["status"]): string {
  const map: Record<DocumentDto["status"], { label: string; className: string }> = {
    draft: { label: "Draft", className: "" },
    issued: { label: "Issued", className: "is-due" },
    partPaid: { label: "Part paid", className: "is-due" },
    paid: { label: "Paid", className: "is-paid" },
    cancelled: { label: "Cancelled", className: "is-cancelled" },
  };
  const entry = map[status];
  return `<span class="doc-stamp ${entry.className}">${escapeHtml(entry.label)}</span>`;
}

export interface RecordDocumentOptions {
  readonly profile: CompanyProfile;
  readonly logoDataUrl?: string | null | undefined;
  /** The moment the document was produced. */
  readonly generatedAt: Date;
}

/* -------------------------------------------------------------------------- */
/* invoice                                                                     */
/* -------------------------------------------------------------------------- */

/** A sales invoice or a purchase invoice. */
export function renderInvoiceDocument(
  document: DocumentDto,
  options: RecordDocumentOptions,
): string {
  const isPurchase = document.kind === "purchaseInvoice";
  const title = isPurchase ? "Purchase Invoice" : "Invoice";
  const partyLabel = isPurchase ? "Supplier" : "Customer";

  const lines = document.lines
    .map(
      (line) => `
        <tr>
          <td>${escapeHtml(line.description)}</td>
          <td class="num">${escapeHtml(formatQuantity(line.quantityMilli))}</td>
          <td class="num">${escapeHtml(formatAmount(line.unitPriceFils))}</td>
          <td class="num">${escapeHtml(formatAmount(line.netFils))}</td>
          <td class="num">${escapeHtml(formatAmount(line.vatFils))}</td>
          <td class="num strong">${escapeHtml(formatAmount(line.netFils + line.vatFils))}</td>
        </tr>`,
    )
    .join("");

  // The gross before discounts is the sum of the lines at their list price.
  const grossBeforeDiscount = document.netFils + document.discountFils;

  const totals: TotalRow[] = [
    { label: "Subtotal", value: formatAmount(grossBeforeDiscount) },
  ];
  if (document.discountFils > 0) {
    totals.push({ label: "Discount", value: `-${formatAmount(document.discountFils)}` });
  }
  totals.push({ label: "Net", value: formatAmount(document.netFils) });
  totals.push({ label: "VAT", value: formatAmount(document.vatFils) });
  totals.push({ label: "Total", value: formatAmount(document.grossFils), grand: true });
  totals.push({ label: "Paid", value: formatAmount(document.paidFils) });
  totals.push({ label: "Outstanding", value: formatAmount(document.outstandingFils) });

  const body = `
    <div class="doc-columns">
      <div>
        <dl class="doc-fields">
          <dt>${escapeHtml(partyLabel)}</dt>
          <dd>${escapeHtml(document.partyName ?? "—")}</dd>
          ${
            document.dueDate === null
              ? ""
              : `<dt>Due date</dt><dd>${escapeHtml(formatDate(document.dueDate))}</dd>`
          }
          ${
            document.notes === null || document.notes.trim().length === 0
              ? ""
              : `<dt>Notes</dt><dd>${escapeHtml(document.notes)}</dd>`
          }
        </dl>
      </div>
      <div>
        <dl class="doc-fields">
          <dt>Status</dt>
          <dd>${statusStamp(document.status)}</dd>
          <dt>Fiscal year</dt>
          <dd>${escapeHtml(String(document.fiscalYear))}</dd>
        </dl>
      </div>
    </div>

    <div class="doc-rule-thin"></div>

    <table>
      <thead>
        <tr>
          <th>Description</th>
          <th class="num">Qty</th>
          <th class="num">Unit price</th>
          <th class="num">Net</th>
          <th class="num">VAT</th>
          <th class="num">Total</th>
        </tr>
      </thead>
      <tbody>${lines}</tbody>
    </table>

    ${renderTotals(totals)}

    <div class="doc-signature">
      <div>${escapeHtml(isPurchase ? "Received by" : "Received by")}</div>
      <div>For ${escapeHtml(options.profile.name)}</div>
    </div>`;

  return renderDocumentShell({
    title,
    subtitle: document.number,
    profile: options.profile,
    body,
    info: renderDocumentInfo(
      [
        { label: "Document", value: document.number },
        { label: "Date", value: formatDate(document.issueDate) },
      ],
      options.generatedAt,
    ),
    footerLabel: `${title} ${document.number}`,
    footerDetail: formatDate(document.issueDate),
  });
}

/* -------------------------------------------------------------------------- */
/* receipt                                                                     */
/* -------------------------------------------------------------------------- */

/** A payment receipt or a supplier payment. */
export function renderReceiptDocument(payment: PaymentDto, options: RecordDocumentOptions): string {
  const isInbound = payment.direction === "inbound";

  const allocations = payment.allocations
    .map(
      (allocation) => `
        <tr>
          <td>${escapeHtml(allocation.documentNumber)}</td>
          <td class="num">${escapeHtml(formatAmount(allocation.amountFils))}</td>
        </tr>`,
    )
    .join("");

  const body = `
    <div class="doc-columns">
      <div>
        <dl class="doc-fields">
          <dt>${escapeHtml(isInbound ? "Received from" : "Paid to")}</dt>
          <dd>${escapeHtml(payment.partyName)}</dd>
          ${payment.reference === null ? "" : `<dt>Reference</dt><dd>${escapeHtml(payment.reference)}</dd>`}
        </dl>
      </div>
      <div>
        <dl class="doc-fields">
          <dt>Method</dt>
          <dd>${escapeHtml(payment.method.toUpperCase())}</dd>
        </dl>
      </div>
    </div>

    <div class="doc-rule-thin"></div>

    <table>
      <thead>
        <tr>
          <th>Settles</th>
          <th class="num">Amount</th>
        </tr>
      </thead>
      <tbody>${
        allocations === ""
          ? `<tr><td class="muted">On account</td><td class="num muted">—</td></tr>`
          : allocations
      }</tbody>
    </table>

    ${renderTotals([
      {
        label: isInbound ? "Received" : "Paid",
        value: formatAmount(payment.amountFils),
        grand: true,
      },
    ])}

    ${
      payment.notes === null || payment.notes.trim().length === 0
        ? ""
        : `<div class="doc-terms"><h4>Notes</h4><p>${escapeHtml(payment.notes)}</p></div>`
    }

    <div class="doc-signature">
      <div>Received by</div>
      <div>For ${escapeHtml(options.profile.name)}</div>
    </div>`;

  return renderDocumentShell({
    title: isInbound ? "Receipt" : "Payment",
    subtitle: payment.receiptNumber ?? `#${String(payment.id)}`,
    profile: options.profile,
    body,
    info: renderDocumentInfo(
      [
        {
          label: "Receipt",
          value: payment.receiptNumber ?? `#${String(payment.id)}`,
        },
        { label: "Date", value: formatDate(payment.paymentDate) },
      ],
      options.generatedAt,
    ),
    footerLabel: isInbound ? "Receipt" : "Payment",
    footerDetail: formatDate(payment.paymentDate),
  });
}

/* -------------------------------------------------------------------------- */
/* expense                                                                     */
/* -------------------------------------------------------------------------- */

/** A single expense entry. */
export function renderExpenseDocument(expense: ExpenseDto, options: RecordDocumentOptions): string {

  const body = `
    <div class="doc-columns">
      <div>
        <dl class="doc-fields">
          <dt>Payment method</dt>
          <dd>${escapeHtml(expense.paymentMethod.toUpperCase())}</dd>
        </dl>
      </div>
      <div>
        <dl class="doc-fields">
          ${expense.reference === null ? "" : `<dt>Reference</dt><dd>${escapeHtml(expense.reference)}</dd>`}
          ${expense.accountCode === null ? "" : `<dt>Account</dt><dd>${escapeHtml(expense.accountCode)}</dd>`}
          <dt>Description</dt>
          <dd>${escapeHtml(expense.description)}</dd>
        </dl>
      </div>
    </div>

    ${renderTotals([
      { label: "Amount", value: formatAmount(expense.amountFils) },
      { label: "VAT", value: formatAmount(expense.vatFils) },
      { label: "Paid", value: formatAmount(expense.paidFils) },
      {
        label: "Outstanding",
        value: formatAmount(expense.amountFils + expense.vatFils - expense.paidFils),
        grand: true,
      },
    ])}

    ${
      expense.notes === null || expense.notes.trim().length === 0
        ? ""
        : `<div class="doc-terms"><h4>Notes</h4><p>${escapeHtml(expense.notes)}</p></div>`
    }

    <div class="doc-signature">
      <div>Approved by</div>
      <div>For ${escapeHtml(options.profile.name)}</div>
    </div>`;

  return renderDocumentShell({
    title: "Expense Voucher",
    subtitle: expense.description,
    profile: options.profile,
    body,
    info: renderDocumentInfo(
      [
        { label: "Date", value: formatDate(expense.expenseDate) },
        { label: "Category", value: expense.category },
      ],
      options.generatedAt,
    ),
    footerLabel: "Expense Voucher",
    footerDetail: formatDate(expense.expenseDate),
  });
}

/* -------------------------------------------------------------------------- */
/* product                                                                     */
/* -------------------------------------------------------------------------- */

/** A product record with its stock position. */
export function renderProductDocument(product: ProductDto, options: RecordDocumentOptions): string {

  const body = `
    <div class="doc-columns">
      <div>
        <dl class="doc-fields">
          ${product.barcode === null ? "" : `<dt>Barcode</dt><dd>${escapeHtml(product.barcode)}</dd>`}
          <dt>Category</dt>
          <dd>${escapeHtml(product.category ?? "—")}</dd>
          <dt>Unit</dt>
          <dd>${escapeHtml(product.unit)}</dd>
        </dl>
      </div>
      <div>
        <dl class="doc-fields">
          <dt>VAT treatment</dt>
          <dd>${escapeHtml(product.vatTreatment)}</dd>
          <dt>Status</dt>
          <dd>${escapeHtml(product.isActive ? "Active" : "Inactive")}</dd>
          <dt>Reorder level</dt>
          <dd>${escapeHtml(formatQuantity(product.reorderLevelMilli))} ${escapeHtml(product.unit)}</dd>
        </dl>
      </div>
    </div>

    <div class="doc-rule-thin"></div>

    <table>
      <thead>
        <tr>
          <th>Measure</th>
          <th class="num">Value</th>
        </tr>
      </thead>
      <tbody>
        <tr><td>Quantity on hand</td><td class="num strong">${escapeHtml(
          `${formatQuantity(product.quantityMilli)} ${product.unit}`,
        )}</td></tr>
        <tr><td>Reference cost</td><td class="num">${escapeHtml(
          formatAmount(product.averageCostFils),
        )}</td></tr>
        <tr><td>Last purchase cost</td><td class="num">${escapeHtml(
          formatAmount(product.lastCostFils),
        )}</td></tr>
        <tr><td>Last sale price</td><td class="num">${escapeHtml(
          formatAmount(product.lastSalePriceFils),
        )}</td></tr>
        <tr><td>Stock value</td><td class="num strong">${escapeHtml(
          formatAmount(product.stockValueFils),
        )}</td></tr>
      </tbody>
    </table>

    ${
      product.description === null || product.description.trim().length === 0
        ? ""
        : `<div class="doc-terms"><h4>Description</h4><p>${escapeHtml(product.description)}</p></div>`
    }

    <div class="doc-signature">
      <div>Prepared by</div>
      <div>For ${escapeHtml(options.profile.name)}</div>
    </div>`;

  return renderDocumentShell({
    title: "Product Record",
    subtitle: product.name,
    profile: options.profile,
    body,
    info: renderDocumentInfo(
      [
        { label: "Item", value: product.name },
        { label: "Code", value: product.sku },
      ],
      options.generatedAt,
    ),
    footerLabel: "Product Record",
    footerDetail: product.sku,
  });
}

/* -------------------------------------------------------------------------- */
/* party                                                                       */
/* -------------------------------------------------------------------------- */

/** A customer or supplier record. */
export function renderPartyDocument(
  party: {
    readonly code: string;
    readonly name: string;
    readonly kind: string;
    readonly phone: string | null;
    readonly email: string | null;
    readonly trn: string | null;
    readonly addressLine: string | null;
    readonly balanceFils: number;
    readonly isActive: boolean;
  },
  options: RecordDocumentOptions,
): string {
  const isCustomer = party.kind === "customer";

  const body = `
    <div class="doc-columns">
      <div>
        <dl class="doc-fields">
          <dt>Type</dt>
          <dd>${escapeHtml(party.kind === "both" ? "Customer and supplier" : party.kind)}</dd>
          <dt>Status</dt>
          <dd>${escapeHtml(party.isActive ? "Active" : "Inactive")}</dd>
        </dl>
      </div>
      <div>
        <dl class="doc-fields">
          ${party.phone === null ? "" : `<dt>Phone</dt><dd>${escapeHtml(party.phone)}</dd>`}
          ${party.email === null ? "" : `<dt>Email</dt><dd>${escapeHtml(party.email)}</dd>`}
          ${party.trn === null ? "" : `<dt>TRN</dt><dd>${escapeHtml(party.trn)}</dd>`}
          ${party.addressLine === null ? "" : `<dt>Address</dt><dd>${escapeHtml(party.addressLine)}</dd>`}
        </dl>
      </div>
    </div>

    ${renderTotals([
      {
        label: isCustomer ? "Balance they owe" : "Balance we owe",
        value: formatAmount(party.balanceFils),
        grand: true,
      },
    ])}

    <div class="doc-signature">
      <div>Contact</div>
      <div>For ${escapeHtml(options.profile.name)}</div>
    </div>`;

  return renderDocumentShell({
    title: isCustomer ? "Customer Record" : "Supplier Record",
    subtitle: party.name,
    profile: options.profile,
    body,
    info: renderDocumentInfo(
      [
        { label: isCustomer ? "Customer" : "Supplier", value: party.name },
        { label: "Code", value: party.code },
      ],
      options.generatedAt,
    ),
    footerLabel: isCustomer ? "Customer Record" : "Supplier Record",
    footerDetail: party.code,
  });
}

/* -------------------------------------------------------------------------- */
/* journal entry                                                               */
/* -------------------------------------------------------------------------- */

/** A journal entry with its lines. */
export function renderJournalEntryDocument(
  entry: JournalEntryDetailDto,
  options: RecordDocumentOptions,
): string {

  const lines = entry.lines
    .map(
      (line) => `
        <tr>
          <td>${escapeHtml(line.accountCode)}</td>
          <td>${escapeHtml(line.accountName)}</td>
          <td>${escapeHtml(line.description ?? "—")}</td>
          <td class="num">${escapeHtml(formatAmount(line.debitFils))}</td>
          <td class="num">${escapeHtml(formatAmount(line.creditFils))}</td>
        </tr>`,
    )
    .join("");

  const body = `
    <div class="doc-columns">
      <div>
        <dl class="doc-fields">
          <dt>Source</dt>
          <dd>${escapeHtml(entry.source)}</dd>
        </dl>
      </div>
      <div>
        <dl class="doc-fields">
          <dt>Status</dt>
          <dd>${escapeHtml(entry.status)}</dd>
          ${entry.reference === null ? "" : `<dt>Reference</dt><dd>${escapeHtml(entry.reference)}</dd>`}
          ${entry.createdBy === null ? "" : `<dt>Posted by</dt><dd>${escapeHtml(entry.createdBy)}</dd>`}
        </dl>
      </div>
    </div>

    <div class="doc-rule-thin"></div>

    <table>
      <thead>
        <tr>
          <th>Account</th>
          <th>Name</th>
          <th>Description</th>
          <th class="num">Debit</th>
          <th class="num">Credit</th>
        </tr>
      </thead>
      <tbody>${lines}</tbody>
    </table>

    ${renderTotals([
      { label: "Total debit", value: formatAmount(entry.totalDebitFils) },
      { label: "Total credit", value: formatAmount(entry.totalCreditFils), grand: true },
    ])}

    <div class="doc-signature">
      <div>Prepared by</div>
      <div>Approved by</div>
    </div>`;

  return renderDocumentShell({
    title: "Journal Entry",
    subtitle: entry.entryNo,
    profile: options.profile,
    body,
    info: renderDocumentInfo(
      [
        { label: "Entry", value: entry.entryNo },
        { label: "Date", value: formatDate(entry.entryDate) },
      ],
      options.generatedAt,
    ),
    footerLabel: "Journal Entry",
    footerDetail: entry.entryNo,
  });
}

/* -------------------------------------------------------------------------- */
/* party statement                                                             */
/* -------------------------------------------------------------------------- */

/** A customer or supplier statement. */
export function renderStatementDocument(
  statement: {
    readonly partyName: string;
    readonly kind: string;
    readonly fromDate: string;
    readonly toDate: string;
    readonly openingBalanceFils: number;
    readonly rows: readonly PartyStatementRowDto[];
    readonly totalDebitFils: number;
    readonly totalCreditFils: number;
    readonly closingBalanceFils: number;
    readonly overdueFils: number;
  },
  options: RecordDocumentOptions,
): string {

  const rows = statement.rows
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(formatDate(row.entryDate))}</td>
          <td>${escapeHtml(row.entryNo)}</td>
          <td>${escapeHtml(row.documentNumber ?? row.reference ?? "—")}</td>
          <td>${escapeHtml(row.description)}</td>
          <td class="num">${escapeHtml(formatAmount(row.debitFils))}</td>
          <td class="num">${escapeHtml(formatAmount(row.creditFils))}</td>
          <td class="num strong">${escapeHtml(formatAmount(row.runningBalanceFils))}</td>
        </tr>`,
    )
    .join("");

  const body = `
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Entry</th>
          <th>Reference</th>
          <th>Description</th>
          <th class="num">Debit</th>
          <th class="num">Credit</th>
          <th class="num">Balance</th>
        </tr>
      </thead>
      <tbody>${
        rows === ""
          ? `<tr><td colspan="7" class="centre muted">No movements in this period.</td></tr>`
          : rows
      }</tbody>
    </table>

    ${renderTotals([
      { label: "Opening balance", value: formatAmount(statement.openingBalanceFils) },
      { label: "Total debits", value: formatAmount(statement.totalDebitFils) },
      { label: "Total credits", value: formatAmount(statement.totalCreditFils) },
      {
        label: "Closing balance",
        value: formatAmount(statement.closingBalanceFils),
        grand: true,
      },
    ])}

    ${
      statement.overdueFils > 0
        ? `<div class="doc-terms"><h4>Overdue</h4><p>${escapeHtml(
            `${formatAmount(statement.overdueFils)} of this balance is past its due date.`,
          )}</p></div>`
        : ""
    }

    <div class="doc-signature">
      <div>Statement prepared by</div>
      <div>For ${escapeHtml(options.profile.name)}</div>
    </div>`;

  return renderDocumentShell({
    title: "Account Statement",
    subtitle: statement.partyName,
    profile: options.profile,
    body,
    info: renderDocumentInfo(
      [
        { label: "Account", value: statement.partyName },
        {
          label: "Period",
          value: `${formatDate(statement.fromDate)} — ${formatDate(statement.toDate)}`,
        },
      ],
      options.generatedAt,
    ),
    footerLabel: "Account Statement",
    footerDetail: statement.partyName,
  });
}

/* -------------------------------------------------------------------------- */
/* general ledger                                                              */
/* -------------------------------------------------------------------------- */

/** A general ledger for one account. */
export function renderLedgerDocument(
  ledger: {
    readonly code: string;
    readonly name: string;
    readonly fromDate: string;
    readonly toDate: string;
    readonly openingBalanceFils: number;
    readonly rows: readonly LedgerLineDto[];
    readonly totalDebitFils: number;
    readonly totalCreditFils: number;
    readonly closingBalanceFils: number;
  },
  options: RecordDocumentOptions,
): string {

  const rows = ledger.rows
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(formatDate(row.entryDate))}</td>
          <td>${escapeHtml(row.entryNo)}</td>
          <td>${escapeHtml(row.description ?? row.reference ?? "—")}</td>
          <td>${escapeHtml(row.source)}</td>
          <td class="num">${escapeHtml(formatAmount(row.debitFils))}</td>
          <td class="num">${escapeHtml(formatAmount(row.creditFils))}</td>
          <td class="num strong">${escapeHtml(formatAmount(row.runningBalanceFils))}</td>
        </tr>`,
    )
    .join("");

  const body = `
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Entry</th>
          <th>Description</th>
          <th>Source</th>
          <th class="num">Debit</th>
          <th class="num">Credit</th>
          <th class="num">Balance</th>
        </tr>
      </thead>
      <tbody>${
        rows === ""
          ? `<tr><td colspan="7" class="centre muted">No movements in this period.</td></tr>`
          : rows
      }</tbody>
    </table>

    ${renderTotals([
      { label: "Opening balance", value: formatAmount(ledger.openingBalanceFils) },
      { label: "Total debits", value: formatAmount(ledger.totalDebitFils) },
      { label: "Total credits", value: formatAmount(ledger.totalCreditFils) },
      {
        label: "Closing balance",
        value: formatAmount(ledger.closingBalanceFils),
        grand: true,
      },
    ])}`;

  return renderDocumentShell({
    title: "General Ledger",
    subtitle: `${ledger.code} ${ledger.name}`,
    profile: options.profile,
    body,
    info: renderDocumentInfo(
      [
        { label: "Account", value: `${ledger.code} ${ledger.name}` },
        {
          label: "Period",
          value: `${formatDate(ledger.fromDate)} — ${formatDate(ledger.toDate)}`,
        },
      ],
      options.generatedAt,
    ),
    footerLabel: "General Ledger",
    footerDetail: `${ledger.code} ${ledger.name}`,
  });
}

/* -------------------------------------------------------------------------- */
/* cash book                                                                   */
/* -------------------------------------------------------------------------- */

/** The cash book: every movement through the till or the bank. */
export function renderCashBookDocument(
  book: {
    readonly accountCode: string;
    readonly accountName: string;
    readonly fromDate: string;
    readonly toDate: string;
    readonly openingBalanceFils: number;
    readonly rows: readonly CashBookRowDto[];
    readonly totalReceiptsFils: number;
    readonly totalPaymentsFils: number;
    readonly closingBalanceFils: number;
  },
  options: RecordDocumentOptions,
): string {

  const rows = book.rows
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(formatDate(row.entryDate))}</td>
          <td>${escapeHtml(row.entryNo)}</td>
          <td>${escapeHtml(row.description)}</td>
          <td class="num">${escapeHtml(formatAmount(row.receiptFils))}</td>
          <td class="num">${escapeHtml(formatAmount(row.paymentFils))}</td>
          <td class="num strong">${escapeHtml(formatAmount(row.balanceFils))}</td>
        </tr>`,
    )
    .join("");

  const body = `
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Entry</th>
          <th>Description</th>
          <th class="num">Receipts</th>
          <th class="num">Payments</th>
          <th class="num">Balance</th>
        </tr>
      </thead>
      <tbody>${
        rows === ""
          ? `<tr><td colspan="6" class="centre muted">No movements in this period.</td></tr>`
          : rows
      }</tbody>
    </table>

    ${renderTotals([
      { label: "Opening balance", value: formatAmount(book.openingBalanceFils) },
      { label: "Total receipts", value: formatAmount(book.totalReceiptsFils) },
      { label: "Total payments", value: formatAmount(book.totalPaymentsFils) },
      {
        label: "Closing balance",
        value: formatAmount(book.closingBalanceFils),
        grand: true,
      },
    ])}`;

  return renderDocumentShell({
    title: "Cash Book",
    subtitle: `${book.accountCode} ${book.accountName}`,
    profile: options.profile,
    body,
    info: renderDocumentInfo(
      [
        { label: "Account", value: `${book.accountCode} ${book.accountName}` },
        {
          label: "Period",
          value: `${formatDate(book.fromDate)} — ${formatDate(book.toDate)}`,
        },
      ],
      options.generatedAt,
    ),
    footerLabel: "Cash Book",
    footerDetail: `${book.accountCode} ${book.accountName}`,
  });
}

/* -------------------------------------------------------------------------- */
/* stock movements                                                             */
/* -------------------------------------------------------------------------- */

/** A stock adjustment record: the movements of one product. */
export function renderStockMovementsDocument(
  product: { readonly sku: string; readonly name: string; readonly unit: string },
  movements: readonly StockMovementDto[],
  options: RecordDocumentOptions,
): string {

  const rows = movements
    .map(
      (movement) => `
        <tr>
          <td>${escapeHtml(formatDate(movement.movementDate))}</td>
          <td>${escapeHtml(movement.kind)}</td>
          <td>${escapeHtml(movement.documentNumber ?? "—")}</td>
          <td class="num">${escapeHtml(formatQuantity(movement.quantityMilli))}</td>
          <td class="num">${escapeHtml(formatAmount(movement.unitCostFils))}</td>
          <td class="num strong">${escapeHtml(formatAmount(movement.costFils))}</td>
          <td>${escapeHtml(movement.notes ?? "—")}</td>
        </tr>`,
    )
    .join("");

  const totalValue = movements.reduce((sum, movement) => sum + movement.costFils, 0);

  const body = `
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Kind</th>
          <th>Document</th>
          <th class="num">Quantity</th>
          <th class="num">Unit cost</th>
          <th class="num">Value</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>${
        rows === ""
          ? `<tr><td colspan="7" class="centre muted">No stock movements recorded.</td></tr>`
          : rows
      }</tbody>
    </table>

    ${renderTotals([
      { label: "Movements", value: String(movements.length) },
      { label: "Total value", value: formatAmount(totalValue), grand: true },
    ])}`;

  return renderDocumentShell({
    title: "Stock Adjustment Record",
    subtitle: product.name,
    profile: options.profile,
    body,
    info: renderDocumentInfo(
      [
        { label: "Item", value: product.name },
        { label: "Code", value: product.sku },
      ],
      options.generatedAt,
    ),
    footerLabel: "Stock Adjustment Record",
    footerDetail: product.sku,
  });
}
