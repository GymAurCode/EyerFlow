/* Temporary: reproduce the MO release failure against an in-memory database. */
import { openInMemoryDatabase } from "../src/data/connection";
import { runMigrations } from "../src/data/migrator";
import { migrations } from "../src/data/migrations";
import { saveProduct, type SaveProductInput } from "../src/main/repositories/products";
import { saveRoute, saveRouteOperation } from "../src/main/repositories/mms/routing";
import { saveBom, saveBomComponent, approveBom } from "../src/main/repositories/mms/bom";
import {
  getManufacturingOrder,
  releaseManufacturingOrder,
  saveManufacturingOrder,
} from "../src/main/repositories/mms/manufacturingOrders";
import { consumeMaterial, issueMaterialToWip } from "../src/main/repositories/mms/materialIssues";
import {
  completeWorkOrder,
  listWorkOrders,
  startWorkOrder,
} from "../src/main/repositories/mms/workOrders";
import { saveFinishedReceipt } from "../src/main/repositories/mms/finishedReceipts";
import { defaultLocationId, postMovement } from "../src/main/repositories/ims/stock";

const db = openInMemoryDatabase();
runMigrations(db, migrations);

const now = new Date().toISOString();
const actor = { id: null, name: "Diagnostic" };

const product = (name: string, sku: string, qty: number): number => {
  const created = saveProduct(
    db,
    actor,
    {
      name,
      sku,
      category: "Manufacturing",
      salePriceFils: 15_000,
      vatTreatment: "standard",
      isSerialised: false,
      isService: false,
      reorderLevelMilli: 0,
    } as unknown as SaveProductInput,
    now,
  );
  if (qty > 0) {
    db.prepare("UPDATE products SET quantity_milli = ?, average_cost_fils = 4000 WHERE id = ?").run(
      qty,
      created.id,
    );
  }
  return created.id;
};

const rawId = product("Filter housing", "RAW-001", 100_000);
const finishedId = product("Inline filter", "FIN-001", 0);

// Real available stock is the movement ledger, not the legacy product column.
postMovement(
  { db, actorName: actor.name, nowIso: now, nowDate: now.slice(0, 10), allowNegativeStock: false },
  {
    productId: rawId,
    locationId: defaultLocationId(db),
    movementDate: now.slice(0, 10),
    kind: "receipt",
    quantityMilli: 100_000,
    unitCostFils: 4_000,
    stockStatus: "available",
    sourceKind: "openingStock",
    sourceId: null,
    notes: "diagnostic opening stock",
    affectProductTotal: true,
  },
);

const route = saveRoute(
  db,
  actor,
  { name: "Filter assembly", status: "approved", effectiveFrom: now.slice(0, 10) },
  now,
);
saveRouteOperation(
  db,
  actor,
  {
    routeId: route.id,
    operationCode: "OP-10",
    name: "Assemble filter",
    sequence: 1,
    cycleTimeMinutes: 5,
  },
  now,
);

const bom = saveBom(
  db,
  actor,
  {
    productId: finishedId,
    name: "Inline filter BOM",
    bomType: "assembly",
    baseOutputQuantity: 1000,
    outputUnit: "pcs",
    routingId: route.id,
  },
  now,
);
saveBomComponent(
  db,
  actor,
  { bomId: bom.id, componentProductId: rawId, quantityPerUnit: 1000, unit: "pcs" },
  now,
);
approveBom(db, actor, bom.id, now);

const mo = saveManufacturingOrder(
  db,
  actor,
  { productId: finishedId, bomId: bom.id, plannedQuantity: 10_000, routeId: route.id },
  now,
);

try {
  const released = releaseManufacturingOrder(db, actor, mo.id, now);
  console.log("released", released.status, released.components);
} catch (error) {
  console.error("RELEASE FAILED");
  console.error((error as Error).stack);
}

const raw = db.prepare("SELECT id, quantity_milli FROM products WHERE id = ?").get(rawId);
console.log("raw stock", raw);

const step = (name: string, run: () => unknown): void => {
  try {
    const result = run();
    console.log(`OK   ${name}`, JSON.stringify(result).slice(0, 160));
  } catch (error) {
    console.error(`FAIL ${name}:`, (error as Error).message);
  }
};

step("issueToWip", () =>
  issueMaterialToWip(db, actor, { moId: mo.id, componentProductId: rawId, quantityMilli: 10_000 }, now),
);
step("consume", () =>
  consumeMaterial(db, actor, { moId: mo.id, componentProductId: rawId, quantityMilli: 10_000 }, now),
);

const workOrders = listWorkOrders(db, { moId: mo.id });
console.log("work orders", workOrders.map((wo) => `${wo.id}:${wo.status}`));
const woId = workOrders[0]?.id ?? 0;
step("startWo", () => startWorkOrder(db, actor, woId, now));
step("completeWo", () =>
  completeWorkOrder(db, actor, woId, 10_000, 10_000, 0, now),
);

const moAfter = getManufacturingOrder(db, mo.id);
console.log("mo after", moAfter.status, moAfter.actualQuantity, moAfter.acceptedQuantity);
step("receipt", () => saveFinishedReceipt(db, actor, { moId: mo.id, quantityMilli: 10_000 }, now));
console.log("finished stock", db.prepare("SELECT quantity_milli FROM products WHERE id = ?").get(finishedId));
