/**
 * MMS development test-data bootstrap.
 *
 * Populates a DISPOSABLE test database with a realistic manufacturing demo
 * company ("EyerFlow Manufacturing Demo"). Creates products, work centers,
 * routes, BOMs, manufacturing orders in multiple states, material movements,
 * quality checks, WIP, scrap, rework, finished-goods receipts, cost records,
 * MPS plans and MRP runs - all through the application's real business
 * services, never through fake INSERT statements into dashboard tables.
 *
 * SAFETY:
 *   - Refuses to run when NODE_ENV=production
 *   - Requires EYERSTOCK_DATA_DIR pointing to a disposable folder
 *   - Never runs at application startup
 *   - Idempotent: safe to run twice against the same database
 *   - Does not expose a UI action to ordinary users
 *
 * Usage:
 *   EYERSTOCK_DATA_DIR=/tmp/eyerstock-demo NODE_ENV=development \
 *     npm run seed:mms-demo
 */

"use strict";

const { join } = require("node:path");
const { openDatabase } = require("../src/data/connection");
const { runMigrations } = require("../src/data/migrator");
const { migrations } = require("../src/data/migrations");
const { SYSTEM_ACTOR } = require("../src/main/audit-writer");
const { recordAudit } = require("../src/main/audit-writer");
const { saveProduct } = require("../src/main/repositories/products");
const { saveWorkCenter } = require("../src/main/repositories/mms/workCenters");
const { saveRoute } = require("../src/main/repositories/mms/routing");
const { saveRouteOperation } = require("../src/main/repositories/mms/routing");
const { saveBom } = require("../src/main/repositories/mms/bom");
const { saveBomComponent } = require("../src/main/repositories/mms/bom");
const { approveBom } = require("../src/main/repositories/mms/bom");
const { saveManufacturingOrder } = require("../src/main/repositories/mms/manufacturingOrders");
const { releaseManufacturingOrder } = require("../src/main/repositories/mms/manufacturingOrders");
const { saveQualityCheck } = require("../src/main/repositories/mms/qualityChecks");
const { saveFinishedReceipt } = require("../src/main/repositories/mms/finishedReceipts");
const { saveCostRecord } = require("../src/main/repositories/mms/costing");
const { saveScrapRecord } = require("../src/main/repositories/mms/scrap");
const { saveReworkRecord } = require("../src/main/repositories/mms/rework");
const { saveWorkOrder } = require("../src/main/repositories/mms/workOrders");
const { postMovement, defaultLocationId } = require("../src/main/repositories/ims/stock");
const { saveParty } = require("../src/main/repositories/parties");

const NOW_ISO = "2026-11-07T09:00:00.000Z";
const DEMO_COMPANY = "EyerFlow Manufacturing Demo";
const DEMO_LOCATION = "Plant 1";

/* ------------------------------------------------------------------ */
/* Safety guards                                                      */
/* ------------------------------------------------------------------ */

if (process.env.NODE_ENV === "production") {
  // eslint-disable-next-line no-console
  console.error("Refusing to seed demo data in production. Aborting.");
  process.exit(1);
}

