import { postMovement, availableQuantity } from "../ims/stock";
import { bin, capacity, physicalProduct, audit, fail, type WmsContext } from "./operations";
/** Adopt a real posted IMS/MMS receipt. Never receive company stock again. */
export function adoptReceipt(c: WmsContext, movementId: number, receivingBinId: number): number {
  return c.db
    .transaction(() => {
      const prior = c.db
        .prepare("SELECT id,receiving_bin_id FROM wms_adoptions WHERE movement_id=?")
        .get(movementId) as { id: number; receiving_bin_id: number } | undefined;
      if (prior) {
        if (prior.receiving_bin_id !== receivingBinId)
          fail("This receipt has already been adopted into another receiving bin.");
        return prior.id;
      }
      const movement = c.db
        .prepare("SELECT * FROM wms_stock_movements WHERE id=?")
        .get(movementId) as
        | {
            product_id: number;
            location_id: number;
            quantity_milli: number;
            source_kind: string;
            kind: string;
            stock_status: string;
            batch_no: string | null;
            serial_no: string | null;
          }
        | undefined;
      if (
        !movement ||
        movement.quantity_milli <= 0 ||
        movement.kind !== "receipt" ||
        !["goodsReceipt", "manufacturingOrder"].includes(movement.source_kind)
      )
        fail("Select a posted IMS goods receipt or accepted MMS finished receipt.");
      if (
        movement.stock_status !== "available" ||
        movement.batch_no !== null ||
        movement.serial_no !== null
      )
        fail("Held, lot and serial receipts require their tracking-specific adoption workflow.");
      if (
        movement.source_kind === "manufacturingOrder" &&
        !c.db
          .prepare(
            "SELECT id FROM manufacturing_finished_receipts WHERE stock_movement_id=? AND accepted_qty>=? AND rejected_qty=0",
          )
          .get(movementId, movement.quantity_milli)
      )
        fail(
          "Only an accepted finished-goods receipt may be adopted from MMS; a material/WIP movement is not finished output.",
        );
      physicalProduct(c.db, movement.product_id);
      const receiving = bin(c.db, receivingBinId);
      if (receiving.type !== "receiving") fail("Choose a physical receiving bin.");
      if (
        availableQuantity(c.db, movement.product_id, movement.location_id) < movement.quantity_milli
      )
        fail("This receipt is no longer fully available at its original location.");
      const mapped = c.db
        .prepare("SELECT id FROM wms_bins WHERE location_id=?")
        .get(movement.location_id);
      if (mapped && movement.location_id !== receiving.location_id)
        fail(
          "The receipt location is already mapped to a bin. Use a controlled warehouse transfer.",
        );
      if (receiving.location_id !== movement.location_id)
        capacity(c.db, receiving, movement.product_id, movement.quantity_milli);
      const id = Number(
        c.db
          .prepare(
            "INSERT INTO wms_adoptions(movement_id,receiving_bin_id,created_at,created_by) VALUES(?,?,?,?)",
          )
          .run(movementId, receiving.id, c.nowIso, c.actor.name).lastInsertRowid,
      );
      if (receiving.location_id !== movement.location_id)
        for (const [locationId, quantity, suffix] of [
          [movement.location_id, -movement.quantity_milli, "out"],
          [receiving.location_id, movement.quantity_milli, "in"],
        ] as const)
          postMovement(
            {
              db: c.db,
              actorName: c.actor.name,
              nowIso: c.nowIso,
              nowDate: c.nowIso.slice(0, 10),
              allowNegativeStock: false,
            },
            {
              productId: movement.product_id,
              locationId,
              quantityMilli: quantity,
              kind: quantity < 0 ? "issue" : "receipt",
              movementDate: c.nowIso.slice(0, 10),
              affectProductTotal: false,
              sourceKind: "wmsAdoption",
              sourceId: id,
              idempotencyKey: `wmsAdoption:${movementId}:${suffix}`,
            },
          );
      c.db
        .prepare(
          "INSERT INTO wms_tasks(type,product_id,source_bin_id,quantity_milli,created_at) VALUES('putaway',?,?,?,?)",
        )
        .run(movement.product_id, receiving.id, movement.quantity_milli, c.nowIso);
      audit(c, "adopt", "wmsReceiptAdoption", id, { movementId, receivingBinId });
      return id;
    })
    .immediate();
}
