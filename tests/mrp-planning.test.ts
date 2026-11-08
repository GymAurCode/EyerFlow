import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqliteDatabase } from "../src/data/connection";
import {
  runMrp,
  approveMrp,
  convertMrp,
  getMrpRun,
  listMrpRuns,
} from "../src/main/repositories/mms/mrp";
import { saveManufacturingOrder } from "../src/main/repositories/mms/manufacturingOrders";
import {
  saveOperation,
  transitionOperation,
  type OperationContext,
} from "../src/main/repositories/ims/operations";
import { defaultLocationId } from "../src/main/repositories/ims/stock";
import { saveLocation } from "../src/main/repositories/ims/reference";
import { issueMaterialToWip, consumeMaterial } from "../src/main/repositories/mms/materialIssues";
import { components, approvedBom } from "../src/main/repositories/mms/planning-common";
import { planningDb, item, bom, NOW, ACTOR } from "./planning-fixtures";
describe("real MRP calculations and IMS integration", () => {
  let db: SqliteDatabase;
  let table: number;
  let legs: number;
  let top: number;
  let screws: number;
  let moId: number;
  function ctx(): OperationContext {
    return {
      db,
      actor: ACTOR,
      nowIso: NOW,
      nowDate: "2026-11-07",
      fiscalYearStartMonth: 1,
      allowNegativeStock: false,
      vatRate: 0,
    };
  }
  const order = (pid: number, bid: number, qty: number) =>
    saveManufacturingOrder(
      db,
      ACTOR,
      {
        productId: pid,
        bomId: bid,
        plannedQuantity: qty,
        plannedStart: "2026-11-10",
        plannedFinish: "2026-11-10",
      },
      NOW,
    ).id;
  const run = () =>
    runMrp(db, { moIds: [moId], fromDate: "2026-11-07", toDate: "2026-11-20" }, NOW, ACTOR);
  beforeEach(() => {
    db = planningDb();
    table = item(db, "Tables");
    legs = item(db, "Legs", 250_000);
    top = item(db, "Tabletops", 100_000);
    screws = item(db, "Screws", 500_000);
    moId = order(
      table,
      bom(db, table, [
        { id: legs, qty: 4000 },
        { id: top, qty: 1000 },
        { id: screws, qty: 8000 },
      ]),
      100_000,
    );
  });
  afterEach(() => db.close());
  it("does not demand issued or consumed material twice and retains released BOM snapshots", () => {
    db.prepare("UPDATE manufacturing_orders SET status='released' WHERE id=?").run(moId);
    issueMaterialToWip(db, ACTOR, { moId, componentProductId: legs, quantityMilli: 100_000 }, NOW);
    consumeMaterial(db, ACTOR, { moId, componentProductId: legs, quantityMilli: 50_000 }, NOW);
    db.prepare("UPDATE manufacturing_boms SET status='superseded' WHERE product_id=?").run(table);
    const leg = run().requirements.find((r) => r.productId === legs)!;
    expect(leg.grossRequirement).toBe(300_000);
    expect(leg.availableSupply).toBe(150_000);
    expect(leg.shortageQty).toBe(150_000);
  });
  it("includes overdue open demand at the planning start", () => {
    db.prepare("UPDATE manufacturing_orders SET planned_start='2026-11-01' WHERE id=?").run(moId);
    expect(run().requirements.find((r) => r.productId === legs)?.requiredByDate).toBe("2026-11-07");
  });
  it("blocks stale approval or conversion when inventory/supply changes", () => {
    let r = run();
    const po = saveOperation(ctx(), {
      kind: "purchaseOrder",
      issueDate: "2026-11-07",
      requiredDate: "2026-11-09",
      lines: [{ productId: legs, description: "Legs", quantityMilli: 100_000 }],
    });
    transitionOperation(ctx(), po.id, "approve");
    expect(() => approveMrp(db, r.id, ACTOR, NOW)).toThrow(/inputs changed/);
    r = run();
    approveMrp(db, r.id, ACTOR, NOW);
    transitionOperation(ctx(), po.id, "cancel");
    expect(() => convertMrp(ctx(), r.id, "purchase")).toThrow(/inputs changed/);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM ims_documents WHERE kind='purchaseRequisition'").get(),
    ).toEqual({ n: 0 });
  });
  it("explodes 100 tables to 400 legs, 100 tops, 800 screws; shortages 150, 0, 300", () => {
    const r = run();
    expect(r.id).toBeGreaterThan(0);
    expect(r.status).toBe("completed");
    const values = r.requirements
      .map((r) => [r.productSku, r.grossRequirement, r.shortageQty])
      .sort();
    expect(values).toEqual([
      ["Legs", 400_000, 150_000],
      ["Screws", 800_000, 300_000],
      ["Tabletops", 100_000, 0],
    ]);
    expect(getMrpRun(db, r.id)).toEqual(r);
    expect(listMrpRuns(db)).toHaveLength(1);
  });
  it("net-explodes subassemblies after allocating existing subassembly stock", () => {
    const frame = item(db, "Frames", 50_000),
      bolt = item(db, "Bolts");
    bom(db, frame, [{ id: bolt, qty: 3000 }]);
    const other = item(db, "OtherTables");
    moId = order(other, bom(db, other, [{ id: frame, qty: 2000 }]), 100_000);
    const r = run();
    expect(r.requirements.find((r) => r.productId === frame)?.shortageQty).toBe(150_000);
    expect(r.requirements.find((r) => r.productId === frame)?.suggestedAction).toBe("manufacture");
    expect(r.requirements.find((r) => r.productId === bolt)?.grossRequirement).toBe(450_000);
  });
  it("nets existing manufacturing supply before exploding additional subassemblies", () => {
    const frame = item(db, "Frames", 50_000),
      bolt = item(db, "Bolts"),
      frameBom = bom(db, frame, [{ id: bolt, qty: 3000 }]);
    const incoming = order(frame, frameBom, 100_000);
    db.prepare("UPDATE manufacturing_orders SET planned_finish='2026-11-09' WHERE id=?").run(
      incoming,
    );
    const parent = item(db, "OtherTables");
    moId = order(parent, bom(db, parent, [{ id: frame, qty: 2000 }]), 100_000);
    const r = run();
    expect(r.requirements.find((r) => r.productId === frame)?.scheduledReceipts).toBe(100_000);
    expect(r.requirements.find((r) => r.productId === frame)?.shortageQty).toBe(50_000);
    expect(r.requirements.find((r) => r.productId === bolt)?.grossRequirement).toBe(150_000);
  });
  it("allocates shared component stock once across multiple orders", () => {
    const second = order(
      table,
      (
        db.prepare("SELECT bom_id FROM manufacturing_orders WHERE id=?").get(moId) as {
          bom_id: number;
        }
      ).bom_id,
      100_000,
    );
    const r = runMrp(db, { moIds: [moId, second] }, NOW);
    expect(r.requirements.find((r) => r.productId === legs)?.grossRequirement).toBe(800_000);
    expect(r.requirements.find((r) => r.productId === legs)?.shortageQty).toBe(550_000);
  });
  it("nets firm PO supply and pending receipts without counting the PO twice", () => {
    const po = saveOperation(ctx(), {
      kind: "purchaseOrder",
      issueDate: "2026-11-07",
      requiredDate: "2026-11-09",
      lines: [{ productId: legs, description: "Legs", quantityMilli: 100_000 }],
    });
    transitionOperation(ctx(), po.id, "approve");
    const gr = saveOperation(ctx(), {
      kind: "goodsReceipt",
      sourceId: po.id,
      issueDate: "2026-11-08",
      requiredDate: "2026-11-09",
      lines: [
        {
          productId: legs,
          description: "Legs",
          quantityMilli: 40_000,
          sourceLineId: po.lines[0]!.id,
        },
      ],
    });
    transitionOperation(ctx(), gr.id, "approve");
    let r = run().requirements.find((r) => r.productId === legs)!;
    expect(r.scheduledReceipts).toBe(100_000);
    expect(r.shortageQty).toBe(50_000);
    transitionOperation(ctx(), gr.id, "post");
    r = run().requirements.find((r) => r.productId === legs)!;
    expect(r.availableSupply).toBe(290_000);
    expect(r.scheduledReceipts).toBe(60_000);
    expect(r.shortageQty).toBe(50_000);
  });
  it("does not use late purchase receipts to meet earlier demand", () => {
    const po = saveOperation(ctx(), {
      kind: "purchaseOrder",
      issueDate: "2026-11-07",
      requiredDate: "2026-11-12",
      lines: [{ productId: legs, description: "Legs", quantityMilli: 100_000 }],
    });
    transitionOperation(ctx(), po.id, "approve");
    expect(run().requirements.find((r) => r.productId === legs)?.shortageQty).toBe(150_000);
  });
  it("honors other reservations and credits the selected order’s own reservation once", () => {
    const insert = db.prepare(
      `INSERT INTO ims_reservations(product_id,quantity_milli,source_kind,source_id,created_at) VALUES(?,?,?,?,?)`,
    );
    insert.run(legs, 50_000, "salesOrder", 999, NOW);
    insert.run(legs, 100_000, "manufacturingOrder", moId, NOW);
    const r = run().requirements.find((r) => r.productId === legs)!;
    expect(r.availableSupply).toBe(200_000);
    expect(r.reservedQuantity).toBe(50_000);
    expect(r.shortageQty).toBe(200_000);
  });
  it("uses IMS safety stock and supplier lead times", () => {
    db.prepare(
      "INSERT INTO ims_reorder_rules(product_id,safety_milli,lead_time_days,updated_at) VALUES(?,?,?,?)",
    ).run(legs, 10_000, 5, NOW);
    const r = run().requirements.find((r) => r.productId === legs)!;
    expect(r.shortageQty).toBe(160_000);
    expect(r.plannedReleaseDate).toBe("2026-11-05");
  });
  it("requires approval and creates real traceable IMS requisitions idempotently", () => {
    const first = run();
    expect(() => convertMrp(ctx(), first.id, "purchase")).toThrow(/Approve/);
    approveMrp(db, first.id, ACTOR, NOW);
    let converted = convertMrp(ctx(), first.id, "purchase");
    expect(converted.requirements.filter((r) => r.requisitionId !== null)).toHaveLength(2);
    converted = convertMrp(ctx(), first.id, "purchase");
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM ims_documents WHERE kind='purchaseRequisition'").get(),
    ).toEqual({ n: 2 });
    const pr = db
      .prepare("SELECT reference FROM ims_documents WHERE kind='purchaseRequisition' LIMIT 1")
      .get() as { reference: string };
    expect(pr.reference).toContain("MRP:" + first.id);
    expect(db.prepare("SELECT quantity_milli FROM products WHERE id=?").get(legs)).toEqual({
      quantity_milli: 250_000,
    });
    const next = run();
    expect(next.requirements.find((r) => r.productId === legs)?.requestedSupply).toBe(150_000);
    expect(next.requirements.find((r) => r.productId === legs)?.suggestedQuantity).toBe(0);
    expect(() => convertMrp(ctx(), first.id, "purchase")).toThrow(/current/);
  });
  it("generates subassembly MOs through the existing manufacturing service once", () => {
    const frame = item(db, "Frames"),
      bolt = item(db, "Bolts");
    bom(db, frame, [{ id: bolt, qty: 2000 }]);
    const parent = item(db, "Parent");
    moId = order(parent, bom(db, parent, [{ id: frame, qty: 1000 }]), 10_000);
    const r = run();
    approveMrp(db, r.id, ACTOR, NOW);
    const converted = convertMrp(ctx(), r.id, "manufacture");
    const suggestion = converted.requirements.find((r) => r.productId === frame)!;
    expect(suggestion.generatedMoId).not.toBeNull();
    expect(
      convertMrp(ctx(), r.id, "manufacture").requirements.find((r) => r.productId === frame)
        ?.generatedMoId,
    ).toBe(suggestion.generatedMoId);
    expect(
      db
        .prepare("SELECT source_demand,planned_quantity FROM manufacturing_orders WHERE id=?")
        .get(suggestion.generatedMoId),
    ).toEqual({
      source_demand: `MRP:${r.id}:requirement:${suggestion.id}`,
      planned_quantity: 10_000,
    });
  });
  it("converts BOM units through the real IMS units table and honors batch output", () => {
    const powder = item(db, "Powder", 0, "kg"),
      batch = item(db, "Batches");
    moId = order(batch, bom(db, batch, [{ id: powder, qty: 500_000, unit: "g" }], 10_000), 20_000);
    expect(run().requirements.find((r) => r.productId === powder)?.grossRequirement).toBe(1000);
  });
  it("rounds converted fractional quantities only after output scaling", () => {
    const powder = item(db, "Powder", 0, "kg"),
      batch = item(db, "Batches");
    const bid = bom(db, batch, [{ id: powder, qty: 100, unit: "g" }]);
    expect(components(db, approvedBom(db, batch, "2026-11-10", bid)!, 10_000)[0]?.quantity).toBe(1);
  });
  it("rejects cyclic BOMs atomically and persists legitimate no-demand runs", () => {
    const r = runMrp(db, { moIds: [] }, NOW);
    expect(r.status).toBe("empty");
    expect(r.requirements).toEqual([]);
    const frame = item(db, "Cyclic");
    const bid = bom(db, frame, [{ id: table, qty: 1000 }]);
    db.prepare(
      "INSERT INTO manufacturing_bom_components(bom_id,component_product_id,quantity_per_unit,unit,line_no) VALUES(?,?,?,?,99)",
    ).run(bid, frame, 1000, "pcs");
    moId = order(frame, bid, 1000);
    expect(() => run()).toThrow(/circular/);
    expect(listMrpRuns(db)).toHaveLength(1);
  });
  it("rejects foreign and out-of-branch order IDs and keeps company results isolated", () => {
    expect(() => runMrp(db, { moIds: [999999] }, NOW)).toThrow(/company/);
    const branch = saveLocation(
      db,
      ACTOR,
      { code: "OTHER", name: "Other branch", type: "branch" },
      NOW,
    ).find((l) => l.code === "OTHER")!;
    expect(() => runMrp(db, { moIds: [moId], locationId: branch.id }, NOW)).toThrow(/branch/);
    expect(
      runMrp(db, { moIds: [moId], locationId: defaultLocationId(db) }, NOW).requirements,
    ).toHaveLength(3);
    const other = planningDb();
    try {
      expect(listMrpRuns(other)).toEqual([]);
      expect(() => getMrpRun(other, run().id)).toThrow(/company/);
    } finally {
      other.close();
    }
  });
});
