/**
 * The report catalogue.
 *
 * Each function turns the data the app already has into a `ReportDocument`.
 * Nothing here queries the database or formats money by hand: the figures come
 * from the same services the screens use, and the formatting comes from the
 * shared formatters, so a report can never disagree with the page it was
 * generated from.
 */

import type {
  DocumentRegisterRow,
  ExpenseDto,
  PartnerSplitDto,
  ProductDto,
  ProfitAndLossDto,
  StockValuationRow,
} from "../../../shared/types";
import type {
  AgingDto,
  BalanceSheetDto,
  CashFlowDto,
  PeriodComparisonDto,
  ProfitLossDto,
  ReportSectionDto,
  TrialBalanceDto,
} from "../../../shared/finance";
import { formatAmount, formatPercent, formatQuantity } from "../../lib/format";
import { formatDate } from "../../lib/utils";
import { cell, type ReportDocument, type ReportSection } from "./report-document";

/** A period, already formatted for the document. */
export function periodLabel(fromDate: string, toDate: string): string {
  return `${formatDate(fromDate)} — ${formatDate(toDate)}`;
}

function statusLabel(status: DocumentRegisterRow["status"]): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "issued":
      return "Issued";
    case "partPaid":
      return "Part paid";
    case "paid":
      return "Paid";
    case "cancelled":
      return "Cancelled";
  }
}

/* -------------------------------------------------------------------------- */
/* profit and loss                                                             */
/* -------------------------------------------------------------------------- */

export function profitAndLossReport(data: ProfitAndLossDto): ReportDocument {
  const sections: ReportSection[] = [
    {
      title: "Profit and loss",
      columns: [{ header: "Line" }, { header: "Amount", align: "end" }],
      rows: [
        [
          cell("Revenue", { strong: true }),
          cell(formatAmount(data.revenueFils), { align: "end" }),
        ],
        [
          cell("Cost of goods sold"),
          cell(formatAmount(data.costOfGoodsFils), { align: "end", tone: "negative" }),
        ],
        [
          cell("Gross profit", { strong: true }),
          cell(formatAmount(data.grossProfitFils), { align: "end", strong: true }),
        ],
        [
          cell("Gross margin"),
          cell(`${formatPercent(data.grossMarginPercent)}%`, { align: "end" }),
        ],
        [
          cell("Operating expenses"),
          cell(formatAmount(data.operatingExpensesFils), {
            align: "end",
            tone: "negative",
          }),
        ],
      ],
      totals: [
        cell("Net profit"),
        cell(formatAmount(data.netProfitFils), { align: "end" }),
      ],
      emptyMessage: "No trading activity in this period.",
    },
  ];

  if (data.expensesByCategory.length > 0) {
    sections.push({
      title: "Expenses by category",
      columns: [{ header: "Category" }, { header: "Amount", align: "end" }],
      rows: data.expensesByCategory.map((row) => [
        cell(row.category),
        cell(formatAmount(row.amountFils), { align: "end" }),
      ]),
      totals: [
        cell("Total expenses"),
        cell(formatAmount(data.operatingExpensesFils), { align: "end" }),
      ],
      emptyMessage: "No expenses recorded in this period.",
    });
  }

  return {
    title: "Profit and Loss",
    subtitle: "Trading performance for the period",
    period: periodLabel(data.fromDate, data.toDate),
    generatedAt: new Date(),
    orientation: "portrait",
    metrics: [
      { label: "Revenue", value: formatAmount(data.revenueFils) },
      { label: "Gross profit", value: formatAmount(data.grossProfitFils) },
      { label: "Gross margin", value: `${formatPercent(data.grossMarginPercent)}%` },
      { label: "Operating expenses", value: formatAmount(data.operatingExpensesFils) },
      {
        label: "Net profit",
        value: formatAmount(data.netProfitFils),
        emphasis: true,
        tone: data.netProfitFils < 0 ? "negative" : "positive",
      },
    ],
    sections,
  };
}

/* -------------------------------------------------------------------------- */
/* partner split                                                               */
/* -------------------------------------------------------------------------- */

