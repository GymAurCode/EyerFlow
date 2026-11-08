import type { SqliteDatabase } from "../../../data/connection";
import { defaultLocationId } from "../ims/stock";
import type { Supply } from "./planning-common";

/** Pending GR lines replace, rather than duplicate, the outstanding lines of their source POs. */
export function purchaseSupply(
  db: SqliteDatabase,
  productId: number,
  location: number | null,
): Supply[] {
  const rows = db
    .prepare(
      `SELECT d.id,d.kind,COALESCE(d.required_date,d.due_date,d.issue_date) AS date,
    COALESCE(d.to_location_id,d.from_location_id,?) AS location_id,
    l.id AS line_id,l.source_line_id,MAX(0,l.quantity_milli-l.processed_milli) AS qty
    FROM ims_documents d JOIN ims_document_lines l ON l.document_id=d.id
    WHERE l.product_id=? AND ((d.kind='purchaseOrder' AND d.status IN ('approved','confirmed','sent','partiallyReceived'))
      OR (d.kind='goodsReceipt' AND d.status IN ('approved','confirmed','received')))
    ORDER BY d.id,l.id`,
    )
    .all(defaultLocationId(db), productId) as {
    id: number;
    kind: string;
    date: string;
    location_id: number;
    line_id: number;
    source_line_id: number | null;
    qty: number;
  }[];
  const pos = rows.filter((r) => r.kind === "purchaseOrder"),
    receipts = rows.filter((r) => r.kind === "goodsReceipt");
  const result: Supply[] = [];
  for (const po of pos) {
    let remaining = po.qty;
    for (const receipt of receipts.filter((r) => r.source_line_id === po.line_id)) {
      const quantity = Math.min(remaining, receipt.qty);
      remaining -= quantity;
      // Subtract linked receipts even when their destination differs from the original PO.
      if (location === null || receipt.location_id === location)
        result.push({ date: receipt.date, quantity, sourceId: receipt.id, kind: "goodsReceipt" });
    }
    if (location === null || po.location_id === location)
      result.push({ date: po.date, quantity: remaining, sourceId: po.id, kind: "purchaseOrder" });
  }
  for (const r of receipts.filter(
    (r) => r.source_line_id === null && (location === null || r.location_id === location),
  ))
    result.push({ date: r.date, quantity: r.qty, sourceId: r.id, kind: "goodsReceipt" });
  return result;
}
