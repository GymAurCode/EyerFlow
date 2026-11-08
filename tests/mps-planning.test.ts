import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqliteDatabase } from "../src/data/connection";
import {
  saveMpsPlan,
  calculateMps,
  approveMps,
  generateMpsOrders,
  listMpsPlans,
  listMpsHistory,
} from "../src/main/repositories/mms/mps";
import { planningDb, item, bom, NOW, ACTOR } from "./planning-fixtures";
import { saveOperation, transitionOperation } from "../src/main/repositories/ims/operations";
describe("persisted MPS planning", () => {
  let db: SqliteDatabase;
  let fg: number;
  let bomId: number;
  beforeEach(() => {
    db = planningDb();
    fg = item(db, "Tables", 20_000);
    bomId = bom(db, fg, [{ id: item(db, "Legs"), qty: 4000 }]);
  });
  afterEach(() => db.close());
  const input = () => ({
    productId: fg,
    bomId,
    fromDate: "2026-11-07",
    toDate: "2026-11-07",
    horizon: "daily" as const,
    forecastDemand: 100_000,
    confirmedDemand: 100_000,
    plannedProduction: 0,
    safetyStock: 10_000,
  });
  it("20 stock, 100 demand, 10 safety recommends 90, persists and records history", () => {
    const p = saveMpsPlan(db, input(), ACTOR, NOW);
    expect(p.openingStock).toBe(20_000);
    expect(p.plannedDemand).toBe(100_000);
    expect(p.projectedStock).toBe(-80_000);
    expect(p.recommendedProduction).toBe(90_000);
    expect(listMpsPlans(db, {})[0]).toEqual(p);
    expect(listMpsHistory(db, p.id)).toHaveLength(1);
  });
  it("edits drafts, detects stale edits, approves and converts once", () => {
    let p = saveMpsPlan(db, input(), ACTOR, NOW);
    p = saveMpsPlan(
      db,
      { ...input(), id: p.id, revision: p.revision, forecastDemand: 120_000 },
      ACTOR,
      NOW,
    );
    expect(() => saveMpsPlan(db, { ...input(), id: p.id, revision: 0 }, ACTOR, NOW)).toThrow(
      /changed/,
    );
    expect(() => generateMpsOrders(db, p.id, ACTOR, NOW)).toThrow(/Approve/);
    approveMps(db, p.id, ACTOR, NOW);
    p = generateMpsOrders(db, p.id, ACTOR, NOW);
    expect(p.status).toBe("converted");
    const id = p.buckets[0]!.generatedMoId;
    expect(generateMpsOrders(db, p.id, ACTOR, NOW).buckets[0]!.generatedMoId).toBe(id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM manufacturing_orders").get()).toEqual({ n: 1 });
    expect(() => calculateMps(db, p.id, ACTOR, NOW)).toThrow(/draft/);
  });
  it("counts existing MO receipts once and carries opening stocks through weekly buckets", () => {
    const first = saveMpsPlan(
      db,
      { ...input(), forecastDemand: 30_000, confirmedDemand: 0 },
      ACTOR,
      NOW,
    );
    approveMps(db, first.id, ACTOR, NOW);
    generateMpsOrders(db, first.id, ACTOR, NOW);
    const p = saveMpsPlan(db, { ...input(), toDate: "2026-11-20", horizon: "weekly" }, ACTOR, NOW);
    expect(p.scheduledReceipts).toBe(20_000);
    expect(p.recommendedProduction).toBe(70_000);
    expect(p.buckets).toHaveLength(2);
    expect(p.buckets[1]!.openingStock).toBe(p.buckets[0]!.projectedStock);
  });
  it("does not cross company databases", () => {
    const p = saveMpsPlan(db, input(), ACTOR, NOW);
    const other = planningDb();
    try {
      expect(listMpsPlans(other, {})).toEqual([]);
      expect(() => approveMps(other, p.id, ACTOR, NOW)).toThrow(/company/);
    } finally {
      other.close();
    }
  });
  it("includes firm purchased finished-goods receipts and excludes late receipts", () => {
    const ctx = {
      db,
      actor: ACTOR,
      nowIso: NOW,
      nowDate: "2026-11-07",
      fiscalYearStartMonth: 1,
      allowNegativeStock: false,
      vatRate: 0,
    };
    const po = saveOperation(ctx, {
      kind: "purchaseOrder",
      issueDate: "2026-11-07",
      requiredDate: "2026-11-07",
      lines: [{ productId: fg, description: "Tables", quantityMilli: 30_000 }],
    });
    transitionOperation(ctx, po.id, "approve");
    const late = saveOperation(ctx, {
      kind: "purchaseOrder",
      issueDate: "2026-11-07",
      requiredDate: "2026-11-08",
      lines: [{ productId: fg, description: "Tables", quantityMilli: 10_000 }],
    });
    transitionOperation(ctx, late.id, "approve");
    const p = saveMpsPlan(db, input(), ACTOR, NOW);
    expect(p.scheduledReceipts).toBe(30_000);
    expect(p.recommendedProduction).toBe(60_000);
  });
  it("blocks stale approved schedules from generating duplicate supply", () => {
    const first = saveMpsPlan(db, input(), ACTOR, NOW),
      second = saveMpsPlan(db, input(), ACTOR, NOW);
    approveMps(db, first.id, ACTOR, NOW);
    approveMps(db, second.id, ACTOR, NOW);
    generateMpsOrders(db, first.id, ACTOR, NOW);
    expect(() => generateMpsOrders(db, second.id, ACTOR, NOW)).toThrow(/changed after approval/);
  });
  it("handles monthly buckets and rejects nonexistent calendar dates", () => {
    expect(
      saveMpsPlan(db, { ...input(), toDate: "2027-01-31", horizon: "monthly" }, ACTOR, NOW).buckets,
    ).toHaveLength(3);
    expect(() => saveMpsPlan(db, { ...input(), fromDate: "2026-02-31" }, ACTOR, NOW)).toThrow(
      /valid planning period/,
    );
  });
});