export function partnerSplitReport(data: PartnerSplitDto): ReportDocument {
  const total =
    data.partners.reduce((sum, partner) => sum + partner.amountFils, 0) + data.donationFils;

  // The percentages are percentages of the net profit, so they add up to 100%
  // between them - the donation and every partner's share. Showing the total
  // that was actually allocated, rather than a hard-coded 100%, keeps the
  // report honest if a partnership is ever configured differently.
  const totalPercent =
    data.donationRatePercent +
    data.partners.reduce((sum, partner) => sum + partner.sharePercent, 0);

  const rows = [
    [
      cell(`Donation (${formatPercent(data.donationRatePercent)}%)`),
      cell(`${formatPercent(data.donationRatePercent)}%`, { align: "end" }),
      cell(formatAmount(data.donationFils), { align: "end" }),
    ],
    ...data.partners.map((partner) => [
      cell(partner.name, { strong: true }),
      cell(`${formatPercent(partner.sharePercent)}%`, { align: "end" }),
      cell(formatAmount(partner.amountFils), { align: "end" }),
    ]),
  ];

  return {
    title: "Partner Split",
    subtitle: "How the net profit is distributed",
    period: periodLabel(data.fromDate, data.toDate),
    generatedAt: new Date(),
    orientation: "portrait",
    metrics: [
      { label: "Net profit", value: formatAmount(data.netProfitFils) },
      {
        label: "Donation",
        value: formatAmount(data.donationFils),
        tone: "negative",
      },
      {
        label: "Distributable",
        value: formatAmount(data.distributableFils),
        emphasis: true,
      },
    ],
    sections: [
      {
        title: "Distribution",
        columns: [
          { header: "Partner" },
          { header: "Share", align: "end" },
          { header: "Amount", align: "end" },
        ],
        rows,
        totals: [
          cell("Total"),
          cell(`${formatPercent(totalPercent)}%`, { align: "end" }),
          cell(formatAmount(total), { align: "end" }),
        ],
        emptyMessage:
          "No partners are configured, or the period made no profit. Add partners in Settings → Tax & Partners.",
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* sales and purchases                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The invoice register: one row per invoice.
 *
 * Sales and purchases share the shape and differ only in the wording and the
 * party column, so they are one function with the labels passed in.
 */
export function documentRegisterReport(
  options: {
    readonly title: string;
    readonly subtitle: string;
    readonly partyHeader: string;
    readonly numberHeader: string;
    readonly rows: readonly DocumentRegisterRow[];
    readonly fromDate: string;
    readonly toDate: string;
  },
): ReportDocument {
  const rows = options.rows;

  const totals = rows.reduce(
    (sum, row) => ({
      net: sum.net + row.netFils,
      vat: sum.vat + row.vatFils,
      gross: sum.gross + row.grossFils,
      paid: sum.paid + row.paidFils,
      outstanding: sum.outstanding + row.outstandingFils,
    }),
    { net: 0, vat: 0, gross: 0, paid: 0, outstanding: 0 },
  );

  return {
    title: options.title,
    subtitle: options.subtitle,
    period: periodLabel(options.fromDate, options.toDate),
    generatedAt: new Date(),
    orientation: "landscape",
    metrics: [
      { label: "Documents", value: String(rows.length) },
      { label: "Net", value: formatAmount(totals.net) },
      { label: "VAT", value: formatAmount(totals.vat) },
      { label: "Gross", value: formatAmount(totals.gross), emphasis: true },
      { label: "Paid", value: formatAmount(totals.paid) },
      {
        label: "Outstanding",
        value: formatAmount(totals.outstanding),
        tone: totals.outstanding > 0 ? "negative" : "positive",
      },
    ],
    sections: [
      {
        title: options.title,
        columns: [
          { header: options.numberHeader },
          { header: "Date" },
          { header: options.partyHeader },
          { header: "Net", align: "end" },
          { header: "VAT", align: "end" },
          { header: "Gross", align: "end" },
          { header: "Paid", align: "end" },
          { header: "Outstanding", align: "end" },
          { header: "Status" },
        ],
        rows: rows.map((row) => [
          cell(row.number, { strong: true }),
          cell(formatDate(row.issueDate)),
          cell(row.partyName ?? "—"),
          cell(formatAmount(row.netFils), { align: "end" }),
          cell(formatAmount(row.vatFils), { align: "end" }),
          cell(formatAmount(row.grossFils), { align: "end" }),
          cell(formatAmount(row.paidFils), { align: "end" }),
          cell(formatAmount(row.outstandingFils), {
            align: "end",
            tone: row.outstandingFils > 0 ? "negative" : "default",
          }),
          cell(statusLabel(row.status), { muted: true }),
        ]),
        totals: [
          cell("Total"),
          cell(""),
          cell(`${String(rows.length)} ${rows.length === 1 ? "document" : "documents"}`),
          cell(formatAmount(totals.net), { align: "end" }),
          cell(formatAmount(totals.vat), { align: "end" }),
          cell(formatAmount(totals.gross), { align: "end" }),
          cell(formatAmount(totals.paid), { align: "end" }),
          cell(formatAmount(totals.outstanding), { align: "end" }),
          cell(""),
        ],
        emptyMessage: "No documents match the selected period.",
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* expenses                                                                    */
/* -------------------------------------------------------------------------- */

export function expenseReport(
  expenses: readonly ExpenseDto[],
  fromDate: string,
  toDate: string,
): ReportDocument {
  const totals = expenses.reduce(
    (sum, expense) => ({
      amount: sum.amount + expense.amountFils,
      vat: sum.vat + expense.vatFils,
      paid: sum.paid + expense.paidFils,
    }),
    { amount: 0, vat: 0, paid: 0 },
  );

  const byCategory = new Map<string, number>();
  for (const expense of expenses) {
    byCategory.set(expense.category, (byCategory.get(expense.category) ?? 0) + expense.amountFils);
  }
  const categories = [...byCategory.entries()].sort((a, b) => b[1] - a[1]);

  return {
    title: "Expense Report",
    subtitle: "Every expense recorded in the period",
    period: periodLabel(fromDate, toDate),
    generatedAt: new Date(),
    orientation: "landscape",
    metrics: [
      { label: "Entries", value: String(expenses.length) },
      { label: "Total amount", value: formatAmount(totals.amount), emphasis: true },
      { label: "VAT", value: formatAmount(totals.vat) },
      { label: "Paid", value: formatAmount(totals.paid) },
    ],
    sections: [
      {
        title: "Expenses",
        columns: [
          { header: "Date" },
          { header: "Category" },
          { header: "Description" },
          { header: "Method" },
          { header: "Reference" },
          { header: "VAT", align: "end" },
          { header: "Amount", align: "end" },
          { header: "Paid", align: "end" },
        ],
        rows: expenses.map((expense) => [
          cell(formatDate(expense.expenseDate)),
          cell(expense.category),
          cell(expense.description),
          cell(expense.paymentMethod.toUpperCase(), { muted: true }),
          cell(expense.reference ?? "—", { muted: true }),
          cell(formatAmount(expense.vatFils), { align: "end" }),
          cell(formatAmount(expense.amountFils), { align: "end" }),
          cell(formatAmount(expense.paidFils), { align: "end" }),
        ]),
        totals: [
          cell("Total"),
          cell(""),
          cell(`${String(expenses.length)} ${expenses.length === 1 ? "entry" : "entries"}`),
          cell(""),
          cell(""),
          cell(formatAmount(totals.vat), { align: "end" }),
          cell(formatAmount(totals.amount), { align: "end" }),
          cell(formatAmount(totals.paid), { align: "end" }),
        ],
        emptyMessage: "No expenses match the selected period.",
      },
      {
        title: "Expenses by category",
        columns: [{ header: "Category" }, { header: "Amount", align: "end" }],
        rows: categories.map(([category, amount]) => [
          cell(category),
          cell(formatAmount(amount), { align: "end" }),
        ]),
        totals: [cell("Total"), cell(formatAmount(totals.amount), { align: "end" })],
        emptyMessage: "No expenses recorded in this period.",
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* stock                                                                       */
/* -------------------------------------------------------------------------- */

export function stockReport(
  rows: readonly StockValuationRow[],
  asOfDate: string,
): ReportDocument {
  const totalValue = rows.reduce((sum, row) => sum + row.valueFils, 0);

  return {
    title: "Stock Report",
    subtitle: "What is on the shelf, valued at the last purchase cost",
    period: `As at ${formatDate(asOfDate)}`,
    generatedAt: new Date(),
    orientation: "landscape",
    metrics: [
      { label: "Items in stock", value: String(rows.length) },
      { label: "Stock value", value: formatAmount(totalValue), emphasis: true },
    ],
    sections: [
      {
        title: "Stock valuation",
        columns: [
          { header: "Code" },
          { header: "Item" },
          { header: "Category" },
          { header: "On hand", align: "end" },
          { header: "Last cost", align: "end" },
          { header: "Value", align: "end" },
        ],
        rows: rows.map((row) => [
          cell(row.sku),
          cell(row.name, { strong: true }),
          cell(row.category ?? "—", { muted: true }),
          cell(formatQuantity(row.quantityMilli), { align: "end" }),
          cell(formatAmount(row.averageCostFils), { align: "end" }),
          cell(formatAmount(row.valueFils), { align: "end" }),
        ]),
        totals: [
          cell("Total stock value"),
          cell(""),
          cell(""),
          cell(""),
          cell(""),
          cell(formatAmount(totalValue), { align: "end" }),
        ],
        emptyMessage: "No stock on hand. Products with a quantity above zero appear here.",
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* financial statements                                                        */
/* -------------------------------------------------------------------------- */

/** The trial balance: the proof that the ledger adds up. */
export function trialBalanceReport(data: TrialBalanceDto): ReportDocument {
  return {
    title: "Trial Balance",
    subtitle: "Every account, its opening balance and the movement in the period",
    period: periodLabel(data.fromDate, data.toDate),
    generatedAt: new Date(),
    orientation: "landscape",
    metrics: [
      { label: "Accounts", value: String(data.rows.length) },
      {
        label: "Closing debits",
        value: formatAmount(data.totalClosingDebitFils),
      },
      {
        label: "Closing credits",
        value: formatAmount(data.totalClosingCreditFils),
      },
      {
        label: "Difference",
        value: formatAmount(data.differenceFils),
        emphasis: true,
        tone: data.isBalanced ? "positive" : "negative",
      },
    ],
    sections: [
      {
        title: "Trial balance",
        columns: [
          { header: "Code" },
          { header: "Account" },
          { header: "Opening debit", align: "end" },
          { header: "Opening credit", align: "end" },
          { header: "Debit", align: "end" },
          { header: "Credit", align: "end" },
          { header: "Closing debit", align: "end" },
          { header: "Closing credit", align: "end" },
        ],
        rows: data.rows.map((row) => [
          cell(row.code),
          cell(row.name, { strong: true }),
          cell(formatAmount(row.openingDebitFils), { align: "end" }),
          cell(formatAmount(row.openingCreditFils), { align: "end" }),
          cell(formatAmount(row.periodDebitFils), { align: "end" }),
          cell(formatAmount(row.periodCreditFils), { align: "end" }),
          cell(formatAmount(row.closingDebitFils), { align: "end" }),
          cell(formatAmount(row.closingCreditFils), { align: "end" }),
        ]),
        totals: [
          cell("Total"),
          cell(`${String(data.rows.length)} accounts`),
          cell(formatAmount(data.totalOpeningDebitFils), { align: "end" }),
          cell(formatAmount(data.totalOpeningCreditFils), { align: "end" }),
          cell(formatAmount(data.totalPeriodDebitFils), { align: "end" }),
          cell(formatAmount(data.totalPeriodCreditFils), { align: "end" }),
          cell(formatAmount(data.totalClosingDebitFils), { align: "end" }),
          cell(formatAmount(data.totalClosingCreditFils), { align: "end" }),
        ],
        emptyMessage: "No accounts have been posted in this period.",
      },
    ],
    notes: data.isBalanced
      ? ["The trial balance agrees: total debits equal total credits."]
      : [
          `The trial balance does not agree: the difference is ${formatAmount(data.differenceFils)}.`,
        ],
  };
}

/** The balance sheet: what the business owns and owes at a date. */
export function balanceSheetReport(data: BalanceSheetDto): ReportDocument {
  const sectionRows = (lines: readonly { code: string; name: string; amountFils: number }[]) =>
    lines.map((line) => [
      cell(line.code),
      cell(line.name),
      cell(formatAmount(line.amountFils), { align: "end" }),
    ]);

  return {
    title: "Balance Sheet",
    subtitle: "What the business owns and what it owes at the reporting date",
    period: `As at ${formatDate(data.asOfDate)}`,
    generatedAt: new Date(),
    orientation: "portrait",
    metrics: [
      {
        label: "Total assets",
        value: formatAmount(data.assets.totalFils),
        emphasis: true,
      },
      {
        label: "Total liabilities",
        value: formatAmount(data.liabilities.totalFils),
      },
      { label: "Total equity", value: formatAmount(data.equity.totalFils) },
      {
        label: "Difference",
        value: formatAmount(data.differenceFils),
        tone: data.isBalanced ? "positive" : "negative",
      },
    ],
    sections: [
      {
        title: "Assets",
        columns: [{ header: "Code" }, { header: "Account" }, { header: "Amount", align: "end" }],
        rows: sectionRows(data.assets.lines),
        totals: [
          cell("Total assets"),
          cell(""),
          cell(formatAmount(data.assets.totalFils), { align: "end" }),
        ],
        emptyMessage: "No assets recorded at this date.",
      },
      {
        title: "Liabilities",
        columns: [{ header: "Code" }, { header: "Account" }, { header: "Amount", align: "end" }],
        rows: sectionRows(data.liabilities.lines),
        totals: [
          cell("Total liabilities"),
          cell(""),
          cell(formatAmount(data.liabilities.totalFils), { align: "end" }),
        ],
        emptyMessage: "No liabilities recorded at this date.",
      },
      {
        title: "Equity",
        columns: [{ header: "Code" }, { header: "Account" }, { header: "Amount", align: "end" }],
        rows: sectionRows(data.equity.lines),
        totals: [
          cell("Total equity"),
          cell(""),
          cell(formatAmount(data.equity.totalFils), { align: "end" }),
        ],
        emptyMessage: "No equity recorded at this date.",
      },
    ],
    notes: [
      `Current period earnings: ${formatAmount(data.currentPeriodEarningsFils)}.`,
      `Liabilities and equity: ${formatAmount(data.liabilitiesAndEquityFils)}.`,
      data.isBalanced
        ? "The balance sheet balances: assets equal liabilities and equity."
        : `The balance sheet does not balance: the difference is ${formatAmount(data.differenceFils)}.`,
    ],
  };
}

/** The finance profit and loss statement. */
export function financeProfitAndLossReport(
  data: ProfitLossDto,
): ReportDocument {
  return {
    title: "Profit & Loss",
    subtitle: "Trading performance for the period",
    period: periodLabel(data.fromDate, data.toDate),
    generatedAt: new Date(),
    orientation: "portrait",
    metrics: [
      { label: "Net sales", value: formatAmount(data.netSalesFils) },
      { label: "Gross profit", value: formatAmount(data.grossProfitFils) },
      { label: "Gross margin", value: `${formatPercent(data.grossMarginPercent)}%` },
      {
        label: "Net profit",
        value: formatAmount(data.netProfitFils),
        emphasis: true,
        tone: data.netProfitFils < 0 ? "negative" : "positive",
      },
    ],
    sections: [
      {
        title: "Profit and loss",
        columns: [{ header: "Line" }, { header: "Amount", align: "end" }],
        rows: [
          [
            cell("Gross sales", { strong: true }),
            cell(formatAmount(data.grossSalesFils), { align: "end" }),
          ],
          [
            cell("Sales returns"),
            cell(formatAmount(data.salesReturnsFils), { align: "end", tone: "negative" }),
          ],
          [
            cell("Net sales", { strong: true }),
            cell(formatAmount(data.netSalesFils), { align: "end" }),
          ],
          [
            cell("Cost of goods sold"),
            cell(formatAmount(data.costOfGoodsSoldFils), {
              align: "end",
              tone: "negative",
            }),
          ],
          [
            cell("Gross profit", { strong: true }),
            cell(formatAmount(data.grossProfitFils), { align: "end", strong: true }),
          ],
          [
            cell("Operating expenses"),
            cell(formatAmount(data.operatingExpensesFils), {
              align: "end",
              tone: "negative",
            }),
          ],
          [
            cell("Other income"),
            cell(formatAmount(data.otherIncomeFils), { align: "end" }),
          ],
        ],
        totals: [
          cell("Net profit"),
          cell(formatAmount(data.netProfitFils), { align: "end" }),
        ],
        emptyMessage: "No trading activity in this period.",
      },
      {
        title: "Operating expenses",
        columns: [{ header: "Code" }, { header: "Account" }, { header: "Amount", align: "end" }],
        rows: data.expenseLines.map((line) => [
          cell(line.code),
          cell(line.name),
          cell(formatAmount(line.amountFils), { align: "end" }),
        ]),
        totals: [
          cell("Total operating expenses"),
          cell(""),
          cell(formatAmount(data.operatingExpensesFils), { align: "end" }),
        ],
        emptyMessage: "No operating expenses in this period.",
      },
      {
        title: "Other income",
        columns: [{ header: "Code" }, { header: "Account" }, { header: "Amount", align: "end" }],
        rows: data.otherIncomeLines.map((line) => [
          cell(line.code),
          cell(line.name),
          cell(formatAmount(line.amountFils), { align: "end" }),
        ]),
        totals: [
          cell("Total other income"),
          cell(""),
          cell(formatAmount(data.otherIncomeFils), { align: "end" }),
        ],
        emptyMessage: "No other income in this period.",
      },
    ],
  };
}

/** The cash flow statement. */
export function cashFlowReport(data: CashFlowDto): ReportDocument {
  const section = (title: string, reportSection: ReportSectionDto): ReportSection => ({
    title,
    columns: [{ header: "Code" }, { header: "Account" }, { header: "Amount", align: "end" }],
    rows: reportSection.lines.map((line) => [
      cell(line.code),
      cell(line.name),
      cell(formatAmount(line.amountFils), { align: "end" }),
    ]),
    totals: [
      cell(`Total ${title.toLowerCase()}`),
      cell(""),
      cell(formatAmount(reportSection.totalFils), { align: "end" }),
    ],
    emptyMessage: `No ${title.toLowerCase()} in this period.`,
  });

  return {
    title: "Cash Flow",
    subtitle: "Where the money came from and where it went",
    period: periodLabel(data.fromDate, data.toDate),
    generatedAt: new Date(),
    orientation: "portrait",
    metrics: [
      { label: "Opening cash", value: formatAmount(data.openingCashFils) },
      { label: "Received", value: formatAmount(data.totalReceivedFils) },
      { label: "Paid", value: formatAmount(data.totalPaidFils) },
      {
        label: "Closing cash",
        value: formatAmount(data.closingCashFils),
        emphasis: true,
      },
    ],
    sections: [
      section("Operating", data.operating),
      section("Investing", data.investing),
      section("Financing", data.financing),
    ],
    notes: [`Net movement in cash: ${formatAmount(data.netMovementFils)}.`],
  };
}

/** The aging report: what is overdue, and by how much. */
export function agingReport(data: AgingDto): ReportDocument {
  const isReceivable = data.side === "receivable";

  return {
    title: isReceivable ? "Receivables Aging" : "Payables Aging",
    subtitle: isReceivable
      ? "What customers owe, and how late it is"
      : "What the business owes suppliers, and how late it is",
    period: `As at ${formatDate(data.asOfDate)}`,
    generatedAt: new Date(),
    orientation: "landscape",
    metrics: [
      {
        label: "Outstanding",
        value: formatAmount(data.totalOutstandingFils),
        emphasis: true,
      },
      {
        label: "Overdue",
        value: formatAmount(data.totalOverdueFils),
        tone: data.totalOverdueFils > 0 ? "negative" : "positive",
      },
      { label: "Invoices", value: String(data.rows.length) },
    ],
    sections: [
      {
        title: "By age",
        columns: [{ header: "Bucket" }, { header: "Amount", align: "end" }],
        rows: data.buckets.map((bucket) => [
          cell(bucket.label),
          cell(formatAmount(bucket.amountFils), { align: "end" }),
        ]),
        totals: [
          cell("Total outstanding"),
          cell(formatAmount(data.totalOutstandingFils), { align: "end" }),
        ],
        emptyMessage: "Nothing outstanding at this date.",
      },
      {
        title: "Invoices",
        columns: [
          { header: "Document" },
          { header: isReceivable ? "Customer" : "Supplier" },
          { header: "Issued" },
          { header: "Due" },
          { header: "Days late", align: "end" },
          { header: "Outstanding", align: "end" },
        ],
        rows: data.rows.map((row) => [
          cell(row.documentNumber, { strong: true }),
          cell(row.partyName),
          cell(formatDate(row.issueDate)),
          cell(row.dueDate === null ? "—" : formatDate(row.dueDate)),
          cell(row.daysOverdue > 0 ? String(row.daysOverdue) : "—", {
            align: "end",
            tone: row.daysOverdue > 0 ? "negative" : "default",
          }),
          cell(formatAmount(row.outstandingFils), { align: "end" }),
        ]),
        totals: [
          cell("Total"),
          cell(`${String(data.rows.length)} invoices`),
          cell(""),
          cell(""),
          cell(""),
          cell(formatAmount(data.totalOutstandingFils), { align: "end" }),
        ],
        emptyMessage: "Nothing outstanding at this date.",
      },
    ],
  };
}

/** The period comparison: this period against the one before it. */
export function periodComparisonReport(
  data: PeriodComparisonDto,
): ReportDocument {
  return {
    title: "Period Comparison",
    subtitle: "This period against the one before it",
    period: `${periodLabel(data.fromDate, data.toDate)} · against ${periodLabel(
      data.previousFromDate,
      data.previousToDate,
    )}`,
    generatedAt: new Date(),
    orientation: "portrait",
    metrics: data.rows.slice(0, 4).map((row) => ({
      label: row.label,
      value: formatAmount(row.currentFils),
      tone: row.changeFils < 0 ? ("negative" as const) : ("positive" as const),
    })),
    sections: [
      {
        title: "Comparison",
        columns: [
          { header: "Measure" },
          { header: "This period", align: "end" },
          { header: "Previous period", align: "end" },
          { header: "Change", align: "end" },
          { header: "Change %", align: "end" },
        ],
        rows: data.rows.map((row) => [
          cell(row.label, { strong: true }),
          cell(formatAmount(row.currentFils), { align: "end" }),
          cell(formatAmount(row.previousFils), { align: "end" }),
          cell(formatAmount(row.changeFils), {
            align: "end",
            tone: row.changeFils < 0 ? "negative" : "positive",
          }),
          cell(row.changePercent === null ? "—" : `${formatPercent(row.changePercent)}%`, {
            align: "end",
          }),
        ]),
        emptyMessage: "Nothing to compare in this period.",
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* inventory                                                                   */
/* -------------------------------------------------------------------------- */

export function inventoryReport(
  products: readonly ProductDto[],
): ReportDocument {
  const totalValue = products.reduce((sum, product) => sum + product.stockValueFils, 0);
  const lowStock = products.filter((product) => product.isLowStock).length;
  const categories = new Set(
    products
      .map((product) => product.category)
      .filter((category): category is string => category !== null),
  );

  return {
    title: "Inventory Report",
    subtitle: "The catalogue and its current stock position",
    period: `As at ${formatDate(new Date().toISOString().slice(0, 10))}`,
    generatedAt: new Date(),
    orientation: "landscape",
    metrics: [
      { label: "Products", value: String(products.length) },
      { label: "Categories", value: String(categories.size) },
      { label: "Low stock", value: String(lowStock), tone: lowStock > 0 ? "negative" : "default" },
      { label: "Stock value", value: formatAmount(totalValue), emphasis: true },
    ],
    sections: [
      {
        title: "Catalogue",
        columns: [
          { header: "Code" },
          { header: "Item" },
          { header: "Category" },
          { header: "Unit" },
          { header: "On hand", align: "end" },
          { header: "Reorder", align: "end" },
          { header: "Last cost", align: "end" },
          { header: "Sale price", align: "end" },
          { header: "Stock value", align: "end" },
        ],
        rows: products.map((product) => [
          cell(product.sku),
          cell(product.name, { strong: true }),
          cell(product.category ?? "—", { muted: true }),
          cell(product.unit, { muted: true }),
          cell(formatQuantity(product.quantityMilli), {
            align: "end",
            tone: product.isLowStock ? "negative" : "default",
          }),
          cell(formatQuantity(product.reorderLevelMilli), { align: "end", muted: true }),
          cell(formatAmount(product.lastCostFils), { align: "end" }),
          cell(formatAmount(product.lastSalePriceFils), { align: "end" }),
          cell(formatAmount(product.stockValueFils), { align: "end" }),
        ]),
        totals: [
          cell("Total stock value"),
          cell(""),
          cell(""),
          cell(""),
          cell(""),
          cell(""),
          cell(""),
          cell(""),
          cell(formatAmount(totalValue), { align: "end" }),
        ],
        emptyMessage: "No products match the selected filters.",
      },
    ],
  };
}
