import type { SqliteDatabase } from "../../../data/connection";
import { recordAudit, type AuditActor } from "../../audit-writer";
import { availableQuantity, postMovement, type StockContext } from "../ims/stock";
import { readWmsSettings } from "./config";
import {
  warehouseSchema,
  binSchema,
  inboundSchema,
  receiptSchema,
  taskCompleteSchema,
  moveSchema,
  type WarehouseInput,
  type BinInput,
  type InboundInput,
  type ReceiptInput,
  type CompleteTaskInput,
  type Warehouse,
  type Bin,
  type Inbound,
  type InboundLine,
  type WarehouseTask,
  type WmsSnapshot,
  type Position,
} from "../../../shared/wms";

export class WmsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WmsError";
  }
}
export interface WmsContext {
  db: SqliteDatabase;
  actor: AuditActor;
  nowIso: string;
}
export function fail(message: string): never {
  throw new WmsError(message);
}
export function stock(c: WmsContext): StockContext {
  return {
    db: c.db,
    actorName: c.actor.name,
    nowIso: c.nowIso,
    nowDate: c.nowIso.slice(0, 10),
    allowNegativeStock: false,
  };
}
export function audit(
  c: WmsContext,
  action: string,
  entityType: string,
  entityId: number,
  values: unknown,
) {
  recordAudit(
    c.db,
    c.actor,
    { module: "warehouse", action, entityType, entityId, newValues: values },
    c.nowIso,
  );
}
function warehouse(db: SqliteDatabase, id: number): Warehouse {
  return (
    (db.prepare("SELECT * FROM wms_warehouses WHERE id=?").get(id) as Warehouse | undefined) ??
    fail("Warehouse not found.")
  );
}
export function bin(db: SqliteDatabase, id: number): Bin {
  const result = db.prepare("SELECT * FROM wms_bins WHERE id=?").get(id) as Bin | undefined;
  if (!result) fail("Bin not found.");
  if (!result.active || result.blocked || !warehouse(db, result.warehouse_id).active)
    fail("The bin or warehouse is inactive or blocked.");
  return result;
}
export function physicalProduct(db: SqliteDatabase, id: number) {
  const p = db
    .prepare("SELECT id,sku,barcode,is_service,is_serialised FROM products WHERE id=?")
    .get(id) as
    | {
        id: number;
        sku: string | null;
        barcode: string | null;
        is_service: number;
        is_serialised: number;
      }
    | undefined;
  if (!p || p.is_service) fail("Choose an existing physical product.");
  if (p.is_serialised)
    fail(
      "Serialized products require the IMS serial workflow; this warehouse command does not support them yet.",
    );
  return p;
}
export function capacity(db: SqliteDatabase, target: Bin, productId: number, quantity: number) {
  const rows = db
    .prepare(
      "SELECT product_id,SUM(quantity_milli) qty FROM wms_stock_movements WHERE location_id=? GROUP BY product_id HAVING qty<>0",
    )
    .all(target.location_id) as { product_id: number; qty: number }[];
  if (
    !target.mixed_sku &&
    (productId === 0
      ? rows.filter((r) => r.qty > 0).length > 1
      : rows.some((r) => r.product_id !== productId && r.qty > 0))
  )
    fail("This bin does not allow mixed SKUs.");
  const total = rows.reduce((sum, r) => sum + r.qty, 0);
  if (target.capacity_milli !== null && total + quantity > target.capacity_milli)
    fail("The destination bin does not have enough quantity capacity.");
}
function untrackedBalance(db: SqliteDatabase, productId: number, locationId: number): number {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(quantity_milli),0) qty FROM wms_stock_movements WHERE product_id=? AND location_id=? AND stock_status='available' AND batch_no IS NULL AND serial_no IS NULL",
    )
    .get(productId, locationId) as { qty: number };
  return Math.min(row.qty, availableQuantity(db, productId, locationId));
}
export function freeBalance(db: SqliteDatabase, productId: number, source: Bin, exceptTask = 0) {
  const pending = db
    .prepare(
      "SELECT COALESCE(SUM(quantity_milli-actual_milli),0) qty FROM wms_tasks WHERE source_bin_id=? AND product_id=? AND status NOT IN ('completed','cancelled') AND type<>'pick' AND id<>?",
    )
    .get(source.id, productId, exceptTask) as { qty: number };
  return untrackedBalance(db, productId, source.location_id) - pending.qty;
}
export function move(
  c: WmsContext,
  source: Bin,
  destination: Bin,
  productId: number,
  qty: number,
  key: string,
  sourceId: number,
) {
  if (source.id === destination.id) fail("Source and destination must differ.");
  if (source.warehouse_id !== destination.warehouse_id)
    fail("Cross-warehouse transport requires an in-transit workflow; use a same-warehouse move.");
  if (
    ["quarantine", "returns"].includes(source.type) ||
    ["quarantine", "returns"].includes(destination.type)
  )
    fail("Held goods require an inspection disposition, not a normal move.");
  capacity(c.db, destination, productId, qty);
  if (untrackedBalance(c.db, productId, source.location_id) < qty)
    fail("Insufficient eligible source stock, or stock is reserved/tracked.");
  for (const [target, quantity, suffix] of [
    [source, -qty, "out"],
    [destination, qty, "in"],
  ] as const) {
    postMovement(stock(c), {
      productId,
      locationId: target.location_id,
      quantityMilli: quantity,
      movementDate: c.nowIso.slice(0, 10),
      kind: quantity < 0 ? "issue" : "receipt",
      affectProductTotal: false,
      sourceKind: "wmsTask",
      sourceId,
      idempotencyKey: `${key}:${suffix}`,
    });
  }
}

