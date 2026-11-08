/**
 * Reports: dashboard, profit and loss, partner split, sales and stock.
 *
 * Every figure is aggregated in SQL against an index that supports the exact
 * predicate used, rather than loading rows into JavaScript. At 50k documents
 * that difference is the difference between a report that opens instantly and
 * one that hangs.
 *
 * All money is integer fils from the first SUM to the last printed digit.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SqliteDatabase } from "../../data/connection";
import { computeGrossProfit } from "../../domain/costing";
import { buildClosingStatement } from "../../domain/partner";
import { rollingMonths, monthBounds, todayIso } from "../../domain/dates";
import type {
  DashboardDto,
  DashboardInventoryDto,
  DocumentRegisterRequest,
  DocumentRegisterRow,
  ExpenseDto,
  ExpenseListRequest,
  PartnerDto,
  PartnerSplitDto,
  ProductDto,
  ProfitAndLossDto,
  SaveExpenseRequest,
  StockValuationRow,
} from "../../shared/types";
import type { AuditActor } from "../audit-writer";
import { recordAudit } from "../audit-writer";
import {
  listLowStockProducts,
  listRecentProducts,
  productCostHistory,
} from "./products";

export const DEFAULT_EXPENSE_CATEGORIES = [
  "rent",
  "utilities",
  "transport",
  "salaries",
  "marketing",
  "maintenance",
  "office",
  "internet",
  "general",
] as const;

/* -------------------------------------------------------------------------- */
/* expenses                                                                   */
/* -------------------------------------------------------------------------- */

interface ExpenseRow {
  readonly id: number;
  readonly expense_date: string;
  readonly category: string;
  readonly description: string;
  readonly amount_fils: number;
  readonly vat_fils: number;
  readonly payment_method: ExpenseDto["paymentMethod"];
  readonly reference: string | null;
  readonly notes: string | null;
  readonly account_code: string | null;
  readonly paid_fils: number;
}

const EXPENSE_SELECT = `
  SELECT e.*
    FROM expenses e
`;

function mapExpense(row: ExpenseRow): ExpenseDto {
  return {
    id: row.id,
    expenseDate: row.expense_date,
    category: row.category,
    description: row.description,
    amountFils: row.amount_fils,
    vatFils: row.vat_fils,
    paymentMethod: row.payment_method,
    reference: row.reference,
    notes: row.notes,
    accountCode: row.account_code,
    // An expense recorded before the "paid" column existed was paid in full:
    // it credited cash when it was posted.
    paidFils: row.paid_fils ?? row.amount_fils,
  };
}

export function listExpenses(db: SqliteDatabase, request: ExpenseListRequest): ExpenseDto[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (request.fromDate !== undefined) {
    clauses.push("e.expense_date >= ?");
    params.push(request.fromDate);
  }
  if (request.toDate !== undefined) {
    clauses.push("e.expense_date <= ?");
    params.push(request.toDate);
  }
  if (request.category !== undefined && request.category.length > 0) {
    clauses.push("e.category = ?");
    params.push(request.category);
  }
  if (request.search !== undefined && request.search.length > 0) {
    clauses.push("e.description LIKE ?");
    params.push(`%${request.search}%`);
  }

  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const limit = request.limit ?? 500;

  const rows = db
    .prepare(`${EXPENSE_SELECT}${where} ORDER BY e.expense_date DESC, e.id DESC LIMIT ?`)
    .all(...params, limit) as ExpenseRow[];

  return rows.map(mapExpense);
}