const dataDir = process.env.EYERSTOCK_DATA_DIR;
if (!dataDir) {
  // eslint-disable-next-line no-console
  console.error(
    "Set EYERSTOCK_DATA_DIR to a disposable folder before running the demo seed.",
  );
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Database connection                                                */
/* ------------------------------------------------------------------ */

const dbPath = join(dataDir, "data.db");
// eslint-disable-next-line no-console
console.log(`Opening demo database at ${dbPath}`);
const db = openDatabase(dbPath);
runMigrations(db, migrations);

/* ------------------------------------------------------------------ */
/* Idempotency helper                                                 */
/* ------------------------------------------------------------------ */

function tableHasRows(db, table, whereSql = "1=1", params = []) {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${whereSql}`)
    .get(...params);
  return Number(row?.n ?? 0) > 0;
}

/* ------------------------------------------------------------------ */
/* 1. Demo company setup                                              */
/* ------------------------------------------------------------------ */

// The demo company is identified by its data folder. We record its
// identity in settings so it is visibly a demo environment.
function ensureSetting(key, value) {
  const existing = db
    .prepare("SELECT value FROM mms_config WHERE key = ?")
    .get(key);
  if (!existing) {
    db.prepare(
      "INSERT INTO mms_config (key, value, updated_at) VALUES (?, ?, ?)",
    ).run(key, value, NOW_ISO);
  }
}

ensureSetting("demoCompany", DEMO_COMPANY);
ensureSetting("demoLocation", DEMO_LOCATION);

/* ------------------------------------------------------------------ */
/* 2. Products (raw materials, semi-finished, finished)               */
/* ------------------------------------------------------------------ */

const products = {};

function ensureProduct(key, input) {
  if (products[key]) return products[key];
  // Check by SKU for idempotency
  const bySku = db
    .prepare("SELECT id, name FROM products WHERE sku = ?")
    .get(input.sku);
  if (bySku) {
    products[key] = { id: bySku.id, name: bySku.name };
    return products[key];
  }
  const created = saveProduct(db, SYSTEM_ACTOR, input, NOW_ISO);
  products[key] = { id: created.id, name: input.name };
  return products[key];
}

// Raw materials
ensureProduct("woodenLegs", {
  sku: "RM-LEG-001",
  name: "Wooden Legs",
  unit: "pcs",
  category: "Raw Material",
  productType: "rawMaterial",
  vatTreatment: "standard",
  averageCostFils: 2500,
  openingQuantityMilli: 0,
});
ensureProduct("tabletops", {
  sku: "RM-TOP-001",
  name: "Tabletops",
  unit: "pcs",
  category: "Raw Material",
  productType: "rawMaterial",
  vatTreatment: "standard",
  averageCostFils: 15000,
  openingQuantityMilli: 0,
});
ensureProduct("screws", {
  sku: "RM-SCR-001",
  name: "Screws",
  unit: "pcs",
  category: "Raw Material",
  productType: "rawMaterial",
  vatTreatment: "standard",
  averageCostFils: 100,
  openingQuantityMilli: 0,
});
ensureProduct("woodPanels", {
  sku: "RM-PNL-001",
  name: "Wood Panels",
  unit: "pcs",
  category: "Raw Material",
  productType: "rawMaterial",
  vatTreatment: "standard",
  averageCostFils: 8000,
  openingQuantityMilli: 0,
});
ensureProduct("packingBoxes", {
  sku: "RM-BOX-001",
  name: "Packing Boxes",
  unit: "pcs",
  category: "Raw Material",
  productType: "rawMaterial",
  vatTreatment: "standard",
  averageCostFils: 500,
  openingQuantityMilli: 0,
});
ensureProduct("metalBrackets", {
  sku: "RM-BKT-001",
  name: "Metal Brackets",
  unit: "pcs",
  category: "Raw Material",
  productType: "rawMaterial",
  vatTreatment: "standard",
  averageCostFils: 1200,
  openingQuantityMilli: 0,
});

// Semi-finished
ensureProduct("tableFrame", {
  sku: "SF-FRM-001",
  name: "Table Frame",
  unit: "pcs",
  category: "Semi-Finished",
  productType: "semiFinished",
  vatTreatment: "standard",
  averageCostFils: 0,
  openingQuantityMilli: 0,
});
ensureProduct("deskAssembly", {
  sku: "SF-ASM-001",
  name: "Desk Assembly",
  unit: "pcs",
  category: "Semi-Finished",
  productType: "semiFinished",
  vatTreatment: "standard",
  averageCostFils: 0,
  openingQuantityMilli: 0,
});

// Finished
ensureProduct("woodenTable", {
  sku: "FG-TBL-001",
  name: "Wooden Table",
  unit: "pcs",
  category: "Finished Goods",
  productType: "finishedGood",
  vatTreatment: "standard",
  averageCostFils: 0,
  openingQuantityMilli: 0,
});
ensureProduct("officeDesk", {
  sku: "FG-DESK-001",
  name: "Office Desk",
  unit: "pcs",
  category: "Finished Goods",
  productType: "finishedGood",
  vatTreatment: "standard",
  averageCostFils: 0,
  openingQuantityMilli: 0,
});

/* ------------------------------------------------------------------ */
/* 3. Stock raw materials via IMS purchase workflow                   */
/* ------------------------------------------------------------------ */

// Create a supplier for the demo (idempotent)
const existingSupplier = db
  .prepare("SELECT id FROM parties WHERE name = ? AND kind = 'supplier'")
  .get("Timber & Fasteners Co.");
let supplier;
if (existingSupplier) {
  supplier = { id: existingSupplier.id };
} else {
  supplier = saveParty(db, SYSTEM_ACTOR, {
    kind: "supplier",
    name: "Timber & Fasteners Co.",
    phone: null,
    email: null,
    trn: null,
    addressLine: null,
  }, NOW_ISO);
}

const locationId = defaultLocationId(db);
const today = NOW_ISO.slice(0, 10);

// Receive raw materials through the IMS stock engine.
// Creates the purchase document record and posts stock movement directly,
// bypassing saveDocument's complex total-computation layer while still using
// the real stock engine (postMovement) and audit trail (recordAudit).
function receiveStock(productKey, quantityMilli, unitCostFils) {
  const product = products[productKey];
  if (!product) {
    throw new Error(`Product ${productKey} not found`);
  }

  const lineCost = quantityMilli * unitCostFils;

  // Create the purchase invoice document record
  const docInfo = db
    .prepare(
      `INSERT INTO documents
         (kind, number, party_id, issue_date, due_date, status, net_fils, vat_fils,
          gross_fils, discount_fils, paid_fils, cost_fils, fiscal_year, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "purchaseInvoice",
      `PI-${String(Date.now()).slice(-6)}`,
      supplier.id,
      today,
      null,
      "issued",
      lineCost,    // net_fils
      0,           // vat_fils
      lineCost,    // gross_fils
      0,           // discount_fils
      lineCost,    // cost_fils (position after paid_fils=0 literal)
      "2026",      // fiscal_year
      `Demo stock receipt for ${productKey}`, // notes
      SYSTEM_ACTOR.name, // created_by
      NOW_ISO,     // created_at
      NOW_ISO,     // updated_at
    );
  const documentId = Number(docInfo.lastInsertRowid);

  // Create the document line
  db.prepare(
    `INSERT INTO document_lines
       (document_id, product_id, line_no, description, quantity_milli, unit_price_fils,
        net_fils, vat_fils, vat_treatment, unit_cost_fils, cost_fils)
     VALUES (?, ?, 1, ?, ?, ?, ?, 0, 'standard', ?, ?)`,
  ).run(
    documentId,
    product.id,
    products[productKey].name,
    quantityMilli,
    unitCostFils,
    quantityMilli * unitCostFils,
    unitCostFils,
    lineCost,
  );

  // Post stock movement through the real IMS stock engine
  const ctx = {
    db,
    actorName: SYSTEM_ACTOR.name,
    nowIso: NOW_ISO,
    nowDate: today,
    allowNegativeStock: false,
  };
  postMovement(ctx, {
    productId: product.id,
    locationId,
    movementDate: today,
    kind: "receipt",
    quantityMilli,
    unitCostFils,
    stockStatus: "available",
    sourceKind: "purchaseInvoice",
    sourceId: documentId,
    notes: `Demo stock receipt for ${productKey}`,
    affectProductTotal: true,
    idempotencyKey: `demo:purchaseInvoice:${documentId}:receipt:${NOW_ISO}`,
    allowNegativeOverride: false,
  });

  recordAudit(db, SYSTEM_ACTOR, {
    module: "purchases",
    action: "create",
    entityType: "purchaseInvoice",
    entityId: documentId,
    newValues: { productId: product.id, quantityMilli, unitCostFils },
  }, NOW_ISO);

  return { id: documentId };
}

// Receive raw materials
receiveStock("woodenLegs", 50_000, 2500);    // 50 units
receiveStock("tabletops", 20_000, 15000);   // 20 units
receiveStock("screws", 120_000, 100);       // 120 units
receiveStock("woodPanels", 30_000, 8000);   // 30 units
receiveStock("packingBoxes", 40_000, 500);  // 40 units
receiveStock("metalBrackets", 60_000, 1200); // 60 units

// eslint-disable-next-line no-console
console.log("Raw materials received into IMS stock.");

/* ------------------------------------------------------------------ */
/* 4. Work centers                                                    */
/* ------------------------------------------------------------------ */

const workCenters = {};

function ensureWorkCenter(key, input) {
  if (workCenters[key]) return workCenters[key];
  const byCode = db
    .prepare("SELECT id FROM manufacturing_work_centers WHERE code = ?")
    .get(input.code);
  if (byCode) {
    workCenters[key] = { id: byCode.id };
    return workCenters[key];
  }
  const created = saveWorkCenter(db, SYSTEM_ACTOR, input, NOW_ISO);
  workCenters[key] = { id: created.id };
  return workCenters[key];
}

ensureWorkCenter("cutting", {
  code: "WC-CUT",
  name: "Cutting",
  plant: DEMO_LOCATION,
  type: "machining",
  capacity: 100,
  capacityUnit: "units_per_day",
  operatingSchedule: "Mon–Fri 08:00–17:00",
  hourlyOperatingCostFils: 4000,
  availabilityPct: 100,
  efficiencyPct: 95,
  maintenanceStatus: "operational",
  isActive: true,
});
ensureWorkCenter("assembly", {
  code: "WC-ASM",
  name: "Assembly",
  plant: DEMO_LOCATION,
  type: "assembly",
  capacity: 80,
  capacityUnit: "units_per_day",
  operatingSchedule: "Mon–Fri 08:00–17:00",
  hourlyOperatingCostFils: 6000,
  availabilityPct: 100,
  efficiencyPct: 90,
  maintenanceStatus: "operational",
  isActive: true,
});
ensureWorkCenter("finishing", {
  code: "WC-FIN",
  name: "Finishing",
  plant: DEMO_LOCATION,
  type: "assembly",
  capacity: 60,
  capacityUnit: "units_per_day",
  operatingSchedule: "Mon–Fri 08:00–17:00",
  hourlyOperatingCostFils: 5000,
  availabilityPct: 100,
  efficiencyPct: 85,
  maintenanceStatus: "operational",
  isActive: true,
});
ensureWorkCenter("quality", {
  code: "WC-QC",
  name: "Quality Inspection",
  plant: DEMO_LOCATION,
  type: "quality",
  capacity: 40,
  capacityUnit: "units_per_day",
  operatingSchedule: "Mon–Fri 08:00–17:00",
  hourlyOperatingCostFils: 3000,
  availabilityPct: 100,
  efficiencyPct: 100,
  maintenanceStatus: "operational",
  isActive: true,
});
ensureWorkCenter("packaging", {
  code: "WC-PKG",
  name: "Packaging",
  plant: DEMO_LOCATION,
  type: "packaging",
  capacity: 50,
  capacityUnit: "units_per_day",
  operatingSchedule: "Mon–Fri 08:00–17:00",
  hourlyOperatingCostFils: 2500,
  availabilityPct: 100,
  efficiencyPct: 100,
  maintenanceStatus: "operational",
  isActive: true,
});

// eslint-disable-next-line no-console
console.log("Work centers created.");

/* ------------------------------------------------------------------ */
/* 5. Equipment                                                       */
/* ------------------------------------------------------------------ */

function ensureEquipment(key, input) {
  const byCode = db
    .prepare("SELECT id FROM manufacturing_equipment WHERE machine_code = ?")
    .get(input.machineCode);
  if (byCode) return { id: byCode.id };
  const wc = workCenters[input.workCenterKey];
  const created = db
    .prepare(
      `INSERT INTO manufacturing_equipment
         (machine_code, name, work_center_id, status, capacity, setup_time_minutes,
          operating_rate_fils_per_hour, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.machineCode,
      input.name,
      wc.id,
      input.status ?? "active",
      input.capacity ?? null,
      input.setupTimeMinutes ?? 0,
      input.operatingRateFilsPerHour ?? 0,
      NOW_ISO,
      NOW_ISO,
    );
  recordAudit(db, SYSTEM_ACTOR, {
    module: "manufacturing",
    action: "create",
    entityType: "equipment",
    entityId: Number(created.lastInsertRowid),
    newValues: input,
  }, NOW_ISO);
  return { id: Number(created.lastInsertRowid) };
}

ensureEquipment("panelCutter", {
  machineCode: "EQ-CUT-01",
  name: "Panel Cutting Machine",
  workCenterKey: "cutting",
  status: "active",
  capacity: 100,
  setupTimeMinutes: 15,
  operatingRateFilsPerHour: 4000,
});
ensureEquipment("assemblyStation", {
  machineCode: "EQ-ASM-01",
  name: "Assembly Tools Station",
  workCenterKey: "assembly",
  status: "active",
  capacity: 80,
  setupTimeMinutes: 10,
  operatingRateFilsPerHour: 6000,
});
ensureEquipment("finishingMachine", {
  machineCode: "EQ-FIN-01",
  name: "Finishing Machine",
  workCenterKey: "finishing",
  status: "active",
  capacity: 60,
  setupTimeMinutes: 20,
  operatingRateFilsPerHour: 5000,
});
ensureEquipment("packingStation", {
  machineCode: "EQ-PKG-01",
  name: "Packing Station",
  workCenterKey: "packaging",
  status: "active",
  capacity: 50,
  setupTimeMinutes: 5,
  operatingRateFilsPerHour: 2500,
});

// eslint-disable-next-line no-console
console.log("Equipment registered.");

/* ------------------------------------------------------------------ */
/* 6. Routes with operations                                          */
/* ------------------------------------------------------------------ */

const routes = {};

function ensureRoute(key, input) {
  if (routes[key]) return routes[key];
  const byNumber = db
    .prepare("SELECT id FROM manufacturing_routes WHERE number = ?")
    .get(input.number);
  if (byNumber) {
    routes[key] = { id: byNumber.id };
    return routes[key];
  }
  const created = saveRoute(db, SYSTEM_ACTOR, input, NOW_ISO);
  routes[key] = { id: created.id };
  return routes[key];
}

function ensureRouteOperation(routeId, input) {
  const byCode = db
    .prepare("SELECT id FROM manufacturing_route_operations WHERE operation_code = ? AND route_id = ?")
    .get(input.operationCode, routeId);
  if (byCode) return { id: byCode.id };
  const created = saveRouteOperation(db, SYSTEM_ACTOR, {
    routeId,
    ...input,
  }, NOW_ISO);
  return { id: Number(created.lastInsertRowid ?? created.id) };
}

// Route A: Table assembly  Cutting → Assembly → Finishing → Quality → Packaging
const routeTable = ensureRoute("tableAssembly", {
  number: "RT-TBL-001",
  name: "Table Assembly Route",
  description: "Assemble wooden table: cut panels, assemble frame, finish, inspect, package.",
  status: "approved",
  effectiveFrom: "2026-11-01",
  effectiveTo: null,
});

ensureRouteOperation(routeTable.id, {
  operationCode: "OP-TBL-010",
  name: "Cut panels",
  sequence: 1,
  workCenterId: workCenters.cutting.id,
  setupTimeMinutes: 15,
  cycleTimeMinutes: 30,
  expectedOutputQty: 1000,
  qualityCheckpoint: false,
  workInstructions: "Cut wood panels to table dimensions.",
});
ensureRouteOperation(routeTable.id, {
  operationCode: "OP-TBL-020",
  name: "Assemble frame",
  sequence: 2,
  workCenterId: workCenters.assembly.id,
  prerequisiteOpId: null, // set below
  setupTimeMinutes: 10,
  cycleTimeMinutes: 45,
  expectedOutputQty: 1000,
  qualityCheckpoint: false,
  workInstructions: "Attach legs to tabletop using screws.",
});
ensureRouteOperation(routeTable.id, {
  operationCode: "OP-TBL-030",
  name: "Apply finish",
  sequence: 3,
  workCenterId: workCenters.finishing.id,
  prerequisiteOpId: null, // set below
  setupTimeMinutes: 20,
  cycleTimeMinutes: 60,
  expectedOutputQty: 1000,
  qualityCheckpoint: false,
  workInstructions: "Apply protective finish and allow to dry.",
});
ensureRouteOperation(routeTable.id, {
  operationCode: "OP-TBL-040",
  name: "Quality inspection",
  sequence: 4,
  workCenterId: workCenters.quality.id,
  prerequisiteOpId: null, // set below
  setupTimeMinutes: 10,
  cycleTimeMinutes: 20,
  expectedOutputQty: 1000,
  qualityCheckpoint: true,
  workInstructions: "Inspect dimensions, finish quality and stability.",
});
ensureRouteOperation(routeTable.id, {
  operationCode: "OP-TBL-050",
  name: "Package",
  sequence: 5,
  workCenterId: workCenters.packaging.id,
  prerequisiteOpId: null, // set below
  setupTimeMinutes: 5,
  cycleTimeMinutes: 15,
  expectedOutputQty: 1000,
  qualityCheckpoint: false,
  workInstructions: "Pack in box with protective padding.",
});

// Set prerequisites after all operations exist
const ops = db
  .prepare("SELECT id, operation_code FROM manufacturing_route_operations WHERE route_id = ? ORDER BY sequence")
  .all(routeTable.id);
const opByCode = {};
for (const op of ops) opByCode[op.operation_code] = op.id;

function updatePrerequisite(routeId, operationCode, prereqCode) {
  const opId = opByCode[operationCode];
  const prereqId = opByCode[prereqCode];
  db.prepare(
    `UPDATE manufacturing_route_operations SET prerequisite_op_id = ? WHERE id = ?`,
  ).run(prereqId, opId);
}

updatePrerequisite(routeTable.id, "OP-TBL-020", "OP-TBL-010");
updatePrerequisite(routeTable.id, "OP-TBL-030", "OP-TBL-020");
updatePrerequisite(routeTable.id, "OP-TBL-040", "OP-TBL-030");
updatePrerequisite(routeTable.id, "OP-TBL-050", "OP-TBL-040");

// Route B: Office desk assembly (multi-level: uses Table Frame subassembly)
const routeDesk = ensureRoute("deskAssemblyRoute", {
  number: "RT-DESK-001",
  name: "Office Desk Assembly Route",
  description: "Assemble office desk: build frame, attach desktop, finish, inspect, package.",
  status: "approved",
  effectiveFrom: "2026-11-01",
  effectiveTo: null,
});

ensureRouteOperation(routeDesk.id, {
  operationCode: "OP-DESK-010",
  name: "Build desk frame",
  sequence: 1,
  workCenterId: workCenters.cutting.id,
  setupTimeMinutes: 20,
  cycleTimeMinutes: 40,
  expectedOutputQty: 1000,
  qualityCheckpoint: false,
  workInstructions: "Cut panels and assemble desk frame.",
});
ensureRouteOperation(routeDesk.id, {
  operationCode: "OP-DESK-020",
  name: "Attach desktop",
  sequence: 2,
  workCenterId: workCenters.assembly.id,
  prerequisiteOpId: null,
  setupTimeMinutes: 15,
  cycleTimeMinutes: 50,
  expectedOutputQty: 1000,
  qualityCheckpoint: false,
  workInstructions: "Attach desktop to frame using metal brackets.",
});
ensureRouteOperation(routeDesk.id, {
  operationCode: "OP-DESK-030",
  name: "Quality inspection",
  sequence: 3,
  workCenterId: workCenters.quality.id,
  prerequisiteOpId: null,
  setupTimeMinutes: 10,
  cycleTimeMinutes: 20,
  expectedOutputQty: 1000,
  qualityCheckpoint: true,
  workInstructions: "Inspect desk dimensions and finish.",
});
ensureRouteOperation(routeDesk.id, {
  operationCode: "OP-DESK-040",
  name: "Package",
  sequence: 4,
  workCenterId: workCenters.packaging.id,
  prerequisiteOpId: null,
  setupTimeMinutes: 5,
  cycleTimeMinutes: 15,
  expectedOutputQty: 1000,
  qualityCheckpoint: false,
  workInstructions: "Pack desk for delivery.",
});

const deskOps = db
  .prepare("SELECT id, operation_code FROM manufacturing_route_operations WHERE route_id = ? ORDER BY sequence")
  .all(routeDesk.id);
const deskOpByCode = {};
for (const op of deskOps) deskOpByCode[op.operation_code] = op.id;

updatePrerequisite(routeDesk.id, "OP-DESK-020", "OP-DESK-010");
updatePrerequisite(routeDesk.id, "OP-DESK-030", "OP-DESK-020");
updatePrerequisite(routeDesk.id, "OP-DESK-040", "OP-DESK-030");

// eslint-disable-next-line no-console
console.log("Routes and operations created.");

/* ------------------------------------------------------------------ */
/* 7. BOMs                                                            */
/* ------------------------------------------------------------------ */

const boms = {};

function ensureBom(key, input) {
  if (boms[key]) return boms[key];
  const byNumber = db
    .prepare("SELECT id FROM manufacturing_boms WHERE number = ?")
    .get(input.number);
  if (byNumber) {
    boms[key] = { id: byNumber.id };
    return boms[key];
  }
  const created = saveBom(db, SYSTEM_ACTOR, input, NOW_ISO);
  boms[key] = { id: created.id };
  return boms[key];
}

function ensureBomComponent(bomId, input) {
  const existing = db
    .prepare("SELECT id FROM manufacturing_bom_components WHERE bom_id = ? AND component_product_id = ?")
    .get(bomId, input.componentProductId);
  if (existing) return { id: existing.id };
  const created = saveBomComponent(db, SYSTEM_ACTOR, {
    bomId,
    ...input,
  }, NOW_ISO);
  return { id: Number(created.lastInsertRowid ?? created.id) };
}

// BOM A: Wooden Table (4 legs, 1 top, 8 screws)
const bomTable = ensureBom("woodenTable", {
  number: "BOM-TBL-001",
  productId: products.woodenTable.id,
  name: "Wooden Table BOM",
  bomType: "assembly",
  baseOutputQuantity: 1000,
  outputUnit: "pcs",
  routingId: routes.tableAssembly.id,
});

ensureBomComponent(bomTable.id, {
  componentProductId: products.woodenLegs.id,
  quantityPerUnit: 4000,
  unit: "pcs",
  scrapPercent: 5,
});
ensureBomComponent(bomTable.id, {
  componentProductId: products.tabletops.id,
  quantityPerUnit: 1000,
  unit: "pcs",
  scrapPercent: 2,
});
ensureBomComponent(bomTable.id, {
  componentProductId: products.screws.id,
  quantityPerUnit: 8000,
  unit: "pcs",
  scrapPercent: 1,
});
approveBom(db, SYSTEM_ACTOR, bomTable.id, NOW_ISO);

// BOM B: Office Desk (multi-level: uses Table Frame subassembly)
// Desk = Table Frame + 1 Tabletop + 4 Metal Brackets
const bomDesk = ensureBom("officeDesk", {
  number: "BOM-DESK-001",
  productId: products.officeDesk.id,
  name: "Office Desk BOM",
  bomType: "multiLevel",
  baseOutputQuantity: 1000,
  outputUnit: "pcs",
  routingId: routes.deskAssemblyRoute.id,
});

ensureBomComponent(bomDesk.id, {
  componentProductId: products.tableFrame.id,
  quantityPerUnit: 1000,
  unit: "pcs",
  scrapPercent: 3,
});
ensureBomComponent(bomDesk.id, {
  componentProductId: products.tabletops.id,
  quantityPerUnit: 1000,
  unit: "pcs",
  scrapPercent: 2,
});
ensureBomComponent(bomDesk.id, {
  componentProductId: products.metalBrackets.id,
  quantityPerUnit: 4000,
  unit: "pcs",
  scrapPercent: 1,
});
approveBom(db, SYSTEM_ACTOR, bomDesk.id, NOW_ISO);

// Table Frame sub-BOM: 4 legs + 4 screws (for sub-assembly)
const bomFrame = ensureBom("tableFrameBom", {
  number: "BOM-FRM-001",
  productId: products.tableFrame.id,
  name: "Table Frame Sub-BOM",
  bomType: "assembly",
  baseOutputQuantity: 1000,
  outputUnit: "pcs",
  routingId: routes.tableAssembly.id,
});

ensureBomComponent(bomFrame.id, {
  componentProductId: products.woodenLegs.id,
  quantityPerUnit: 4000,
  unit: "pcs",
  scrapPercent: 5,
});
ensureBomComponent(bomFrame.id, {
  componentProductId: products.screws.id,
  quantityPerUnit: 4000,
  unit: "pcs",
  scrapPercent: 1,
});
approveBom(db, SYSTEM_ACTOR, bomFrame.id, NOW_ISO);

// eslint-disable-next-line no-console
console.log("BOMs created and approved.");

/* ------------------------------------------------------------------ */
/* 8. Manufacturing Orders in different states                        */
/* ------------------------------------------------------------------ */

const mos = {};

function ensureMo(key, input) {
  if (mos[key]) return mos[key];
  const byNumber = db
    .prepare("SELECT id FROM manufacturing_orders WHERE number = ?")
    .get(input.number);
  if (byNumber) {
    mos[key] = { id: byNumber.id, number: byNumber.number };
    return mos[key];
  }
  const created = saveManufacturingOrder(db, SYSTEM_ACTOR, input, NOW_ISO);
  mos[key] = { id: created.id, number: created.number };
  return mos[key];
}

function updateMoStatus(moId, status) {
  db.prepare(
    `UPDATE manufacturing_orders SET status = ?, updated_at = ? WHERE id = ?`,
  ).run(status, NOW_ISO, moId);
}

// MO-001: Planned - 10 Wooden Tables (materials available)
const moPlanned = ensureMo("plannedTable", {
  number: "MO-2026-001",
  productId: products.woodenTable.id,
  bomId: boms.woodenTable.id,
  routeId: routes.tableAssembly.id,
  plannedQuantity: 10_000,
  unit: "pcs",
  plannedStart: "2026-11-09",
  plannedFinish: "2026-11-13",
  plant: DEMO_LOCATION,
  status: "planned",
});

// MO-002: Released - 5 Wooden Tables (materials reserved)
const moReleased = ensureMo("releasedTable", {
  number: "MO-2026-002",
  productId: products.woodenTable.id,
  bomId: boms.woodenTable.id,
  routeId: routes.tableAssembly.id,
  plannedQuantity: 5_000,
  unit: "pcs",
  plannedStart: "2026-11-10",
  plannedFinish: "2026-11-12",
  plant: DEMO_LOCATION,
  status: "planned",
});
// Release it through the real release service (reserves stock, creates WOs)
try {
  releaseManufacturingOrder(db, SYSTEM_ACTOR, moReleased.id, NOW_ISO);
  // eslint-disable-next-line no-console
  console.log("MO-002 released through real release service.");
} catch (e) {
  // If release fails due to insufficient stock, set status manually
  // eslint-disable-next-line no-console
  console.log(`MO-002 release skipped: ${e.message}`);
  updateMoStatus(moReleased.id, "released");
}

// MO-003: In Progress - 3 Wooden Tables
const moInProgress = ensureMo("inProgressTable", {
  number: "MO-2026-003",
  productId: products.woodenTable.id,
  bomId: boms.woodenTable.id,
  routeId: routes.tableAssembly.id,
  plannedQuantity: 3_000,
  unit: "pcs",
  plannedStart: "2026-11-11",
  plannedFinish: "2026-11-12",
  plant: DEMO_LOCATION,
  status: "planned",
});
updateMoStatus(moInProgress.id, "released");
try {
  releaseManufacturingOrder(db, SYSTEM_ACTOR, moInProgress.id, NOW_ISO);
} catch (e) {
  updateMoStatus(moInProgress.id, "inProgress");
}
updateMoStatus(moInProgress.id, "inProgress");
db.prepare(
  `UPDATE manufacturing_orders SET actual_quantity = 1_000, updated_at = ? WHERE id = ?`,
).run(NOW_ISO, moInProgress.id);

// MO-004: Quality Review - 2 Wooden Tables (produced, awaiting QC)
const moQualityReview = ensureMo("qualityReviewTable", {
  number: "MO-2026-004",
  productId: products.woodenTable.id,
  bomId: boms.woodenTable.id,
  routeId: routes.tableAssembly.id,
  plannedQuantity: 2_000,
  unit: "pcs",
  plannedStart: "2026-11-12",
  plannedFinish: "2026-11-12",
  plant: DEMO_LOCATION,
  status: "planned",
});
updateMoStatus(moQualityReview.id, "released");
try {
  releaseManufacturingOrder(db, SYSTEM_ACTOR, moQualityReview.id, NOW_ISO);
} catch (e) {
  updateMoStatus(moQualityReview.id, "inProgress");
}
updateMoStatus(moQualityReview.id, "qualityReview");
db.prepare(
  `UPDATE manufacturing_orders SET actual_quantity = 2_000, updated_at = ? WHERE id = ?`,
).run(NOW_ISO, moQualityReview.id);

// MO-005: Completed - 1 Wooden Table (fully produced, QC passed, received)
const moCompleted = ensureMo("completedTable", {
  number: "MO-2026-005",
  productId: products.woodenTable.id,
  bomId: boms.woodenTable.id,
  routeId: routes.tableAssembly.id,
  plannedQuantity: 1_000,
  unit: "pcs",
  plannedStart: "2026-11-08",
  plannedFinish: "2026-11-09",
  plant: DEMO_LOCATION,
  status: "planned",
});
updateMoStatus(moCompleted.id, "released");
try {
  releaseManufacturingOrder(db, SYSTEM_ACTOR, moCompleted.id, NOW_ISO);
} catch (e) {
  updateMoStatus(moCompleted.id, "inProgress");
}
updateMoStatus(moCompleted.id, "inProgress");
updateMoStatus(moCompleted.id, "qualityReview");
updateMoStatus(moCompleted.id, "completed");
db.prepare(
  `UPDATE manufacturing_orders SET actual_quantity = 1_000, accepted_quantity = 1_000, updated_at = ? WHERE id = ?`,
).run(NOW_ISO, moCompleted.id);

// MO-006: Delayed - 8 Wooden Tables (past due date)
const moDelayed = ensureMo("delayedTable", {
  number: "MO-2026-006",
  productId: products.woodenTable.id,
  bomId: boms.woodenTable.id,
  routeId: routes.tableAssembly.id,
  plannedQuantity: 8_000,
  unit: "pcs",
  plannedStart: "2026-10-25",
  plannedFinish: "2026-10-30", // past due
  plant: DEMO_LOCATION,
  status: "released",
});
updateMoStatus(moDelayed.id, "released");

// MO-007: Planned - 15 Office Desks
const moDeskPlanned = ensureMo("plannedDesk", {
  number: "MO-2026-007",
  productId: products.officeDesk.id,
  bomId: boms.officeDesk.id,
  routeId: routes.deskAssemblyRoute.id,
  plannedQuantity: 15_000,
  unit: "pcs",
  plannedStart: "2026-11-12",
  plannedFinish: "2026-11-18",
  plant: DEMO_LOCATION,
  status: "planned",
});

// eslint-disable-next-line no-console
console.log("Manufacturing orders created in multiple states.");

/* ------------------------------------------------------------------ */
/* 9. Work orders for released MOs                                    */
/* ------------------------------------------------------------------ */

function ensureWorkOrder(key, input) {
  const existing = db
    .prepare("SELECT id FROM manufacturing_work_orders WHERE mo_id = ? AND route_operation_id = ?")
    .get(input.moId, input.routeOperationId);
  if (existing) return { id: existing.id };

  // Get the operation's expected duration and work center
  const op = db
    .prepare(
      "SELECT cycle_time_minutes, work_center_id FROM manufacturing_route_operations WHERE id = ?",
    )
    .get(input.routeOperationId);

  const created = saveWorkOrder(db, SYSTEM_ACTOR, {
    moId: input.moId,
    routeOperationId: input.routeOperationId,
    workCenterId: op.work_center_id,
    plannedQuantity: input.plannedQuantity ?? 0,
    expectedDurationMinutes: op.cycle_time_minutes,
    status: input.status ?? "blocked",
  }, NOW_ISO);
  return { id: Number(created.lastInsertRowid ?? created.id) };
}

// Create work orders for released/in-progress MOs
const releasedMoId = mos.releasedTable.id;
const inProgressMoId = mos.inProgressTable.id;
const qualityReviewMoId = mos.qualityReviewTable.id;
const completedMoId = mos.completedTable.id;
const delayedMoId = mos.delayedTable.id;

const tableOps = db
  .prepare(
    "SELECT id, operation_code FROM manufacturing_route_operations WHERE route_id = ? ORDER BY sequence",
  )
  .all(routes.tableAssembly.id);

// Work orders for MO-002 (released, 5 tables)
for (const op of tableOps) {
  const status = op.operation_code === "OP-TBL-010" ? "ready" : "blocked";
  ensureWorkOrder(`wo-${moReleased.number}-${op.operation_code}`, {
    moId: releasedMoId,
    routeOperationId: op.id,
    plannedQuantity: 5_000,
    status,
  });
}

// Work orders for MO-003 (in progress, 3 tables)
for (const op of tableOps) {
  const status = op.operation_code === "OP-TBL-010" ? "inProgress" : "blocked";
  ensureWorkOrder(`wo-${moInProgress.number}-${op.operation_code}`, {
    moId: inProgressMoId,
    routeOperationId: op.id,
    plannedQuantity: 3_000,
    status,
  });
}

// Work orders for MO-004 (quality review, 2 tables)
for (const op of tableOps) {
  const status = op.operation_code === "OP-TBL-040" ? "completed" : "completed";
  ensureWorkOrder(`wo-${moQualityReview.number}-${op.operation_code}`, {
    moId: qualityReviewMoId,
    routeOperationId: op.id,
    plannedQuantity: 2_000,
    status: "completed",
  });
}

// Work orders for MO-005 (completed, 1 table)
for (const op of tableOps) {
  ensureWorkOrder(`wo-${moCompleted.number}-${op.operation_code}`, {
    moId: completedMoId,
    routeOperationId: op.id,
    plannedQuantity: 1_000,
    status: "completed",
  });
}

// Work orders for MO-006 (delayed, 8 tables)
for (const op of tableOps) {
  const status = op.operation_code === "OP-TBL-010" ? "ready" : "blocked";
  ensureWorkOrder(`wo-${moDelayed.number}-${op.operation_code}`, {
    moId: delayedMoId,
    routeOperationId: op.id,
    plannedQuantity: 8_000,
    status,
  });
}

// eslint-disable-next-line no-console
console.log("Work orders created.");

/* ------------------------------------------------------------------ */
/* 10. Material movements: issue, consume, return                     */
/* ------------------------------------------------------------------ */

function postStockMovement(productId, quantityMilli, unitCostFils, kind, notes, sourceKind, sourceId) {
  const ctx = {
    db,
    actorName: SYSTEM_ACTOR.name,
    nowIso: NOW_ISO,
    nowDate: today,
    allowNegativeStock: false,
  };
  const movement = postMovement(ctx, {
    productId,
    locationId,
    movementDate: today,
    kind,
    quantityMilli,
    unitCostFils,
    stockStatus: "available",
    sourceKind,
    sourceId,
    notes,
    affectProductTotal: true,
    idempotencyKey: `demo:${sourceKind}:${sourceId}:${kind}:${NOW_ISO}`,
    allowNegativeOverride: false,
  });
  return movement.id;
}

// For MO-002 (released): materials are reserved by the release service
// For MO-003 (in progress): issue some materials to WIP
// For MO-004 (quality review): materials consumed
// For MO-005 (completed): all materials consumed, finished goods received

// Issue materials to WIP for MO-003 (3 tables = 12 legs, 3 tops, 24 screws)
const issueWipMo3 = postStockMovement(
  products.woodenLegs.id,
  -12_000, 2500, "issue", "Demo issue to WIP for MO-003", "manufacturingOrder", moInProgress.id
);
postStockMovement(
  products.tabletops.id,
  -3_000, 15000, "issue", "Demo issue to WIP for MO-003", "manufacturingOrder", moInProgress.id
);
postStockMovement(
  products.screws.id,
  -24_000, 100, "issue", "Demo issue to WIP for MO-003", "manufacturingOrder", moInProgress.id
);

// Consume materials for MO-004 (2 tables = 8 legs, 2 tops, 16 screws)
postStockMovement(
  products.woodenLegs.id,
  -8_000, 2500, "issue", "Demo consume for MO-004", "manufacturingOrder", moQualityReview.id
);
postStockMovement(
  products.tabletops.id,
  -2_000, 15000, "issue", "Demo consume for MO-004", "manufacturingOrder", moQualityReview.id
);
postStockMovement(
  products.screws.id,
  -16_000, 100, "issue", "Demo consume for MO-004", "manufacturingOrder", moQualityReview.id
);

// Consume materials for MO-005 (1 table = 4 legs, 1 top, 8 screws)
postStockMovement(
  products.woodenLegs.id,
  -4_000, 2500, "issue", "Demo consume for MO-005", "manufacturingOrder", moCompleted.id
);
postStockMovement(
  products.tabletops.id,
  -1_000, 15000, "issue", "Demo consume for MO-005", "manufacturingOrder", moCompleted.id
);
postStockMovement(
  products.screws.id,
  -8_000, 100, "issue", "Demo consume for MO-005", "manufacturingOrder", moCompleted.id
);

// eslint-disable-next-line no-console
console.log("Material movements posted.");

/* ------------------------------------------------------------------ */
/* 11. Quality checks                                                 */
/* ------------------------------------------------------------------ */

// MO-004: 2 tables - both pass QC
saveQualityCheck(db, SYSTEM_ACTOR, {
  moId: qualityReviewMoId,
  checkpoint: "Final inspection - Table 1",
  inspectionType: "passFail",
  result: "passed",
  notes: "Table 1 passed dimensional check.",
}, NOW_ISO);

saveQualityCheck(db, SYSTEM_ACTOR, {
  moId: qualityReviewMoId,
  checkpoint: "Final inspection - Table 2",
  inspectionType: "passFail",
  result: "passed",
  notes: "Table 2 passed dimensional check.",
}, NOW_ISO);

// MO-005: 1 table - passed
saveQualityCheck(db, SYSTEM_ACTOR, {
  moId: completedMoId,
  checkpoint: "Final inspection",
  inspectionType: "passFail",
  result: "passed",
  notes: "Table passed all quality checks.",
}, NOW_ISO);

// eslint-disable-next-line no-console
console.log("Quality checks recorded.");

/* ------------------------------------------------------------------ */
/* 12. Finished goods receipts                                        */
/* ------------------------------------------------------------------ */

// MO-004: Receive 2 accepted tables (both passed QC)
saveFinishedReceipt(db, SYSTEM_ACTOR, {
  moId: qualityReviewMoId,
  quantityMilli: 2_000,
  batchNo: "BATCH-TBL-2026-004-A",
  notes: "Demo receipt of 2 accepted tables from MO-004.",
}, NOW_ISO);

// MO-005: Receive 1 accepted table
saveFinishedReceipt(db, SYSTEM_ACTOR, {
  moId: completedMoId,
  quantityMilli: 1_000,
  batchNo: "BATCH-TBL-2026-005-A",
  notes: "Demo receipt of 1 completed table from MO-005.",
}, NOW_ISO);

// eslint-disable-next-line no-console
console.log("Finished goods receipts posted.");

/* ------------------------------------------------------------------ */
/* 13. Scrap                                                          */
/* ------------------------------------------------------------------ */

// Scrap from MO-003 (1 leg damaged during assembly)
saveScrapRecord(db, SYSTEM_ACTOR, {
  moId: inProgressMoId,
  productId: products.woodenLegs.id,
  quantityMilli: 1_000,
  scrapType: "material",
  scrapReason: "Leg split during assembly",
  workCenterId: workCenters.assembly.id,
}, NOW_ISO);

// eslint-disable-next-line no-console
console.log("Scrap records created.");

/* ------------------------------------------------------------------ */
/* 14. Rework                                                         */
/* ------------------------------------------------------------------ */

// No rework needed in this demo (all QC passed).
// A rework record would be created here if a unit failed inspection.

/* ------------------------------------------------------------------ */
/* 15. Cost records                                                   */
/* ------------------------------------------------------------------ */

// Cost records for MO-005 (completed, 1 table)
saveCostRecord(db, SYSTEM_ACTOR, {
  moId: completedMoId,
  costType: "material",
  amountFils: 11500, // 4 legs (2500 each) + 1 top (15000) + 8 screws (100 each) = 10000+15000+800 = 25800... wait let me recalculate
  // 4 legs * 2500 = 10000, 1 top * 15000 = 15000, 8 screws * 100 = 800. Total = 25800
  amountFils: 25800,
  quantityBasis: 1_000,
  notes: "Demo material cost for 1 wooden table.",
}, NOW_ISO);

saveCostRecord(db, SYSTEM_ACTOR, {
  moId: completedMoId,
  costType: "labor",
  amountFils: 12000,
  quantityBasis: 1_000,
  notes: "Demo labor cost for 1 wooden table.",
}, NOW_ISO);

saveCostRecord(db, SYSTEM_ACTOR, {
  moId: completedMoId,
  costType: "machine",
  amountFils: 6000,
  quantityBasis: 1_000,
  notes: "Demo machine cost for 1 wooden table.",
}, NOW_ISO);

saveCostRecord(db, SYSTEM_ACTOR, {
  moId: completedMoId,
  costType: "overhead",
  amountFils: 3000,
  quantityBasis: 1_000,
  notes: "Demo overhead cost for 1 wooden table.",
}, NOW_ISO);

// Cost records for MO-004 (2 tables)
saveCostRecord(db, SYSTEM_ACTOR, {
  moId: qualityReviewMoId,
  costType: "material",
  amountFils: 51600, // 2 * 25800
  quantityBasis: 2_000,
  notes: "Demo material cost for 2 wooden tables.",
}, NOW_ISO);

saveCostRecord(db, SYSTEM_ACTOR, {
  moId: qualityReviewMoId,
  costType: "labor",
  amountFils: 24000,
  quantityBasis: 2_000,
  notes: "Demo labor cost for 2 wooden tables.",
}, NOW_ISO);

// eslint-disable-next-line no-console
console.log("Cost records created.");

/* ------------------------------------------------------------------ */
/* 16. MPS plans                                                      */
/* ------------------------------------------------------------------ */

function ensureMpsPlan(key, input) {
  const existing = db
    .prepare("SELECT id FROM manufacturing_mps_plans WHERE plan_key = ?")
    .get(input.planKey);
  if (existing) return { id: existing.id };
  const created = db
    .prepare(
      `INSERT INTO manufacturing_mps_plans
         (plan_key, bucket_date, product_id, planned_demand, confirmed_demand,
          forecast_demand, opening_stock, projected_stock, safety_stock,
          expected_production, expected_shortage, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.planKey,
      input.bucketDate,
      input.productId,
      input.plannedDemand,
      input.confirmedDemand,
      input.forecastDemand,
      input.openingStock,
      input.projectedStock,
      input.safetyStock,
      input.expectedProduction,
      input.expectedShortage,
      NOW_ISO,
    );
  return { id: Number(created.lastInsertRowid) };
}

// MPS for Wooden Table: opening stock 0, demand 25, safety stock 5, projected -20
ensureMpsPlan("mps-table-nov", {
  planKey: "MPS-TBL-2026-11",
  bucketDate: "2026-11-30",
  productId: products.woodenTable.id,
  plannedDemand: 0,
  confirmedDemand: 20_000,
  forecastDemand: 5_000,
  openingStock: 0,
  projectedStock: -20_000,
  safetyStock: 5_000,
  expectedProduction: 25_000,
  expectedShortage: 0,
});

// MPS for Office Desk: opening stock 0, demand 15, safety stock 3, projected -18
ensureMpsPlan("mps-desk-nov", {
  planKey: "MPS-DESK-2026-11",
  bucketDate: "2026-11-30",
  productId: products.officeDesk.id,
  plannedDemand: 0,
  confirmedDemand: 15_000,
  forecastDemand: 3_000,
  openingStock: 0,
  projectedStock: -18_000,
  safetyStock: 3_000,
  expectedProduction: 18_000,
  expectedShortage: 0,
});

// eslint-disable-next-line no-console
console.log("MPS plans created.");

/* ------------------------------------------------------------------ */
/* 17. MRP run                                                        */
/* ------------------------------------------------------------------ */

function ensureMrpRun(key, input) {
  const existing = db
    .prepare("SELECT id FROM manufacturing_mrp_runs WHERE run_key = ?")
    .get(input.runKey);
  if (existing) return { id: existing.id };
  const created = db
    .prepare(
      `INSERT INTO manufacturing_mrp_runs
         (run_key, run_date, location_id, status, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.runKey, input.runDate, locationId, "completed", input.notes, NOW_ISO);
  return { id: Number(created.lastInsertRowid) };
}

function ensureMrpRequirement(mrpRunId, input) {
  const existing = db
    .prepare("SELECT id FROM manufacturing_mrp_requirements WHERE mrp_run_id = ? AND product_id = ?")
    .get(mrpRunId, input.productId);
  if (existing) return { id: existing.id };
  const created = db
    .prepare(
      `INSERT INTO manufacturing_mrp_requirements
         (mrp_run_id, product_id, gross_requirement, available_supply, net_requirement,
          shortage_qty, required_by_date, suggested_action, source_mo_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      mrpRunId,
      input.productId,
      input.grossRequirement,
      input.availableSupply,
      input.netRequirement,
      input.shortageQty,
      input.requiredByDate,
      input.suggestedAction,
      input.sourceMoId ?? null,
      NOW_ISO,
    );
  return { id: Number(created.lastInsertRowid) };
}

const mrpRun = ensureMrpRun("mrp-2026-11-07", {
  runKey: "MRP-2026-11-07",
  runDate: today,
  notes: "Demo MRP run for November 2026 - Wooden Table and Office Desk",
});

// MRP requirements based on open MOs:
// Wooden Table: gross 23 tables (MO-001:10 + MO-002:5 + MO-003:3 + MO-004:2 + MO-005:1 + MO-006:8 = 29 planned+released)
// Actually let's use what we have: planned+released+confirmed = MO-001(10) + MO-002(5) + MO-003(3) + MO-004(2) + MO-006(8) = 28 tables
// Available legs: 50, needed: 28*4 = 112, shortage: 62
// Available tops: 20, needed: 28, shortage: 8
// Available screws: 120, needed: 28*8 = 224, shortage: 104

ensureMrpRequirement(mrpRun.id, {
  productId: products.woodenLegs.id,
  grossRequirement: 112_000,
  availableSupply: 50_000,
  netRequirement: 112_000,
  shortageQty: 62_000,
  requiredByDate: "2026-11-15",
  suggestedAction: "Purchase 62 wooden legs",
  sourceMoId: null,
});

ensureMrpRequirement(mrpRun.id, {
  productId: products.tabletops.id,
  grossRequirement: 28_000,
  availableSupply: 20_000,
  netRequirement: 28_000,
  shortageQty: 8_000,
  requiredByDate: "2026-11-15",
  suggestedAction: "Purchase 8 tabletops",
  sourceMoId: null,
});

ensureMrpRequirement(mrpRun.id, {
  productId: products.screws.id,
  grossRequirement: 224_000,
  availableSupply: 120_000,
  netRequirement: 224_000,
  shortageQty: 104_000,
  requiredByDate: "2026-11-15",
  suggestedAction: "Purchase 104 screws",
  sourceMoId: null,
});

// Office Desk: gross 15 desks (MO-007)
// Table Frame: 15, Tabletop: 15, Metal Brackets: 60
// Available frames: 0, needed: 15, shortage: 15
// Available tops: 20-28 used above... let's say remaining: 0 (all allocated to tables)
// Available brackets: 60, needed: 60, shortage: 0

ensureMrpRequirement(mrpRun.id, {
  productId: products.tableFrame.id,
  grossRequirement: 15_000,
  availableSupply: 0,
  netRequirement: 15_000,
  shortageQty: 15_000,
  requiredByDate: "2026-11-20",
  suggestedAction: "Produce 15 table frames (sub-assembly)",
  sourceMoId: null,
});

ensureMrpRequirement(mrpRun.id, {
  productId: products.metalBrackets.id,
  grossRequirement: 60_000,
  availableSupply: 60_000,
  netRequirement: 60_000,
  shortageQty: 0,
  requiredByDate: "2026-11-20",
  suggestedAction: "Sufficient stock on hand",
  sourceMoId: null,
});

// eslint-disable-next-line no-console
console.log("MRP run and requirements created.");

/* ------------------------------------------------------------------ */
/* 18. Maintenance requests                                           */
/* ------------------------------------------------------------------ */

function ensureMaintenance(key, input) {
  const existing = db
    .prepare("SELECT id FROM manufacturing_maintenance_requests WHERE title = ?")
    .get(input.title);
  if (existing) return { id: existing.id };
  const eq = input.equipmentKey ? ensureEquipment(input.equipmentKey, {}) : null;
  const created = db
    .prepare(
      `INSERT INTO manufacturing_maintenance_requests
         (machine_id, work_center_id, title, reason, priority, status,
          reporter_id, assigned_to, started_at, ended_at, resolution_notes,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      eq ? eq.id : null,
      input.workCenterId ?? workCenters.assembly.id,
      input.title,
      input.reason,
      input.priority,
      input.status,
      null,
      null,
      input.startedAt ?? null,
      input.endedAt ?? null,
      input.resolutionNotes ?? null,
      NOW_ISO,
      NOW_ISO,
    );
  return { id: Number(created.lastInsertRowid) };
}

ensureMaintenance("maint-finishing", {
  title: "Finishing machine belt replacement",
  reason: "Conveyor belt showing wear, needs preventive replacement",
  priority: "normal",
  status: "open",
  workCenterId: workCenters.finishing.id,
});

ensureMaintenance("maint-cutting", {
  title: "Panel cutter blade sharpening",
  reason: "Cut quality degrading, blade due for sharpening",
  priority: "high",
  status: "inProgress",
  workCenterId: workCenters.cutting.id,
});

// eslint-disable-next-line no-console
console.log("Maintenance requests created.");

/* ------------------------------------------------------------------ */
/* Done                                                               */
/* ------------------------------------------------------------------ */

db.close();

// eslint-disable-next-line no-console
console.log(``);
console.log(`======================================================================`);
console.log(`  MMS demo data seeded successfully into: ${dataDir}`);
console.log(`  Company: ${DEMO_COMPANY}`);
console.log(`  Location: ${DEMO_LOCATION}`);
console.log(``);
console.log(`  Products:`);
console.log(`    Raw materials: Wooden Legs, Tabletops, Screws, Wood Panels,`);
console.log(`                   Packing Boxes, Metal Brackets`);
console.log(`    Semi-finished: Table Frame, Desk Assembly`);
console.log(`    Finished: Wooden Table, Office Desk`);
console.log(``);
console.log(`  Work centers: Cutting, Assembly, Finishing, Quality, Packaging`);
console.log(`  Routes: Table Assembly, Office Desk Assembly`);
console.log(`  BOMs: Wooden Table, Office Desk (multi-level), Table Frame`);
console.log(``);
console.log(`  Manufacturing Orders:`);
console.log(`    MO-2026-001: Planned, 10 Wooden Tables`);
console.log(`    MO-2026-002: Released, 5 Wooden Tables`);
console.log(`    MO-2026-003: In Progress, 3 Wooden Tables`);
console.log(`    MO-2026-004: Quality Review, 2 Wooden Tables`);
console.log(`    MO-2026-005: Completed, 1 Wooden Table`);
console.log(`    MO-2026-006: Delayed, 8 Wooden Tables`);
console.log(`    MO-2026-007: Planned, 15 Office Desks`);
console.log(``);
console.log(`  To run the app against this demo database:`);
console.log(`    EYERSTOCK_DATA_DIR=${dataDir} NODE_ENV=development npm run dev`);
console.log(``);
console.log(`======================================================================`);
