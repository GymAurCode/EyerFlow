import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openInMemoryDatabase, type SqliteDatabase } from "../src/data/connection";
import { runMigrations } from "../src/data/migrator";
import { migrations } from "../src/data/migrations";
import { item, NOW } from "./planning-fixtures";
import { SYSTEM_ACTOR } from "../src/main/audit-writer";
import { onHandAt, postMovement } from "../src/main/repositories/ims/stock";
import * as wms from "../src/main/repositories/wms/operations";

describe("warehouse execution against the shared IMS ledger", () => {
  let db: SqliteDatabase;
  let c: wms.WmsContext;
  let product: number, warehouse: number, receiving: number, storage: number, quarantine: number;
  beforeEach(() => {
    db = openInMemoryDatabase();
    runMigrations(db, migrations);
    c = { db, actor: SYSTEM_ACTOR, nowIso: NOW };
    product = item(db, "WMS-ITEM");
    warehouse = wms.saveWarehouse(c, { code: "WH-LHR", name: "Lahore" }).id;
    receiving = wms.saveBin(c, { warehouseId: warehouse, code: "WH-LHR/REC", type: "receiving" });
    quarantine = wms.saveBin(c, {
      warehouseId: warehouse,
      code: "WH-LHR/HOLD",
      type: "quarantine",
    });
    storage = wms.saveBin(c, {
      warehouseId: warehouse,
      code: "WH-LHR/A01/R01/L01/B01",
      zone: "A",
      aisle: "A01",
      rack: "R01",
      shelf: "L01",
      type: "storage",
      capacityMilli: 100_000,
    });
  });
  afterEach(() => db.close());
  function inbound(qty = 100_000) {
    const id = wms.createInbound(c, {
      warehouseId: warehouse,
      reference: randomUUID(),
      lines: [{ productId: product, quantityMilli: qty }],
    });
    wms.arriveInbound(c, id);
    return wms.snapshot(db, NOW).inbounds.find((d) => d.id === id)!.lines[0]!.id;
  }
  function receive(qty = 70_000, damaged = 5_000) {
    const lineId = inbound();
    const request = {
      lineId,
      binId: receiving,
      quantityMilli: qty,
      damagedMilli: damaged,
      commandKey: randomUUID(),
    };
    const id = wms.receive(c, request);
    return { id, request };
  }
  function confirm(taskId: number, quantity = 65_000) {
    const b = wms.snapshot(db, NOW).bins.find((b) => b.id === storage)!;
    return {
      id: taskId,
      destinationBinId: storage,
      sourceScan: "WH-LHR/REC",
      productScan: "WMS-ITEM",
      destinationScan: b.code,
      quantityMilli: quantity,
      commandKey: randomUUID(),
    };
  }
  function total() {
    return (
      db.prepare("SELECT quantity_milli q FROM products WHERE id=?").get(product) as { q: number }
    ).q;
  }
  it("partial receipt 70/100, 65 accepted, 5 damaged; retries and putaway preserve totals", () => {
    const { id, request } = receive();
    for (let i = 0; i < 10; i++) expect(wms.receive(c, request)).toBe(id);
    expect(total()).toBe(70_000);
    let s = wms.snapshot(db, NOW);
    expect(s.inbounds[0]!.status).toBe("partiallyReceived");
    expect(s.positions.find((p) => p.bin_id === quarantine)?.stock_status).toBe("damaged");
    const command = confirm(s.tasks[0]!.id);
    wms.completeTask(c, command);
    wms.completeTask(c, command);
    expect(total()).toBe(70_000);
    s = wms.snapshot(db, NOW);
    expect(s.positions.find((p) => p.bin_id === storage)?.quantity_milli).toBe(65_000);
    wms.receive(c, {
      ...request,
      quantityMilli: 30_000,
      damagedMilli: 0,
      commandKey: randomUUID(),
    });
    expect(total()).toBe(100_000);
    s = wms.snapshot(db, NOW);
    expect(s.inbounds[0]!.status).toBe("received");
    expect(s.reconciliation).toEqual([]);
    expect(s.positions.reduce((sum, p) => sum + p.quantity_milli, 0)).toBe(100_000);
  });
  it("rejects conflicting receipt key and over-receipt without stock effects", () => {
    const { request } = receive();
    expect(() => wms.receive(c, { ...request, quantityMilli: 60_000 })).toThrow(/key/);
    expect(() =>
      wms.receive(c, { ...request, quantityMilli: 40_000, commandKey: randomUUID() }),
    ).toThrow(/Over-receipt/);
    expect(total()).toBe(70_000);
  });
  it("rejects wrong SKU and wrong destination scan without moving stock", () => {
    receive();
    const task = wms.snapshot(db, NOW).tasks[0]!;
    expect(() => wms.completeTask(c, { ...confirm(task.id), productScan: "WRONG" })).toThrow(
      /Wrong SKU/,
    );
    expect(() => wms.completeTask(c, { ...confirm(task.id), destinationScan: "WRONG" })).toThrow(
      /scan mismatch/,
    );
    expect(
      wms.snapshot(db, NOW).positions.find((p) => p.bin_id === receiving)?.quantity_milli,
    ).toBe(65_000);
    expect(total()).toBe(70_000);
  });
  it("enforces capacity at completion even if a competing task fills the bin", () => {
    receive();
    const task = wms.snapshot(db, NOW).tasks[0]!;
    const destination = wms.snapshot(db, NOW).bins.find((b) => b.id === storage)!;
    postMovement(
      {
        db,
        actorName: "External IMS",
        nowIso: NOW,
        nowDate: NOW.slice(0, 10),
        allowNegativeStock: false,
      },
      {
        productId: product,
        locationId: destination.location_id,
        quantityMilli: 50_000,
        kind: "receipt",
        movementDate: NOW.slice(0, 10),
      },
    );
    expect(() => wms.completeTask(c, confirm(task.id))).toThrow(/capacity/);
    expect(total()).toBe(120_000);
    expect(wms.snapshot(db, NOW).tasks[0]!.status).toBe("created");
  });
  it("partial putaway creates remainder work and cannot replay as a second move", () => {
    receive();
    const task = wms.snapshot(db, NOW).tasks[0]!;
    const command = confirm(task.id, 40_000);
    wms.completeTask(c, command);
    wms.completeTask(c, command);
    const s = wms.snapshot(db, NOW);
    expect(s.tasks.find((t) => t.status === "created")?.quantity_milli).toBe(25_000);
    expect(total()).toBe(70_000);
    expect(s.positions.find((p) => p.bin_id === storage)?.quantity_milli).toBe(40_000);
  });
  it("mapping an IMS location preserves existing stock and all history", () => {
    const location = (
      db.prepare("SELECT id FROM ims_locations WHERE is_default=1").get() as { id: number }
    ).id;
    postMovement(
      { db, actorName: "IMS", nowIso: NOW, nowDate: NOW.slice(0, 10), allowNegativeStock: false },
      {
        productId: product,
        locationId: location,
        quantityMilli: 12_000,
        kind: "opening",
        movementDate: NOW.slice(0, 10),
        batchNo: "LOT-OLD",
      },
    );
    const before = db.prepare("SELECT * FROM stock_movements").all();
    wms.mapLocation(c, warehouse, location, "WH-LHR/LEGACY");
    expect(db.prepare("SELECT * FROM stock_movements").all()).toEqual(before);
    expect(total()).toBe(12_000);
    expect(onHandAt(db, product, location)).toBe(12_000);
    expect(wms.snapshot(db, NOW).unassigned).toEqual([]);
    expect(wms.snapshot(db, NOW).positions[0]!.batch_no).toBe("LOT-OLD");
  });
  it("blocks deactivating stocked bins and warehouses", () => {
    receive();
    expect(() =>
      wms.saveBin(c, {
        id: receiving,
        warehouseId: warehouse,
        code: "WH-LHR/REC",
        type: "receiving",
        active: false,
      }),
    ).toThrow(/stock/);
    expect(() =>
      wms.saveWarehouse(c, { id: warehouse, code: "WH-LHR", name: "Lahore", active: false }),
    ).toThrow(/stock/);
  });
  it("a failed receipt rolls back document, ledger and task together", () => {
    const lineId = inbound();
    db.exec(
      "CREATE TRIGGER fail_task BEFORE INSERT ON wms_tasks BEGIN SELECT RAISE(ABORT,'test interruption'); END",
    );
    expect(() =>
      wms.receive(c, { lineId, binId: receiving, quantityMilli: 10_000, commandKey: randomUUID() }),
    ).toThrow(/interruption/);
    expect(total()).toBe(0);
    expect(db.prepare("SELECT count(*) n FROM wms_receipts").get()).toEqual({ n: 0 });
    expect(wms.snapshot(db, NOW).inbounds[0]!.lines[0]!.received_milli).toBe(0);
  });
  it("excludes damaged goods from normal movement", () => {
    receive();
    expect(() =>
      wms.createMove(c, {
        sourceBinId: quarantine,
        destinationBinId: storage,
        productId: product,
        quantityMilli: 1000,
      }),
    ).toThrow(/Held stock/);
    expect(total()).toBe(70_000);
  });
  it("prevents two tasks from committing the last eligible source units", () => {
    receive();
    wms.completeTask(c, confirm(wms.snapshot(db, NOW).tasks[0]!.id));
    const destination = wms.saveBin(c, {
      warehouseId: warehouse,
      code: "WH-LHR/B02",
      type: "storage",
    });
    wms.createMove(c, {
      sourceBinId: storage,
      destinationBinId: destination,
      productId: product,
      quantityMilli: 60_000,
    });
    expect(() =>
      wms.createMove(c, {
        sourceBinId: storage,
        destinationBinId: destination,
        productId: product,
        quantityMilli: 10_000,
      }),
    ).toThrow(/committed/);
  });
});