export function saveWarehouse(c: WmsContext, input: WarehouseInput): Warehouse {
  const p = warehouseSchema.parse(input);
  return c.db
    .transaction(() => {
      if (
        c.db.prepare("SELECT id FROM wms_warehouses WHERE code=? AND id<>?").get(p.code, p.id ?? 0)
      )
        fail("Warehouse code is already in use.");
      let id = p.id;
      if (id !== undefined) {
        warehouse(c.db, id);
        if (!p.active) {
          const busy = c.db
            .prepare(
              "SELECT 1 FROM wms_bins b JOIN wms_stock_movements m ON m.location_id=b.location_id WHERE b.warehouse_id=? GROUP BY b.id,m.product_id,m.stock_status HAVING SUM(m.quantity_milli)<>0 LIMIT 1",
            )
            .get(id);
          const tasks = c.db
            .prepare(
              "SELECT 1 FROM wms_tasks t JOIN wms_bins b ON b.id=t.source_bin_id WHERE b.warehouse_id=? AND t.status NOT IN ('completed','cancelled') LIMIT 1",
            )
            .get(id);
          const rootStock = c.db
            .prepare(
              "SELECT 1 FROM wms_stock_movements m JOIN wms_warehouses w ON w.ims_location_id=m.location_id WHERE w.id=? GROUP BY m.product_id,m.stock_status,m.batch_no HAVING SUM(m.quantity_milli)<>0 LIMIT 1",
            )
            .get(id);
          const inbound = c.db
            .prepare(
              "SELECT 1 FROM wms_inbounds WHERE warehouse_id=? AND status NOT IN ('received','cancelled') LIMIT 1",
            )
            .get(id);
          const outbound = c.db
            .prepare(
              "SELECT 1 FROM wms_dispatches WHERE warehouse_id=? AND status NOT IN ('handedOver','cancelled') LIMIT 1",
            )
            .get(id);
          if (busy || tasks || rootStock || inbound || outbound)
            fail("Cannot deactivate a warehouse with stock, open documents or open tasks.");
        }
        c.db
          .prepare(
            "UPDATE wms_warehouses SET code=?,name=?,address=?,site=?,branch=?,active=?,updated_at=? WHERE id=?",
          )
          .run(p.code, p.name, p.address, p.site, p.site, Number(p.active), c.nowIso, id);
      } else {
        const locationId = Number(
          c.db
            .prepare(
              "INSERT INTO ims_locations(code,name,type,is_default,is_active,created_at,updated_at) VALUES(?,?,'warehouse',0,?,?,?)",
            )
            .run(`WMS-WH:${p.code}`, p.name, Number(p.active), c.nowIso, c.nowIso).lastInsertRowid,
        );
        id = Number(
          c.db
            .prepare(
              "INSERT INTO wms_warehouses(code,name,ims_location_id,address,site,branch,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
            )
            .run(
              p.code,
              p.name,
              locationId,
              p.address,
              p.site,
              p.site,
              Number(p.active),
              c.nowIso,
              c.nowIso,
            ).lastInsertRowid,
        );
      }
      audit(c, "save", "wmsWarehouse", id, p);
      return warehouse(c.db, id);
    })
    .immediate();
}

