import { afterEach, beforeEach, it, expect } from "vitest";
import { openInMemoryDatabase, type SqliteDatabase } from "../src/data/connection";
import { runMigrations } from "../src/data/migrator";
import { migrations } from "../src/data/migrations";
import { NOW } from "./planning-fixtures";
import { SYSTEM_ACTOR } from "../src/main/audit-writer";
import { saveWarehouse, snapshot, type WmsContext } from "../src/main/repositories/wms/operations";
import {
  saveDock,
  saveAppointment,
  transitionAppointment,
} from "../src/main/repositories/wms/appointments";
let db: SqliteDatabase, c: WmsContext, warehouseId: number, dockId: number;
beforeEach(() => {
  db = openInMemoryDatabase();
  runMigrations(db, migrations);
  c = { db, actor: SYSTEM_ACTOR, nowIso: NOW };
  warehouseId = saveWarehouse(c, { code: "WH", name: "Warehouse" }).id;
  dockId = saveDock(c, { warehouseId, code: "DOCK-01", name: "Receiving door" });
});
afterEach(() => db.close());
const input = () => ({
  warehouseId,
  dockId,
  code: "APPT-01",
  name: "Supplier delivery",
  startsAt: "2026-11-07T10:00:00.000Z",
  endsAt: "2026-11-07T11:00:00.000Z",
});
it("blocks overlapping bookings and permits adjacent slots", () => {
  saveAppointment(c, input());
  expect(() =>
    saveAppointment(c, { ...input(), code: "OVERLAP", startsAt: "2026-11-07T10:30:00.000Z" }),
  ).toThrow(/already booked/);
  saveAppointment(c, {
    ...input(),
    code: "NEXT",
    startsAt: "2026-11-07T11:00:00.000Z",
    endsAt: "2026-11-07T12:00:00.000Z",
  });
  expect(snapshot(db, NOW).appointments).toHaveLength(2);
});
it("check-in, unloading and completion persist actual times and reject stale edits", () => {
  const id = saveAppointment(c, input());
  transitionAppointment(c, id, 0, "arrived", "");
  expect(() => saveAppointment(c, { ...input(), id, revision: 0 })).toThrow(/scheduled/);
  transitionAppointment(c, id, 1, "unloading", "");
  transitionAppointment(c, id, 2, "completed", "");
  transitionAppointment(c, id, 2, "completed", "");
  expect(snapshot(db, NOW).appointments[0]).toMatchObject({
    status: "completed",
    arrived_at: NOW,
    actual_start: NOW,
    actual_end: NOW,
    revision: 3,
  });
});
it("blocks invalid transitions, premature no-show and disabling a booked door", () => {
  const id = saveAppointment(c, input());
  expect(() => transitionAppointment(c, id, 0, "completed", "")).toThrow(/Invalid/);
  expect(() => transitionAppointment(c, id, 0, "noShow", "Did not arrive")).toThrow(/before/);
  expect(() =>
    saveDock(c, {
      id: dockId,
      warehouseId,
      code: "DOCK-01",
      name: "Receiving door",
      active: false,
    }),
  ).toThrow(/active appointments/);
  expect(() => transitionAppointment(c, id, 0, "cancelled", "")).toThrow(/reason/);
  transitionAppointment(c, id, 0, "cancelled", "Supplier rescheduled");
  saveDock(c, { id: dockId, warehouseId, code: "DOCK-01", name: "Receiving door", active: false });
});
