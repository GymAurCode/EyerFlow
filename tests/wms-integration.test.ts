import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, it, expect } from "vitest";
import { openInMemoryDatabase, type SqliteDatabase } from "../src/data/connection";
import { runMigrations } from "../src/data/migrator";
import { migrations } from "../src/data/migrations";
import { item, NOW } from "./planning-fixtures";
import { SYSTEM_ACTOR } from "../src/main/audit-writer";
import {
  saveOperation,
  transitionOperation,
  type OperationContext,
} from "../src/main/repositories/ims/operations";
import { postMovement } from "../src/main/repositories/ims/stock";
import * as wms from "../src/main/repositories/wms/operations";
import { adoptReceipt } from "../src/main/repositories/wms/integration";
import { saveWmsSettings } from "../src/main/repositories/wms/config";
import { runWarehouseReport } from "../src/main/repositories/wms/reports";
import { createDispatch, releaseDispatch } from "../src/main/repositories/wms/outbound";
import { saveBom, saveBomComponent, approveBom } from "../src/main/repositories/mms/bom";
import { saveRoute, saveRouteOperation } from "../src/main/repositories/mms/routing";
import { saveWorkCenter } from "../src/main/repositories/mms/workCenters";
import {
  saveManufacturingOrder,
  releaseManufacturingOrder,
} from "../src/main/repositories/mms/manufacturingOrders";
import {
  listWorkOrders,
  startWorkOrder,
  completeWorkOrder,
} from "../src/main/repositories/mms/workOrders";
import { issueMaterialToWip, consumeMaterial } from "../src/main/repositories/mms/materialIssues";
import { saveQualityCheck } from "../src/main/repositories/mms/qualityChecks";
import { saveFinishedReceipt } from "../src/main/repositories/mms/finishedReceipts";
let db: SqliteDatabase,
  c: wms.WmsContext,
  warehouse: number,
  receiving: number,
  bulk: number,
  product: number;