export function saveBin(c: WmsContext, input: BinInput): number {
  const p = binSchema.parse(input);
  return c.db
    .transaction(() => {
      if (!warehouse(c.db, p.warehouseId).active) fail("Warehouse is inactive.");
      if (c.db.prepare("SELECT id FROM wms_bins WHERE code=? AND id<>?").get(p.code, p.id ?? 0))
        fail("Bin code is already in use.");
      let id = p.id;
      let locationId: number;
      if (id !== undefined) {
        const old = c.db.prepare("SELECT * FROM wms_bins WHERE id=?").get(id) as Bin | undefined;
        if (!old) fail("Bin not found.");
        if (old.warehouse_id !== p.warehouseId || old.type !== p.type)
          fail("Warehouse and bin type cannot be changed after creation.");
        const total = c.db
          .prepare(
            "SELECT COALESCE(SUM(quantity_milli),0) qty FROM wms_stock_movements WHERE location_id=?",
          )
          .get(old.location_id) as { qty: number };
        const task = c.db
          .prepare(
            "SELECT 1 FROM wms_tasks WHERE (source_bin_id=? OR destination_bin_id=?) AND status NOT IN ('completed','cancelled') LIMIT 1",
          )
          .get(id, id);
        if (!p.active && (total.qty !== 0 || task))
          fail("Resolve physical stock and tasks before disabling this bin.");
        capacity(
          c.db,
          { ...old, capacity_milli: p.capacityMilli, mixed_sku: Number(p.mixedSku) },
          0,
          0,
        );
        locationId = old.location_id;
        c.db
          .prepare(
            "UPDATE wms_bins SET code=?,zone=?,aisle=?,rack=?,shelf=?,capacity_milli=?,mixed_sku=?,blocked=?,active=? WHERE id=?",
          )
          .run(
            p.code,
            p.zone,
            p.aisle,
            p.rack,
            p.shelf,
            p.capacityMilli,
            Number(p.mixedSku),
            Number(p.blocked),
            Number(p.active),
            id,
          );
      } else {
        locationId = Number(
          c.db
            .prepare(
              "INSERT INTO ims_locations(code,name,type,is_default,is_active,created_at,updated_at) VALUES(?,?,?,0,1,?,?)",
            )
            .run(
              `WMS:${p.code}`,
              p.code,
              p.type === "quarantine" || p.type === "returns" ? "quarantine" : "warehouse",
              c.nowIso,
              c.nowIso,
            ).lastInsertRowid,
        );
        id = Number(
          c.db
            .prepare(
              "INSERT INTO wms_bins(warehouse_id,location_id,code,zone,aisle,rack,shelf,type,capacity_milli,mixed_sku,blocked,active) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              p.warehouseId,
              locationId,
              p.code,
              p.zone,
              p.aisle,
              p.rack,
              p.shelf,
              p.type,
              p.capacityMilli,
              Number(p.mixedSku),
              Number(p.blocked),
              Number(p.active),
            ).lastInsertRowid,
        );
      }
      c.db
        .prepare("UPDATE ims_locations SET name=?,is_active=?,updated_at=? WHERE id=?")
        .run(p.code, Number(p.active), c.nowIso, locationId);
      audit(c, "save", "wmsBin", id, p);
      return id;
    })
    .immediate();
}

