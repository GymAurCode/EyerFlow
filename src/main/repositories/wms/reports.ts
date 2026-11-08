import type { SqliteDatabase } from "../../../data/connection";
import { reportSchema, type WmsReportRequest, type WmsReport } from "../../../shared/wms";
import { fail } from "./operations";
/** Preserve text as text when a spreadsheet opens the CSV. */
export function safeWarehouseExportCell(value: string | number): string | number {
  return typeof value === "string" && /^\s*[=+\-@]/.test(value) ? `'${value}` : value;
}
export function runWarehouseReport(
  db: SqliteDatabase,
  input: WmsReportRequest,
  nowIso: string,
): WmsReport {
  const p = reportSchema.parse(input);
  if (p.fromDate && p.toDate && p.fromDate > p.toDate)
    fail("Start date must not be later than end date.");
  const definitions = {
    stock: {
      sql: `SELECT w.code warehouse,b.code bin,p.sku,p.name,m.stock_status status,COALESCE(m.batch_no,'') lot,SUM(m.quantity_milli)/1000.0 quantity
      FROM wms_stock_movements m JOIN wms_bins b ON b.location_id=m.location_id JOIN wms_warehouses w ON w.id=b.warehouse_id JOIN products p ON p.id=m.product_id`,
      where: "w.id",
      date: "m.movement_date",
      group: " GROUP BY b.id,p.id,m.stock_status,m.batch_no HAVING SUM(m.quantity_milli)<>0",
      columns: ["warehouse", "bin", "sku", "name", "status", "lot", "quantity"],
    },
    receiving: {
      sql: `SELECT w.code warehouse,d.number inbound,d.reference,p.sku,r.quantity_milli/1000.0 received,r.damaged_milli/1000.0 damaged,r.created_by operator,r.created_at
      FROM wms_receipts r JOIN wms_inbound_lines l ON l.id=r.inbound_line_id JOIN wms_inbounds d ON d.id=l.inbound_id JOIN wms_warehouses w ON w.id=d.warehouse_id JOIN products p ON p.id=l.product_id`,
      where: "w.id",
      date: "r.created_at",
      group: "",
      columns: [
        "warehouse",
        "inbound",
        "reference",
        "sku",
        "received",
        "damaged",
        "operator",
        "created_at",
      ],
    },
    movements: {
      sql: `SELECT w.code warehouse,b.code bin,p.sku,m.quantity_milli/1000.0 quantity,m.stock_status status,m.kind,m.source_kind,m.source_id,m.movement_date
      FROM wms_stock_movements m JOIN wms_bins b ON b.location_id=m.location_id JOIN wms_warehouses w ON w.id=b.warehouse_id JOIN products p ON p.id=m.product_id`,
      where: "w.id",
      date: "m.movement_date",
      group: "",
      columns: [
        "warehouse",
        "bin",
        "sku",
        "quantity",
        "status",
        "kind",
        "source_kind",
        "source_id",
        "movement_date",
      ],
    },
    tasks: {
      sql: `SELECT w.code warehouse,t.id task,t.type,p.sku,s.code source,d.code destination,t.quantity_milli/1000.0 planned,t.actual_milli/1000.0 actual,t.status,t.assigned_to worker,t.created_at,t.started_at,t.completed_at
      FROM wms_tasks t JOIN wms_bins s ON s.id=t.source_bin_id JOIN wms_warehouses w ON w.id=s.warehouse_id JOIN products p ON p.id=t.product_id LEFT JOIN wms_bins d ON d.id=t.destination_bin_id`,
      where: "w.id",
      date: "t.created_at",
      group: "",
      columns: [
        "warehouse",
        "task",
        "type",
        "sku",
        "source",
        "destination",
        "planned",
        "actual",
        "status",
        "worker",
        "created_at",
        "started_at",
        "completed_at",
      ],
    },
    dispatch: {
      sql: `SELECT w.code warehouse,d.number,d.recipient,d.reference,d.required_date,d.status,d.carrier,d.vehicle,d.handed_over_at,
      COALESCE((SELECT SUM(quantity_milli)/1000.0 FROM wms_dispatch_lines WHERE dispatch_id=d.id),0) quantity
      FROM wms_dispatches d JOIN wms_warehouses w ON w.id=d.warehouse_id`,
      where: "w.id",
      date: "d.created_at",
      group: "",
      columns: [
        "warehouse",
        "number",
        "recipient",
        "reference",
        "required_date",
        "status",
        "carrier",
        "vehicle",
        "handed_over_at",
        "quantity",
      ],
    },
    counts: {
      sql: `SELECT w.code warehouse,b.code bin,p.sku,c.expected_milli/1000.0 expected,c.counted_milli/1000.0 counted,(c.counted_milli-c.expected_milli)/1000.0 variance,c.status,c.counted_by_name,c.reason,c.created_at,c.posted_at
      FROM wms_counts c JOIN wms_bins b ON b.id=c.bin_id JOIN wms_warehouses w ON w.id=b.warehouse_id JOIN products p ON p.id=c.product_id`,
      where: "w.id",
      date: "c.created_at",
      group: "",
      columns: [
        "warehouse",
        "bin",
        "sku",
        "expected",
        "counted",
        "variance",
        "status",
        "counted_by_name",
        "reason",
        "created_at",
        "posted_at",
      ],
    },
    exceptions: {
      sql: `SELECT w.code warehouse,e.task_id,e.operation,e.reason,e.actor_name,e.created_at
      FROM wms_exceptions e JOIN wms_tasks t ON t.id=e.task_id JOIN wms_bins b ON b.id=t.source_bin_id JOIN wms_warehouses w ON w.id=b.warehouse_id`,
      where: "w.id",
      date: "e.created_at",
      group: "",
      columns: ["warehouse", "task_id", "operation", "reason", "actor_name", "created_at"],
    },
  };
  const def = definitions[p.report],
    clauses = ["1=1"],
    args: (string | number)[] = [];
  if (p.warehouseId) {
    clauses.push(`${def.where}=?`);
    args.push(p.warehouseId);
  }
  // Stock is an as-of balance: never subtract earlier receipts by applying a
  // period start filter to its ledger. Other reports use a normal period.
  if (p.fromDate && p.report !== "stock") {
    clauses.push(`substr(${def.date},1,10)>=?`);
    args.push(p.fromDate);
  }
  if (p.toDate) {
    clauses.push(`substr(${def.date},1,10)<=?`);
    args.push(p.toDate);
  }
  args.push(p.limit);
  const rows = db
    .prepare(`${def.sql} WHERE ${clauses.join(" AND ")}${def.group} ORDER BY 1,2 LIMIT ?`)
    .all(...args) as WmsReport["rows"];
  return {
    columns: def.columns,
    rows,
    generatedAt: nowIso,
    cutoff: p.toDate ?? nowIso,
    limit: p.limit,
  };
}
