import {
  returnSchema,
  replenishmentSchema,
  type ReturnInput,
  type ReplenishmentInput,
  type WarehouseReturn,
  type DispatchLine,
  type ReplenishmentRule,
} from "../../../shared/wms";
import { saveOperation, transitionOperation, type OperationContext } from "../ims/operations";
import { onHandAt, reclassifyStock, availableQuantity } from "../ims/stock";
import {
  bin,
  physicalProduct,
  capacity,
  freeBalance,
  audit,
  stock,
  fail,
  type WmsContext,
} from "./operations";
function ims(c: WmsContext): OperationContext {
  return {
    ...c,
    nowDate: c.nowIso.slice(0, 10),
    fiscalYearStartMonth: 1,
    allowNegativeStock: false,
    vatRate: 0,
  };
}
export function receiveReturn(c: WmsContext, input: ReturnInput): number {
  const p = returnSchema.parse(input);
  return c.db
    .transaction(() => {
      const replay = c.db
        .prepare("SELECT id FROM wms_returns WHERE command_key=?")
        .get(p.commandKey) as { id: number } | undefined;
      if (replay) return replay.id;
      const line = c.db
        .prepare(
          "SELECT l.*,d.warehouse_id FROM wms_dispatch_lines l JOIN wms_dispatches d ON d.id=l.dispatch_id WHERE l.id=? AND d.status='handedOver'",
        )
        .get(p.dispatchLineId) as (DispatchLine & { warehouse_id: number }) | undefined;
      if (!line) fail("Choose a line from a physically handed-over shipment.");
      const product = physicalProduct(c.db, line.product_id),
        area = bin(c.db, p.binId);
      if (product.sku !== p.productScan && product.barcode !== p.productScan)
        fail("Returned SKU scan does not match the shipment.");
      if (area.warehouse_id !== line.warehouse_id || !["returns", "quarantine"].includes(area.type))
        fail("Receive returns into a returns/quarantine bin in the shipment warehouse.");
      const returned = c.db
        .prepare(
          "SELECT COALESCE(SUM(quantity_milli),0) qty FROM wms_returns WHERE dispatch_line_id=?",
        )
        .get(line.id) as { qty: number };
      if (returned.qty + p.quantityMilli > line.quantity_milli)
        fail("Returned quantity exceeds the shipped quantity still eligible for return.");
      capacity(c.db, area, line.product_id, p.quantityMilli);
      const document = saveOperation(ims(c), {
        kind: "salesReturn",
        toLocationId: area.location_id,
        issueDate: c.nowIso.slice(0, 10),
        reference: `Warehouse return for DSP-${line.dispatch_id}`,
        notes: p.condition,
        clientToken: p.commandKey,
        lines: [
          {
            productId: line.product_id,
            description: "Warehouse return awaiting inspection",
            quantityMilli: p.quantityMilli,
            restock: false,
          },
        ],
      });
      transitionOperation(ims(c), document.id, "post");
      const id = Number(
        c.db
          .prepare(
            "INSERT INTO wms_returns(dispatch_line_id,ims_document_id,bin_id,quantity_milli,condition_note,command_key,received_by,created_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            line.id,
            document.id,
            area.id,
            p.quantityMilli,
            p.condition,
            p.commandKey,
            c.actor.name,
            c.nowIso,
          ).lastInsertRowid,
      );
      audit(c, "returnReceive", "wmsReturn", id, p);
      return id;
    })
    .immediate();
}
export function inspectReturn(
  c: WmsContext,
  id: number,
  sellableMilli: number,
  destinationBinId: number,
  reason: string,
): void {
  if (!Number.isSafeInteger(sellableMilli) || sellableMilli < 0 || !reason.trim())
    fail("Enter a nonnegative sellable quantity and inspection reason.");
  c.db
    .transaction(() => {
      const r = c.db
        .prepare(
          "SELECT r.*,l.product_id FROM wms_returns r JOIN wms_dispatch_lines l ON l.id=r.dispatch_line_id WHERE r.id=?",
        )
        .get(id) as (WarehouseReturn & { product_id: number }) | undefined;
      if (!r) fail("Return not found.");
      if (r.status === "inspected") {
        if (r.sellable_milli === sellableMilli) return;
        fail("Return already inspected.");
      }
      if (sellableMilli > r.quantity_milli) fail("Sellable quantity exceeds returned quantity.");
      const source = bin(c.db, r.bin_id),
        destination = bin(c.db, destinationBinId);
      if (
        source.warehouse_id !== destination.warehouse_id ||
        !["storage", "pickFace"].includes(destination.type)
      )
        fail("Choose eligible storage in the same warehouse.");
      if (onHandAt(c.db, r.product_id, source.location_id, "quarantine") < r.quantity_milli)
        fail("Returned stock changed during inspection.");
      capacity(c.db, destination, r.product_id, sellableMilli);
      for (const [qty, toStatus, toLocationId, suffix] of [
        [sellableMilli, "available", destination.location_id, "sellable"],
        [r.quantity_milli - sellableMilli, "damaged", source.location_id, "damaged"],
      ] as const) {
        if (qty > 0)
          reclassifyStock(stock(c), {
            productId: r.product_id,
            locationId: source.location_id,
            quantityMilli: qty,
            fromStatus: "quarantine",
            toStatus,
            toLocationId,
            movementDate: c.nowIso.slice(0, 10),
            sourceKind: "wmsReturnInspection",
            sourceId: r.id,
            notes: reason,
            idempotencyKey: `wmsReturn:${r.id}:${suffix}`,
          });
      }
      c.db
        .prepare(
          "UPDATE wms_returns SET sellable_milli=?,status='inspected',inspected_by=?,inspected_at=? WHERE id=?",
        )
        .run(sellableMilli, c.actor.name, c.nowIso, r.id);
      audit(c, "inspect", "wmsReturn", r.id, { sellableMilli, destinationBinId, reason });
    })
    .immediate();
}
export function saveReplenishmentRule(c: WmsContext, input: ReplenishmentInput): number {
  const p = replenishmentSchema.parse(input);
  return c.db
    .transaction(() => {
      const source = bin(c.db, p.sourceBinId),
        destination = bin(c.db, p.destinationBinId);
      physicalProduct(c.db, p.productId);
      if (
        source.id === destination.id ||
        source.warehouse_id !== destination.warehouse_id ||
        source.type !== "storage" ||
        destination.type !== "pickFace"
      )
        fail("Replenishment requires bulk storage and a pick-face bin in one warehouse.");
      if (p.targetMilli <= p.minimumMilli) fail("Target must exceed minimum.");
      if (destination.capacity_milli !== null && p.targetMilli > destination.capacity_milli)
        fail("Target exceeds destination capacity.");
      let id = p.id;
      if (id) {
        if (!c.db.prepare("SELECT id FROM wms_replenishment_rules WHERE id=?").get(id))
          fail("Rule not found.");
        c.db
          .prepare(
            "UPDATE wms_replenishment_rules SET product_id=?,source_bin_id=?,destination_bin_id=?,minimum_milli=?,target_milli=?,active=? WHERE id=?",
          )
          .run(
            p.productId,
            source.id,
            destination.id,
            p.minimumMilli,
            p.targetMilli,
            Number(p.active),
            id,
          );
      } else
        id = Number(
          c.db
            .prepare(
              "INSERT INTO wms_replenishment_rules(product_id,source_bin_id,destination_bin_id,minimum_milli,target_milli,active) VALUES(?,?,?,?,?,?)",
            )
            .run(
              p.productId,
              source.id,
              destination.id,
              p.minimumMilli,
              p.targetMilli,
              Number(p.active),
            ).lastInsertRowid,
        );
      audit(c, "save", "wmsReplenishmentRule", id, p);
      return id;
    })
    .immediate();
}
export function generateReplenishment(c: WmsContext, id: number): number | null {
  return c.db
    .transaction(() => {
      const r = c.db
        .prepare("SELECT * FROM wms_replenishment_rules WHERE id=? AND active=1")
        .get(id) as ReplenishmentRule | undefined;
      if (!r) fail("Active replenishment rule not found.");
      const source = bin(c.db, r.source_bin_id),
        destination = bin(c.db, r.destination_bin_id);
      const pending = c.db
        .prepare(
          "SELECT COALESCE(SUM(quantity_milli-actual_milli),0) qty FROM wms_tasks WHERE destination_bin_id=? AND product_id=? AND status NOT IN ('completed','cancelled')",
        )
        .get(destination.id, r.product_id) as { qty: number };
      const eligible = availableQuantity(c.db, r.product_id, destination.location_id);
      if (eligible + pending.qty >= r.minimum_milli) return null;
      const quantity = Math.min(
        r.target_milli - eligible - pending.qty,
        Math.max(0, freeBalance(c.db, r.product_id, source)),
      );
      if (quantity <= 0) fail("No eligible bulk stock is available for replenishment.");
      capacity(c.db, destination, r.product_id, quantity);
      const taskId = Number(
        c.db
          .prepare(
            "INSERT INTO wms_tasks(type,product_id,source_bin_id,destination_bin_id,quantity_milli,replenishment_rule_id,created_at) VALUES('replenish',?,?,?,?,?,?)",
          )
          .run(r.product_id, source.id, destination.id, quantity, id, c.nowIso).lastInsertRowid,
      );
      audit(c, "generate", "wmsReplenishmentRule", id, { taskId, quantityMilli: quantity });
      return taskId;
    })
    .immediate();
}