export function createInbound(c: WmsContext, input: InboundInput): number {
  const p = inboundSchema.parse(input);
  return c.db
    .transaction(() => {
      if (!warehouse(c.db, p.warehouseId).active) fail("Warehouse is inactive.");
      if (new Set(p.lines.map((l) => l.productId)).size !== p.lines.length)
        fail("Combine duplicate SKU lines.");
      p.lines.forEach((l) => physicalProduct(c.db, l.productId));
      const id = Number(
        c.db
          .prepare(
            "INSERT INTO wms_inbounds(number,warehouse_id,reference,created_at,created_by) VALUES(lower(hex(randomblob(8))),?,?,?,?)",
          )
          .run(p.warehouseId, p.reference, c.nowIso, c.actor.name).lastInsertRowid,
      );
      c.db
        .prepare("UPDATE wms_inbounds SET number=? WHERE id=?")
        .run(`ASN-${String(id).padStart(6, "0")}`, id);
      for (const l of p.lines)
        c.db
          .prepare(
            "INSERT INTO wms_inbound_lines(inbound_id,product_id,expected_milli) VALUES(?,?,?)",
          )
          .run(id, l.productId, l.quantityMilli);
      audit(c, "create", "wmsInbound", id, p);
      return id;
    })
    .immediate();
}
export function arriveInbound(c: WmsContext, id: number): void {
  c.db
    .transaction(() => {
      const doc = c.db.prepare("SELECT status FROM wms_inbounds WHERE id=?").get(id) as
        { status: string } | undefined;
      if (!doc) fail("Inbound reference not found.");
      if (doc.status === "arrived") return;
      if (doc.status !== "expected") fail("Only expected inbound references can arrive.");
      c.db.prepare("UPDATE wms_inbounds SET status='arrived' WHERE id=?").run(id);
      audit(c, "arrive", "wmsInbound", id, { status: "arrived" });
    })
    .immediate();
}

export function receive(c: WmsContext, input: ReceiptInput): number {
  const p = receiptSchema.parse(input);
  return c.db
    .transaction(() => {
      const replay = c.db
        .prepare("SELECT * FROM wms_receipts WHERE command_key=?")
        .get(p.commandKey) as
        | {
            id: number;
            inbound_line_id: number;
            bin_id: number;
            quantity_milli: number;
            damaged_milli: number;
          }
        | undefined;
      if (replay) {
        if (
          replay.inbound_line_id !== p.lineId ||
          replay.bin_id !== p.binId ||
          replay.quantity_milli !== p.quantityMilli ||
          replay.damaged_milli !== p.damagedMilli
        )
          fail("The receipt command key was already used for different inputs.");
        return replay.id;
      }
      const line = c.db
        .prepare(
          "SELECT l.*,d.warehouse_id,d.status FROM wms_inbound_lines l JOIN wms_inbounds d ON d.id=l.inbound_id WHERE l.id=?",
        )
        .get(p.lineId) as (InboundLine & { warehouse_id: number; status: string }) | undefined;
      if (!line) fail("Inbound line not found.");
      if (!["arrived", "partiallyReceived"].includes(line.status))
        fail("Mark the inbound reference arrived before receiving.");
      physicalProduct(c.db, line.product_id);
      if (p.damagedMilli > p.quantityMilli)
        fail("Damaged quantity cannot exceed received quantity.");
      if (line.received_milli + p.quantityMilli > line.expected_milli)
        fail("Over-receipt is blocked. Correct the expected reference first.");
      const area = bin(c.db, p.binId);
      if (area.warehouse_id !== line.warehouse_id || area.type !== "receiving")
        fail("Choose a receiving bin in this inbound warehouse.");
      const accepted = p.quantityMilli - p.damagedMilli;
      capacity(c.db, area, line.product_id, accepted);
      let held: Bin | undefined;
      if (p.damagedMilli > 0) {
        held = c.db
          .prepare(
            "SELECT * FROM wms_bins WHERE warehouse_id=? AND type='quarantine' AND active=1 AND blocked=0 ORDER BY id LIMIT 1",
          )
          .get(line.warehouse_id) as Bin | undefined;
        if (!held) fail("Configure an active quarantine bin before receiving damaged goods.");
        capacity(c.db, held, line.product_id, p.damagedMilli);
      }
      const id = Number(
        c.db
          .prepare(
            "INSERT INTO wms_receipts(command_key,inbound_line_id,bin_id,quantity_milli,damaged_milli,created_at,created_by) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            p.commandKey,
            p.lineId,
            p.binId,
            p.quantityMilli,
            p.damagedMilli,
            c.nowIso,
            c.actor.name,
          ).lastInsertRowid,
      );
      for (const [target, qty, status] of [
        [area, accepted, "available"],
        [held, p.damagedMilli, "damaged"],
      ] as const) {
        if (!target || qty === 0) continue;
        postMovement(stock(c), {
          productId: line.product_id,
          locationId: target.location_id,
          quantityMilli: qty,
          movementDate: c.nowIso.slice(0, 10),
          kind: "receipt",
          stockStatus: status,
          sourceKind: "wmsReceipt",
          sourceId: id,
          idempotencyKey: `wmsReceipt:${id}:${status}`,
        });
      }
      if (accepted > 0 && readWmsSettings(c.db).autoPutaway) {
        const candidates = c.db
          .prepare(
            "SELECT * FROM wms_bins WHERE warehouse_id=? AND type IN ('storage','pickFace') AND active=1 AND blocked=0 ORDER BY CASE type WHEN 'storage' THEN 0 ELSE 1 END,code",
          )
          .all(line.warehouse_id) as Bin[];
        const destination = candidates.find((b) => {
          try {
            const incoming = c.db
              .prepare(
                "SELECT product_id,SUM(quantity_milli-actual_milli) qty FROM wms_tasks WHERE destination_bin_id=? AND status NOT IN ('completed','cancelled') GROUP BY product_id",
              )
              .all(b.id) as { product_id: number; qty: number }[];
            if (!b.mixed_sku && incoming.some((r) => r.product_id !== line.product_id && r.qty > 0))
              return false;
            capacity(
              c.db,
              b,
              line.product_id,
              accepted + incoming.reduce((sum, r) => sum + r.qty, 0),
            );
            return true;
          } catch (e) {
            if (e instanceof WmsError) return false;
            throw e;
          }
        });
        c.db
          .prepare(
            "INSERT INTO wms_tasks(type,product_id,source_bin_id,destination_bin_id,quantity_milli,receipt_id,created_at) VALUES('putaway',?,?,?,?,?,?)",
          )
          .run(line.product_id, area.id, destination?.id ?? null, accepted, id, c.nowIso);
      }
      c.db
        .prepare("UPDATE wms_inbound_lines SET received_milli=received_milli+? WHERE id=?")
        .run(p.quantityMilli, line.id);
      const outstanding = c.db
        .prepare(
          "SELECT 1 FROM wms_inbound_lines WHERE inbound_id=? AND received_milli<expected_milli LIMIT 1",
        )
        .get(line.inbound_id);
      c.db
        .prepare("UPDATE wms_inbounds SET status=? WHERE id=?")
        .run(outstanding ? "partiallyReceived" : "received", line.inbound_id);
      audit(c, "receive", "wmsReceipt", id, p);
      return id;
    })
    .immediate();
}

