/**
 * Quality control enforcement test.
 *
 * Verifies that finished-goods receipts cannot be posted against a
 * manufacturing order when `requireQCBeforeReceipt` is enabled and no
 * passed quality check exists.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteDatabase } from "../src/data/connection";
import { openInMemoryDatabase } from "../src/data/connection";
import { runMigrations } from "../src/data/migrator";
import { migrations } from "../src/data/migrations";
import { SYSTEM_ACTOR } from "../src/main/audit-writer";
import { saveProduct } from "../src/main/repositories/products";
import { saveManufacturingOrder } from "../src/main/repositories/mms/manufacturingOrders";
import { readConfig, updateConfig } from "../src/main/repositories/mms/config";
import { saveQualityCheck } from "../src/main/repositories/mms/qualityChecks";
import { saveFinishedReceipt } from "../src/main/repositories/mms/finishedReceipts";
import { saveRoute } from "../src/main/repositories/mms/routing";
import { saveWorkCenter } from "../src/main/repositories/mms/workCenters";
import { saveBom } from "../src/main/repositories/mms/bom";
import { saveBomComponent } from "../src/main/repositories/mms/bom";
import type { SaveManufacturingOrderRequest } from "../src/shared/types";
import type { RouteDto } from "../src/shared/types";

const NOW_ISO = "2026-11-07T09:00:00.000Z";

function makeDb(): SqliteDatabase {
  const db = openInMemoryDatabase();
  runMigrations(db, migrations);
  return db;
}

function seedMo(db: SqliteDatabase): { moId: number; productId: number } {
  const product = saveProduct(
    db,
    SYSTEM_ACTOR,
    {
      sku: "TABLE-001",
      name: "Wooden Table",
      unit: "pcs",
      category: null,
      vatTreatment: "standard",
      averageCostFils: 10000,
      openingQuantityMilli: 0,
    },
    NOW_ISO,
  );
  const productId = product.id;

  const workCenter = saveWorkCenter(
    db,
    SYSTEM_ACTOR,
    {
      code: "WC-01",
      name: "Assembly",
      plant: null,
      type: "assembly",
      capacity: 10,
      capacityUnit: "units_per_hour",
      operatingSchedule: null,
      shiftId: null,
      hourlyOperatingCostFils: 0,
      availabilityPct: 100,
      efficiencyPct: 100,
      maintenanceStatus: "operational",
      isActive: true,
    },
    NOW_ISO,
  );
  const route = saveRoute(
    db,
    SYSTEM_ACTOR,
    {
      name: "Table assembly",
      description: null,
      status: "approved",
      effectiveFrom: "2026-11-07",
      effectiveTo: null,
    },
    NOW_ISO,
  );

  // Create and approve a BOM so saveManufacturingOrder accepts the MO.
  const bomProduct = productId;
  const component = saveProduct(
    db,
    SYSTEM_ACTOR,
    {
      sku: "LEG-001",
      name: "Table Leg",
      unit: "pcs",
      category: null,
      vatTreatment: "standard",
      averageCostFils: 1000,
      openingQuantityMilli: 0,
    },
    NOW_ISO,
  );
  const bom = saveBom(
    db,
    SYSTEM_ACTOR,
    {
      productId: bomProduct,
      name: "Table BOM",
      bomType: "assembly",
      baseOutputQuantity: 1000,
      outputUnit: "pcs",
      routingId: route.id,
    },
    NOW_ISO,
  );
  saveBomComponent(
    db,
    SYSTEM_ACTOR,
    {
      bomId: bom.id,
      componentProductId: component.id,
      quantityPerUnit: 4000,
      unit: "pcs",
      scrapPercent: 0,
    },
    NOW_ISO,
  );
  saveBom(
    db,
    SYSTEM_ACTOR,
    {
      id: bom.id,
      productId: bomProduct,
      name: "Table BOM",
      bomType: "assembly",
      baseOutputQuantity: 1000,
      outputUnit: "pcs",
      routingId: route.id,
      status: "approved",
    },
    NOW_ISO,
  );

  const request: SaveManufacturingOrderRequest = {
    productId,
    bomId: bom.id,
    routeId: route.id,
    plannedQuantity: 10_000,
    unit: "pcs",
    plannedStart: "2026-11-07",
    plannedFinish: "2026-11-14",
  };

  const mo = saveManufacturingOrder(db, SYSTEM_ACTOR, request, NOW_ISO);

  // Put the MO into a receivable state for the receipt gate tests.
  db.prepare(
    `UPDATE manufacturing_orders SET status = 'qualityReview', actual_quantity = ?, updated_at = ? WHERE id = ?`,
  ).run(10_000, NOW_ISO, mo.id);

  return { moId: mo.id, productId };
}

describe("QC gate before finished-goods receipt", () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = makeDb();
    updateConfig(db, SYSTEM_ACTOR, { requireQCBeforeReceipt: true }, NOW_ISO);
  });

  it("refuses receipt when no quality check exists", () => {
    const { moId } = seedMo(db);

    expect(() =>
      saveFinishedReceipt(
        db,
        SYSTEM_ACTOR,
        { moId, quantityMilli: 10_000 },
        NOW_ISO,
      ),
    ).toThrow("quality check must be passed");
  });

  it("allows receipt after a passed quality check", () => {
    const { moId } = seedMo(db);

    saveQualityCheck(
      db,
      SYSTEM_ACTOR,
      {
        moId,
        checkpoint: "Final dimensions",
        inspectionType: "passFail",
        result: "passed",
      },
      NOW_ISO,
    );

    const receipt = saveFinishedReceipt(
      db,
      SYSTEM_ACTOR,
      { moId, quantityMilli: 10_000 },
      NOW_ISO,
    );

    expect(receipt.quantityMilli).toBe(10_000);
  });

  it("refuses receipt after a failed quality check", () => {
    const { moId } = seedMo(db);

    saveQualityCheck(
      db,
      SYSTEM_ACTOR,
      {
        moId,
        checkpoint: "Final dimensions",
        inspectionType: "passFail",
        result: "failed",
      },
      NOW_ISO,
    );

    expect(() =>
      saveFinishedReceipt(
        db,
        SYSTEM_ACTOR,
        { moId, quantityMilli: 10_000 },
        NOW_ISO,
      ),
    ).toThrow("quality check must be passed");
  });
});