export function saveExpense(
  context: { db: SqliteDatabase; actor: AuditActor; nowIso: string },
  request: SaveExpenseRequest,
): ExpenseDto {
  const { db } = context;

  // The amount paid at the time. An expense that is not paid in full leaves
  // a liability behind, and the ledger has to know about it.
  const paidFils = Math.min(Math.max(request.paidFils ?? request.amountFils, 0), request.amountFils);

  return db.transaction((): ExpenseDto => {
    if (request.id !== undefined) {
      db.prepare(
        `UPDATE expenses
            SET expense_date = ?, category = ?, description = ?, amount_fils = ?, vat_fils = ?,
                payment_method = ?, reference = ?, notes = ?, account_code = ?, paid_fils = ?,
                updated_at = ?
          WHERE id = ?`,
      ).run(
        request.expenseDate,
        request.category,
        request.description,
        request.amountFils,
        request.vatFils ?? 0,
        request.paymentMethod ?? "cash",
        request.reference ?? null,
        request.notes ?? null,
        request.accountCode ?? null,
        paidFils,
        context.nowIso,
        request.id,
      );

      recordAudit(
        db,
        context.actor,
        {
          module: "finance",
          action: "update",
          entityType: "expense",
          entityId: request.id,
          newValues: request,
        },
        context.nowIso,
      );

      const row = db.prepare(`${EXPENSE_SELECT} WHERE e.id = ?`).get(request.id) as ExpenseRow;
      return mapExpense(row);
    }

    const info = db
      .prepare(
        `INSERT INTO expenses
           (expense_date, category, description, amount_fils, vat_fils, payment_method,
            reference, notes, account_code, paid_fils, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.expenseDate,
        request.category,
        request.description,
        request.amountFils,
        request.vatFils ?? 0,
        request.paymentMethod ?? "cash",
        request.reference ?? null,
        request.notes ?? null,
        request.accountCode ?? null,
        paidFils,
        context.actor.name,
        context.nowIso,
        context.nowIso,
      );

    const id = Number(info.lastInsertRowid);

    recordAudit(
      db,
      context.actor,
      {
        module: "finance",
        action: "create",
        entityType: "expense",
        entityId: id,
        newValues: request,
      },
      context.nowIso,
    );

    const row = db.prepare(`${EXPENSE_SELECT} WHERE e.id = ?`).get(id) as ExpenseRow;
    return mapExpense(row);
  })();
}

export function deleteExpense(
  context: { db: SqliteDatabase; actor: AuditActor; nowIso: string },
  id: number,
): void {
  const { db } = context;
  db.transaction(() => {
    const row = db.prepare("SELECT expense_date FROM expenses WHERE id = ?").get(id) as
      | { expense_date: string }
      | undefined;

    if (row === undefined) throw new Error(`Expense ${String(id)} was not found.`);

    db.prepare("DELETE FROM expenses WHERE id = ?").run(id);

    recordAudit(
      db,
      context.actor,
      { module: "finance", action: "delete", entityType: "expense", entityId: id },
      context.nowIso,
    );
  })();
}

/* -------------------------------------------------------------------------- */
/* dashboard                                                                  */
/* -------------------------------------------------------------------------- */

export function dashboardSummary(
  db: SqliteDatabase,
  request: {
    fromDate?: string;
    toDate?: string;
    previousFromDate?: string;
    previousToDate?: string;
    includeInventory?: boolean;
  },
  now: Date,
): DashboardDto {
  const today = todayIso(now);
  const from = request.fromDate ?? `${today.slice(0, 4)}-01-01`;
  const to = request.toDate ?? today;

  const sales = db
    .prepare(
      `SELECT COALESCE(SUM(gross_fils), 0) AS gross
         FROM documents
        WHERE kind = 'invoice' AND status <> 'cancelled' AND issue_date BETWEEN ? AND ?`,
    )
    .get(from, to) as { gross: number };

  // The previous window used to cost a second full dashboard summary - six
  // months of aggregates, a P&L and a top-products query - only to read one
  // number. It is one indexed sum now.
  const previousSales =
    request.previousFromDate === undefined || request.previousToDate === undefined
      ? { gross: 0 }
      : (db
          .prepare(
            `SELECT COALESCE(SUM(gross_fils), 0) AS gross
               FROM documents
              WHERE kind = 'invoice' AND status <> 'cancelled' AND issue_date BETWEEN ? AND ?`,
          )
          .get(request.previousFromDate, request.previousToDate) as { gross: number });

  const purchases = db
    .prepare(
      `SELECT COALESCE(SUM(gross_fils), 0) AS gross
         FROM documents
        WHERE kind = 'purchaseInvoice' AND status <> 'cancelled' AND issue_date BETWEEN ? AND ?`,
    )
    .get(from, to) as { gross: number };

  const expenses = db
    .prepare(
      "SELECT COALESCE(SUM(amount_fils), 0) AS total FROM expenses WHERE expense_date BETWEEN ? AND ?",
    )
    .get(from, to) as { total: number };

  const receivables = db
    .prepare(
      `SELECT COALESCE(SUM(gross_fils - paid_fils), 0) AS total
         FROM documents
        WHERE kind = 'invoice' AND status IN ('issued','partPaid')`,
    )
    .get() as { total: number };

  const payables = db
    .prepare(
      `SELECT COALESCE(SUM(gross_fils - paid_fils), 0) AS total
         FROM documents
        WHERE kind = 'purchaseInvoice' AND status IN ('issued','partPaid')`,
    )
    .get() as { total: number };

  const lowStock = db
    .prepare(
      "SELECT COUNT(*) AS count FROM products WHERE is_active = 1 AND quantity_milli <= 5000",
    )
    .get() as { count: number };

  const months = rollingMonths(now, 6);
  const first = months[0];
  const last = months[months.length - 1];
  const firstBounds =
    first === undefined
      ? undefined
      : monthBounds(
          Number.parseInt(first.month.slice(0, 4), 10),
          Number.parseInt(first.month.slice(5, 7), 10),
        );
  const lastBounds =
    last === undefined
      ? undefined
      : monthBounds(
          Number.parseInt(last.month.slice(0, 4), 10),
          Number.parseInt(last.month.slice(5, 7), 10),
        );

  // One grouped query per side instead of one pair per month. The date range
  // still uses the same indexes; the grouping only removes the twelve round
  // trips.
  const salesByMonth = new Map<string, number>();
  const expensesByMonth = new Map<string, number>();
  if (firstBounds !== undefined && lastBounds !== undefined) {
    const salesRows = db
      .prepare(
        `SELECT substr(issue_date, 1, 7) AS month,
                COALESCE(SUM(gross_fils), 0) AS total
           FROM documents
          WHERE kind = 'invoice' AND status <> 'cancelled'
            AND issue_date BETWEEN ? AND ?
          GROUP BY month`,
      )
      .all(firstBounds.start, lastBounds.end) as { month: string; total: number }[];
    for (const row of salesRows) salesByMonth.set(row.month, row.total);

    const expenseRows = db
      .prepare(
        `SELECT substr(expense_date, 1, 7) AS month,
                COALESCE(SUM(amount_fils), 0) AS total
           FROM expenses
          WHERE expense_date BETWEEN ? AND ?
          GROUP BY month`,
      )
      .all(firstBounds.start, lastBounds.end) as { month: string; total: number }[];
    for (const row of expenseRows) expensesByMonth.set(row.month, row.total);
  }

  const salesVsExpenses = months.map((month) => ({
    month: month.month,
    salesFils: salesByMonth.get(month.month) ?? 0,
    expenseFils: expensesByMonth.get(month.month) ?? 0,
  }));

  const topProducts = db
    .prepare(
      `SELECT dl.description AS name,
              SUM(dl.quantity_milli) AS qty_milli,
              SUM(dl.net_fils) AS net_fils
         FROM document_lines dl
         JOIN documents d ON d.id = dl.document_id
        WHERE d.kind = 'invoice' AND d.status <> 'cancelled'
          AND d.issue_date BETWEEN ? AND ?
        GROUP BY dl.description
        ORDER BY net_fils DESC
        LIMIT 8`,
    )
    .all(from, to) as { name: string; qty_milli: number; net_fils: number }[];

  // The dashboard shows the headline number only; the breakdown lives on the
  // Profit & Loss report so the two can never disagree.
  const pnl = profitAndLoss(db, from, to);

  return {
    salesFils: Math.round(sales.gross),
    previousSalesFils: Math.round(previousSales.gross),
    purchasesFils: Math.round(purchases.gross),
    expensesFils: Math.round(expenses.total),
    netProfitFils: pnl.netProfitFils,
    receivablesFils: Math.round(receivables.total),
    payablesFils: Math.round(payables.total),
    lowStockCount: lowStock.count,
    salesVsExpenses,
    topProducts: topProducts.map((row) => ({
      name: row.name,
      qtyMilli: row.qty_milli,
      netFils: row.net_fils,
    })),
    inventory:
      request.includeInventory === true ? dashboardInventory(db) : EMPTY_DASHBOARD_INVENTORY,
    generatedAtIso: now.toISOString(),
  };
}

const EMPTY_DASHBOARD_INVENTORY: DashboardInventoryDto = {
  productCount: 0,
  totalQuantityMilli: 0,
  stockedCount: 0,
  totalStockValueFils: 0,
  units: [],
  recentProducts: [],
  lowStockProducts: [],
  categories: [],
};

/**
 * The dashboard's inventory half, aggregated in SQL.
 *
 * It used to be built by reading up to 5,000 product rows (and their cost
 * history) into the renderer just to sum four columns and show six rows. The
 * totals and category split belong in the database; only the handful of rows
 * the screen actually prints come back.
 */
function dashboardInventory(db: SqliteDatabase): DashboardInventoryDto {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS product_count,
              COALESCE(SUM(quantity_milli), 0) AS total_quantity_milli,
              COALESCE(SUM(CASE WHEN quantity_milli > 0 THEN 1 ELSE 0 END), 0) AS stocked_count,
              COALESCE(SUM(CAST(ROUND(quantity_milli * average_cost_fils / 1000.0) AS INTEGER)), 0)
                AS total_stock_value_fils
         FROM products`,
    )
    .get() as {
    product_count: number;
    total_quantity_milli: number;
    stocked_count: number;
    total_stock_value_fils: number;
  };

  const units = (
    db
      .prepare(
        "SELECT DISTINCT unit FROM products WHERE unit IS NOT NULL AND TRIM(unit) <> '' ORDER BY unit",
      )
      .all() as { unit: string }[]
  ).map((row) => row.unit);

  const categories = db
    .prepare(
      `SELECT CASE WHEN TRIM(COALESCE(category, '')) = '' THEN 'Uncategorised' ELSE category END
                AS name,
              COUNT(*) AS count,
              COALESCE(SUM(CAST(ROUND(quantity_milli * average_cost_fils / 1000.0) AS INTEGER)), 0)
                AS value_fils
         FROM products
        GROUP BY CASE WHEN TRIM(COALESCE(category, '')) = '' THEN 'Uncategorised' ELSE category END
        ORDER BY name`,
    )
    .all() as { name: string; count: number; value_fils: number }[];

  return {
    productCount: totals.product_count,
    totalQuantityMilli: totals.total_quantity_milli,
    stockedCount: totals.stocked_count,
    totalStockValueFils: totals.total_stock_value_fils,
    units,
    recentProducts: listRecentProducts(db, 6),
    lowStockProducts: listLowStockProducts(db, 3),
    categories: categories.map((row) => ({
      name: row.name,
      count: row.count,
      valueFils: row.value_fils,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* profit and loss                                                            */
/* -------------------------------------------------------------------------- */

export function profitAndLoss(
  db: SqliteDatabase,
  fromDate: string,
  toDate: string,
): ProfitAndLossDto {
  const sales = db
    .prepare(
      `SELECT COALESCE(SUM(net_fils), 0) AS net, COALESCE(SUM(cost_fils), 0) AS cost
         FROM documents
        WHERE kind = 'invoice' AND status <> 'cancelled' AND issue_date BETWEEN ? AND ?`,
    )
    .get(fromDate, toDate) as { net: number; cost: number };

  const expenses = db
    .prepare(
      "SELECT COALESCE(SUM(amount_fils), 0) AS total FROM expenses WHERE expense_date BETWEEN ? AND ?",
    )
    .get(fromDate, toDate) as { total: number };

  const revenueFils = Math.round(sales.net);
  const costOfGoodsFils = Math.round(sales.cost);
  const operatingExpensesFils = Math.round(expenses.total);

  const gross = computeGrossProfit(revenueFils, costOfGoodsFils);
  const grossProfitFils = gross.grossProfitFils;

  const expenseRows = db
    .prepare(
      `SELECT category, COALESCE(SUM(amount_fils), 0) AS amount_fils
         FROM expenses
        WHERE expense_date BETWEEN ? AND ?
        GROUP BY category
        ORDER BY amount_fils DESC`,
    )
    .all(fromDate, toDate) as { category: string; amount_fils: number }[];

  return {
    fromDate,
    toDate,
    revenueFils,
    netSalesFils: revenueFils,
    costOfGoodsFils,
    grossProfitFils,
    grossMarginPercent: Math.round(gross.grossMarginPercent * 100) / 100,
    operatingExpensesFils,
    netProfitFils: grossProfitFils - operatingExpensesFils,
    expensesByCategory: expenseRows.map((row) => ({
      category: row.category,
      amountFils: row.amount_fils,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* partner split                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The split every partner agrees to, for a date range.
 *
 * The donation and each partner's share are percentages of the net profit and
 * they add up to exactly 100%, using the same `buildClosingStatement` the
 * partnership ledger is tested against, so the report and the ledger can never
 * disagree. A loss period or a shop with no partners configured splits nothing
 * rather than failing: the numbers are still shown, with zeros where the money
 * would go.
 */
export function partnerSplit(
  db: SqliteDatabase,
  fromDate: string,
  toDate: string,
  partners: readonly PartnerDto[],
  settings: { donationRatePercent: number },
): PartnerSplitDto {
  const pnl = profitAndLoss(db, fromDate, toDate);

  // Only active partners with a share take part.
  const active = partners.filter((partner) => partner.isActive && partner.sharePercent > 0);

  const empty = (netProfitFils: number): PartnerSplitDto => ({
    fromDate,
    toDate,
    netProfitFils,
    donationRatePercent: settings.donationRatePercent,
    donationFils: 0,
    distributableFils: 0,
    partners: [],
    configurationError: null,
  });

  if (pnl.netProfitFils <= 0 || active.length === 0) {
    return empty(pnl.netProfitFils);
  }

  let statement;
  try {
    statement = buildClosingStatement(
      {
        revenueFils: pnl.revenueFils,
        costOfGoodsFils: pnl.costOfGoodsFils,
        operatingExpensesFils: pnl.operatingExpensesFils,
        vatPayableFils: 0,
      },
      active.map((partner) => ({
        id: String(partner.id),
        name: partner.name,
        sharePercent: partner.sharePercent,
      })),
      settings.donationRatePercent,
    );
  } catch (caught) {
    // A partnership whose shares and donation do not come to 100% cannot be
    // split without inventing money. The report says so rather than showing a
    // split that is not true.
    return {
      fromDate,
      toDate,
      netProfitFils: pnl.netProfitFils,
      donationRatePercent: settings.donationRatePercent,
      donationFils: 0,
      distributableFils: 0,
      partners: [],
      configurationError:
        caught instanceof Error ? caught.message : "The profit split could not be worked out.",
    };
  }

  return {
    fromDate,
    toDate,
    netProfitFils: statement.netProfitFils,
    donationRatePercent: statement.donationRatePercent,
    donationFils: statement.donationFils,
    distributableFils: statement.distributableProfitFils,
    partners: statement.allocations.map((allocation) => ({
      partnerId: Number(allocation.partnerId),
      name: allocation.partnerName,
      sharePercent: allocation.sharePercent,
      amountFils: allocation.allocatedShareFils,
    })),
    configurationError: null,
  };
}

/* -------------------------------------------------------------------------- */
/* stock report                                                               */
/* -------------------------------------------------------------------------- */

export function stockValuation(
  db: SqliteDatabase,
  products: readonly ProductDto[],
): StockValuationRow[] {
  const history = productCostHistory(
    db,
    products.map((product) => product.id),
  );
  return products
    .filter((product) => product.quantityMilli !== 0)
    .map((product) => {
      const lastCost = history.get(product.id)?.lastCostFils ?? 0;
      return {
        productId: product.id,
        sku: product.sku,
        name: product.name,
        category: product.category,
        quantityMilli: product.quantityMilli,
        averageCostFils: lastCost,
        valueFils: Math.round((product.quantityMilli * lastCost) / 1000),
      };
    });
}

/* -------------------------------------------------------------------------- */
/* sales report                                                               */
/* -------------------------------------------------------------------------- */

export interface SalesReportRow {
  readonly number: string;
  readonly issueDate: string;
  readonly partyName: string;
  readonly netFils: number;
  readonly vatFils: number;
  readonly grossFils: number;
  readonly paidFils: number;
  readonly outstandingFils: number;
  readonly status: string;
}

/** Every sales invoice in the range, newest first, with its payment position. */
export function salesReport(
  db: SqliteDatabase,
  fromDate: string,
  toDate: string,
): readonly SalesReportRow[] {
  const rows = db
    .prepare(
      `SELECT d.number, d.issue_date, COALESCE(p.name, '') AS party_name,
              d.net_fils, d.vat_fils, d.gross_fils, d.paid_fils, d.status
         FROM documents d
         LEFT JOIN parties p ON p.id = d.party_id
        WHERE d.kind = 'invoice' AND d.issue_date BETWEEN ? AND ?
        ORDER BY d.issue_date DESC, d.id DESC`,
    )
    .all(fromDate, toDate) as {
    number: string;
    issue_date: string;
    party_name: string;
    net_fils: number;
    vat_fils: number;
    gross_fils: number;
    paid_fils: number;
    status: string;
  }[];

  return rows.map((row) => ({
    number: row.number,
    issueDate: row.issue_date,
    partyName: row.party_name,
    netFils: Math.round(row.net_fils),
    vatFils: Math.round(row.vat_fils),
    grossFils: Math.round(row.gross_fils),
    paidFils: Math.round(row.paid_fils),
    outstandingFils: Math.round(row.gross_fils - row.paid_fils),
    status: row.status,
  }));
}

/* -------------------------------------------------------------------------- */
/* invoice register                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Every invoice in a period, with the money on it.
 *
 * The lines are counted rather than read: a register shows how many items an
 * invoice carries, and reading every line of every invoice in a year would
 * turn one query per row into thousands of them.
 */
export function documentRegister(
  db: SqliteDatabase,
  request: DocumentRegisterRequest,
): readonly DocumentRegisterRow[] {
  const clauses = ["d.kind = ?", "d.issue_date BETWEEN ? AND ?"];
  const params: (string | number)[] = [request.kind, request.fromDate, request.toDate];

  if (request.status !== undefined) {
    clauses.push("d.status = ?");
    params.push(request.status);
  }
  if (request.partyId !== undefined) {
    clauses.push("d.party_id = ?");
    params.push(request.partyId);
  }
  if (request.search !== undefined && request.search.trim().length > 0) {
    clauses.push("(d.number LIKE ? OR COALESCE(p.name, '') LIKE ?)");
    const like = `%${request.search.trim()}%`;
    params.push(like, like);
  }

  const rows = db
    .prepare(
      `SELECT d.id, d.number, d.issue_date, COALESCE(p.name, '') AS party_name,
              d.status, d.net_fils, d.vat_fils, d.gross_fils, d.paid_fils,
              (SELECT COUNT(*) FROM document_lines dl WHERE dl.document_id = d.id) AS line_count
         FROM documents d
         LEFT JOIN parties p ON p.id = d.party_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY d.issue_date DESC, d.id DESC`,
    )
    .all(...params) as {
    id: number;
    number: string;
    issue_date: string;
    party_name: string;
    status: string;
    net_fils: number;
    vat_fils: number;
    gross_fils: number;
    paid_fils: number;
    line_count: number;
  }[];

  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    issueDate: row.issue_date,
    partyName: row.party_name.length > 0 ? row.party_name : null,
    status: row.status as DocumentRegisterRow["status"],
    netFils: Math.round(row.net_fils),
    vatFils: Math.round(row.vat_fils),
    grossFils: Math.round(row.gross_fils),
    paidFils: Math.round(row.paid_fils),
    outstandingFils: Math.round(row.gross_fils - row.paid_fils),
    lineCount: row.line_count,
  }));
}

/* -------------------------------------------------------------------------- */
/* CSV export                                                                 */
/* -------------------------------------------------------------------------- */

/** Quotes for CSV: wraps in quotes and doubles any quote inside. */
function csvCell(value: string | number): string {
  const text = typeof value === "number" ? String(value) : value;
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRows(rows: readonly (readonly (string | number)[])[]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

/** Write rows to a CSV file in the export folder and return its path. */
export function exportReportCsv(
  exportDir: string,
  filename: string,
  rows: readonly (readonly (string | number)[])[],
): string {
  const path = join(exportDir, filename);
  writeFileSync(path, `${csvRows(rows)}\r\n`, "utf8");
  return path;
}