it("additive compatibility migration preserves version 29 records and IMS stock", () => {
  const db = openInMemoryDatabase();
  try {
    runMigrations(
      db,
      migrations.filter((m) => m.version <= 29),
    );
    const p = item(db, "PRE-EXISTING", 50_000);
    const location = (
      db.prepare("SELECT id FROM ims_locations WHERE is_default=1").get() as { id: number }
    ).id;
    db.prepare(
      "INSERT INTO wms_warehouses(code,name,ims_location_id,branch,created_at,updated_at) VALUES('OLD','Existing',?,'Karachi',?,?)",
    ).run(location, NOW, NOW);
    db.exec(
      "INSERT INTO wms_locations(warehouse_id,code,name,type) VALUES(1,'A','Existing bin','storage')",
    );
    const before = db.prepare("SELECT * FROM stock_movements").all();
    runMigrations(db, migrations);
    expect(db.prepare("SELECT site FROM wms_warehouses").get()).toEqual({ site: "Karachi" });
    expect(db.prepare("SELECT name FROM wms_locations").get()).toEqual({ name: "Existing bin" });
    expect(db.prepare("SELECT * FROM stock_movements").all()).toEqual(before);
    expect(onHandAt(db, p)).toBe(50_000);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally {
    db.close();
  }
});
