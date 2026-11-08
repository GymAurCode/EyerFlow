import {
  dispatchSchema,
  cartonSchema,
  taskCompleteSchema,
  type DispatchInput,
  type CartonInput,
  type CompleteTaskInput,
  type Dispatch,
  type DispatchLine,
  type WarehouseTask,
  type Bin,
} from "../../../shared/wms";
import {
  bin,
  stock,
  audit,
  physicalProduct,
  freeBalance,
  move,
  fail,
  WmsError,
  type WmsContext,
} from "./operations";
import { postMovement, reserveStock, releaseReservations } from "../ims/stock";
import { readWmsSettings } from "./config";

function document(c: WmsContext, id: number): Dispatch {
  return (
    (c.db.prepare("SELECT * FROM wms_dispatches WHERE id=?").get(id) as Dispatch | undefined) ??
    fail("Dispatch request not found.")
  );
}
export function createDispatch(c: WmsContext, input: DispatchInput): number {
  const p = dispatchSchema.parse(input);
  return c.db
    .transaction(() => {
      const replay = c.db
        .prepare("SELECT * FROM wms_dispatches WHERE command_key=?")
        .get(p.commandKey) as Dispatch | undefined;
      if (replay) {
        const lines = c.db
          .prepare(
            "SELECT product_id,quantity_milli FROM wms_dispatch_lines WHERE dispatch_id=? ORDER BY product_id",
          )
          .all(replay.id);
        const requested = [...p.lines]
          .sort((a, b) => a.productId - b.productId)
          .map((l) => ({ product_id: l.productId, quantity_milli: l.quantityMilli }));
        if (
          replay.warehouse_id !== p.warehouseId ||
          replay.recipient !== p.recipient ||
          replay.reference !== p.reference ||
          replay.required_date !== p.requiredDate ||
          JSON.stringify(lines) !== JSON.stringify(requested)
        )
          fail("This command key has already been used for a different dispatch request.");
        return replay.id;
      }
      if (!c.db.prepare("SELECT id FROM wms_warehouses WHERE id=? AND active=1").get(p.warehouseId))
        fail("Choose an active warehouse.");
      if (new Set(p.lines.map((l) => l.productId)).size !== p.lines.length)
        fail("Combine duplicate product lines.");
      p.lines.forEach((l) => physicalProduct(c.db, l.productId));
      const id = Number(
        c.db
          .prepare(
            "INSERT INTO wms_dispatches(number,command_key,warehouse_id,recipient,reference,required_date,created_at,created_by) VALUES(lower(hex(randomblob(8))),?,?,?,?,?,?,?)",
          )
          .run(
            p.commandKey,
            p.warehouseId,
            p.recipient,
            p.reference,
            p.requiredDate,
            c.nowIso,
            c.actor.name,
          ).lastInsertRowid,
      );
      c.db
        .prepare("UPDATE wms_dispatches SET number=? WHERE id=?")
        .run(`DSP-${String(id).padStart(6, "0")}`, id);
      for (const l of p.lines)
        c.db
          .prepare(
            "INSERT INTO wms_dispatch_lines(dispatch_id,product_id,quantity_milli) VALUES(?,?,?)",
          )
          .run(id, l.productId, l.quantityMilli);
      audit(c, "create", "wmsDispatch", id, p);
      return id;
    })
    .immediate();
}
export function releaseDispatch(c: WmsContext, id: number, packingBinId: number): void {
  c.db
    .transaction(() => {
      const d = document(c, id);
      if (d.status === "released") return;
      if (d.status !== "draft") fail("Only draft requests can be released.");
      const packing = bin(c.db, packingBinId);
      if (packing.warehouse_id !== d.warehouse_id || packing.type !== "packing")
        fail("Choose a packing bin in this warehouse.");
      const lines = c.db
        .prepare("SELECT * FROM wms_dispatch_lines WHERE dispatch_id=? ORDER BY id")
        .all(id) as DispatchLine[];
      for (const l of lines) {
        let remaining = l.quantity_milli;
        const sources = c.db
          .prepare(
            `SELECT * FROM wms_bins WHERE warehouse_id=? AND active=1 AND blocked=0 AND type IN ('storage','pickFace') ORDER BY ${readWmsSettings(c.db).pickFaceFirst ? "CASE type WHEN 'pickFace' THEN 0 ELSE 1 END," : ""}code`,
          )
          .all(d.warehouse_id) as Bin[];
        for (const source of sources) {
          const qty = Math.min(remaining, Math.max(0, freeBalance(c.db, l.product_id, source)));
          if (!qty) continue;
          const taskId = Number(
            c.db
              .prepare(
                "INSERT INTO wms_tasks(type,product_id,source_bin_id,destination_bin_id,quantity_milli,dispatch_line_id,created_at) VALUES('pick',?,?,?,?,?,?)",
              )
              .run(l.product_id, source.id, packing.id, qty, l.id, c.nowIso).lastInsertRowid,
          );
          reserveStock(
            c.db,
            c.actor.name,
            {
              productId: l.product_id,
              locationId: source.location_id,
              quantityMilli: qty,
              sourceKind: "wmsPick",
              sourceId: taskId,
            },
            c.nowIso,
          );
          remaining -= qty;
          if (!remaining) break;
        }
        if (remaining > 0)
          fail(
            `Insufficient eligible stock for product ${l.product_id}. Missing ${remaining / 1000} units. No allocations were committed.`,
          );
      }
      c.db.prepare("UPDATE wms_dispatches SET status='released' WHERE id=?").run(id);
      audit(c, "release", "wmsDispatch", id, { packingBinId });
    })
    .immediate();
}
export function confirmPick(c: WmsContext, input: CompleteTaskInput): void {
  const p = taskCompleteSchema.parse(input);
  try {
    c.db
      .transaction(() => {
        const t = c.db.prepare("SELECT * FROM wms_tasks WHERE id=? AND type='pick'").get(p.id) as
          (WarehouseTask & { completion_key: string | null; dispatch_line_id: number }) | undefined;
        if (!t) fail("Pick task not found.");
        if (t.status === "completed") {
          if (
            t.completion_key === p.commandKey &&
            t.actual_milli === p.quantityMilli &&
            t.destination_bin_id === p.destinationBinId
          )
            return;
          fail("Pick is already complete. Refresh tasks.");
        }
        if (!["created", "assigned", "started"].includes(t.status)) fail("Pick is not open.");
        if (t.assigned_to !== null && t.assigned_to !== c.actor.id)
          fail("Pick belongs to a different worker.");
        const source = bin(c.db, t.source_bin_id),
          destination = bin(c.db, p.destinationBinId),
          product = physicalProduct(c.db, t.product_id);
        if (
          p.sourceScan !== source.code ||
          p.destinationScan !== destination.code ||
          destination.id !== t.destination_bin_id
        )
          fail("Wrong bin scan. Follow the task source and destination.");
        if (p.productScan !== product.sku && p.productScan !== product.barcode)
          fail("Wrong SKU/barcode. Stock is unchanged.");
        if (p.quantityMilli !== t.quantity_milli)
          fail("Confirm the full allocated quantity. A short pick requires supervisor review.");
        releaseReservations(c.db, "wmsPick", t.id, "released", c.nowIso);
        if (freeBalance(c.db, t.product_id, source, t.id) < p.quantityMilli)
          fail("Source stock changed after allocation.");
        move(c, source, destination, t.product_id, p.quantityMilli, `wmsPick:${t.id}`, t.id);
        reserveStock(
          c.db,
          c.actor.name,
          {
            productId: t.product_id,
            locationId: destination.location_id,
            quantityMilli: p.quantityMilli,
            sourceKind: "wmsPick",
            sourceId: t.id,
          },
          c.nowIso,
        );
        c.db
          .prepare(
            "UPDATE wms_tasks SET status='completed',actual_milli=?,completion_key=?,started_at=COALESCE(started_at,?),completed_at=? WHERE id=?",
          )
          .run(p.quantityMilli, p.commandKey, c.nowIso, c.nowIso, t.id);
        const line = c.db
          .prepare("SELECT dispatch_id FROM wms_dispatch_lines WHERE id=?")
          .get(t.dispatch_line_id) as { dispatch_id: number };
        const outstanding = c.db
          .prepare(
            "SELECT 1 FROM wms_tasks t JOIN wms_dispatch_lines l ON l.id=t.dispatch_line_id WHERE l.dispatch_id=? AND t.status<>'completed' LIMIT 1",
          )
          .get(line.dispatch_id);
        if (!outstanding)
          c.db
            .prepare("UPDATE wms_dispatches SET status='picked' WHERE id=?")
            .run(line.dispatch_id);
        audit(c, "pick", "wmsTask", t.id, p);
      })
      .immediate();
  } catch (error) {
    if (error instanceof WmsError)
      c.db
        .transaction(() => {
          c.db
            .prepare(
              "INSERT INTO wms_exceptions(task_id,operation,reason,created_at,actor_name) VALUES(?,'pick',?,?,?)",
            )
            .run(p.id, error.message, c.nowIso, c.actor.name);
          audit(c, "exception", "wmsTask", p.id, { reason: error.message });
        })
        .immediate();
    throw error;
  }
}
export function packCarton(c: WmsContext, input: CartonInput): number {
  const p = cartonSchema.parse(input);
  return c.db
    .transaction(() => {
      const replay = c.db
        .prepare("SELECT id,dispatch_id,code,weight_grams FROM wms_cartons WHERE command_key=?")
        .get(p.commandKey) as
        { id: number; dispatch_id: number; code: string; weight_grams: number } | undefined;
      if (replay) {
        const lines = c.db
          .prepare(
            "SELECT dispatch_line_id,quantity_milli FROM wms_carton_lines WHERE carton_id=? ORDER BY dispatch_line_id",
          )
          .all(replay.id);
        const requested = [...p.lines]
          .sort((a, b) => a.lineId - b.lineId)
          .map((l) => ({ dispatch_line_id: l.lineId, quantity_milli: l.quantityMilli }));
        if (
          replay.dispatch_id !== p.dispatchId ||
          replay.code !== p.code ||
          replay.weight_grams !== p.weightGrams ||
          JSON.stringify(lines) !== JSON.stringify(requested)
        )
          fail("This command key has already been used for a different carton.");
        return replay.id;
      }
      const d = document(c, p.dispatchId);
      if (d.status !== "picked") fail("Complete all picks before packing.");
      if (new Set(p.lines.map((l) => l.lineId)).size !== p.lines.length)
        fail("Combine duplicate lines in the carton.");
      const id = Number(
        c.db
          .prepare(
            "INSERT INTO wms_cartons(dispatch_id,code,command_key,weight_grams,created_at,created_by) VALUES(?,?,?,?,?,?)",
          )
          .run(d.id, p.code, p.commandKey, p.weightGrams, c.nowIso, c.actor.name).lastInsertRowid,
      );
      for (const l of p.lines) {
        const line = c.db
          .prepare("SELECT * FROM wms_dispatch_lines WHERE id=? AND dispatch_id=?")
          .get(l.lineId, d.id) as DispatchLine | undefined;
        if (!line) fail("Carton line does not belong to this dispatch.");
        const product = physicalProduct(c.db, line.product_id);
        if (l.productScan !== product.sku && l.productScan !== product.barcode)
          fail("Wrong SKU/barcode for packing.");
        const packed = c.db
          .prepare(
            "SELECT COALESCE(SUM(quantity_milli),0) qty FROM wms_carton_lines WHERE dispatch_line_id=?",
          )
          .get(l.lineId) as { qty: number };
        if (packed.qty + l.quantityMilli > line.quantity_milli)
          fail("Cannot pack more than the picked request quantity.");
        c.db
          .prepare(
            "INSERT INTO wms_carton_lines(carton_id,dispatch_line_id,quantity_milli) VALUES(?,?,?)",
          )
          .run(id, l.lineId, l.quantityMilli);
      }
      const incomplete = c.db
        .prepare(
          "SELECT 1 FROM wms_dispatch_lines l WHERE dispatch_id=? AND quantity_milli<>(SELECT COALESCE(SUM(quantity_milli),0) FROM wms_carton_lines WHERE dispatch_line_id=l.id) LIMIT 1",
        )
        .get(d.id);
      if (!incomplete)
        c.db.prepare("UPDATE wms_dispatches SET status='packed' WHERE id=?").run(d.id);
      audit(c, "pack", "wmsCarton", id, p);
      return id;
    })
    .immediate();
}
export function scanCarton(
  c: WmsContext,
  dispatchId: number,
  scan: string,
  action: "stage" | "load",
): void {
  c.db
    .transaction(() => {
      const d = document(c, dispatchId);
      const carton = c.db
        .prepare("SELECT id,status FROM wms_cartons WHERE dispatch_id=? AND code=?")
        .get(d.id, scan) as { id: number; status: string } | undefined;
      if (!carton) fail("Carton does not belong to this dispatch.");
      const from = action === "stage" ? "closed" : "staged",
        to = action === "stage" ? "staged" : "loaded";
      if (carton.status === to || (action === "stage" && carton.status === "loaded")) return;
      if (d.status !== (action === "stage" ? "packed" : "staged") || carton.status !== from)
        fail("Carton is not ready for this action.");
      c.db.prepare("UPDATE wms_cartons SET status=? WHERE id=?").run(to, carton.id);
      if (
        !c.db
          .prepare("SELECT 1 FROM wms_cartons WHERE dispatch_id=? AND status<>? LIMIT 1")
          .get(d.id, to)
      )
        c.db.prepare("UPDATE wms_dispatches SET status=? WHERE id=?").run(to, d.id);
      audit(c, action, "wmsCarton", carton.id, { dispatchId });
    })
    .immediate();
}
export function handover(
  c: WmsContext,
  id: number,
  carrier: string,
  vehicle: string,
  acknowledgement: string,
): void {
  c.db
    .transaction(() => {
      const d = document(c, id);
      if (d.status === "handedOver") return;
      if (d.status !== "loaded") fail("Load and verify every carton before physical handover.");
      if (!carrier.trim() || !vehicle.trim() || !acknowledgement.trim())
        fail("Carrier, vehicle and handover acknowledgement are required.");
      const picks = c.db
        .prepare(
          "SELECT t.* FROM wms_tasks t JOIN wms_dispatch_lines l ON l.id=t.dispatch_line_id WHERE l.dispatch_id=? AND t.status='completed'",
        )
        .all(d.id) as WarehouseTask[];
      if (!picks.length) fail("No verified picks exist for this dispatch.");
      for (const t of picks) {
        const destination = bin(c.db, t.destination_bin_id!);
        releaseReservations(c.db, "wmsPick", t.id, "consumed", c.nowIso);
        postMovement(stock(c), {
          productId: t.product_id,
          locationId: destination.location_id,
          quantityMilli: -t.actual_milli,
          kind: "issue",
          movementDate: c.nowIso.slice(0, 10),
          sourceKind: "wmsDispatch",
          sourceId: d.id,
          idempotencyKey: `wmsDispatch:${d.id}:pick:${t.id}`,
        });
      }
      c.db
        .prepare(
          "UPDATE wms_dispatches SET status='handedOver',handed_over_at=?,carrier=?,vehicle=?,acknowledgement=? WHERE id=?",
        )
        .run(c.nowIso, carrier.trim(), vehicle.trim(), acknowledgement.trim(), id);
      audit(c, "handover", "wmsDispatch", id, { carrier, vehicle, acknowledgement });
    })
    .immediate();
}
