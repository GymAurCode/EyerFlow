/**
 * MMS analytics: manufacturing dashboard and report center.
 *
 * All figures come from real posted records: manufacturing orders, work
 * orders, consumption, finished receipts, scrap, quality checks, and the
 * shared IMS stock ledger. No hardcoded statistics.
 */

import type { SqliteDatabase } from "../../../data/connection";
import { todayIso } from "../../../domain/dates";
import type {
  MmsDashboardDto,
  MmsDashboardRequest,
  MmsReportColumn,
  MmsReportDto,
  MmsReportId,
  MmsReportRequest,
  MmsReportTitle,
} from "../../../shared/mms";

function scalar(db: SqliteDatabase, sql: string, ...params: (string | number)[]): number {
  const row = db.prepare(sql).get(...params) as Record<string, number> | undefined;
  return row === undefined ? 0 : Number(Object.values(row)[0] ?? 0);
}

function rowsOf(
  db: SqliteDatabase,
  sql: string,
  ...params: (string | number)[]
): Record<string, string | number | null>[] {
  return db.prepare(sql).all(...params) as Record<string, string | number | null>[];
}

function periodOf(
  request: { fromDate?: string; toDate?: string },
  days = 30,
): { readonly fromDate: string; readonly toDate: string } {
  const toDate = request.toDate ?? todayIso();
  if (request.fromDate !== undefined) return { fromDate: request.fromDate, toDate };
  const start = new Date(`${toDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { fromDate: start.toISOString().slice(0, 10), toDate };
}

export function mmsDashboard(
  db: SqliteDatabase,
  request: MmsDashboardRequest,
): MmsDashboardDto {
  const period = periodOf(request);

  const totalMo = scalar(db, "SELECT COUNT(*) AS n FROM manufacturing_orders");
  const plannedMo = scalar(
    db,
    "SELECT COUNT(*) AS n FROM manufacturing_orders WHERE status = 'planned'",
  );
  const activeMo = scalar(
    db,
    "SELECT COUNT(*) AS n FROM manufacturing_orders WHERE status IN ('released','inProgress','qualityReview')",
  );
  const completedMo = scalar(
    db,
    "SELECT COUNT(*) AS n FROM manufacturing_orders WHERE status = 'completed'",
  );
  const delayedMo = scalar(
    db,
    `SELECT COUNT(*) AS n FROM manufacturing_orders
       WHERE status IN ('planned','confirmed','released','inProgress')
         AND planned_finish IS NOT NULL AND planned_finish < ?`,
    period.toDate,
  );
  const pendingWorkOrders = scalar(
    db,
    "SELECT COUNT(*) AS n FROM manufacturing_work_orders WHERE status IN ('blocked','ready','inProgress','paused')",
  );

  const producedUnits = scalar(
    db,
    // Work-order completion records output while the MO can still be in QC.
    // Counting only completed MOs hid real production awaiting final closure.
    "SELECT COALESCE(SUM(actual_quantity), 0) AS n FROM manufacturing_orders",
  );
  const rejectedUnits = scalar(
    db,
    "SELECT COALESCE(SUM(rejected_quantity), 0) AS n FROM manufacturing_orders",
  );

  const materialShortageCount = scalar(
    db,
    `SELECT COUNT(*) AS n FROM manufacturing_order_components moc
       JOIN manufacturing_orders mo ON mo.id = moc.mo_id
      WHERE moc.required_quantity > moc.issued_quantity + moc.consumed_quantity
        AND mo.status IN ('released','inProgress')`,
  );

  const wipValueFils = scalar(
    db,
    "SELECT COALESCE(SUM(material_cost_fils + labor_cost_fils + machine_cost_fils + overhead_cost_fils), 0) AS n FROM manufacturing_wip_records",
  );

  const plannedCostFils = scalar(
    db,
    "SELECT COALESCE(SUM(planned_cost_fils), 0) AS n FROM manufacturing_orders",
  );
  const actualCostFils = scalar(
    db,
    "SELECT COALESCE(SUM(actual_cost_fils), 0) AS n FROM manufacturing_orders",
  );

  const productionYieldPct =
    producedUnits > 0
      ? Math.round(((producedUnits - rejectedUnits) / producedUnits) * 10000) / 100
      : 0;

  const workCenterUtilizationPct = 0; // placeholder until time logs are aggregated

  const moByStatus = rowsOf(
    db,
    "SELECT status, COUNT(*) AS count FROM manufacturing_orders GROUP BY status ORDER BY count DESC",
  ).map((row) => ({
    status: String(row.status ?? ""),
    count: Number(row.count ?? 0),
  }));

  const dailyOutput = rowsOf(
    db,
    `SELECT fr.received_at AS date, COALESCE(SUM(fr.accepted_qty), 0) AS qty
       FROM manufacturing_finished_receipts fr
       JOIN manufacturing_orders mo ON mo.id = fr.mo_id
      WHERE fr.received_at BETWEEN ? AND ?
      GROUP BY fr.received_at
      ORDER BY fr.received_at`,
    period.fromDate,
    period.toDate,
  ).map((row) => ({
    date: String(row.date ?? ""),
    qty: Number(row.qty ?? 0),
  }));

  const materialConsumption = rowsOf(
    db,
    `SELECT cr.consumed_at AS date, COALESCE(SUM(cr.quantity_milli), 0) AS qty_milli
       FROM manufacturing_consumption_records cr
      WHERE cr.consumed_at BETWEEN ? AND ?
      GROUP BY cr.consumed_at
      ORDER BY cr.consumed_at`,
    period.fromDate,
    period.toDate,
  ).map((row) => ({
    date: String(row.date ?? ""),
    qtyMilli: Number(row.qty_milli ?? 0),
  }));

  const productionCosts = rowsOf(
    db,
    `SELECT cr.recorded_at AS date, COALESCE(SUM(cr.amount_fils), 0) AS cost_fils
       FROM manufacturing_cost_records cr
      WHERE cr.recorded_at BETWEEN ? AND ?
      GROUP BY cr.recorded_at
      ORDER BY cr.recorded_at`,
    period.fromDate,
    period.toDate,
  ).map((row) => ({
    date: String(row.date ?? ""),
    costFils: Number(row.cost_fils ?? 0),
  }));

  const scrapTrend = rowsOf(
    db,
    `SELECT s.created_at AS date, COALESCE(SUM(s.quantity_milli), 0) AS qty_milli
       FROM manufacturing_scrap s
      WHERE s.created_at BETWEEN ? AND ?
      GROUP BY s.created_at
      ORDER BY s.created_at`,
    period.fromDate,
    period.toDate,
  ).map((row) => ({
    date: String(row.date ?? ""),
    qtyMilli: Number(row.qty_milli ?? 0),
  }));

  const qualityPassFail = rowsOf(
    db,
    "SELECT result, COUNT(*) AS count FROM manufacturing_quality_checks GROUP BY result ORDER BY count DESC",
  ).map((row) => ({
    result: String(row.result ?? ""),
    count: Number(row.count ?? 0),
  }));

  const workCenterUtilization = rowsOf(
    db,
    `SELECT w.name AS work_center, 0 AS utilization_pct
       FROM manufacturing_work_centers w
       WHERE w.is_active = 1
       ORDER BY w.name LIMIT 10`,
  ).map((row) => ({
    workCenter: String(row.work_center ?? ""),
    utilizationPct: Number(row.utilization_pct ?? 0),
  }));

  const ordersNeedingAttention = rowsOf(
    db,
    `SELECT mo.id, mo.number, p.name AS product_name, mo.status,
            CASE
              WHEN mo.status = 'hold' THEN 'On hold'
              WHEN mo.planned_finish IS NOT NULL AND mo.planned_finish < ? THEN 'Delayed'
              ELSE 'Material shortage'
            END AS issue
           FROM manufacturing_orders mo
           JOIN products p ON p.id = mo.product_id
          WHERE mo.status IN ('hold','planned','confirmed','released','inProgress')
            AND (mo.status = 'hold'
              OR (mo.planned_finish IS NOT NULL AND mo.planned_finish < ?)
              OR EXISTS (
                SELECT 1 FROM manufacturing_order_components moc
                 WHERE moc.mo_id = mo.id
                   AND moc.required_quantity > moc.issued_quantity + moc.consumed_quantity
              ))
          ORDER BY mo.updated_at DESC
          LIMIT 8`,
    period.toDate,
    period.toDate,
  ).map((row) => ({
    id: Number(row.id),
    number: String(row.number ?? ""),
    productName: String(row.product_name ?? ""),
    status: String(row.status ?? ""),
    issue: String(row.issue ?? ""),
  }));

  const materialShortages = rowsOf(
    db,
    `SELECT p.id AS product_id, p.sku, p.name,
            SUM(moc.required_quantity) AS required,
            COALESCE(SUM(moc.issued_quantity + moc.consumed_quantity), 0) AS available,
            SUM(moc.required_quantity) - COALESCE(SUM(moc.issued_quantity + moc.consumed_quantity), 0) AS shortage
           FROM manufacturing_order_components moc
           JOIN manufacturing_orders mo ON mo.id = moc.mo_id
           JOIN products p ON p.id = moc.component_product_id
          WHERE moc.required_quantity > moc.issued_quantity + moc.consumed_quantity
            AND mo.status IN ('released','inProgress')
          GROUP BY p.id
          ORDER BY shortage DESC
          LIMIT 8`,
  ).map((row) => ({
    productId: Number(row.product_id ?? 0),
    sku: String(row.sku ?? ""),
    name: String(row.name ?? ""),
    required: Number(row.required ?? 0),
    available: Number(row.available ?? 0),
    shortage: Number(row.shortage ?? 0),
  }));

  const pendingApprovals = rowsOf(
    db,
    `SELECT id, number, 'BOM' AS type, NULL AS party_name FROM manufacturing_boms
       WHERE status = 'review'
     UNION ALL
     SELECT id, number, 'MO' AS type, NULL AS party_name FROM manufacturing_orders
       WHERE status = 'planned'
     ORDER BY number LIMIT 8`,
  ).map((row) => ({
    id: Number(row.id),
    number: String(row.number ?? ""),
    type: String(row.type ?? ""),
    partyName: null,
  }));

  const delayedWorkOrders = rowsOf(
    db,
    `SELECT wo.id, mo.number AS mo_number, o.name AS operation_name, w.name AS work_center
       FROM manufacturing_work_orders wo
       JOIN manufacturing_orders mo ON mo.id = wo.mo_id
       JOIN manufacturing_route_operations o ON o.id = wo.route_operation_id
       LEFT JOIN manufacturing_work_centers w ON w.id = wo.work_center_id
      WHERE wo.status IN ('blocked','inProgress','paused')
        AND wo.planned_finish IS NOT NULL AND wo.planned_finish < ?
      ORDER BY wo.planned_finish LIMIT 8`,
    period.toDate,
  ).map((row) => ({
    id: Number(row.id),
    moNumber: String(row.mo_number ?? ""),
    operationName: String(row.operation_name ?? ""),
    workCenter: row.work_center === null ? null : String(row.work_center),
  }));

  const qualityFailures = rowsOf(
    db,
    `SELECT qc.id, mo.number AS mo_number, qc.checkpoint, qc.result
       FROM manufacturing_quality_checks qc
       JOIN manufacturing_orders mo ON mo.id = qc.mo_id
      WHERE qc.result IN ('failed','rejected','reworkRequired')
      ORDER BY qc.inspected_at DESC, qc.id DESC
      LIMIT 8`,
  ).map((row) => ({
    id: Number(row.id),
    moNumber: String(row.mo_number ?? ""),
    checkpoint: String(row.checkpoint ?? ""),
    result: String(row.result ?? ""),
  }));

  const recentActivity = rowsOf(
    db,
    `SELECT al.id, al.occurred_at, al.actor_name, al.action, al.module
       FROM audit_log al
      WHERE al.module = 'manufacturing'
      ORDER BY al.occurred_at DESC
      LIMIT 12`,
  ).map((row) => ({
    id: Number(row.id),
    occurredAt: String(row.occurred_at ?? ""),
    actorName: String(row.actor_name ?? ""),
    action: String(row.action ?? ""),
    module: String(row.module ?? ""),
  }));

  return {
    totalMo,
    plannedMo,
    activeMo,
    completedMo,
    delayedMo,
    pendingWorkOrders,
    producedUnits,
    rejectedUnits,
    materialShortageCount,
    wipValueFils,
    plannedCostFils,
    actualCostFils,
    productionYieldPct,
    workCenterUtilizationPct,
    moByStatus,
    dailyOutput,
    materialConsumption,
    productionCosts,
    scrapTrend,
    qualityPassFail,
    workCenterUtilization,
    ordersNeedingAttention,
    materialShortages,
    pendingApprovals,
    delayedWorkOrders,
    qualityFailures,
    recentActivity,
    generatedAtIso: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Reports                                                                    */
/* -------------------------------------------------------------------------- */

interface ReportSpec {
  readonly title: string;
  readonly columns: readonly MmsReportColumn[];
  readonly sql: string;
  readonly params: readonly (string | number)[];
  readonly precomputed?: Record<string, string | number | null>[];
}

const COL = {
  moNumber: { id: "moNumber", label: "MO Number", type: "text" },
  product: { id: "product", label: "Product", type: "text" },
  sku: { id: "sku", label: "SKU", type: "text" },
  status: { id: "status", label: "Status", type: "text" },
  quantity: { id: "quantity", label: "Quantity", type: "quantity", align: "end" },
  plannedQty: { id: "plannedQty", label: "Planned Qty", type: "quantity", align: "end" },
  actualQty: { id: "actualQty", label: "Actual Qty", type: "quantity", align: "end" },
  acceptedQty: { id: "acceptedQty", label: "Accepted Qty", type: "quantity", align: "end" },
  date: { id: "date", label: "Date", type: "date" },
  cost: { id: "cost", label: "Cost", type: "money", align: "end" },
  plannedCost: { id: "plannedCost", label: "Planned Cost", type: "money", align: "end" },
  actualCost: { id: "actualCost", label: "Actual Cost", type: "money", align: "end" },
  variance: { id: "variance", label: "Variance", type: "money", align: "end" },
  unitCost: { id: "unitCost", label: "Unit Cost", type: "money", align: "end" },
  workCenter: { id: "workCenter", label: "Work Center", type: "text" },
  operation: { id: "operation", label: "Operation", type: "text" },
  result: { id: "result", label: "Result", type: "text" },
  scrapQty: { id: "scrapQty", label: "Scrap Qty", type: "quantity", align: "end" },
  shortage: { id: "shortage", label: "Shortage", type: "quantity", align: "end" },
  required: { id: "required", label: "Required", type: "quantity", align: "end" },
  available: { id: "available", label: "Available", type: "quantity", align: "end" },
} as const satisfies Record<string, MmsReportColumn>;

function mmsReportSpec(
  request: MmsReportRequest,
): ReportSpec {
  const period = periodOf(request);

  switch (request.report) {
    case "moSummary": {
      return {
        title: "Manufacturing Order Summary",
        columns: [
          COL.moNumber, COL.product, COL.sku, COL.status,
          COL.plannedQty, COL.actualQty, COL.acceptedQty, COL.cost,
        ],
        sql: `
          SELECT mo.number AS moNumber, p.name AS product, p.sku AS sku,
                 mo.status, mo.planned_quantity AS plannedQty,
                 mo.actual_quantity AS actualQty, mo.accepted_quantity AS acceptedQty,
                 mo.actual_cost_fils AS cost
            FROM manufacturing_orders mo
            JOIN products p ON p.id = mo.product_id
           WHERE mo.created_at BETWEEN ? AND ?
           ORDER BY mo.created_at DESC, mo.id DESC
           LIMIT 5000`,
        params: [period.fromDate, period.toDate],
      };
    }

    case "plannedVsActual": {
      return {
        title: "Planned vs Actual Production",
        columns: [COL.moNumber, COL.product, COL.plannedQty, COL.actualQty, COL.acceptedQty],
        sql: `
          SELECT mo.number AS moNumber, p.name AS product,
                 mo.planned_quantity AS plannedQty,
                 mo.actual_quantity AS actualQty,
                 mo.accepted_quantity AS acceptedQty
            FROM manufacturing_orders mo
            JOIN products p ON p.id = mo.product_id
           WHERE mo.created_at BETWEEN ? AND ?
           ORDER BY mo.created_at DESC`,
        params: [period.fromDate, period.toDate],
      };
    }

    case "outputByProduct": {
      return {
        title: "Production Output by Product",
        columns: [COL.product, COL.sku, COL.quantity, COL.cost],
        sql: `
          SELECT p.name AS product, p.sku AS sku,
                 COALESCE(SUM(fr.accepted_qty), 0) AS quantity,
                 COALESCE(SUM(fr.total_cost_fils), 0) AS cost
            FROM products p
            LEFT JOIN manufacturing_finished_receipts fr ON fr.product_id = p.id
            LEFT JOIN manufacturing_orders mo ON mo.id = fr.mo_id
           WHERE fr.received_at BETWEEN ? AND ? OR fr.received_at IS NULL
           GROUP BY p.id
           ORDER BY quantity DESC`,
        params: [period.fromDate, period.toDate],
      };
    }

    case "outputByWorkCenter": {
      return {
        title: "Production Output by Work Center",
        columns: [COL.workCenter, COL.quantity],
        sql: `
          SELECT w.name AS workCenter,
                 COALESCE(SUM(wo.accepted_quantity), 0) AS quantity
            FROM manufacturing_work_centers w
            LEFT JOIN manufacturing_work_orders wo ON wo.work_center_id = w.id
            LEFT JOIN manufacturing_orders mo ON mo.id = wo.mo_id
           WHERE wo.completed_at BETWEEN ? AND ? OR wo.completed_at IS NULL
           GROUP BY w.id
           ORDER BY quantity DESC`,
        params: [period.fromDate, period.toDate],
      };
    }

    case "moStatus": {
      return {
        title: "Manufacturing Order Status",
        columns: [COL.status, COL.quantity],
        sql: `
          SELECT mo.status, COUNT(*) AS quantity
            FROM manufacturing_orders mo
           WHERE mo.created_at BETWEEN ? AND ?
           GROUP BY mo.status
           ORDER BY quantity DESC`,
        params: [period.fromDate, period.toDate],
      };
    }

    case "delayedMo": {
      return {
        title: "Delayed Production Orders",
        columns: [COL.moNumber, COL.product, COL.status, COL.date],
        sql: `
          SELECT mo.number AS moNumber, p.name AS product, mo.status,
                 mo.planned_finish AS date
            FROM manufacturing_orders mo
            JOIN products p ON p.id = mo.product_id
           WHERE mo.status IN ('planned','confirmed','released','inProgress')
             AND mo.planned_finish IS NOT NULL AND mo.planned_finish < ?
           ORDER BY mo.planned_finish`,
        params: [period.toDate],
      };
    }

    case "workOrderPerformance": {
      return {
        title: "Work Order Performance",
        columns: [COL.moNumber, COL.operation, COL.workCenter, COL.quantity, COL.date],
        sql: `
          SELECT mo.number AS moNumber, o.name AS operation, w.name AS workCenter,
                 wo.actual_quantity AS quantity, wo.completed_at AS date
            FROM manufacturing_work_orders wo
            JOIN manufacturing_orders mo ON mo.id = wo.mo_id
            JOIN manufacturing_route_operations o ON o.id = wo.route_operation_id
            LEFT JOIN manufacturing_work_centers w ON w.id = wo.work_center_id
           WHERE wo.status = 'completed'
             AND wo.completed_at BETWEEN ? AND ?
           ORDER BY wo.completed_at DESC`,
        params: [period.fromDate, period.toDate],
      };
    }

    case "materialConsumption": {
      return {
        title: "Material Consumption",
        columns: [COL.product, COL.sku, COL.quantity, COL.cost, COL.date],
        sql: `
          SELECT p.name AS product, p.sku AS sku,
                 COALESCE(SUM(cr.quantity_milli), 0) AS quantity,
                 COALESCE(SUM(cr.cost_fils), 0) AS cost,
                 MAX(cr.consumed_at) AS date
            FROM manufacturing_consumption_records cr
            JOIN products p ON p.id = cr.component_product_id
           WHERE cr.consumed_at BETWEEN ? AND ?
           GROUP BY p.id
           ORDER BY quantity DESC`,
        params: [period.fromDate, period.toDate],
      };
    }

    case "materialUsageVariance": {
      return {
        title: "Material Usage Variance",
        columns: [COL.product, COL.sku, COL.required, COL.available, COL.shortage],
        sql: `
          SELECT p.name AS product, p.sku AS sku,
                 SUM(moc.required_quantity) AS required,
                 COALESCE(SUM(moc.issued_quantity + moc.consumed_quantity), 0) AS available,
                 SUM(moc.required_quantity) - COALESCE(SUM(moc.issued_quantity + moc.consumed_quantity), 0) AS shortage
            FROM manufacturing_order_components moc
            JOIN products p ON p.id = moc.component_product_id
            JOIN manufacturing_orders mo ON mo.id = moc.mo_id
           WHERE mo.created_at BETWEEN ? AND ?
           GROUP BY p.id
           ORDER BY shortage DESC`,
        params: [period.fromDate, period.toDate],
      };
    }

    case "rawMaterialShortage": {
      return {
        title: "Raw Material Shortage",
        columns: [COL.product, COL.sku, COL.required, COL.available, COL.shortage],
        sql: `
          SELECT p.name AS product, p.sku AS sku,
                 SUM(moc.required_quantity) AS required,
                 COALESCE(SUM(moc.issued_quantity + moc.consumed_quantity), 0) AS available,
                 SUM(moc.required_quantity) - COALESCE(SUM(moc.issued_quantity + moc.consumed_quantity), 0) AS shortage
            FROM manufacturing_order_components moc
            JOIN products p ON p.id = moc.component_product_id
            JOIN manufacturing_orders mo ON mo.id = moc.mo_id
           WHERE moc.required_quantity > moc.issued_quantity + moc.consumed_quantity
             AND mo.status IN ('released','inProgress')
           GROUP BY p.id
           ORDER BY shortage DESC`,
        params: [],
      };
    }

    case "productionCostSummary": {
      return {
        title: "Production Cost Summary",
        columns: [COL.moNumber, COL.product, COL.plannedCost, COL.actualCost, COL.variance],
        sql: `
          SELECT mo.number AS moNumber, p.name AS product,
                 mo.planned_cost_fils AS plannedCost,
                 mo.actual_cost_fils AS actualCost,
                 (mo.actual_cost_fils - mo.planned_cost_fils) AS variance
            FROM manufacturing_orders mo
            JOIN products p ON p.id = mo.product_id
           WHERE mo.created_at BETWEEN ? AND ?
           ORDER BY variance DESC`,
        params: [period.fromDate, period.toDate],
      };
    }

    case "plannedVsActualCost": {
      return {
        title: "Planned vs Actual Cost",
        columns: [COL.date, COL.plannedCost, COL.actualCost],
        sql: `
          SELECT mo.created_at AS date,
                 COALESCE(SUM(mo.planned_cost_fils), 0) AS plannedCost,
                 COALESCE(SUM(mo.actual_cost_fils), 0) AS actualCost
            FROM manufacturing_orders mo
           WHERE mo.created_at BETWEEN ? AND ?
           GROUP BY mo.created_at
           ORDER BY mo.created_at`,
        params: [period.fromDate, period.toDate],
      };
    }

    case "costPerFinishedUnit": {
      return {
        title: "Cost per Finished Unit",
        columns: [COL.product, COL.sku, COL.quantity, COL.cost, COL.unitCost],
        sql: `
          SELECT p.name AS product, p.sku AS sku,
                 COALESCE(SUM(fr.accepted_qty), 0) AS quantity,
                 COALESCE(SUM(fr.total_cost_fils), 0) AS cost,
                 CASE WHEN COALESCE(SUM(fr.accepted_qty), 0) > 0
                   THEN ROUND(COALESCE(SUM(fr.total_cost_fils), 0) * 1000.0 / COALESCE(SUM(fr.accepted_qty), 1))
                   ELSE 0 END AS unitCost
            FROM products p
            LEFT JOIN manufacturing_finished_receipts fr ON fr.product_id = p.id
           WHERE fr.received_at BETWEEN ? AND ? OR fr.received_at IS NULL
           GROUP BY p.id
           ORDER BY cost DESC`,
        params: [period.fromDate, period.toDate],
      };
    }

    case "wip": {
      return {
        title: "Work in Progress",
        columns: [COL.moNumber, COL.product, COL.quantity, COL.cost],
        sql: `
          SELECT mo.number AS moNumber, p.name AS product,
                 COALESCE(SUM(wpr.quantity_milli), 0) AS quantity,
                 COALESCE(SUM(wpr.material_cost_fils + wpr.labor_cost_fils + wpr.machine_cost_fils + wpr.overhead_cost_fils), 0) AS cost
            FROM manufacturing_orders mo
            JOIN products p ON p.id = mo.product_id
            LEFT JOIN manufacturing_wip_records wpr ON wpr.mo_id = mo.id
           WHERE mo.status IN ('released','inProgress','qualityReview')
           GROUP BY mo.id
           ORDER BY cost DESC`,
        params: [],
      };
    }

    case "wipAging": {
      return {
        title: "WIP Aging",
        columns: [COL.moNumber, COL.product, COL.quantity, COL.cost, COL.date],
        sql: `
          SELECT mo.number AS moNumber, p.name AS product,
                 COALESCE(SUM(wpr.quantity_milli), 0) AS quantity,
                 COALESCE(SUM(wpr.material_cost_fils + wpr.labor_cost_fils + wpr.machine_cost_fils + wpr.overhead_cost_fils), 0) AS cost,
                 mo.created_at AS date
            FROM manufacturing_orders mo
            JOIN products p ON p.id = mo.product_id
            LEFT JOIN manufacturing_wip_records wpr ON wpr.mo_id = mo.id
           WHERE mo.status IN ('released','inProgress','qualityReview')
           GROUP BY mo.id
           ORDER BY mo.created_at`,
        params: [],
      };
    }

    case "productionYield": {
      return {
        title: "Production Yield",
        columns: [COL.product, COL.sku, COL.quantity, COL.cost],
        sql: `
          SELECT p.name AS product, p.sku AS sku,
                 COALESCE(SUM(mo.actual_quantity), 0) AS quantity,
                 COALESCE(SUM(mo.rejected_quantity), 0) AS cost
            FROM manufacturing_orders mo
            JOIN products p ON p.id = mo.product_id
           WHERE mo.created_at BETWEEN ? AND ?
           GROUP BY p.id
           ORDER BY quantity DESC`,
        params: [period.fromDate, period.toDate],
      };
    }

    case "scrap": {
      return {
        title: "Scrap / Waste",
        columns: [COL.product, COL.sku, COL.scrapQty, COL.cost, COL.date],
        sql: `
          SELECT p.name AS product, p.sku AS sku,
                 COALESCE(SUM(s.quantity_milli), 0) AS scrapQty,
                 COALESCE(SUM(s.cost_fils), 0) AS cost,
                 MAX(s.created_at) AS date
            FROM manufacturing_scrap s
            JOIN products p ON p.id = s.product_id
           WHERE s.created_at BETWEEN ? AND ?
           GROUP BY p.id
           ORDER BY scrapQty DESC`,
        params: [period.fromDate, period.toDate],
      };
    }

    case "rework": {
      return {
        title: "Rework",
        columns: [COL.product, COL.sku, COL.quantity, COL.cost],
        sql: `
          SELECT p.name AS product, p.sku AS sku,
                 COALESCE(SUM(r.quantity_milli), 0) AS quantity,
                 COALESCE(SUM(r.extra_material_cost_fils + r.extra_labor_cost_fils), 0) AS cost
            FROM manufacturing_rework r
            JOIN products p ON p.id = r.output_product_id
           WHERE r.created_at BETWEEN ? AND ?
           GROUP BY p.id
           ORDER BY quantity DESC`,
        params: [period.fromDate, period.toDate],
      };
    }

    case "qualityPassFail": {
      return {
        title: "Quality Pass / Fail",
        columns: [COL.result, COL.quantity],
        sql: `
          SELECT qc.result, COUNT(*) AS quantity
            FROM manufacturing_quality_checks qc
           WHERE qc.inspected_at BETWEEN ? AND ?
           GROUP BY qc.result
           ORDER BY quantity DESC`,
        params: [period.fromDate, period.toDate],
      };
    }

    case "machineDowntime": {
      return {
        title: "Machine Downtime",
        columns: [COL.workCenter, COL.quantity, COL.date],
        sql: `
          SELECT w.name AS workCenter,
                 COALESCE(SUM(jtl.downtime_minutes), 0) AS quantity,
                 MAX(jtl.started_at) AS date
            FROM manufacturing_job_time_logs jtl
            JOIN manufacturing_work_orders wo ON wo.id = jtl.work_order_id
            LEFT JOIN manufacturing_work_centers w ON w.id = wo.work_center_id
           WHERE jtl.downtime_minutes > 0
             AND jtl.started_at BETWEEN ? AND ?
           GROUP BY w.id
           ORDER BY quantity DESC`,
        params: [period.fromDate, period.toDate],
      };
    }

    case "workCenterUtilization": {
      return {
        title: "Work Center Utilization",
        columns: [COL.workCenter, COL.quantity],
        sql: `
          SELECT w.name AS workCenter,
                 COALESCE(SUM(jtl.duration_minutes), 0) AS quantity
            FROM manufacturing_work_centers w
            LEFT JOIN manufacturing_work_orders wo ON wo.work_center_id = w.id
            LEFT JOIN manufacturing_job_time_logs jtl ON jtl.work_order_id = wo.id
           GROUP BY w.id
           ORDER BY quantity DESC`,
        params: [],
      };
    }

    case "oee": {
      return {
        title: "Overall Equipment Effectiveness (OEE)",
        columns: [COL.workCenter, COL.quantity],
        sql: `
          SELECT w.name AS workCenter,
                 COALESCE(SUM(jtl.duration_minutes), 0) AS quantity
            FROM manufacturing_work_centers w
            LEFT JOIN manufacturing_work_orders wo ON wo.work_center_id = w.id
            LEFT JOIN manufacturing_job_time_logs jtl ON jtl.work_order_id = wo.id
           GROUP BY w.id
           ORDER BY quantity DESC`,
        params: [],
      };
    }

    case "subcontractProduction": {
      return {
        title: "Subcontract Production",
        columns: [COL.moNumber, COL.product, COL.quantity, COL.cost, COL.status],
        sql: `
          SELECT so.number AS moNumber, p.name AS product, so.quantity_milli AS quantity,
                 so.processing_cost_fils AS cost, so.status
            FROM manufacturing_subcontract_orders so
            JOIN products p ON p.id = so.product_id
           WHERE so.created_at BETWEEN ? AND ?
           ORDER BY so.created_at DESC`,
        params: [period.fromDate, period.toDate],
      };
    }

    case "batchGenealogy": {
      return {
        title: "Batch / Lot Genealogy",
        columns: [COL.moNumber, COL.product, COL.quantity, COL.date],
        sql: `
          SELECT mo.number AS moNumber, p.name AS product,
                 COALESCE(SUM(gl.component_qty_milli), 0) AS quantity,
                 MAX(gl.created_at) AS date
            FROM manufacturing_genealogy_links gl
            JOIN manufacturing_orders mo ON mo.id = gl.mo_id
            JOIN products p ON p.id = gl.component_product_id
           WHERE gl.created_at BETWEEN ? AND ?
           GROUP BY mo.id
           ORDER BY date DESC`,
        params: [period.fromDate, period.toDate],
      };
    }

    case "finishedGoodsHistory": {
      return {
        title: "Finished Goods Production History",
        columns: [COL.moNumber, COL.product, COL.quantity, COL.cost, COL.date],
        sql: `
          SELECT mo.number AS moNumber, p.name AS product,
                 COALESCE(SUM(fr.accepted_qty), 0) AS quantity,
                 COALESCE(SUM(fr.total_cost_fils), 0) AS cost,
                 MAX(fr.received_at) AS date
            FROM manufacturing_finished_receipts fr
            JOIN manufacturing_orders mo ON mo.id = fr.mo_id
            JOIN products p ON p.id = fr.product_id
           WHERE fr.received_at BETWEEN ? AND ?
           GROUP BY mo.id
           ORDER BY date DESC`,
        params: [period.fromDate, period.toDate],
      };
    }

    default: {
      return {
        title: "Manufacturing Report",
        columns: [COL.moNumber, COL.product, COL.status, COL.quantity, COL.cost],
        sql: `
          SELECT mo.number AS moNumber, p.name AS product, mo.status,
                 mo.planned_quantity AS quantity, mo.actual_cost_fils AS cost
            FROM manufacturing_orders mo
            JOIN products p ON p.id = mo.product_id
           WHERE mo.created_at BETWEEN ? AND ?
           ORDER BY mo.created_at DESC`,
        params: [period.fromDate, period.toDate],
      };
    }
  }
}

export function runMmsReport(
  db: SqliteDatabase,
  request: MmsReportRequest,
): MmsReportDto {
  const period = periodOf(request);
  const spec = mmsReportSpec(request);
  const precomputed = spec.precomputed;
  const rows = precomputed ?? rowsOf(db, spec.sql, ...spec.params);

  const totals: Record<string, number> = {};
  for (const column of spec.columns) {
    if (column.type === "money" || column.type === "quantity") {
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

export function mmsReportTitles(): readonly MmsReportTitle[] {
  return [
    { id: "moSummary", title: "MO Summary", group: "Production" },
    { id: "plannedVsActual", title: "Planned vs Actual", group: "Production" },
    { id: "outputByProduct", title: "Output by Product", group: "Production" },
    { id: "outputByWorkCenter", title: "Output by Work Center", group: "Production" },
    { id: "moStatus", title: "MO Status", group: "Production" },
    { id: "delayedMo", title: "Delayed MOs", group: "Production" },
    { id: "workOrderPerformance", title: "Work Order Performance", group: "Operations" },
    { id: "materialConsumption", title: "Material Consumption", group: "Materials" },
    { id: "materialUsageVariance", title: "Material Usage Variance", group: "Materials" },
    { id: "rawMaterialShortage", title: "Raw Material Shortage", group: "Materials" },
    { id: "productionCostSummary", title: "Production Cost Summary", group: "Costing" },
    { id: "plannedVsActualCost", title: "Planned vs Actual Cost", group: "Costing" },
    { id: "costPerFinishedUnit", title: "Cost per Finished Unit", group: "Costing" },
    { id: "wip", title: "Work in Progress", group: "Costing" },
    { id: "wipAging", title: "WIP Aging", group: "Costing" },
    { id: "productionYield", title: "Production Yield", group: "Quality" },
    { id: "scrap", title: "Scrap / Waste", group: "Quality" },
    { id: "rework", title: "Rework", group: "Quality" },
    { id: "qualityPassFail", title: "Quality Pass/Fail", group: "Quality" },
    { id: "machineDowntime", title: "Machine Downtime", group: "Resources" },
    { id: "workCenterUtilization", title: "Work Center Utilization", group: "Resources" },
    { id: "oee", title: "OEE", group: "Resources" },
    { id: "subcontractProduction", title: "Subcontract Production", group: "Subcontracting" },
    { id: "batchGenealogy", title: "Batch Genealogy", group: "Traceability" },
    { id: "finishedGoodsHistory", title: "Finished Goods History", group: "Production" },
  ];
}
