import { countSchema, type CountInput, type CycleCount } from "../../../shared/wms";
import {
  saveOperation,
  transitionOperation,
  getOperation,
  type OperationContext,
} from "../ims/operations";
import { onHandAt, reservedQuantity } from "../ims/stock";
import { bin, physicalProduct, audit, fail, type WmsContext } from "./operations";
function ims(c: WmsContext): OperationContext {
  return {
    ...c,
    nowDate: c.nowIso.slice(0, 10),
    fiscalYearStartMonth: 1,
    allowNegativeStock: false,
    vatRate: 0,
  };
}
function version(c: WmsContext, locationId: number, productId: number): number {
  return (
    c.db
      .prepare(
        "SELECT COALESCE(MAX(id),0) version FROM wms_stock_movements WHERE location_id=? AND product_id=?",
      )
      .get(locationId, productId) as { version: number }
  ).version;
}
function noWork(c: WmsContext, binId: number, locationId: number, productId: number) {
  if (
    c.db
      .prepare(
        "SELECT 1 FROM wms_tasks WHERE (source_bin_id=? OR destination_bin_id=?) AND product_id=? AND status NOT IN ('completed','cancelled') LIMIT 1",
      )
      .get(binId, binId, productId) ||
    reservedQuantity(c.db, productId, locationId) > 0
  )
    fail("Resolve active picks, moves and reservations before counting this stock.");
}
export function recordCount(c: WmsContext, input: CountInput): number {
  const p = countSchema.parse(input);
  return c.db
    .transaction(() => {
      const replay = c.db
        .prepare("SELECT id FROM wms_counts WHERE command_key=?")
        .get(p.commandKey) as { id: number } | undefined;
      if (replay) return replay.id;
      const b = bin(c.db, p.binId),
        product = physicalProduct(c.db, p.productId);
      if (
        p.binScan !== b.code ||
        (p.productScan !== product.sku && p.productScan !== product.barcode)
      )
        fail("Wrong bin or product scan. Count not recorded.");
      if (!["storage", "pickFace"].includes(b.type))
        fail("This count workflow supports eligible storage and pick-face stock.");
      noWork(c, b.id, b.location_id, p.productId);
      if (p.recountOfId) {
        const prior = c.db
          .prepare(
            "SELECT * FROM wms_counts WHERE id=? AND status='review' AND superseded_by IS NULL",
          )
          .get(p.recountOfId) as CycleCount | undefined;
        if (!prior || prior.bin_id !== b.id || prior.product_id !== p.productId)
          fail("Choose the current unposted count for the same stock when recording a recount.");
      }
      if (
        c.db
          .prepare(
            "SELECT 1 FROM wms_counts WHERE bin_id=? AND product_id=? AND status='review' AND superseded_by IS NULL AND id<>?",
          )
          .get(b.id, p.productId, p.recountOfId ?? 0)
      )
        fail("A count is already awaiting review for this stock.");
      const tracked = c.db
        .prepare(
          "SELECT 1 FROM wms_stock_movements WHERE location_id=? AND product_id=? AND (batch_no IS NOT NULL OR serial_no IS NOT NULL OR stock_status<>'available') GROUP BY batch_no,serial_no,stock_status HAVING SUM(quantity_milli)<>0 LIMIT 1",
        )
        .get(b.location_id, p.productId);
      if (tracked)
        fail(
          "Lot, serial and held-stock counts require separate dimensions and are not supported by this count form.",
        );
      const expected = onHandAt(c.db, p.productId, b.location_id, "available");
      const snapshot = version(c, b.location_id, p.productId);
      const document = saveOperation(ims(c), {
        kind: "stockCount",
        fromLocationId: b.location_id,
        toLocationId: b.location_id,
        issueDate: c.nowIso.slice(0, 10),
        reference: `WMS count ${b.code}`,
        reason: p.reason,
        clientToken: p.commandKey,
        lines: [
          {
            productId: p.productId,
            description: `Physical bin count ${b.code}`,
            quantityMilli: Math.max(expected, 1000),
            expectedMilli: expected,
            countedMilli: p.countedMilli,
          },
        ],
      });
      const id = Number(
        c.db
          .prepare(
            "INSERT INTO wms_counts(ims_document_id,bin_id,product_id,expected_milli,counted_milli,snapshot_movement_id,counted_by,counted_by_name,reason,command_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            document.id,
            b.id,
            p.productId,
            expected,
            p.countedMilli,
            snapshot,
            c.actor.id,
            c.actor.name,
            p.reason,
            p.commandKey,
            c.nowIso,
          ).lastInsertRowid,
      );
      if (p.recountOfId) {
        c.db.prepare("UPDATE wms_counts SET recount_of=? WHERE id=?").run(p.recountOfId, id);
        c.db.prepare("UPDATE wms_counts SET superseded_by=? WHERE id=?").run(id, p.recountOfId);
      }
      audit(c, "count", "wmsCount", id, p);
      return id;
    })
    .immediate();
}
export function approveCount(c: WmsContext, id: number): void {
  c.db
    .transaction(() => {
      const count = c.db.prepare("SELECT * FROM wms_counts WHERE id=?").get(id) as
        (CycleCount & { snapshot_movement_id: number }) | undefined;
      if (!count) fail("Count not found.");
      if (count.status === "posted") return;
      if (count.superseded_by !== null)
        fail("This count has been superseded by a traceable recount.");
      if (count.counted_by === c.actor.id)
        fail("A different supervisor must approve the count variance.");
      const b = bin(c.db, count.bin_id);
      noWork(c, b.id, b.location_id, count.product_id);
      if (version(c, b.location_id, count.product_id) !== count.snapshot_movement_id)
        fail("Stock changed after the count snapshot. Recount before approving.");
      const original = getOperation(c.db, count.ims_document_id);
      if (
        original.kind !== "stockCount" ||
        original.fromLocationId !== b.location_id ||
        original.lines.length !== 1 ||
        original.lines[0]?.productId !== count.product_id ||
        original.lines[0]?.expectedMilli !== count.expected_milli ||
        original.lines[0]?.countedMilli !== count.counted_milli
      )
        fail("The linked IMS count was changed. Investigate before approving.");
      c.db.prepare("UPDATE wms_counts SET approved_by=? WHERE id=?").run(c.actor.id, id);
      transitionOperation(ims(c), count.ims_document_id, "approve");
      transitionOperation(ims(c), count.ims_document_id, "post");
      c.db
        .prepare("UPDATE wms_counts SET status='posted',approved_by=?,posted_at=? WHERE id=?")
        .run(c.actor.id, c.nowIso, id);
      audit(c, "approve", "wmsCount", id, {
        varianceMilli: count.counted_milli - count.expected_milli,
      });
    })
    .immediate();
}
