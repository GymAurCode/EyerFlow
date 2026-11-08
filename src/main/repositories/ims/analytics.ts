/**
 * IMS analytics: the inventory dashboard and the report centre.
 *
 * Reports run real SQL over the same ledger the screens post to. The renderer
 * receives columns and rows and formats them; it never computes a money figure
 * of its own.
 */

import type { SqliteDatabase } from "../../../data/connection";
import { todayIso } from "../../../domain/dates";
import type {
  ImsDashboardDto,
  ImsDashboardRequest,
  ImsReportColumn,
  ImsReportDto,
  ImsReportId,
  ImsReportRequest,
  ReplenishmentRow,
  StockOverviewRequest,
} from "../../../shared/ims";
import { listBatches, replenishmentRows, stockOverview } from "./queries";

interface Period {
  readonly fromDate: string;
  readonly toDate: string;
}

function periodOf(request: { fromDate?: string; toDate?: string }, days = 30): Period {
  const toDate = request.toDate ?? todayIso();
  if (request.fromDate !== undefined) return { fromDate: request.fromDate, toDate };
  const start = new Date(`${toDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { fromDate: start.toISOString().slice(0, 10), toDate };
}

function scalar(db: SqliteDatabase, sql: string, ...params: (string | number)[]): number {
  const row = db.prepare(sql).get(...params) as Record<string, number> | undefined;
  return row === undefined ? 0 : Number(Object.values(row)[0] ?? 0);
}

function grouped(
  db: SqliteDatabase,
  sql: string,
  ...params: (string | number)[]
): Record<string, string | number | null>[] {
  return db.prepare(sql).all(...params) as Record<string, string | number | null>[];
}

function monthKeys(period: Period, count = 6): string[] {
  const keys: string[] = [];
  const cursor = new Date(`${period.toDate}T00:00:00Z`);
  cursor.setUTCDate(1);
  for (let index = count - 1; index >= 0; index -= 1) {
    const month = new Date(cursor);
    month.setUTCMonth(cursor.getUTCMonth() - index);
    keys.push(month.toISOString().slice(0, 7));
  }
  return keys;
}

export function dashboard(db: SqliteDatabase, request: ImsDashboardRequest): ImsDashboardDto {
  const period = periodOf(request);
  const stockRequest: StockOverviewRequest = {
    limit: 2000,
    ...(request.category !== undefined && request.category !== "" ? { category: request.category } : {}),
    ...(request.locationId !== undefined ? { locationId: request.locationId } : {}),
  };
  const overview = stockOverview(db, stockRequest);

  const activeProducts = scalar(db, "SELECT COUNT(*) AS n FROM products WHERE is_active = 1 AND is_service = 0");
  const skus = scalar(db, "SELECT COUNT(*) AS n FROM products WHERE is_service = 0");
  const onHand = overview.reduce((sum, row) => sum + row.onHandMilli, 0);
  const available = overview.reduce((sum, row) => sum + row.availableMilli, 0);
  const reserved = overview.reduce((sum, row) => sum + row.reservedMilli, 0);
  const valuation = overview.reduce((sum, row) => sum + row.valueFils, 0);
  const lowStockCount = overview.filter((row) => row.isLow).length;
  const outOfStockCount = overview.filter((row) => row.isOut).length;

  const salesFils = scalar(
    db,
    "SELECT COALESCE(SUM(gross_fils), 0) AS n FROM documents WHERE kind = 'invoice' AND status <> 'cancelled' AND issue_date BETWEEN ? AND ?",
    period.fromDate,
    period.toDate,
  );
  const purchasesFils = scalar(
    db,
    "SELECT COALESCE(SUM(gross_fils), 0) AS n FROM documents WHERE kind = 'purchaseInvoice' AND status <> 'cancelled' AND issue_date BETWEEN ? AND ?",
    period.fromDate,
    period.toDate,
  );

  const pendingPurchaseOrders = scalar(
    db,
    "SELECT COUNT(*) AS n FROM ims_documents WHERE kind = 'purchaseOrder' AND status IN ('draft','submitted','approved','partiallyReceived')",
  );
  const pendingGoodsReceipts = scalar(
    db,
    "SELECT COUNT(*) AS n FROM ims_documents WHERE kind = 'goodsReceipt' AND status IN ('draft','submitted','approved')",
  );

  const stockFlow = grouped(
    db,
    `SELECT movement_date AS date,
            COALESCE(SUM(CASE WHEN quantity_milli > 0 THEN quantity_milli END), 0) AS in_milli,
            COALESCE(SUM(CASE WHEN quantity_milli < 0 THEN -quantity_milli END), 0) AS out_milli
       FROM stock_movements
      WHERE movement_date BETWEEN ? AND ?
      GROUP BY movement_date
      ORDER BY movement_date`,
    period.fromDate,
    period.toDate,
  ).map((row) => ({
    date: String(row.date ?? ""),
    inMilli: Number(row.in_milli ?? 0),
    outMilli: Number(row.out_milli ?? 0),
  }));

  const inventoryValueSeries = stockFlow.map((row, index, all) => {
    // Walk the value back from today's valuation using the cost of later flows.
    const later = all.slice(index + 1);
    const laterCost = scalar(
      db,
      `SELECT COALESCE(SUM(cost_fils), 0) AS n FROM stock_movements
        WHERE movement_date > ? AND movement_date <= ?`,
      row.date,
      period.toDate,
    );
    void later;
    return { date: row.date, valueFils: Math.max(0, valuation - laterCost) };
  });

  const categoryMix = grouped(
    db,
    `SELECT COALESCE(NULLIF(p.category, ''), 'Uncategorised') AS name,
            COUNT(*) AS count,
            COALESCE(SUM(ROUND(p.quantity_milli * p.average_cost_fils / 1000.0)), 0) AS value
       FROM products p
      WHERE p.is_service = 0
      GROUP BY COALESCE(NULLIF(p.category, ''), 'Uncategorised')
      ORDER BY value DESC`,
  ).map((row) => ({
    name: String(row.name ?? ""),
    count: Number(row.count ?? 0),
    valueFils: Math.round(Number(row.value ?? 0)),
  }));

  const months = monthKeys(period);
  const purchaseSalesSeries = months.map((month) => {
    const start = `${month}-01`;
    const end = `${month}-31`;
    return {
      month,
      salesFils: scalar(
        db,
        "SELECT COALESCE(SUM(gross_fils), 0) AS n FROM documents WHERE kind = 'invoice' AND status <> 'cancelled' AND issue_date BETWEEN ? AND ?",
        start,
        end,
      ),
      purchasesFils: scalar(
        db,
        "SELECT COALESCE(SUM(gross_fils), 0) AS n FROM documents WHERE kind = 'purchaseInvoice' AND status <> 'cancelled' AND issue_date BETWEEN ? AND ?",
        start,
        end,
      ),
    };
  });

  const fastMoving = grouped(
    db,
    `SELECT dl.product_id, p.name, COALESCE(SUM(dl.quantity_milli), 0) AS quantity_milli,
            COALESCE(SUM(dl.net_fils), 0) AS value
       FROM document_lines dl
       JOIN documents d ON d.id = dl.document_id
       JOIN products p ON p.id = dl.product_id
      WHERE d.kind = 'invoice' AND d.status <> 'cancelled'
        AND d.issue_date BETWEEN ? AND ? AND dl.product_id IS NOT NULL
      GROUP BY dl.product_id, p.name
      ORDER BY quantity_milli DESC
      LIMIT 8`,
    period.fromDate,
    period.toDate,
  ).map((row) => ({
    productId: Number(row.product_id),
    name: String(row.name ?? ""),
    quantityMilli: Number(row.quantity_milli ?? 0),
    valueFils: Math.round(Number(row.value ?? 0)),
  }));

  const slowMoving = grouped(
    db,
    `SELECT p.id AS product_id, p.name, p.quantity_milli,
            ROUND(p.quantity_milli * p.average_cost_fils / 1000.0) AS value,
            (SELECT MAX(d.issue_date) FROM document_lines dl
               JOIN documents d ON d.id = dl.document_id
              WHERE dl.product_id = p.id AND d.kind = 'invoice' AND d.status <> 'cancelled') AS last_sold
       FROM products p
      WHERE p.is_service = 0 AND p.quantity_milli > 0
        AND (last_sold IS NULL OR last_sold < date(?, '-90 day'))
      ORDER BY value DESC
      LIMIT 8`,
    period.toDate,
  ).map((row) => ({
    productId: Number(row.product_id),
    name: String(row.name ?? ""),
    quantityMilli: Number(row.quantity_milli ?? 0),
    valueFils: Math.round(Number(row.value ?? 0)),
    lastSoldOn: row.last_sold === null ? null : String(row.last_sold),
  }));

  const lowStock = overview
    .filter((row) => row.isLow || row.isOut)
    .slice(0, 8)
    .map((row) => ({
      productId: row.productId,
      name: row.name,
      sku: row.sku,
      onHandMilli: row.onHandMilli,
      reorderPointMilli: row.reorderPointMilli,
    }));

  const recentMovements = grouped(
    db,
    `SELECT sm.id, sm.movement_date, p.name AS product_name, sm.kind, sm.quantity_milli,
            l.name AS location_name
       FROM stock_movements sm
       JOIN products p ON p.id = sm.product_id
       LEFT JOIN ims_locations l ON l.id = sm.location_id
      ORDER BY sm.movement_date DESC, sm.id DESC
      LIMIT 12`,
  ).map((row) => ({
    id: Number(row.id),
    movementDate: String(row.movement_date ?? ""),
    productName: String(row.product_name ?? ""),
    kind: String(row.kind ?? ""),
    quantityMilli: Number(row.quantity_milli ?? 0),
    locationName: row.location_name === null ? null : String(row.location_name),
    sourceNumber: null,
  }));

  const pendingApprovals = grouped(
    db,
    `SELECT d.id, d.number, d.kind, p.name AS party_name, d.total_fils, d.issue_date
       FROM ims_documents d
       LEFT JOIN parties p ON p.id = d.party_id
      WHERE d.status = 'submitted'
      ORDER BY d.issue_date, d.id
      LIMIT 8`,
  ).map((row) => ({
    id: Number(row.id),
    number: String(row.number ?? ""),
    kind: String(row.kind ?? ""),
    partyName: row.party_name === null ? null : String(row.party_name),
    totalFils: Number(row.total_fils ?? 0),
    issueDate: String(row.issue_date ?? ""),
  }));

  const pendingReceipts = grouped(
    db,
    `SELECT d.id, d.number, p.name AS party_name, d.due_date,
            SUM(CASE WHEN l.processed_milli < l.quantity_milli THEN 1 ELSE 0 END) AS outstanding_lines
       FROM ims_documents d
       LEFT JOIN parties p ON p.id = d.party_id
       LEFT JOIN ims_document_lines l ON l.document_id = d.id
      WHERE d.kind = 'purchaseOrder' AND d.status IN ('approved','sent','partiallyReceived')
      GROUP BY d.id
      ORDER BY d.due_date IS NULL, d.due_date
      LIMIT 8`,
  ).map((row) => ({
    id: Number(row.id),
    number: String(row.number ?? ""),
    partyName: row.party_name === null ? null : String(row.party_name),
    dueDate: row.due_date === null ? null : String(row.due_date),
    outstandingLines: Number(row.outstanding_lines ?? 0),
  }));

  const recentSales = grouped(
    db,
    `SELECT d.id, d.number, p.name AS party_name, d.issue_date, d.gross_fils
       FROM documents d LEFT JOIN parties p ON p.id = d.party_id
      WHERE d.kind = 'invoice' AND d.status <> 'cancelled'
      ORDER BY d.issue_date DESC, d.id DESC LIMIT 8`,
  ).map((row) => ({
    id: Number(row.id),
    number: String(row.number ?? ""),
    partyName: row.party_name === null ? null : String(row.party_name),
    issueDate: String(row.issue_date ?? ""),
    totalFils: Number(row.gross_fils ?? 0),
  }));

  const replenishment = replenishmentRows(db, {
    ...(request.locationId !== undefined ? { locationId: request.locationId } : {}),
    limit: 8,
  });

  const statusMix = grouped(
    db,
    `SELECT stock_status AS status, COUNT(DISTINCT product_id) AS count,
            COALESCE(SUM(ROUND(quantity_milli * unit_cost_fils / 1000.0)), 0) AS value
       FROM stock_movements
      GROUP BY stock_status`,
  ).map((row) => ({
    status: String(row.status ?? ""),
    count: Number(row.count ?? 0),
    valueFils: Math.round(Number(row.value ?? 0)),
  }));

  const lowStockTrend: { date: string; count: number }[] = [];
  const trendDays = 14;
  for (let offset = trendDays - 1; offset >= 0; offset -= 1) {
    const date = new Date(`${period.toDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - offset);
    lowStockTrend.push({ date: date.toISOString().slice(0, 10), count: lowStockCount });
  }

  const exceptions: Array<ImsDashboardDto["exceptions"][number]> = [];
  if (outOfStockCount > 0) {
    exceptions.push({
      kind: "outOfStock",
      message: `${String(outOfStockCount)} item(s) have no sellable stock.`,
      severity: "danger",
    });
  }
  if (lowStockCount > 0) {
    exceptions.push({
      kind: "lowStock",
      message: `${String(lowStockCount)} item(s) are at or below their reorder point.`,
      severity: "warning",
    });
  }
  const expired = listBatches(db, { expiringDays: 0, limit: 5000 }).filter((batch) => batch.expired).length;
  if (expired > 0) {
    exceptions.push({
      kind: "expiredBatches",
      message: `${String(expired)} batch(es) are past their expiry date.`,
      severity: "danger",
    });
  }
  const quarantine = scalar(
    db,
    "SELECT COALESCE(SUM(quantity_milli), 0) AS n FROM stock_movements WHERE stock_status = 'quarantine'",
  );
  if (quarantine > 0) {
    exceptions.push({
      kind: "quarantine",
      message: `${String(Math.round(quarantine / 1000))} unit(s) are held in quarantine.`,
      severity: "warning",
    });
  }

  return {
    period,
    kpis: {
      activeProducts,
      skus,
      onHandMilli: onHand,
      availableMilli: available,
      reservedMilli: reserved,
      valuationFils: valuation,
      lowStockCount,
      outOfStockCount,
      pendingPurchaseOrders,
      pendingGoodsReceipts,
      salesFils,
      purchasesFils,
    },
    inventoryValueSeries,
    stockFlowSeries: stockFlow,
    categoryMix,
    purchaseSalesSeries,
    fastMoving,
    slowMoving,
    lowStockTrend,
    stockStatusMix: statusMix,
    lowStock,
    recentMovements,
    pendingApprovals,
    pendingReceipts,
    recentSales,
    replenishment,
    exceptions,
    generatedAtIso: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* reports                                                                    */
/* -------------------------------------------------------------------------- */

interface ReportSpec {
  readonly title: string;
  readonly columns: readonly ImsReportColumn[];
  readonly sql: string;
  readonly params: readonly (string | number)[];
}

const COL = {
  sku: { id: "sku", label: "SKU", type: "text" },
  product: { id: "product", label: "Product", type: "text" },
  category: { id: "category", label: "Category", type: "text" },
  brand: { id: "brand", label: "Brand", type: "text" },
  location: { id: "location", label: "Location", type: "text" },
  onHand: { id: "onHand", label: "On hand", type: "quantity", align: "end" },
  reserved: { id: "reserved", label: "Reserved", type: "quantity", align: "end" },
  available: { id: "available", label: "Available", type: "quantity", align: "end" },
  inTransit: { id: "inTransit", label: "In transit", type: "quantity", align: "end" },
  quarantine: { id: "quarantine", label: "Quarantine", type: "quantity", align: "end" },
  damaged: { id: "damaged", label: "Damaged", type: "quantity", align: "end" },
  cost: { id: "cost", label: "Unit cost", type: "money", align: "end" },
  value: { id: "value", label: "Value", type: "money", align: "end" },
  reorder: { id: "reorder", label: "Reorder point", type: "quantity", align: "end" },
  date: { id: "date", label: "Date", type: "date" },
  number: { id: "number", label: "Number", type: "text" },
  party: { id: "party", label: "Party", type: "text" },
  status: { id: "status", label: "Status", type: "text" },
  total: { id: "total", label: "Total", type: "money", align: "end" },
  quantity: { id: "quantity", label: "Quantity", type: "quantity", align: "end" },
  amount: { id: "amount", label: "Amount", type: "money", align: "end" },
  net: { id: "net", label: "Net", type: "money", align: "end" },
  vat: { id: "vat", label: "VAT", type: "money", align: "end" },
  costTotal: { id: "costTotal", label: "Cost", type: "money", align: "end" },
  margin: { id: "margin", label: "Margin", type: "money", align: "end" },
  kind: { id: "kind", label: "Type", type: "text" },
  reference: { id: "reference", label: "Reference", type: "text" },
  days: { id: "days", label: "Days", type: "number", align: "end" },
  expiry: { id: "expiry", label: "Expiry", type: "date" },
  batch: { id: "batch", label: "Batch", type: "text" },
  serial: { id: "serial", label: "Serial", type: "text" },
  balance: { id: "balance", label: "Balance", type: "money", align: "end" },
} as const satisfies Record<string, ImsReportColumn>;

function stockBase(request: ImsReportRequest): { where: string; params: (string | number)[] } {
  const clauses = ["p.is_service = 0"];
  const params: (string | number)[] = [];
  if (request.category !== undefined && request.category !== "") {
    clauses.push("p.category = ?");
    params.push(request.category);
  }
  if (request.search !== undefined && request.search !== "") {
    clauses.push("(p.name LIKE ? OR p.sku LIKE ?)");
    params.push(`%${request.search}%`, `%${request.search}%`);
  }
  return { where: clauses.join(" AND "), params };
}

function documentBase(
  request: ImsReportRequest,
  kind: "invoice" | "purchaseInvoice",
  alias = "d",
): { where: string; params: (string | number)[] } {
  const period = periodOf(request);
  const clauses = [`${alias}.kind = ?`, `${alias}.status <> 'cancelled'`, `${alias}.issue_date BETWEEN ? AND ?`];
  const params: (string | number)[] = [kind, period.fromDate, period.toDate];
  if (request.partyId !== undefined) {
    clauses.push(`${alias}.party_id = ?`);
    params.push(request.partyId);
  }
  if (request.search !== undefined && request.search !== "") {
    clauses.push(`(${alias}.number LIKE ? OR p.name LIKE ?)`);
    params.push(`%${request.search}%`, `%${request.search}%`);
  }
  return { where: clauses.join(" AND "), params };
}

function reportSpec(db: SqliteDatabase, request: ImsReportRequest): ReportSpec {
  const period = periodOf(request);
  const stock = stockBase(request);

  switch (request.report) {
    case "currentStock":
    case "availableStock":
    case "lowStock":
    case "outOfStock":
    case "stockValuation": {
      const extra =
        request.report === "lowStock"
          ? " AND COALESCE((SELECT SUM(sm.quantity_milli) FROM stock_movements sm WHERE sm.product_id = p.id AND sm.stock_status = 'available'), 0) <= p.reorder_level_milli"
          : request.report === "outOfStock"
            ? " AND COALESCE((SELECT SUM(sm.quantity_milli) FROM stock_movements sm WHERE sm.product_id = p.id AND sm.stock_status = 'available'), 0) <= 0"
            : "";
      const title =
        request.report === "currentStock"
          ? "Current stock"
          : request.report === "availableStock"
            ? "Available stock"
            : request.report === "lowStock"
              ? "Low stock"
              : request.report === "outOfStock"
                ? "Out of stock"
                : "Stock valuation";
      const columns =
        request.report === "stockValuation"
          ? [COL.sku, COL.product, COL.category, COL.onHand, COL.cost, COL.value]
          : request.report === "availableStock"
            ? [COL.sku, COL.product, COL.category, COL.onHand, COL.reserved, COL.available, COL.reorder]
            : [COL.sku, COL.product, COL.category, COL.brand, COL.onHand, COL.reorder];
      return {
        title,
        columns,
        sql: `
          SELECT p.sku, p.name AS product, p.category, p.brand,
                 COALESCE(SUM(CASE WHEN sm.stock_status <> 'inTransit' THEN sm.quantity_milli END), 0) AS onHand,
                 COALESCE(SUM(CASE WHEN sm.stock_status = 'available' THEN sm.quantity_milli END), 0)
                   - COALESCE((SELECT SUM(r.quantity_milli) FROM ims_reservations r WHERE r.product_id = p.id AND r.status = 'active'), 0) AS available,
                 COALESCE((SELECT SUM(r.quantity_milli) FROM ims_reservations r WHERE r.product_id = p.id AND r.status = 'active'), 0) AS reserved,
                 COALESCE(SUM(CASE WHEN sm.stock_status = 'quarantine' THEN sm.quantity_milli END), 0) AS quarantine,
                 COALESCE(SUM(CASE WHEN sm.stock_status = 'damaged' THEN sm.quantity_milli END), 0) AS damaged,
                 p.average_cost_fils AS cost,
                 ROUND(COALESCE(SUM(CASE WHEN sm.stock_status <> 'inTransit' THEN sm.quantity_milli END), 0) * p.average_cost_fils / 1000.0) AS value,
                 p.reorder_level_milli AS reorder
            FROM products p
            LEFT JOIN stock_movements sm ON sm.product_id = p.id
           WHERE ${stock.where}${extra}
           GROUP BY p.id
           ORDER BY p.name`,
        params: stock.params,
      };
    }

    case "stockByLocation": {
      const params = [...stock.params];
      let locationClause = "";
      if (request.locationId !== undefined) {
        locationClause = " AND sm.location_id = ?";
        params.push(request.locationId);
      }
      return {
        title: "Stock by location",
        columns: [COL.sku, COL.product, COL.location, COL.onHand, COL.available, COL.quarantine, COL.inTransit, COL.value],
        sql: `
          SELECT p.sku, p.name AS product, COALESCE(l.name, 'Main Store') AS location,
                 SUM(CASE WHEN sm.stock_status <> 'inTransit' THEN sm.quantity_milli ELSE 0 END) AS onHand,
                 SUM(CASE WHEN sm.stock_status = 'available' THEN sm.quantity_milli ELSE 0 END) AS available,
                 SUM(CASE WHEN sm.stock_status = 'quarantine' THEN sm.quantity_milli ELSE 0 END) AS quarantine,
                 SUM(CASE WHEN sm.stock_status = 'inTransit' THEN sm.quantity_milli ELSE 0 END) AS inTransit,
                 ROUND(SUM(CASE WHEN sm.stock_status <> 'inTransit' THEN sm.quantity_milli ELSE 0 END) * p.average_cost_fils / 1000.0) AS value
            FROM products p
            JOIN stock_movements sm ON sm.product_id = p.id
            LEFT JOIN ims_locations l ON l.id = sm.location_id
           WHERE ${stock.where}${locationClause}
           GROUP BY p.id, COALESCE(l.name, 'Main Store')
           ORDER BY p.name, location`,
        params,
      };
    }

    case "stockLedger":
    case "stockMovement": {
      const params: (string | number)[] = [period.fromDate, period.toDate];
      let more = "";
      if (request.locationId !== undefined) {
        more += " AND sm.location_id = ?";
        params.push(request.locationId);
      }
      if (request.search !== undefined && request.search !== "") {
        more += " AND (p.name LIKE ? OR p.sku LIKE ?)";
        params.push(`%${request.search}%`, `%${request.search}%`);
      }
      return {
        title: request.report === "stockLedger" ? "Stock ledger" : "Stock movements",
        columns: [COL.date, COL.sku, COL.product, COL.location, COL.kind, COL.quantity, COL.cost, COL.value, COL.reference],
        sql: `
          SELECT sm.movement_date AS date, p.sku, p.name AS product,
                 COALESCE(l.name, 'Main Store') AS location, sm.kind,
                 sm.quantity_milli AS quantity, sm.unit_cost_fils AS cost, sm.cost_fils AS value,
                 COALESCE(d.number, sm.notes) AS reference
            FROM stock_movements sm
            JOIN products p ON p.id = sm.product_id
            LEFT JOIN ims_locations l ON l.id = sm.location_id
            LEFT JOIN documents d ON d.id = sm.document_id
           WHERE sm.movement_date BETWEEN ? AND ?${more}
           ORDER BY sm.movement_date DESC, sm.id DESC
           LIMIT 5000`,
        params,
      };
    }

    case "stockAging": {
      return {
        title: "Stock aging",
        columns: [COL.sku, COL.product, COL.onHand, COL.value, COL.date, COL.days],
        sql: `
          SELECT p.sku, p.name AS product,
                 COALESCE(SUM(sm.quantity_milli), 0) AS onHand,
                 ROUND(COALESCE(SUM(sm.quantity_milli), 0) * p.average_cost_fils / 1000.0) AS value,
                 MAX(sm.movement_date) AS date,
                 CAST(julianday(?) - julianday(MAX(sm.movement_date)) AS INTEGER) AS days
            FROM products p
            LEFT JOIN stock_movements sm ON sm.product_id = p.id AND sm.quantity_milli > 0
           WHERE ${stock.where}
           GROUP BY p.id HAVING COALESCE(SUM(sm.quantity_milli), 0) > 0
           ORDER BY days DESC`,
        params: [...stock.params, period.toDate],
      };
    }

    case "slowMoving":
    case "deadStock": {
      const days = request.report === "deadStock" ? 365 : 90;
      return {
        title: request.report === "deadStock" ? "Dead stock" : "Slow moving stock",
        columns: [COL.sku, COL.product, COL.onHand, COL.value, COL.date, COL.days],
        sql: `
          SELECT p.sku, p.name AS product, p.quantity_milli AS onHand,
                 ROUND(p.quantity_milli * p.average_cost_fils / 1000.0) AS value,
                 last_sold AS date,
                 COALESCE(CAST(julianday(?) - julianday(last_sold) AS INTEGER), 99999) AS days
            FROM (
              SELECT p.*, (SELECT MAX(d.issue_date)
                             FROM document_lines dl JOIN documents d ON d.id = dl.document_id
                            WHERE dl.product_id = p.id AND d.kind = 'invoice' AND d.status <> 'cancelled') AS last_sold
                FROM products p WHERE ${stock.where}
            ) p
           WHERE p.quantity_milli > 0
             AND (last_sold IS NULL OR last_sold < date(?, '-${String(days)} day'))
           ORDER BY value DESC`,
        params: [...stock.params, period.toDate, period.toDate],
      };
    }

    case "reorderCandidates": {
      const rows = replenishmentRows(db, {
        ...(request.locationId !== undefined ? { locationId: request.locationId } : {}),
        ...(request.partyId !== undefined ? { supplierId: request.partyId } : {}),
        limit: 1000,
      }).map(toReplenishmentRow);
      return {
        title: "Reorder candidates",
        columns: [COL.sku, COL.product, COL.party, COL.onHand, COL.reserved, COL.available, COL.reorder, COL.quantity, COL.cost, COL.value],
        sql: "",
        params: [],
        ...{ precomputed: rows },
      } as ReportSpec & { precomputed: Record<string, string | number | null>[] };
    }

    case "stockAdjustments":
    case "stockCounts":
    case "purchaseOrderStatus":
    case "purchaseReceipts":
    case "supplierReturns": {
      const kind =
        request.report === "stockAdjustments"
          ? "purchaseAdjustment"
          : request.report === "stockCounts"
            ? "stockCount"
            : request.report === "purchaseOrderStatus"
              ? "purchaseOrder"
              : request.report === "purchaseReceipts"
                ? "goodsReceipt"
                : "supplierReturn";
      const title =
        request.report === "stockAdjustments"
          ? "Stock adjustments"
          : request.report === "stockCounts"
            ? "Stock counts"
            : request.report === "purchaseOrderStatus"
              ? "Purchase order status"
              : request.report === "purchaseReceipts"
                ? "Goods receipts"
                : "Supplier returns";
      return {
        title,
        columns: [COL.date, COL.number, COL.party, COL.status, COL.total, COL.reference],
        sql: `
          SELECT d.issue_date AS date, d.number, COALESCE(p.name, '') AS party,
                 d.status, d.total_fils AS total, COALESCE(d.reference, d.reason, '') AS reference
            FROM ims_documents d
            LEFT JOIN parties p ON p.id = d.party_id
           WHERE d.kind = ? AND d.issue_date BETWEEN ? AND ?
             ${request.status === undefined ? "" : "AND d.status = ?"}
           ORDER BY d.issue_date DESC, d.id DESC`,
        params:
          request.status === undefined
            ? [kind, period.fromDate, period.toDate]
            : [kind, period.fromDate, period.toDate, request.status],
      };
    }

    case "pendingReceipts": {
      return {
        title: "Pending receipts",
        columns: [COL.date, COL.number, COL.party, COL.status, COL.quantity, COL.total],
        sql: `
          SELECT d.issue_date AS date, d.number, COALESCE(p.name, '') AS party, d.status,
                 SUM(l.quantity_milli - l.processed_milli) AS quantity, d.total_fils AS total
            FROM ims_documents d
            LEFT JOIN parties p ON p.id = d.party_id
            JOIN ims_document_lines l ON l.document_id = d.id
           WHERE d.kind = 'purchaseOrder' AND d.status IN ('approved','sent','partiallyReceived')
             AND l.processed_milli < l.quantity_milli
           GROUP BY d.id
           ORDER BY d.issue_date`,
        params: [],
      };
    }

    case "batchTrace":
    case "expiry": {
      const batches = listBatches(db, {
        ...(request.search !== undefined && request.search !== "" ? { search: request.search } : {}),
        ...(request.report === "expiry" ? { expiringDays: 90 } : {}),
        limit: 5000,
      });
      return {
        title: request.report === "expiry" ? "Expiry report" : "Batch trace",
        columns: [COL.batch, COL.sku, COL.product, COL.quantity, COL.expiry, COL.days, COL.value],
        sql: "",
        params: [],
        ...{
          precomputed: batches.map((batch) => ({
            batch: batch.batchNo,
            sku: batch.sku,
            product: batch.productName,
            quantity: batch.quantityMilli,
            expiry: batch.expiryDate,
            days: batch.daysToExpiry,
            value: batch.valueFils,
          })),
        },
      } as ReportSpec & { precomputed: Record<string, string | number | null>[] };
    }

    case "purchaseSummary":
    case "salesSummary": {
      const kind = request.report === "purchaseSummary" ? "purchaseInvoice" : "invoice";
      const base = documentBase(request, kind);
      return {
        title: request.report === "purchaseSummary" ? "Purchase summary" : "Sales summary",
        columns: [COL.date, COL.number, COL.party, COL.status, COL.net, COL.vat, COL.total, COL.balance],
        sql: `
          SELECT d.issue_date AS date, d.number, COALESCE(p.name, '') AS party, d.status,
                 d.net_fils AS net, d.vat_fils AS vat, d.gross_fils AS total,
                 (d.gross_fils - d.paid_fils) AS balance
            FROM documents d
            LEFT JOIN parties p ON p.id = d.party_id
           WHERE ${base.where}
           ORDER BY d.issue_date DESC, d.id DESC`,
        params: base.params,
      };
    }

    case "salesByProduct":
    case "salesByCategory":
    case "cogsMargin": {
      const base = documentBase(request, "invoice");
      const byCategory = request.report === "salesByCategory";
      const columns =
        request.report === "cogsMargin"
          ? [COL.sku, COL.product, COL.quantity, COL.net, COL.costTotal, COL.margin]
          : byCategory
            ? [{ id: "category", label: "Category", type: "text" as const }, COL.quantity, COL.net, COL.vat, COL.total]
            : [COL.sku, COL.product, COL.quantity, COL.net, COL.vat, COL.total];
      return {
        title:
          request.report === "salesByProduct"
            ? "Sales by product"
            : request.report === "salesByCategory"
              ? "Sales by category"
              : "Cost of goods and margin",
        columns,
        sql: byCategory
          ? `
            SELECT COALESCE(NULLIF(p.category, ''), 'Uncategorised') AS category,
                   SUM(dl.quantity_milli) AS quantity, SUM(dl.net_fils) AS net,
                   SUM(dl.vat_fils) AS vat, SUM(dl.net_fils + dl.vat_fils) AS total
              FROM document_lines dl
              JOIN documents d ON d.id = dl.document_id
              LEFT JOIN products p ON p.id = dl.product_id
             WHERE ${base.where}
             GROUP BY COALESCE(NULLIF(p.category, ''), 'Uncategorised')
             ORDER BY total DESC`
          : `
            SELECT p.sku, COALESCE(p.name, dl.description) AS product,
                   SUM(dl.quantity_milli) AS quantity, SUM(dl.net_fils) AS net,
                   SUM(dl.vat_fils) AS vat, SUM(dl.net_fils + dl.vat_fils) AS total,
                   SUM(dl.cost_fils) AS costTotal, SUM(dl.net_fils - dl.cost_fils) AS margin
              FROM document_lines dl
              JOIN documents d ON d.id = dl.document_id
              LEFT JOIN products p ON p.id = dl.product_id
             WHERE ${base.where}
             GROUP BY COALESCE(p.id, dl.description)
             ORDER BY total DESC`,
        params: base.params,
      };
    }

    case "salesByCustomer":
    case "customerBalances": {
      const base = documentBase(request, "invoice");
      if (request.report === "customerBalances") {
        return {
          title: "Customer balances",
          columns: [COL.party, COL.total, COL.amount, COL.balance],
          sql: `
            SELECT p.name AS party,
                   COALESCE(SUM(d.gross_fils), 0) AS total,
                   COALESCE(SUM(d.paid_fils), 0) AS amount,
                   COALESCE(SUM(d.gross_fils - d.paid_fils), 0) + p.opening_balance AS balance
              FROM parties p
              LEFT JOIN documents d ON d.party_id = p.id AND d.kind = 'invoice' AND d.status <> 'cancelled'
             WHERE p.kind IN ('customer','both')
             GROUP BY p.id HAVING balance <> 0
             ORDER BY balance DESC`,
          params: [],
        };
      }
      return {
        title: "Sales by customer",
        columns: [COL.party, COL.total, COL.amount, COL.balance],
        sql: `
          SELECT COALESCE(p.name, 'Walk-in') AS party,
                 SUM(d.gross_fils) AS total, SUM(d.paid_fils) AS amount,
                 SUM(d.gross_fils - d.paid_fils) AS balance
            FROM documents d LEFT JOIN parties p ON p.id = d.party_id
           WHERE ${base.where}
           GROUP BY d.party_id ORDER BY total DESC`,
        params: base.params,
      };
    }

    case "supplierPurchaseHistory":
    case "supplierPerformance": {
      const base = documentBase(request, "purchaseInvoice");
      return {
        title: request.report === "supplierPerformance" ? "Supplier performance" : "Supplier purchase history",
        columns: [COL.party, COL.total, COL.amount, COL.balance],
        sql: `
          SELECT COALESCE(p.name, '') AS party, SUM(d.gross_fils) AS total,
                 SUM(d.paid_fils) AS amount, SUM(d.gross_fils - d.paid_fils) AS balance
            FROM documents d LEFT JOIN parties p ON p.id = d.party_id
           WHERE ${base.where}
           GROUP BY d.party_id ORDER BY total DESC`,
        params: base.params,
      };
    }

    case "purchasePriceVariance": {
      const base = documentBase(request, "purchaseInvoice");
      return {
        title: "Purchase price variance",
        columns: [COL.date, COL.number, COL.sku, COL.product, COL.quantity, COL.cost, COL.costTotal],
        sql: `
          SELECT d.issue_date AS date, d.number, p.sku, COALESCE(p.name, dl.description) AS product,
                 dl.quantity_milli AS quantity, dl.unit_price_fils AS cost,
                 (dl.quantity_milli * dl.unit_price_fils / 1000.0) AS costTotal
            FROM document_lines dl
            JOIN documents d ON d.id = dl.document_id
            LEFT JOIN products p ON p.id = dl.product_id
           WHERE ${base.where}
           ORDER BY d.issue_date DESC, d.id DESC`,
        params: base.params,
      };
    }

    case "posSales": {
      return {
        title: "POS sales",
        sql: `
          SELECT d.issue_date AS date, d.number, COALESCE(p.name, 'Walk-in') AS party,
                 d.status, ps.method, ps.total_fils AS total
            FROM ims_pos_sales ps
            JOIN documents d ON d.id = ps.document_id
            LEFT JOIN parties p ON p.id = d.party_id
           WHERE d.issue_date BETWEEN ? AND ?
           ORDER BY ps.created_at DESC`,
        params: [period.fromDate, period.toDate],
        columns: [COL.date, COL.number, COL.party, COL.status, COL.kind, COL.total],
      };
    }

    case "salesReturns": {
      return reportSpec(db, { ...request, report: "supplierReturns" }) satisfies ReportSpec;
    }

    case "discounts": {
      const base = documentBase(request, "invoice");
      return {
        title: "Discounts",
        columns: [COL.date, COL.number, COL.party, COL.total, COL.amount],
        sql: `
          SELECT d.issue_date AS date, d.number, COALESCE(p.name, '') AS party,
                 d.gross_fils AS total, d.discount_fils AS amount
            FROM documents d LEFT JOIN parties p ON p.id = d.party_id
           WHERE ${base.where} AND d.discount_fils > 0
           ORDER BY amount DESC`,
        params: base.params,
      };
    }

    case "expenseSummary":
    case "expenseByCategory": {
      return {
        title: request.report === "expenseByCategory" ? "Expenses by category" : "Expense summary",
        columns: [COL.category, COL.amount],
        sql: `
          SELECT category, SUM(amount_fils + vat_fils) AS amount
            FROM expenses
           WHERE expense_date BETWEEN ? AND ?
           GROUP BY category ORDER BY amount DESC`,
        params: [period.fromDate, period.toDate],
      };
    }

    case "paymentCollection":
    case "supplierPayments": {
      const direction = request.report === "paymentCollection" ? "inbound" : "outbound";
      return {
        title: request.report === "paymentCollection" ? "Payment collection" : "Supplier payments",
        columns: [COL.date, COL.party, COL.kind, COL.amount],
        sql: `
          SELECT pm.payment_date AS date, p.name AS party, pm.method AS kind, pm.amount_fils AS amount
            FROM payments pm JOIN parties p ON p.id = pm.party_id
           WHERE pm.direction = ? AND pm.payment_date BETWEEN ? AND ?
           ORDER BY pm.payment_date DESC`,
        params: [direction, period.fromDate, period.toDate],
      };
    }

    case "outstandingBalances": {
      return {
        title: "Outstanding balances",
        columns: [COL.date, COL.number, COL.party, COL.kind, COL.total, COL.amount, COL.balance],
        sql: `
          SELECT d.issue_date AS date, d.number, COALESCE(p.name, '') AS party, d.kind,
                 d.gross_fils AS total, d.paid_fils AS amount, (d.gross_fils - d.paid_fils) AS balance
            FROM documents d LEFT JOIN parties p ON p.id = d.party_id
           WHERE d.status IN ('issued','partPaid') AND d.gross_fils > d.paid_fils
           ORDER BY d.issue_date`,
        params: [],
      };
    }

    case "supplierReturns":
    default: {
      return {
        title: "Supplier returns",
        columns: [COL.date, COL.number, COL.party, COL.status, COL.total],
        sql: `
          SELECT d.issue_date AS date, d.number, COALESCE(p.name, '') AS party, d.status, d.total_fils AS total
            FROM ims_documents d LEFT JOIN parties p ON p.id = d.party_id
           WHERE d.kind = 'supplierReturn' AND d.issue_date BETWEEN ? AND ?
           ORDER BY d.issue_date DESC`,
        params: [period.fromDate, period.toDate],
      };
    }
  }
}

function toReplenishmentRow(row: ReplenishmentRow): Record<string, string | number | null> {
  return {
    sku: row.sku,
    product: row.name,
    party: row.supplierName,
    onHand: row.onHandMilli,
    reserved: row.reservedMilli,
    available: row.eligibleMilli,
    reorder: row.reorderPointMilli,
    quantity: row.suggestedMilli,
    cost: row.lastCostFils,
    value: row.suggestedValueFils,
  };
}

export function runReport(db: SqliteDatabase, request: ImsReportRequest): ImsReportDto {
  const period = periodOf(request);
  const spec = reportSpec(db, request);
  const precomputed = (spec as ReportSpec & { precomputed?: Record<string, string | number | null>[] })
    .precomputed;
  const rows = precomputed ?? grouped(db, spec.sql, ...spec.params);

  const totals: Record<string, number> = {};
  for (const column of spec.columns) {
    if (column.type === "money" || column.type === "quantity" || column.type === "number") {
      totals[column.id] = rows.reduce((sum, row) => {
        const value = row[column.id];
        return sum + (typeof value === "number" ? value : 0);
      }, 0);
    }
  }

  return {
    report: request.report,
    title: spec.title,
    period,
    columns: spec.columns,
    rows,
    totals,
    generatedAtIso: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

export function reportTitles(): readonly { id: ImsReportId; title: string; group: string }[] {
  return [
    { id: "currentStock", title: "Current stock", group: "Stock" },
    { id: "availableStock", title: "Available stock", group: "Stock" },
    { id: "stockByLocation", title: "Stock by location", group: "Stock" },
    { id: "stockValuation", title: "Stock valuation", group: "Stock" },
    { id: "stockLedger", title: "Stock ledger", group: "Stock" },
    { id: "stockMovement", title: "Stock movement", group: "Stock" },
    { id: "stockAging", title: "Stock aging", group: "Stock" },
    { id: "slowMoving", title: "Slow moving", group: "Stock" },
    { id: "deadStock", title: "Dead stock", group: "Stock" },
    { id: "lowStock", title: "Low stock", group: "Stock" },
    { id: "outOfStock", title: "Out of stock", group: "Stock" },
    { id: "reorderCandidates", title: "Reorder candidates", group: "Stock" },
    { id: "stockAdjustments", title: "Stock adjustments", group: "Stock" },
    { id: "stockCounts", title: "Stock counts", group: "Stock" },
    { id: "batchTrace", title: "Batch trace", group: "Stock" },
    { id: "expiry", title: "Expiry", group: "Stock" },
    { id: "purchaseSummary", title: "Purchase summary", group: "Purchasing" },
    { id: "purchaseOrderStatus", title: "Purchase order status", group: "Purchasing" },
    { id: "purchaseReceipts", title: "Goods receipts", group: "Purchasing" },
    { id: "pendingReceipts", title: "Pending receipts", group: "Purchasing" },
    { id: "supplierPurchaseHistory", title: "Supplier purchase history", group: "Purchasing" },
    { id: "supplierPerformance", title: "Supplier performance", group: "Purchasing" },
    { id: "supplierReturns", title: "Supplier returns", group: "Purchasing" },
    { id: "purchasePriceVariance", title: "Purchase price variance", group: "Purchasing" },
    { id: "salesSummary", title: "Sales summary", group: "Sales" },
    { id: "salesByProduct", title: "Sales by product", group: "Sales" },
    { id: "salesByCustomer", title: "Sales by customer", group: "Sales" },
    { id: "salesByCategory", title: "Sales by category", group: "Sales" },
    { id: "posSales", title: "POS sales", group: "Sales" },
    { id: "salesReturns", title: "Sales returns", group: "Sales" },
    { id: "discounts", title: "Discounts", group: "Sales" },
    { id: "cogsMargin", title: "COGS and margin", group: "Sales" },
    { id: "customerBalances", title: "Customer balances", group: "Payments" },
    { id: "expenseSummary", title: "Expense summary", group: "Payments" },
    { id: "expenseByCategory", title: "Expenses by category", group: "Payments" },
    { id: "paymentCollection", title: "Payment collection", group: "Payments" },
    { id: "supplierPayments", title: "Supplier payments", group: "Payments" },
    { id: "outstandingBalances", title: "Outstanding balances", group: "Payments" },
  ];
}
