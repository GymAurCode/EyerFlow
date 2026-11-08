import {
  dockSchema,
  appointmentSchema,
  type DockInput,
  type AppointmentInput,
  type Appointment,
  type Dock,
} from "../../../shared/wms";
import { audit, fail, type WmsContext } from "./operations";
export function saveDock(c: WmsContext, input: DockInput): number {
  const p = dockSchema.parse(input);
  return c.db
    .transaction(() => {
      if (!c.db.prepare("SELECT id FROM wms_warehouses WHERE id=? AND active=1").get(p.warehouseId))
        fail("Choose an active warehouse.");
      let id = p.id;
      if (id) {
        const d = c.db.prepare("SELECT * FROM wms_docks WHERE id=?").get(id) as Dock | undefined;
        if (!d) fail("Dock not found.");
        if (d.warehouse_id !== p.warehouseId) fail("The dock warehouse cannot change.");
        if (
          !p.active &&
          c.db
            .prepare(
              "SELECT id FROM wms_appointments WHERE dock_id=? AND status NOT IN ('completed','cancelled','noShow') LIMIT 1",
            )
            .get(id)
        )
          fail("Resolve active appointments before deactivating this dock.");
        c.db
          .prepare("UPDATE wms_docks SET code=?,name=?,active=? WHERE id=?")
          .run(p.code, p.name, Number(p.active), id);
      } else
        id = Number(
          c.db
            .prepare("INSERT INTO wms_docks(warehouse_id,code,name,active) VALUES(?,?,?,?)")
            .run(p.warehouseId, p.code, p.name, Number(p.active)).lastInsertRowid,
        );
      audit(c, "save", "wmsDock", id, p);
      return id;
    })
    .immediate();
}
export function saveAppointment(c: WmsContext, input: AppointmentInput): number {
  const p = appointmentSchema.parse(input);
  return c.db
    .transaction(() => {
      if (p.startsAt >= p.endsAt) fail("Appointment end must be after its start.");
      if (
        !c.db
          .prepare(
            "SELECT d.id FROM wms_docks d JOIN wms_warehouses w ON w.id=d.warehouse_id WHERE d.id=? AND d.warehouse_id=? AND d.active=1 AND w.active=1",
          )
          .get(p.dockId, p.warehouseId)
      )
        fail("Choose an active dock in this warehouse.");
      if (
        p.supplierId !== null &&
        !c.db
          .prepare("SELECT id FROM parties WHERE id=? AND kind IN ('supplier','both')")
          .get(p.supplierId)
      )
        fail("Choose an existing supplier.");
      if (
        c.db
          .prepare(
            "SELECT id FROM wms_appointments WHERE dock_id=? AND id<>? AND status NOT IN ('completed','cancelled','noShow') AND starts_at<? AND ends_at>? LIMIT 1",
          )
          .get(p.dockId, p.id ?? 0, p.endsAt, p.startsAt)
      )
        fail("This dock is already booked during the requested time window.");
      let id = p.id;
      if (id) {
        const d = c.db.prepare("SELECT * FROM wms_appointments WHERE id=?").get(id) as
          Appointment | undefined;
        if (!d || d.status !== "scheduled") fail("Only scheduled appointments may be edited.");
        if (d.revision !== p.revision) fail("Appointment changed. Refresh and retry.");
        c.db
          .prepare(
            "UPDATE wms_appointments SET warehouse_id=?,code=?,name=?,dock_id=?,supplier_id=?,starts_at=?,ends_at=?,carrier=?,vehicle=?,priority=?,revision=revision+1 WHERE id=?",
          )
          .run(
            p.warehouseId,
            p.code,
            p.name,
            p.dockId,
            p.supplierId,
            p.startsAt,
            p.endsAt,
            p.carrier,
            p.vehicle,
            p.priority,
            id,
          );
      } else
        id = Number(
          c.db
            .prepare(
              "INSERT INTO wms_appointments(warehouse_id,code,name,dock_id,supplier_id,starts_at,ends_at,carrier,vehicle,priority) VALUES(?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              p.warehouseId,
              p.code,
              p.name,
              p.dockId,
              p.supplierId,
              p.startsAt,
              p.endsAt,
              p.carrier,
              p.vehicle,
              p.priority,
            ).lastInsertRowid,
        );
      audit(c, "save", "wmsAppointment", id, p);
      return id;
    })
    .immediate();
}
export function transitionAppointment(
  c: WmsContext,
  id: number,
  revision: number,
  status: "arrived" | "unloading" | "completed" | "cancelled" | "noShow",
  reason: string,
): void {
  c.db
    .transaction(() => {
      const d = c.db.prepare("SELECT * FROM wms_appointments WHERE id=?").get(id) as
        Appointment | undefined;
      if (!d) fail("Appointment not found.");
      if (d.status === status) return;
      if (d.revision !== revision) fail("Appointment changed. Refresh and retry.");
      const allowed: Record<string, string[]> = {
        scheduled: ["arrived", "cancelled", "noShow"],
        arrived: ["unloading", "cancelled"],
        unloading: ["completed"],
      };
      if (!allowed[d.status]?.includes(status)) fail("Invalid appointment transition.");
      if (["cancelled", "noShow"].includes(status) && !reason.trim())
        fail("A reason is required for cancellation or no-show.");
      if (status === "noShow" && c.nowIso < d.ends_at)
        fail("An appointment cannot be marked no-show before its window ends.");
      c.db
        .prepare(
          "UPDATE wms_appointments SET status=?,revision=revision+1,arrived_at=CASE WHEN ?='arrived' THEN ? ELSE arrived_at END,actual_start=CASE WHEN ?='unloading' THEN ? ELSE actual_start END,actual_end=CASE WHEN ?='completed' THEN ? ELSE actual_end END WHERE id=?",
        )
        .run(status, status, c.nowIso, status, c.nowIso, status, c.nowIso, id);
      audit(c, "transition", "wmsAppointment", id, { status, reason });
    })
    .immediate();
}