export function createMove(
  c: WmsContext,
  input: {
    sourceBinId: number;
    destinationBinId: number;
    productId: number;
    quantityMilli: number;
  },
): number {
  const p = moveSchema.parse(input);
  return c.db
    .transaction(() => {
      physicalProduct(c.db, p.productId);
      const source = bin(c.db, p.sourceBinId),
        dest = bin(c.db, p.destinationBinId);
      if (source.id === dest.id || source.warehouse_id !== dest.warehouse_id)
        fail("Choose different bins in the same warehouse.");
      if (
        ["quarantine", "returns"].includes(source.type) ||
        ["quarantine", "returns"].includes(dest.type)
      )
        fail("Held stock requires a controlled disposition.");
      if (freeBalance(c.db, p.productId, source) < p.quantityMilli)
        fail("Stock is unavailable or already committed to warehouse work.");
      capacity(c.db, dest, p.productId, p.quantityMilli);
      const id = Number(
        c.db
          .prepare(
            "INSERT INTO wms_tasks(type,product_id,source_bin_id,destination_bin_id,quantity_milli,created_at) VALUES('move',?,?,?,?,?)",
          )
          .run(p.productId, source.id, dest.id, p.quantityMilli, c.nowIso).lastInsertRowid,
      );
      audit(c, "create", "wmsTask", id, p);
      return id;
    })
    .immediate();
}
export function assignTask(c: WmsContext, id: number, workerId: number): void {
  c.db
    .transaction(() => {
      if (
        !c.db
          .prepare(
            "SELECT u.id FROM users u JOIN role_permissions p ON p.role_id=u.role_id WHERE u.id=? AND u.is_active=1 AND p.module='warehouse' AND p.action='edit'",
          )
          .get(workerId)
      )
        fail("Select an active worker with warehouse execution permission.");
      const change = c.db
        .prepare(
          "UPDATE wms_tasks SET assigned_to=?,status='assigned' WHERE id=? AND status IN ('created','assigned')",
        )
        .run(workerId, id);
      if (!change.changes) fail("Only ready tasks can be assigned.");
      audit(c, "assign", "wmsTask", id, { workerId });
    })
    .immediate();
}
export function startTask(c: WmsContext, id: number): void {
  c.db
    .transaction(() => {
      const task = c.db.prepare("SELECT assigned_to,status FROM wms_tasks WHERE id=?").get(id) as
        { assigned_to: number | null; status: string } | undefined;
      if (!task) fail("Task not found.");
      if (task.assigned_to !== null && task.assigned_to !== c.actor.id)
        fail("Task belongs to another worker.");
      if (task.status === "started") return;
      if (!["created", "assigned"].includes(task.status)) fail("Only ready tasks may be started.");
      c.db
        .prepare("UPDATE wms_tasks SET status='started',started_at=?,assigned_to=? WHERE id=?")
        .run(c.nowIso, c.actor.id, id);
      audit(c, "start", "wmsTask", id, { workerId: c.actor.id });
    })
    .immediate();
}
export function completeTask(c: WmsContext, input: CompleteTaskInput): void {
  const p = taskCompleteSchema.parse(input);
  c.db
    .transaction(() => {
      const t = c.db.prepare("SELECT * FROM wms_tasks WHERE id=?").get(p.id) as
        (WarehouseTask & { completion_key: string | null }) | undefined;
      if (!t) fail("Task not found.");
      if (t.type === "pick") fail("Use the picking workstation to confirm allocated pick work.");
      if (t.status === "completed") {
        if (
          t.completion_key === p.commandKey &&
          t.destination_bin_id === p.destinationBinId &&
          t.actual_milli === p.quantityMilli
        )
          return;
        fail("Task has already completed; refresh the task list.");
      }
      if (!["created", "assigned", "started"].includes(t.status))
        fail("This task cannot be completed.");
      if (t.assigned_to !== null && c.actor.id !== t.assigned_to)
        fail("Task is assigned to another worker. Reassign before completion.");
      const source = bin(c.db, t.source_bin_id),
        destination = bin(c.db, p.destinationBinId),
        product = physicalProduct(c.db, t.product_id);
      if (p.sourceScan !== source.code || p.destinationScan !== destination.code)
        fail("Bin scan mismatch. Scan the source and destination shown on the task.");
      if (p.productScan !== product.sku && p.productScan !== product.barcode)
        fail("Wrong SKU/barcode. No stock was moved.");
      if (t.destination_bin_id !== null && destination.id !== t.destination_bin_id)
        fail("Destination differs from the task. Supervisor must choose an alternate bin.");
      if (t.type === "putaway" && !["storage", "pickFace"].includes(destination.type))
        fail("Putaway requires a storage or pick-face bin.");
      const remaining = t.quantity_milli - t.actual_milli;
      if (p.quantityMilli > remaining) fail("Quantity exceeds remaining task quantity.");
      if (freeBalance(c.db, t.product_id, source, t.id) < p.quantityMilli)
        fail("Source stock changed or is committed to another task.");
      move(c, source, destination, t.product_id, p.quantityMilli, `wmsTask:${p.commandKey}`, t.id);
      if (p.quantityMilli < remaining) {
        c.db
          .prepare(
            "INSERT INTO wms_tasks(type,product_id,source_bin_id,destination_bin_id,quantity_milli,created_at) VALUES(?,?,?,?,?,?)",
          )
          .run(
            t.type,
            t.product_id,
            source.id,
            destination.id,
            remaining - p.quantityMilli,
            c.nowIso,
          );
      }
      c.db
        .prepare(
          "UPDATE wms_tasks SET destination_bin_id=?,actual_milli=?,status='completed',started_at=COALESCE(started_at,?),completed_at=?,completion_key=? WHERE id=?",
        )
        .run(destination.id, p.quantityMilli, c.nowIso, c.nowIso, p.commandKey, t.id);
      audit(c, "complete", "wmsTask", t.id, p);
    })
    .immediate();
}