beforeEach(() => {
  db = openInMemoryDatabase();
  runMigrations(db, migrations);
  c = { db, actor: SYSTEM_ACTOR, nowIso: NOW };
  product = item(db, "INTEGRATION-SKU");
  warehouse = wms.saveWarehouse(c, { code: "WH", name: "Warehouse" }).id;
  receiving = wms.saveBin(c, { warehouseId: warehouse, code: "REC", type: "receiving" });
  bulk = wms.saveBin(c, { warehouseId: warehouse, code: "A-BULK", type: "storage" });
});
afterEach(() => db.close());
it("adopts a real IMS goods receipt into WMS and never receives the stock twice", () => {
  const ctx: OperationContext = {
    ...c,
    nowDate: NOW.slice(0, 10),
    fiscalYearStartMonth: 1,
    allowNegativeStock: false,
    vatRate: 0,
  };
  const doc = saveOperation(ctx, {
    kind: "goodsReceipt",
    issueDate: NOW.slice(0, 10),
    lines: [{ productId: product, description: "Receipt", quantityMilli: 10_000 }],
  });
  transitionOperation(ctx, doc.id, "post");
  const movement = db
    .prepare("SELECT id FROM stock_movements WHERE source_kind='goodsReceipt' AND source_id=?")
    .get(doc.id) as { id: number };
  const first = adoptReceipt(c, movement.id, receiving);
  expect(adoptReceipt(c, movement.id, receiving)).toBe(first);
  const state = wms.snapshot(db, NOW);
  expect(state.tasks).toHaveLength(1);
  wms.completeTask(c, {
    id: state.tasks[0]!.id,
    destinationBinId: bulk,
    sourceScan: "REC",
    destinationScan: "A-BULK",
    productScan: "INTEGRATION-SKU",
    quantityMilli: 10_000,
    commandKey: randomUUID(),
  });
  expect(db.prepare("SELECT quantity_milli FROM products WHERE id=?").get(product)).toEqual({
    quantity_milli: 10_000,
  });
  expect(wms.snapshot(db, NOW).reconciliation).toEqual([]);
  expect(wms.snapshot(db, NOW).positions[0]!.bin).toBe("A-BULK");
});
it("legacy null-location stock maps to the IMS default without rewriting history", () => {
  const legacy = item(db, "LEGACY", 15_000);
  db.prepare("UPDATE stock_movements SET location_id=NULL WHERE product_id=?").run(legacy);
  const location = (
    db.prepare("SELECT id FROM ims_locations WHERE is_default=1").get() as { id: number }
  ).id;
  const before = db.prepare("SELECT * FROM stock_movements").all();
  wms.mapLocation(c, warehouse, location, "LEGACY-BIN");
  expect(wms.snapshot(db, NOW).positions.find((p) => p.product_id === legacy)?.quantity_milli).toBe(
    15_000,
  );
  expect(db.prepare("SELECT * FROM stock_movements").all()).toEqual(before);
});
it("accepted MMS finished output is put away without another receipt or material consumption", () => {
  const raw = item(db, "MMS-RAW", 100_000),
    wc = saveWorkCenter(db, SYSTEM_ACTOR, { code: "ASSEMBLY", name: "Assembly" }, NOW);
  const route = saveRoute(db, SYSTEM_ACTOR, { name: "Assembly route" }, NOW);
  saveRouteOperation(
    db,
    SYSTEM_ACTOR,
    {
      routeId: route.id,
      operationCode: "ASSEMBLE",
      name: "Assemble",
      workCenterId: wc.id,
      cycleTimeMinutes: 1,
    },
    NOW,
  );
  const bom = saveBom(
    db,
    SYSTEM_ACTOR,
    {
      productId: product,
      name: "Finished product",
      baseOutputQuantity: 1000,
      outputUnit: "pcs",
      routingId: route.id,
    },
    NOW,
  );
  saveBomComponent(
    db,
    SYSTEM_ACTOR,
    { bomId: bom.id, componentProductId: raw, quantityPerUnit: 1000, unit: "pcs" },
    NOW,
  );
  approveBom(db, SYSTEM_ACTOR, bom.id, NOW);
  const mo = saveManufacturingOrder(
    db,
    SYSTEM_ACTOR,
    { productId: product, bomId: bom.id, routeId: route.id, plannedQuantity: 10_000 },
    NOW,
  );
  releaseManufacturingOrder(db, SYSTEM_ACTOR, mo.id, NOW);
  issueMaterialToWip(
    db,
    SYSTEM_ACTOR,
    {
      moId: mo.id,
      componentProductId: raw,
      quantityMilli: 10_000,
      idempotencyKey: "mms-test-issue",
    },
    NOW,
  );
  consumeMaterial(
    db,
    SYSTEM_ACTOR,
    {
      moId: mo.id,
      componentProductId: raw,
      quantityMilli: 10_000,
    },
    NOW,
  );
  const work = listWorkOrders(db, { moId: mo.id })[0]!;
  startWorkOrder(db, SYSTEM_ACTOR, work.id, NOW);
  completeWorkOrder(db, SYSTEM_ACTOR, work.id, 10_000, 10_000, 0, NOW);
  saveQualityCheck(
    db,
    SYSTEM_ACTOR,
    { moId: mo.id, checkpoint: "Final inspection", inspectionType: "passFail", result: "passed" },
    NOW,
  );
  const receipt = saveFinishedReceipt(
    db,
    SYSTEM_ACTOR,
    { moId: mo.id, quantityMilli: 10_000, idempotencyKey: "mms-test-output" },
    NOW,
  );
  const movement = (
    db
      .prepare("SELECT stock_movement_id id FROM manufacturing_finished_receipts WHERE id=?")
      .get(receipt.id) as { id: number }
  ).id;
  adoptReceipt(c, movement, receiving);
  adoptReceipt(c, movement, receiving);
  const task = wms.snapshot(db, NOW).tasks[0]!;
  wms.completeTask(c, {
    id: task.id,
    destinationBinId: bulk,
    sourceScan: "REC",
    destinationScan: "A-BULK",
    productScan: "INTEGRATION-SKU",
    quantityMilli: 10_000,
    commandKey: randomUUID(),
  });
  expect(db.prepare("SELECT quantity_milli FROM products WHERE id=?").get(product)).toEqual({
    quantity_milli: 10_000,
  });
  expect(db.prepare("SELECT quantity_milli FROM products WHERE id=?").get(raw)).toEqual({
    quantity_milli: 90_000,
  });
  expect(wms.snapshot(db, NOW).reconciliation).toEqual([]);
});
it("automatic putaway setting is persisted and enforced enabled and disabled", () => {
  function receive() {
    const id = wms.createInbound(c, {
      warehouseId: warehouse,
      reference: randomUUID(),
      lines: [{ productId: product, quantityMilli: 1000 }],
    });
    wms.arriveInbound(c, id);
    const line = wms.snapshot(db, NOW).inbounds.find((d) => d.id === id)!.lines[0]!;
    wms.receive(c, {
      lineId: line.id,
      binId: receiving,
      quantityMilli: 1000,
      commandKey: randomUUID(),
    });
  }
  saveWmsSettings(db, SYSTEM_ACTOR, { autoPutaway: false, pickFaceFirst: true }, NOW);
  receive();
  expect(wms.snapshot(db, NOW).tasks).toHaveLength(0);
  saveWmsSettings(db, SYSTEM_ACTOR, { autoPutaway: true, pickFaceFirst: true }, NOW);
  receive();
  expect(wms.snapshot(db, NOW).tasks).toHaveLength(1);
});
it("pick-face priority setting changes the actual allocation order", () => {
  const face = wms.saveBin(c, { warehouseId: warehouse, code: "Z-FACE", type: "pickFace" }),
    packing = wms.saveBin(c, { warehouseId: warehouse, code: "PACK", type: "packing" });
  for (const id of [bulk, face]) {
    const location = wms.snapshot(db, NOW).bins.find((b) => b.id === id)!.location_id;
    postMovement(wms.stock(c), {
      productId: product,
      locationId: location,
      quantityMilli: 30_000,
      kind: "receipt",
      movementDate: NOW.slice(0, 10),
    });
  }
  const release = () => {
    const id = createDispatch(c, {
      warehouseId: warehouse,
      recipient: "Customer",
      reference: randomUUID(),
      requiredDate: NOW.slice(0, 10),
      commandKey: randomUUID(),
      lines: [{ productId: product, quantityMilli: 10_000 }],
    });
    releaseDispatch(c, id, packing);
    return wms.snapshot(db, NOW).tasks[0]!.source;
  };
  expect(release()).toBe("Z-FACE");
  saveWmsSettings(db, SYSTEM_ACTOR, { autoPutaway: true, pickFaceFirst: false }, NOW);
  expect(release()).toBe("A-BULK");
});
it("all exposed reports execute real queries and stock uses an as-of balance", () => {
  const location = wms.snapshot(db, NOW).bins.find((b) => b.id === bulk)!.location_id;
  postMovement(wms.stock(c), {
    productId: product,
    locationId: location,
    quantityMilli: 50_000,
    kind: "receipt",
    movementDate: "2026-01-01",
  });
  const result = runWarehouseReport(
    db,
    { report: "stock", warehouseId: warehouse, fromDate: "2026-11-01", toDate: "2026-11-08" },
    NOW,
  );
  expect(result.rows[0]?.["quantity"]).toBe(50);
  for (const report of [
    "stock",
    "receiving",
    "movements",
    "tasks",
    "dispatch",
    "counts",
    "exceptions",
  ] as const) {
    const r = runWarehouseReport(db, { report }, NOW);
    expect(r.columns.length).toBeGreaterThan(0);
    expect(r.generatedAt).toBe(NOW);
  }
  expect(() =>
    runWarehouseReport(db, { report: "stock", fromDate: "2026-11-09", toDate: "2026-11-08" }, NOW),
  ).toThrow(/Start date/);
});
