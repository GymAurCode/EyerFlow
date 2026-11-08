import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openInMemoryDatabase, type SqliteDatabase } from "../src/data/connection";
import { runMigrations } from "../src/data/migrator";
import { migrations } from "../src/data/migrations";
import { item, NOW } from "./planning-fixtures";
import { SYSTEM_ACTOR } from "../src/main/audit-writer";
import { postMovement, reservedQuantity } from "../src/main/repositories/ims/stock";
import * as wms from "../src/main/repositories/wms/operations";
import * as out from "../src/main/repositories/wms/outbound";
import {
  receiveReturn,
  inspectReturn,
  saveReplenishmentRule,
  generateReplenishment,
} from "../src/main/repositories/wms/control";
import { sellableOnHand } from "../src/main/repositories/ims/stock";
describe("warehouse outbound", () => {
  let db: SqliteDatabase,
    c: wms.WmsContext,
    product: number,
    warehouse: number,
    source: number,
    packing: number;
  beforeEach(() => {
    db = openInMemoryDatabase();
    runMigrations(db, migrations);
    c = { db, actor: SYSTEM_ACTOR, nowIso: NOW };
    product = item(db, "SHIP-SKU");
    warehouse = wms.saveWarehouse(c, { code: "WH", name: "Warehouse" }).id;
    source = wms.saveBin(c, { warehouseId: warehouse, code: "BULK", type: "storage" });
    packing = wms.saveBin(c, { warehouseId: warehouse, code: "PACK", type: "packing" });
    const location = wms.snapshot(db, NOW).bins.find((b) => b.id === source)!.location_id;
    postMovement(wms.stock(c), {
      productId: product,
      locationId: location,
      quantityMilli: 100_000,
      kind: "receipt",
      movementDate: NOW.slice(0, 10),
    });
  });
  afterEach(() => db.close());
  const total = () =>
    (db.prepare("SELECT quantity_milli q FROM products WHERE id=?").get(product) as { q: number })
      .q;
  function create(qty = 20_000) {
    return out.createDispatch(c, {
      warehouseId: warehouse,
      reference: randomUUID(),
      recipient: "Customer",
      requiredDate: NOW.slice(0, 10),
      commandKey: randomUUID(),
      lines: [{ productId: product, quantityMilli: qty }],
    });
  }
  function pick(id: number) {
    out.releaseDispatch(c, id, packing);
    out.releaseDispatch(c, id, packing);
    const task = wms
      .snapshot(db, NOW)
      .tasks.find((t) => t.type === "pick" && t.status !== "completed")!;
    const command = {
      id: task.id,
      destinationBinId: packing,
      sourceScan: "BULK",
      destinationScan: "PACK",
      productScan: "SHIP-SKU",
      quantityMilli: task.quantity_milli,
      commandKey: randomUUID(),
    };
    out.confirmPick(c, command);
    out.confirmPick(c, command);
    return task;
  }
  function pack(id: number, qty = 10_000, code = "C1") {
    const line = wms.snapshot(db, NOW).dispatches.find((d) => d.id === id)!.lines[0]!;
    const command = {
      dispatchId: id,
      code,
      weightGrams: 1500,
      commandKey: randomUUID(),
      lines: [{ lineId: line.id, quantityMilli: qty, productScan: "SHIP-SKU" }],
    };
    const carton = out.packCarton(c, command);
    expect(out.packCarton(c, command)).toBe(carton);
  }
  it("pick, two cartons, staging, loading and replayed handover issue stock once", () => {
    const id = create();
    pick(id);
    expect(total()).toBe(100_000);
    pack(id);
    pack(id, 10_000, "C2");
    expect(total()).toBe(100_000);
    expect(wms.snapshot(db, NOW).dispatches[0]!.status).toBe("packed");
    for (const code of ["C1", "C2"]) out.scanCarton(c, id, code, "stage");
    for (const code of ["C1", "C2"]) out.scanCarton(c, id, code, "load");
    for (let i = 0; i < 10; i++) out.handover(c, id, "Carrier", "TRUCK-01", "Signed manifest");
    expect(total()).toBe(80_000);
    expect(wms.snapshot(db, NOW).dispatches[0]!.status).toBe("handedOver");
    expect(wms.snapshot(db, NOW).reconciliation).toEqual([]);
    expect(reservedQuantity(db, product)).toBe(0);
  });
  it("reserves last units once and rolls back insufficient allocation", () => {
    const id = create(100_000);
    out.releaseDispatch(c, id, packing);
    const second = create(1000);
    expect(() => out.releaseDispatch(c, second, packing)).toThrow(/Insufficient/);
    expect(wms.snapshot(db, NOW).tasks).toHaveLength(1);
    expect(reservedQuantity(db, product)).toBe(100_000);
    expect(total()).toBe(100_000);
  });
  it("wrong SKU creates an audited exception without moving stock", () => {
    const id = create();
    out.releaseDispatch(c, id, packing);
    const t = wms.snapshot(db, NOW).tasks[0]!;
    expect(() =>
      out.confirmPick(c, {
        id: t.id,
        destinationBinId: packing,
        sourceScan: "BULK",
        destinationScan: "PACK",
        productScan: "WRONG",
        quantityMilli: 20_000,
        commandKey: randomUUID(),
      }),
    ).toThrow(/Wrong SKU/);
    expect(db.prepare("SELECT count(*) n FROM wms_exceptions").get()).toEqual({ n: 1 });
    expect(total()).toBe(100_000);
    expect(reservedQuantity(db, product)).toBe(20_000);
  });
  it("blocks overpacking and handover of unverified cartons", () => {
    const id = create();
    pick(id);
    expect(() => pack(id, 21_000)).toThrow(/more than/);
    expect(wms.snapshot(db, NOW).cartons).toHaveLength(0);
    pack(id);
    expect(() => out.handover(c, id, "Carrier", "TRUCK", "Signed")).toThrow(/Load/);
    expect(() => out.scanCarton(c, id, "NOT-OURS", "stage")).toThrow(/belong/);
    expect(total()).toBe(100_000);
  });
  it("receives five returned units into quarantine and releases only three after inspection", () => {
    const id = create();
    pick(id);
    pack(id, 20_000);
    out.scanCarton(c, id, "C1", "stage");
    out.scanCarton(c, id, "C1", "load");
    out.handover(c, id, "Carrier", "Truck", "Signed");
    const area = wms.saveBin(c, { warehouseId: warehouse, code: "RETURNS", type: "returns" });
    const line = wms.snapshot(db, NOW).dispatches[0]!.lines[0]!;
    const input = {
      dispatchLineId: line.id,
      binId: area,
      quantityMilli: 5000,
      productScan: "SHIP-SKU",
      condition: "Three unopened; two damaged",
      commandKey: randomUUID(),
    };
    const returned = receiveReturn(c, input);
    expect(receiveReturn(c, input)).toBe(returned);
    expect(total()).toBe(85_000);
    expect(sellableOnHand(db, product)).toBe(80_000);
    inspectReturn(c, returned, 3000, source, "Inspected all five units");
    inspectReturn(c, returned, 3000, source, "Replay");
    expect(total()).toBe(85_000);
    expect(sellableOnHand(db, product)).toBe(83_000);
    const state = wms.snapshot(db, NOW);
    expect(state.positions.find((p) => p.stock_status === "damaged")?.quantity_milli).toBe(2000);
    expect(state.reconciliation).toEqual([]);
    expect(() =>
      receiveReturn(c, { ...input, quantityMilli: 16_000, commandKey: randomUUID() }),
    ).toThrow(/exceeds/);
  });
  it("min 20, target 100, pick-face 15 creates one 85-unit replenishment task", () => {
    const face = wms.saveBin(c, {
      warehouseId: warehouse,
      code: "FACE",
      type: "pickFace",
      capacityMilli: 100_000,
    });
    const location = wms.snapshot(db, NOW).bins.find((b) => b.id === face)!.location_id;
    postMovement(wms.stock(c), {
      productId: product,
      locationId: location,
      quantityMilli: 15_000,
      kind: "receipt",
      movementDate: NOW.slice(0, 10),
    });
    const rule = saveReplenishmentRule(c, {
      productId: product,
      sourceBinId: source,
      destinationBinId: face,
      minimumMilli: 20_000,
      targetMilli: 100_000,
    });
    const task = generateReplenishment(c, rule)!;
    expect(generateReplenishment(c, rule)).toBeNull();
    expect(wms.snapshot(db, NOW).tasks.find((t) => t.id === task)?.quantity_milli).toBe(85_000);
    wms.completeTask(c, {
      id: task,
      destinationBinId: face,
      sourceScan: "BULK",
      destinationScan: "FACE",
      productScan: "SHIP-SKU",
      quantityMilli: 85_000,
      commandKey: randomUUID(),
    });
    expect(total()).toBe(115_000);
    expect(wms.snapshot(db, NOW).positions.find((p) => p.bin_id === face)?.quantity_milli).toBe(
      100_000,
    );
    expect(generateReplenishment(c, rule)).toBeNull();
  });
});