/** Mapping adds hierarchy metadata to an existing IMS location; it never posts stock. */
export function mapLocation(
  c: WmsContext,
  warehouseId: number,
  locationId: number,
  code: string,
): number {
  return c.db
    .transaction(() => {
      warehouse(c.db, warehouseId);
      const loc = c.db
        .prepare("SELECT type,is_active FROM ims_locations WHERE id=?")
        .get(locationId) as { type: string; is_active: number } | undefined;
      if (!loc || !loc.is_active) fail("Choose an active IMS location.");
      if (!/^[A-Za-z0-9_/-]{1,100}$/.test(code))
        fail("Use a unique bin code with letters, digits, slash, dash or underscore.");
      if (loc.type === "transit") fail("In-transit locations cannot be mapped as storage.");
      const id = Number(
        c.db
          .prepare("INSERT INTO wms_bins(warehouse_id,location_id,code,type) VALUES(?,?,?,?)")
          .run(
            warehouseId,
            locationId,
            code,
            ["quarantine", "damaged"].includes(loc.type) ? "quarantine" : "storage",
          ).lastInsertRowid,
      );
      audit(c, "map", "wmsBin", id, { warehouseId, locationId, code });
      return id;
    })
    .immediate();
}

export function snapshot(db: SqliteDatabase, nowIso: string): WmsSnapshot {
  const warehouses = db.prepare("SELECT * FROM wms_warehouses ORDER BY code").all() as Warehouse[];
  const bins = db
    .prepare(
      "SELECT b.*,COALESCE((SELECT SUM(quantity_milli) FROM wms_stock_movements WHERE location_id=b.location_id),0) quantity_milli FROM wms_bins b ORDER BY b.code",
    )
    .all() as Bin[];
  const positions = db
    .prepare(
      `SELECT w.code warehouse,b.code bin,b.id bin_id,b.location_id,p.id product_id,p.sku,p.name,m.stock_status,m.batch_no,SUM(m.quantity_milli) quantity_milli
    FROM wms_stock_movements m JOIN wms_bins b ON b.location_id=m.location_id JOIN wms_warehouses w ON w.id=b.warehouse_id JOIN products p ON p.id=m.product_id
    GROUP BY b.id,p.id,m.stock_status,m.batch_no HAVING SUM(m.quantity_milli)<>0 ORDER BY w.code,b.code,p.sku`,
    )
    .all() as Position[];
  const inbounds = db.prepare("SELECT * FROM wms_inbounds ORDER BY id DESC").all() as Inbound[];
  const lines = db
    .prepare(
      "SELECT l.*,p.sku,p.name FROM wms_inbound_lines l JOIN products p ON p.id=l.product_id",
    )
    .all() as InboundLine[];
  inbounds.forEach((d) => {
    d.lines = lines.filter((l) => l.inbound_id === d.id);
  });
  const tasks = db
    .prepare(
      "SELECT t.*,p.sku,p.name,s.code source,d.code destination FROM wms_tasks t JOIN products p ON p.id=t.product_id JOIN wms_bins s ON s.id=t.source_bin_id LEFT JOIN wms_bins d ON d.id=t.destination_bin_id ORDER BY t.id DESC",
    )
    .all() as WarehouseTask[];
  const products = db
    .prepare("SELECT id,sku,name FROM products WHERE is_service=0 ORDER BY name")
    .all() as WmsSnapshot["products"];
  const unassigned = db
    .prepare(
      "SELECT m.location_id,m.product_id,p.sku,SUM(m.quantity_milli) quantity_milli FROM wms_stock_movements m JOIN products p ON p.id=m.product_id LEFT JOIN wms_bins b ON b.location_id=m.location_id WHERE b.id IS NULL GROUP BY m.location_id,m.product_id HAVING SUM(m.quantity_milli)<>0",
    )
    .all() as WmsSnapshot["unassigned"];
  const reconciliation = db
    .prepare(
      "SELECT p.id product_id,p.sku,p.quantity_milli cached_milli,COALESCE(SUM(m.quantity_milli),0) ledger_milli FROM products p LEFT JOIN wms_stock_movements m ON m.product_id=p.id WHERE p.is_service=0 GROUP BY p.id HAVING cached_milli<>ledger_milli",
    )
    .all() as WmsSnapshot["reconciliation"];
  const dispatches = db
    .prepare("SELECT * FROM wms_dispatches ORDER BY id DESC")
    .all() as WmsSnapshot["dispatches"];
  const dispatchLines = db
    .prepare(
      `SELECT l.*,p.sku,
    COALESCE((SELECT SUM(actual_milli) FROM wms_tasks WHERE dispatch_line_id=l.id AND status='completed'),0) picked_milli,
    COALESCE((SELECT SUM(quantity_milli) FROM wms_carton_lines WHERE dispatch_line_id=l.id),0) packed_milli
    FROM wms_dispatch_lines l JOIN products p ON p.id=l.product_id`,
    )
    .all() as WmsSnapshot["dispatches"][number]["lines"];
  dispatches.forEach((d) => {
    d.lines = dispatchLines.filter((l) => l.dispatch_id === d.id);
  });
  const cartons = db
    .prepare(
      "SELECT c.*,COALESCE((SELECT SUM(quantity_milli) FROM wms_carton_lines WHERE carton_id=c.id),0) quantity_milli FROM wms_cartons c ORDER BY id DESC",
    )
    .all() as WmsSnapshot["cartons"];
  const counts = db
    .prepare(
      "SELECT c.*,b.code bin,p.sku FROM wms_counts c JOIN wms_bins b ON b.id=c.bin_id JOIN products p ON p.id=c.product_id ORDER BY c.id DESC",
    )
    .all() as WmsSnapshot["counts"];
  const adoptableReceipts = db
    .prepare(
      `SELECT m.id,m.product_id,p.sku,m.source_kind,m.source_id,m.quantity_milli,m.location_id
    FROM wms_stock_movements m JOIN products p ON p.id=m.product_id LEFT JOIN wms_adoptions a ON a.movement_id=m.id
    WHERE a.id IS NULL AND m.quantity_milli>0 AND m.kind='receipt' AND m.stock_status='available' AND m.batch_no IS NULL AND m.serial_no IS NULL
    AND (m.source_kind='goodsReceipt' OR (m.source_kind='manufacturingOrder' AND EXISTS(SELECT 1 FROM manufacturing_finished_receipts fr WHERE fr.stock_movement_id=m.id AND fr.accepted_qty>=m.quantity_milli AND fr.rejected_qty=0))) ORDER BY m.id DESC`,
    )
    .all() as WmsSnapshot["adoptableReceipts"];
  const returns = db
    .prepare(
      "SELECT r.*,p.sku FROM wms_returns r JOIN wms_dispatch_lines l ON l.id=r.dispatch_line_id JOIN products p ON p.id=l.product_id ORDER BY r.id DESC",
    )
    .all() as WmsSnapshot["returns"];
  const replenishmentRules = db
    .prepare(
      "SELECT r.*,p.sku,s.code source,d.code destination FROM wms_replenishment_rules r JOIN products p ON p.id=r.product_id JOIN wms_bins s ON s.id=r.source_bin_id JOIN wms_bins d ON d.id=r.destination_bin_id ORDER BY r.id",
    )
    .all() as WmsSnapshot["replenishmentRules"];
  const docks = db.prepare("SELECT * FROM wms_docks ORDER BY code").all() as WmsSnapshot["docks"];
  const appointments = db
    .prepare("SELECT * FROM wms_appointments ORDER BY starts_at DESC")
    .all() as WmsSnapshot["appointments"];
  const suppliers = db
    .prepare("SELECT id,name FROM parties WHERE kind IN ('supplier','both') ORDER BY name")
    .all() as WmsSnapshot["suppliers"];
  const workers = db
    .prepare("SELECT id,display_name FROM users WHERE is_active=1 ORDER BY display_name")
    .all() as WmsSnapshot["workers"];
  return {
    warehouses,
    bins,
    positions,
    inbounds,
    tasks,
    products,
    unassigned,
    reconciliation,
    dispatches,
    cartons,
    counts,
    settings: readWmsSettings(db),
    adoptableReceipts,
    returns,
    replenishmentRules,
    docks,
    appointments,
    suppliers,
    workers,
    generatedAt: nowIso,
  };
}
