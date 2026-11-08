import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openInMemoryDatabase, type SqliteDatabase } from "../src/data/connection";
import { runMigrations } from "../src/data/migrator";
import { migrations } from "../src/data/migrations";
import { item, NOW } from "./planning-fixtures";
import * as wms from "../src/main/repositories/wms/operations";
import { recordCount, approveCount } from "../src/main/repositories/wms/counting";
import { postMovement } from "../src/main/repositories/ims/stock";
import { transitionOperation } from "../src/main/repositories/ims/operations";
let db: SqliteDatabase, c: wms.WmsContext, product: number, binId: number, locationId: number;
beforeEach(() => {
  db = openInMemoryDatabase();
  runMigrations(db, migrations);
  c = { db, actor: { id: 1, name: "Counter" }, nowIso: NOW };
  product = item(db, "COUNT-SKU");
  const warehouse = wms.saveWarehouse(c, { code: "WH", name: "Warehouse" }).id;
  binId = wms.saveBin(c, { warehouseId: warehouse, code: "A01", type: "storage" });
  locationId = wms.snapshot(db, NOW).bins[0]!.location_id;
  postMovement(wms.stock(c), {
    productId: product,
    locationId,
    quantityMilli: 50_000,
    kind: "receipt",
    movementDate: NOW.slice(0, 10),
  });
});
afterEach(() => db.close());
function count() {
  return recordCount(c, {
    binId,
    productId: product,
    countedMilli: 47_000,
    binScan: "A01",
    productScan: "COUNT-SKU",
    reason: "Physical variance",
    commandKey: randomUUID(),
  });
}
it("50 expected, 47 counted: different supervisor posts one shared -3 adjustment", () => {
  const id = count();
  expect(() => approveCount(c, id)).toThrow(/different supervisor/);
  const supervisor = { ...c, actor: { id: 2, name: "Supervisor" } };
  approveCount(supervisor, id);
  approveCount(supervisor, id);
  expect(db.prepare("SELECT quantity_milli FROM products WHERE id=?").get(product)).toEqual({
    quantity_milli: 47_000,
  });
  expect(wms.snapshot(db, NOW).counts[0]!.status).toBe("posted");
  expect(wms.snapshot(db, NOW).reconciliation).toEqual([]);
});
it("a move after counting invalidates the immutable snapshot", () => {
  const id = count();
  postMovement(wms.stock(c), {
    productId: product,
    locationId,
    quantityMilli: 1000,
    kind: "receipt",
    movementDate: NOW.slice(0, 10),
  });
  expect(() => approveCount({ ...c, actor: { id: 2, name: "Supervisor" } }, id)).toThrow(
    /Stock changed/,
  );
  expect(wms.snapshot(db, NOW).counts[0]!.status).toBe("review");
});
it("linked warehouse count cannot bypass supervisor review through IMS post", () => {
  count();
  const doc = wms.snapshot(db, NOW).counts[0]!.ims_document_id;
  expect(() =>
    transitionOperation(
      {
        ...c,
        nowDate: NOW.slice(0, 10),
        fiscalYearStartMonth: 1,
        allowNegativeStock: false,
        vatRate: 0,
      },
      doc,
      "post",
    ),
  ).toThrow(/approval through WMS/);
  expect(wms.snapshot(db, NOW).positions[0]!.quantity_milli).toBe(50_000);
});
it("a recount preserves the original snapshot and supersedes it explicitly", () => {
  const first = count();
  postMovement(wms.stock(c), {
    productId: product,
    locationId,
    quantityMilli: 1000,
    kind: "receipt",
    movementDate: NOW.slice(0, 10),
  });
  const second = recordCount(c, {
    binId,
    productId: product,
    countedMilli: 47_000,
    binScan: "A01",
    productScan: "COUNT-SKU",
    reason: "Recount after receiving",
    commandKey: randomUUID(),
    recountOfId: first,
  });
  const supervisor = { ...c, actor: { id: 2, name: "Supervisor" } };
  expect(() => approveCount(supervisor, first)).toThrow(/superseded/);
  approveCount(supervisor, second);
  const counts = wms.snapshot(db, NOW).counts;
  expect(counts.find((r) => r.id === first)).toMatchObject({
    expected_milli: 50_000,
    superseded_by: second,
  });
  expect(counts.find((r) => r.id === second)).toMatchObject({
    expected_milli: 51_000,
    recount_of: first,
    status: "posted",
  });
  expect(wms.snapshot(db, NOW).positions[0]!.quantity_milli).toBe(47_000);
});
