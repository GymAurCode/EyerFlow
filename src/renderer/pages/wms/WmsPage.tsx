import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useLocation, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Warehouse as WarehouseIcon, Plus, RefreshCw } from "lucide-react";
import { call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { WMS_SECTIONS } from "../../lib/wms-nav";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { PageHeader, TableSkeleton } from "../../components/ui/Feedback";
import { Field, Input, Select } from "../../components/ui/Input";
import { StatCard } from "../../components/ui/StatCard";
import { MmsTable as Table } from "../mms/MmsTable";
import type { Column } from "../../components/ui/DataTable";
import type {
  Bin,
  Warehouse,
  WmsSnapshot,
  WarehouseTask,
  InboundLine,
  Inbound,
  Position,
  CycleCount,
  WarehouseReturn,
  ReplenishmentRule,
  Dock,
  Appointment,
} from "../../../shared/wms";

type FormKind =
  | "warehouse"
  | "bin"
  | "inbound"
  | "receive"
  | "task"
  | "move"
  | "map"
  | "count"
  | "adopt"
  | "return"
  | "inspectReturn"
  | "replenishment"
  | "dock"
  | "appointment"
  | "appointmentStatus"
  | "assignment";
type Values = Record<string, string>;
type Edit = { kind: FormKind; title: string; values: Values; commandKey: string };
const units = (m: number) => (m / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 });
const milli = (s: string | undefined) => {
  if (!s || !/^\d+(\.\d{1,3})?$/.test(s))
    throw new Error("Enter a positive quantity with at most three decimal places.");
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 1000 + Number(frac.padEnd(3, "0"));
};
const textColumn = <T,>(id: string, header: string, cell: (r: T) => ReactNode): Column<T> => ({
  id,
  header,
  cell,
});

export function WmsPage(): React.JSX.Element {
  const path = useLocation().pathname.split("/").at(-1) ?? "overview";
  const { can, user } = useApp();
  const client = useQueryClient();
  const [edit, setEdit] = useState<Edit | null>(null);
  const [formError, setFormError] = useState("");
  const [myTasks, setMyTasks] = useState(false);
  const query = useQuery({
    queryKey: ["wms"],
    queryFn: () => call("wms.snapshot", {}),
    enabled: can("warehouse", "view"),
  });
  const data = query.data;
  const title =
    WMS_SECTIONS.flatMap((s) => s.items).find((i) => i.path === `/wms/${path}`)?.label ??
    "Warehouse Dashboard";
  const open = (kind: FormKind, title: string, values: Values = {}) => {
    setFormError("");
    setEdit({ kind, title, values, commandKey: crypto.randomUUID() });
  };
  const mutate = useMutation({
    mutationFn: async () => {
      if (!edit) return;
      const v = edit.values,
        id = Number(v["id"]);
      switch (edit.kind) {
        case "assignment":
          return call("wms.tasks.assign", { id, workerId: Number(v["workerId"]) });
        case "dock":
          return call("wms.docks.save", {
            ...(id ? { id } : {}),
            warehouseId: Number(v["warehouseId"]),
            code: v["code"] ?? "",
            name: v["name"] ?? "",
            active: v["active"] !== "0",
          });
        case "appointment":
          return call("wms.appointments.save", {
            ...(id ? { id } : {}),
            revision: Number(v["revision"] ?? 0),
            warehouseId: Number(v["warehouseId"]),
            dockId: Number(v["dockId"]),
            supplierId: v["supplierId"] ? Number(v["supplierId"]) : null,
            code: v["code"] ?? "",
            name: v["name"] ?? "",
            startsAt: new Date(v["startsAt"] ?? "").toISOString(),
            endsAt: new Date(v["endsAt"] ?? "").toISOString(),
            carrier: v["carrier"] ?? "",
            vehicle: v["vehicle"] ?? "",
            priority: (v["priority"] ?? "normal") as "normal" | "high" | "urgent",
          });
        case "appointmentStatus":
          return call("wms.appointments.transition", {
            id,
            revision: Number(v["revision"]),
            status: v["status"] as "arrived" | "unloading" | "completed" | "cancelled" | "noShow",
            reason: v["reason"] ?? "",
          });
        case "return":
          return call("wms.returns.receive", {
            dispatchLineId: Number(v["lineId"]),
            binId: Number(v["binId"]),
            quantityMilli: milli(v["quantity"]),
            productScan: v["productScan"] ?? "",
            condition: v["condition"] ?? "",
            commandKey: edit.commandKey,
          });
        case "inspectReturn":
          return call("wms.returns.inspect", {
            id,
            sellableMilli: milli(v["quantity"]),
            destinationBinId: Number(v["destinationBinId"]),
            reason: v["reason"] ?? "",
          });
        case "replenishment":
          return call("wms.replenishment.save", {
            ...(id ? { id } : {}),
            productId: Number(v["productId"]),
            sourceBinId: Number(v["sourceBinId"]),
            destinationBinId: Number(v["destinationBinId"]),
            minimumMilli: milli(v["minimum"]),
            targetMilli: milli(v["target"]),
            active: v["active"] !== "0",
          });
        case "adopt":
          return call("wms.receipts.adopt", {
            movementId: Number(v["movementId"]),
            receivingBinId: Number(v["receivingBinId"]),
          });
        case "count":
          return call("wms.counts.record", {
            binId: Number(v["binId"]),
            productId: Number(v["productId"]),
            countedMilli: milli(v["quantity"]),
            binScan: v["binScan"] ?? "",
            productScan: v["productScan"] ?? "",
            reason: v["reason"] ?? "",
            commandKey: edit.commandKey,
            ...(v["recountOfId"] ? { recountOfId: Number(v["recountOfId"]) } : {}),
          });
        case "warehouse":
          return call("wms.warehouses.save", {
            ...(id ? { id } : {}),
            code: v["code"] ?? "",
            name: v["name"] ?? "",
            site: v["site"] ?? "",
            address: v["address"] ?? "",
            active: v["active"] !== "0",
          });
        case "bin":
          return call("wms.bins.save", {
            ...(id ? { id } : {}),
            warehouseId: Number(v["warehouseId"]),
            code: v["code"] ?? "",
            zone: v["zone"] ?? "",
            aisle: v["aisle"] ?? "",
            rack: v["rack"] ?? "",
            shelf: v["shelf"] ?? "",
            type: (v["type"] ?? "storage") as "storage",
            capacityMilli: v["capacity"] ? milli(v["capacity"]) : null,
            mixedSku: v["mixedSku"] !== "0",
            active: v["active"] !== "0",
            blocked: v["blocked"] === "1",
          });
        case "inbound":
          return call("wms.inbound.create", {
            warehouseId: Number(v["warehouseId"]),
            reference: v["reference"] ?? "",
            lines: [{ productId: Number(v["productId"]), quantityMilli: milli(v["quantity"]) }],
          });
        case "receive":
          return call("wms.receiving.post", {
            lineId: Number(v["lineId"]),
            binId: Number(v["binId"]),
            quantityMilli: milli(v["quantity"]),
            damagedMilli: v["damaged"] ? milli(v["damaged"]) : 0,
            commandKey: edit.commandKey,
          });
        case "task":
          return call(v["type"] === "pick" ? "wms.picks.confirm" : "wms.tasks.complete", {
            id,
            destinationBinId: Number(v["destinationBinId"]),
            sourceScan: v["sourceScan"] ?? "",
            productScan: v["productScan"] ?? "",
            destinationScan: v["destinationScan"] ?? "",
            quantityMilli: milli(v["quantity"]),
            commandKey: edit.commandKey,
          });
        case "move":
          return call("wms.moves.create", {
            sourceBinId: Number(v["sourceBinId"]),
            destinationBinId: Number(v["destinationBinId"]),
            productId: Number(v["productId"]),
            quantityMilli: milli(v["quantity"]),
          });
        case "map":
          return call("wms.locations.map", {
            warehouseId: Number(v["warehouseId"]),
            locationId: Number(v["locationId"]),
            code: v["code"] ?? "",
          });
      }
    },
    onSuccess: () => {
      toast.success("Warehouse operation saved.");
      setEdit(null);
      void client.invalidateQueries({ queryKey: ["wms"] });
    },
    onError: (e: unknown) => {
      console.error("Warehouse operation failed", e);
      setFormError(errorMessage(e));
    },
  });
  const arrive = useMutation({
    mutationFn: (id: number) => call("wms.inbound.arrive", { id }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["wms"] });
    },
    onError: (e: unknown) => {
      console.error(e);
      toast.error(errorMessage(e));
    },
  });
  const canEdit = can("warehouse", "edit");
  const approve = useMutation({
    mutationFn: (id: number) => call("wms.counts.approve", { id }),
    onSuccess: () => {
      toast.success("Count approved and posted.");
      void client.invalidateQueries({ queryKey: ["wms"] });
    },
    onError: (e: unknown) => {
      console.error(e);
      toast.error(errorMessage(e));
    },
  });
  const replenish = useMutation({
    mutationFn: (id: number) => call("wms.replenishment.generate", { id }),
    onSuccess: (id) => {
      toast.success(
        id === null
          ? "No replenishment demand; stock and pending work meet the minimum."
          : `Replenishment task #${id} created.`,
      );
      void client.invalidateQueries({ queryKey: ["wms"] });
    },
    onError: (e: unknown) => {
      console.error(e);
      toast.error(errorMessage(e));
    },
  });
  const appointmentAction = useMutation({
    mutationFn: (p: {
      id: number;
      revision: number;
      status: "arrived" | "unloading" | "completed";
      reason: string;
    }) => call("wms.appointments.transition", p),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["wms"] });
    },
    onError: (e: unknown) => {
      console.error(e);
      toast.error(errorMessage(e));
    },
  });
  const start = useMutation({
    mutationFn: (id: number) => call("wms.tasks.start", { id }),
    onSuccess: () => {
      toast.success("Task started.");
      void client.invalidateQueries({ queryKey: ["wms"] });
    },
    onError: (e: unknown) => {
      console.error(e);
      toast.error(errorMessage(e));
    },
  });
  function field(
    key: string,
    label: string,
    options?: { value: string; label: string }[],
    required = true,
    type = "text",
  ) {
    if (!edit) return null;
    return (
      <Field label={label} required={required} key={key}>
        {(id) =>
          options ? (
            <Select
              id={id}
              value={edit.values[key] ?? ""}
              onChange={(value) => setEdit({ ...edit, values: { ...edit.values, [key]: value } })}
              options={[{ value: "", label: "Select…" }, ...options]}
            />
          ) : (
            <Input
              id={id}
              required={required}
              type={type}
              autoComplete="off"
              value={edit.values[key] ?? ""}
              onChange={(e) =>
                setEdit({ ...edit, values: { ...edit.values, [key]: e.target.value } })
              }
            />
          )
        }
      </Field>
    );
  }
  const warehouseOptions =
    data?.warehouses
      .filter((w) => w.active)
      .map((w) => ({ value: String(w.id), label: `${w.code} · ${w.name}` })) ?? [];
  const bins = (filter: (b: Bin) => boolean = () => true) =>
    data?.bins
      .filter((b) => b.active && !b.blocked && filter(b))
      .map((b) => ({ value: String(b.id), label: b.code })) ?? [];
  const productOptions =
    data?.products.map((p) => ({ value: String(p.id), label: `${p.sku ?? ""} · ${p.name}` })) ?? [];
  const yesNo = [
    { value: "1", label: "Yes" },
    { value: "0", label: "No" },
  ];
  const warehouseName = (id: number) =>
    data?.warehouses.find((w) => w.id === id)?.code ?? String(id);
  const taskOpen = (t: WarehouseTask) =>
    open("task", `Scan & confirm task #${t.id}`, {
      id: String(t.id),
      type: t.type,
      destinationBinId: String(t.destination_bin_id ?? ""),
      quantity: String((t.quantity_milli - t.actual_milli) / 1000),
    });
  const receiveOpen = (l: InboundLine) =>
    open("receive", `Receive ${l.sku} · ${l.name}`, {
      lineId: String(l.id),
      quantity: String((l.expected_milli - l.received_milli) / 1000),
      damaged: "0",
    });
  const actions: ReactNode = (
    <div className="flex gap-2">
      <Button
        variant="secondary"
        onClick={() => {
          void query.refetch();
        }}
      >
        <RefreshCw className="h-4 w-4" />
        Refresh
      </Button>
      {canEdit && path === "warehouses" && (
        <Button onClick={() => open("warehouse", "Create warehouse", { active: "1" })}>
          <Plus className="h-4 w-4" />
          Create warehouse
        </Button>
      )}
      {canEdit && path === "bins" && (
        <Button
          onClick={() =>
            open("bin", "Create bin", { type: "storage", active: "1", mixedSku: "1", blocked: "0" })
          }
        >
          Create bin
        </Button>
      )}
      {can("warehouse", "create") && ["inbounds", "receiving"].includes(path) && (
        <Button onClick={() => open("inbound", "Create inbound reference")}>
          Create inbound reference
        </Button>
      )}
      {canEdit && path === "transfers" && (
        <Button onClick={() => open("move", "Create internal transfer")}>Create transfer</Button>
      )}
    </div>
  );
  return (
    <div className="space-y-5">
      <PageHeader
        title={title}
        description="Warehouse Management System · Local transactional inventory"
        actions={actions}
      />
      {path === "counts" && canEdit && (
        <Button onClick={() => open("count", "Record physical bin count")}>
          Record cycle count
        </Button>
      )}
      {path === "receiving" && canEdit && (
        <Button
          variant="secondary"
          onClick={() => open("adopt", "Place an already-posted IMS / MMS receipt")}
        >
          Adopt posted receipt
        </Button>
      )}
      {path === "returns" && canEdit && (
        <Button onClick={() => open("return", "Receive shipment return")}>Receive return</Button>
      )}
      {path === "replenishment" && canEdit && (
        <Button onClick={() => open("replenishment", "Create replenishment rule", { active: "1" })}>
          Create replenishment rule
        </Button>
      )}
      {path === "docks" && canEdit && (
        <Button onClick={() => open("dock", "Create dock door", { active: "1" })}>
          Create dock door
        </Button>
      )}
      {path === "appointments" && canEdit && (
        <Button
          onClick={() =>
            open("appointment", "Schedule inbound appointment", { priority: "normal" })
          }
        >
          Schedule appointment
        </Button>
      )}
      {path === "tasks" && (
        <div className="flex gap-2">
          <Button variant={!myTasks ? "primary" : "secondary"} onClick={() => setMyTasks(false)}>
            All tasks
          </Button>
          <Button variant={myTasks ? "primary" : "secondary"} onClick={() => setMyTasks(true)}>
            My Tasks
          </Button>
        </div>
      )}
      {query.isPending ? (
        <TableSkeleton />
      ) : query.isError ? (
        <div className="card p-6" role="alert">
          <p className="text-danger">{errorMessage(query.error)}</p>
          <Button
            onClick={() => {
              void query.refetch();
            }}
          >
            Retry
          </Button>
        </div>
      ) : (
        data && (
          <>
            {path === "overview" && <Overview data={data} />}
            {path === "docks" && (
              <Table<Dock>
                rows={data.docks}
                rowKey={(r) => r.id}
                columns={[
                  { id: "code", header: "Dock code", cell: (r) => r.code },
                  { id: "name", header: "Name", cell: (r) => r.name },
                  {
                    id: "warehouse",
                    header: "Warehouse",
                    cell: (r) => warehouseName(r.warehouse_id),
                  },
                  {
                    id: "status",
                    header: "Status",
                    cell: (r) => (r.active ? "Active" : "Inactive"),
                  },
                  {
                    id: "actions",
                    header: "Actions",
                    cell: (r) =>
                      canEdit && (
                        <Button
                          variant="secondary"
                          onClick={() =>
                            open("dock", "Edit dock door", {
                              id: String(r.id),
                              warehouseId: String(r.warehouse_id),
                              code: r.code,
                              name: r.name,
                              active: String(r.active),
                            })
                          }
                        >
                          Edit
                        </Button>
                      ),
                  },
                ]}
              />
            )}
            {path === "appointments" && (
              <Table<Appointment>
                rows={data.appointments}
                rowKey={(r) => r.id}
                columns={[
                  { id: "code", header: "Appointment", cell: (r) => r.code },
                  { id: "name", header: "Inbound reference", cell: (r) => r.name },
                  {
                    id: "dock",
                    header: "Dock",
                    cell: (r) => data.docks.find((d) => d.id === r.dock_id)?.code,
                  },
                  {
                    id: "window",
                    header: "Arrival window",
                    cell: (r) =>
                      `${new Date(r.starts_at).toLocaleString()} – ${new Date(r.ends_at).toLocaleTimeString()}`,
                  },
                  {
                    id: "carrier",
                    header: "Carrier / vehicle",
                    cell: (r) => `${r.carrier} · ${r.vehicle}`,
                  },
                  { id: "priority", header: "Priority", cell: (r) => r.priority },
                  { id: "status", header: "Status", cell: (r) => r.status },
                  {
                    id: "late",
                    header: "Arrival",
                    cell: (r) =>
                      r.arrived_at
                        ? `${new Date(r.arrived_at).toLocaleTimeString()}${r.arrived_at > r.ends_at ? " · Late" : ""}`
                        : "Awaiting arrival",
                  },
                  {
                    id: "actions",
                    header: "Actions",
                    cell: (r) =>
                      canEdit && (
                        <div className="flex flex-wrap gap-2">
                          {["scheduled", "arrived", "unloading"].includes(r.status) && (
                            <Button
                              disabled={appointmentAction.isPending}
                              onClick={() =>
                                appointmentAction.mutate({
                                  id: r.id,
                                  revision: r.revision,
                                  status:
                                    r.status === "scheduled"
                                      ? "arrived"
                                      : r.status === "arrived"
                                        ? "unloading"
                                        : "completed",
                                  reason: "",
                                })
                              }
                            >
                              {r.status === "scheduled"
                                ? "Check in"
                                : r.status === "arrived"
                                  ? "Start unloading"
                                  : "Complete"}
                            </Button>
                          )}
                          {r.status === "scheduled" && (
                            <Button
                              variant="secondary"
                              onClick={() => {
                                const local = (s: string) => {
                                  const d = new Date(s);
                                  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
                                    .toISOString()
                                    .slice(0, 16);
                                };
                                open("appointment", "Edit scheduled appointment", {
                                  id: String(r.id),
                                  revision: String(r.revision),
                                  warehouseId: String(r.warehouse_id),
                                  dockId: String(r.dock_id),
                                  supplierId: r.supplier_id ? String(r.supplier_id) : "",
                                  code: r.code,
                                  name: r.name,
                                  startsAt: local(r.starts_at),
                                  endsAt: local(r.ends_at),
                                  carrier: r.carrier,
                                  vehicle: r.vehicle,
                                  priority: r.priority,
                                });
                              }}
                            >
                              Edit
                            </Button>
                          )}
                          {["scheduled", "arrived"].includes(r.status) && (
                            <Button
                              variant="secondary"
                              onClick={() =>
                                open("appointmentStatus", "Cancel appointment", {
                                  id: String(r.id),
                                  revision: String(r.revision),
                                  status: "cancelled",
                                })
                              }
                            >
                              Cancel
                            </Button>
                          )}
                        </div>
                      ),
                  },
                ]}
              />
            )}
            {path === "returns" && (
              <>
                <p className="text-sm text-ink-secondary">
                  Returned goods enter quarantine through IMS sales return posting. Inspection
                  releases approved units and retains rejected units as damaged. Refunds remain in
                  IMS.
                </p>
                <Table<WarehouseReturn>
                  rows={data.returns}
                  rowKey={(r) => r.id}
                  columns={[
                    { id: "id", header: "Return", cell: (r) => `RTN-${r.id}` },
                    { id: "sku", header: "SKU", cell: (r) => r.sku },
                    { id: "quantity", header: "Returned", cell: (r) => units(r.quantity_milli) },
                    {
                      id: "sellable",
                      header: "Approved sellable",
                      cell: (r) => units(r.sellable_milli),
                    },
                    { id: "condition", header: "Condition", cell: (r) => r.condition_note },
                    { id: "status", header: "Status", cell: (r) => r.status },
                    {
                      id: "actions",
                      header: "Actions",
                      cell: (r) =>
                        canEdit &&
                        r.status === "quarantine" && (
                          <Button
                            onClick={() =>
                              open("inspectReturn", "Inspect and release return", {
                                id: String(r.id),
                              })
                            }
                          >
                            Inspect return
                          </Button>
                        ),
                    },
                  ]}
                />
              </>
            )}
            {path === "replenishment" && (
              <Table<ReplenishmentRule>
                rows={data.replenishmentRules}
                rowKey={(r) => r.id}
                columns={[
                  { id: "sku", header: "SKU", cell: (r) => r.sku },
                  { id: "source", header: "Bulk source", cell: (r) => r.source },
                  { id: "destination", header: "Pick face", cell: (r) => r.destination },
                  { id: "minimum", header: "Minimum", cell: (r) => units(r.minimum_milli) },
                  { id: "target", header: "Target", cell: (r) => units(r.target_milli) },
                  {
                    id: "status",
                    header: "Status",
                    cell: (r) => (r.active ? "Active" : "Inactive"),
                  },
                  {
                    id: "actions",
                    header: "Actions",
                    cell: (r) =>
                      canEdit && (
                        <div className="flex gap-2">
                          <Button
                            disabled={replenish.isPending || !r.active}
                            onClick={() => replenish.mutate(r.id)}
                          >
                            Generate task
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={() =>
                              open("replenishment", "Edit replenishment rule", {
                                id: String(r.id),
                                productId: String(r.product_id),
                                sourceBinId: String(r.source_bin_id),
                                destinationBinId: String(r.destination_bin_id),
                                minimum: String(r.minimum_milli / 1000),
                                target: String(r.target_milli / 1000),
                                active: String(r.active),
                              })
                            }
                          >
                            Edit
                          </Button>
                        </div>
                      ),
                  },
                ]}
              />
            )}
            {path === "counts" && (
              <>
                <p className="text-sm text-ink-secondary">
                  Counts retain an immutable stock version and require review by a different
                  supervisor. Intervening stock movements block approval. IMS posts the approved
                  variance.
                </p>
                <Table<CycleCount>
                  rows={data.counts}
                  rowKey={(r) => r.id}
                  columns={[
                    { id: "id", header: "Count", cell: (r) => `CNT-${r.id}` },
                    { id: "bin", header: "Bin", cell: (r) => r.bin },
                    { id: "sku", header: "SKU", cell: (r) => r.sku },
                    { id: "expected", header: "Expected", cell: (r) => units(r.expected_milli) },
                    { id: "counted", header: "Counted", cell: (r) => units(r.counted_milli) },
                    {
                      id: "variance",
                      header: "Variance",
                      cell: (r) => units(r.counted_milli - r.expected_milli),
                    },
                    { id: "counter", header: "Counted by", cell: (r) => r.counted_by_name },
                    {
                      id: "status",
                      header: "Status",
                      cell: (r) => (r.superseded_by ? "superseded" : r.status),
                    },
                    {
                      id: "actions",
                      header: "Actions",
                      cell: (r) =>
                        canEdit &&
                        r.status === "review" &&
                        !r.superseded_by && (
                          <div className="flex gap-2">
                            <Button
                              disabled={approve.isPending}
                              onClick={() => approve.mutate(r.id)}
                            >
                              Approve variance
                            </Button>
                            <Button
                              variant="secondary"
                              onClick={() =>
                                open("count", "Record traceable recount", {
                                  recountOfId: String(r.id),
                                  binId: String(r.bin_id),
                                  productId: String(r.product_id),
                                })
                              }
                            >
                              Recount
                            </Button>
                          </div>
                        ),
                    },
                  ]}
                />
              </>
            )}
            {path === "warehouses" && (
              <Table
                rows={data.warehouses}
                rowKey={(r) => r.id}
                columns={[
                  textColumn<Warehouse>("code", "Code", (r) => r.code),
                  textColumn<Warehouse>("name", "Name", (r) => r.name),
                  textColumn<Warehouse>("site", "Branch / Site", (r) => r.site || "—"),
                  textColumn<Warehouse>("address", "Address", (r) => r.address || "—"),
                  textColumn<Warehouse>("status", "Status", (r) =>
                    r.active ? "Active" : "Inactive",
                  ),
                  textColumn<Warehouse>(
                    "actions",
                    "Actions",
                    (r) =>
                      canEdit && (
                        <Button
                          variant="secondary"
                          onClick={() =>
                            open("warehouse", "Edit warehouse", {
                              id: String(r.id),
                              code: r.code,
                              name: r.name,
                              site: r.site,
                              address: r.address,
                              active: String(r.active),
                            })
                          }
                        >
                          Edit
                        </Button>
                      ),
                  ),
                ]}
              />
            )}
            {path === "bins" && (
              <Table
                rows={data.bins}
                rowKey={(r) => r.id}
                columns={[
                  textColumn<Bin>("code", "Bin", (r) => r.code),
                  textColumn<Bin>("warehouse", "Warehouse", (r) => warehouseName(r.warehouse_id)),
                  textColumn<Bin>(
                    "hierarchy",
                    "Zone / Aisle / Rack / Level",
                    (r) => [r.zone, r.aisle, r.rack, r.shelf].filter(Boolean).join(" / ") || "—",
                  ),
                  textColumn<Bin>("type", "Type", (r) => r.type),
                  textColumn<Bin>("quantity_milli", "On-hand", (r) => units(r.quantity_milli)),
                  textColumn<Bin>("capacity", "Quantity capacity", (r) =>
                    r.capacity_milli === null ? "Unknown" : units(r.capacity_milli),
                  ),
                  textColumn<Bin>("status", "Status", (r) =>
                    !r.active ? "Inactive" : r.blocked ? "Blocked" : "Available",
                  ),
                  textColumn<Bin>(
                    "actions",
                    "Actions",
                    (r) =>
                      canEdit && (
                        <Button
                          variant="secondary"
                          onClick={() =>
                            open("bin", "Edit bin", {
                              id: String(r.id),
                              warehouseId: String(r.warehouse_id),
                              code: r.code,
                              zone: r.zone,
                              aisle: r.aisle,
                              rack: r.rack,
                              shelf: r.shelf,
                              type: r.type,
                              capacity:
                                r.capacity_milli === null ? "" : String(r.capacity_milli / 1000),
                              mixedSku: String(r.mixed_sku),
                              active: String(r.active),
                              blocked: String(r.blocked),
                            })
                          }
                        >
                          Edit
                        </Button>
                      ),
                  ),
                ]}
              />
            )}
            {["inbounds", "receiving"].includes(path) && (
              <Table
                rows={data.inbounds}
                rowKey={(r) => r.id}
                columns={[
                  textColumn<Inbound>("number", "Reference", (r) => r.number),
                  textColumn<Inbound>("reference", "Source", (r) => r.reference),
                  textColumn<Inbound>("warehouse", "Warehouse", (r) =>
                    warehouseName(r.warehouse_id),
                  ),
                  textColumn<Inbound>("status", "Status", (r) => r.status),
                  textColumn<Inbound>("lines", "Expected / received", (r) => (
                    <div className="space-y-2">
                      {r.lines.map((l) => (
                        <div key={l.id}>
                          {l.sku} · {units(l.expected_milli)} / {units(l.received_milli)}{" "}
                          {canEdit &&
                            ["arrived", "partiallyReceived"].includes(r.status) &&
                            l.received_milli < l.expected_milli && (
                              <Button variant="secondary" onClick={() => receiveOpen(l)}>
                                Receive {l.sku}
                              </Button>
                            )}
                        </div>
                      ))}
                    </div>
                  )),
                  textColumn<Inbound>(
                    "actions",
                    "Actions",
                    (r) =>
                      canEdit &&
                      r.status === "expected" && (
                        <Button disabled={arrive.isPending} onClick={() => arrive.mutate(r.id)}>
                          Mark arrived
                        </Button>
                      ),
                  ),
                ]}
              />
            )}
            {["putaway", "transfers", "tasks"].includes(path) && (
              <Table
                rows={data.tasks.filter(
                  (t) =>
                    (path === "putaway"
                      ? t.type === "putaway"
                      : path === "transfers"
                        ? t.type === "move"
                        : true) &&
                    (!myTasks || t.assigned_to === user?.id),
                )}
                rowKey={(r) => r.id}
                columns={[
                  textColumn<WarehouseTask>("id", "Task", (r) => `#${r.id}`),
                  textColumn<WarehouseTask>("type", "Type", (r) => r.type),
                  textColumn<WarehouseTask>("sku", "SKU", (r) => r.sku),
                  textColumn<WarehouseTask>("source", "Source", (r) => r.source),
                  textColumn<WarehouseTask>(
                    "destination",
                    "Suggested destination",
                    (r) => r.destination ?? "Select eligible bin",
                  ),
                  textColumn<WarehouseTask>(
                    "quantity",
                    "Planned / actual",
                    (r) => `${units(r.quantity_milli)} / ${units(r.actual_milli)}`,
                  ),
                  textColumn<WarehouseTask>(
                    "worker",
                    "Worker",
                    (r) =>
                      data.workers.find((w) => w.id === r.assigned_to)?.display_name ??
                      "Unassigned",
                  ),
                  textColumn<WarehouseTask>("status", "Status", (r) => r.status),
                  textColumn<WarehouseTask>(
                    "actions",
                    "Actions",
                    (r) =>
                      canEdit &&
                      !["completed", "cancelled"].includes(r.status) && (
                        <div className="flex flex-wrap gap-2">
                          <Button onClick={() => taskOpen(r)}>Scan & confirm</Button>
                          {["created", "assigned"].includes(r.status) && (
                            <>
                              <Button
                                variant="secondary"
                                disabled={start.isPending}
                                onClick={() => start.mutate(r.id)}
                              >
                                Start task
                              </Button>
                              <Button
                                variant="secondary"
                                onClick={() =>
                                  open("assignment", "Assign warehouse task", {
                                    id: String(r.id),
                                    workerId: r.assigned_to ? String(r.assigned_to) : "",
                                  })
                                }
                              >
                                Assign
                              </Button>
                            </>
                          )}
                        </div>
                      ),
                  ),
                ]}
              />
            )}
            {path === "stock-locator" && (
              <>
                <p className="text-sm text-ink-secondary">
                  Search SKU, product, exact bin, lot or stock status. Quantities are read from the
                  shared inventory ledger.
                </p>
                <Table
                  rows={data.positions}
                  rowKey={(r) =>
                    `${r.bin_id}:${r.product_id}:${r.stock_status}:${r.batch_no ?? ""}`
                  }
                  columns={[
                    textColumn<Position>("warehouse", "Warehouse", (r) => r.warehouse),
                    textColumn<Position>("bin", "Exact bin", (r) => r.bin),
                    textColumn<Position>("sku", "SKU", (r) => r.sku),
                    textColumn<Position>("name", "Product", (r) => r.name),
                    textColumn<Position>("stock_status", "Stock status", (r) => r.stock_status),
                    textColumn<Position>("batch_no", "Lot", (r) => r.batch_no ?? "—"),
                    textColumn<Position>("quantity_milli", "Physical on-hand", (r) =>
                      units(r.quantity_milli),
                    ),
                  ]}
                />
              </>
            )}
            {path === "reconciliation" && (
              <>
                <div className="card p-5">
                  <h2 className="font-semibold text-ink">Shared ledger reconciliation</h2>
                  <p className="mt-2 text-sm text-ink-secondary">
                    {data.reconciliation.length === 0
                      ? "Product totals agree with the shared stock ledger."
                      : `${data.reconciliation.length} product discrepancies require investigation.`}{" "}
                    {data.unassigned.length} stock positions have no warehouse/bin mapping.
                  </p>
                  <p className="mt-2 text-sm text-ink-secondary">
                    Mapping attaches an existing IMS location to warehouse hierarchy. It creates no
                    stock movement. Historical lot and status dimensions remain intact.
                  </p>
                </div>
                <Table
                  rows={data.unassigned}
                  rowKey={(r) => `${r.location_id}:${r.product_id}`}
                  columns={[
                    textColumn<WmsSnapshot["unassigned"][number]>(
                      "location_id",
                      "IMS location",
                      (r) => r.location_id ?? "Unspecified",
                    ),
                    textColumn<WmsSnapshot["unassigned"][number]>("sku", "SKU", (r) => r.sku),
                    textColumn<WmsSnapshot["unassigned"][number]>(
                      "quantity_milli",
                      "Unassigned quantity",
                      (r) => units(r.quantity_milli),
                    ),
                    textColumn<WmsSnapshot["unassigned"][number]>(
                      "actions",
                      "Action",
                      (r) =>
                        canEdit &&
                        r.location_id !== null && (
                          <Button
                            onClick={() =>
                              open("map", "Map existing IMS location", {
                                locationId: String(r.location_id),
                              })
                            }
                          >
                            Map location
                          </Button>
                        ),
                    ),
                  ]}
                />
                {data.reconciliation.length > 0 && (
                  <Table
                    rows={data.reconciliation}
                    rowKey={(r) => r.product_id}
                    columns={[
                      textColumn<WmsSnapshot["reconciliation"][number]>("sku", "SKU", (r) => r.sku),
                      textColumn<WmsSnapshot["reconciliation"][number]>(
                        "cached_milli",
                        "Product total",
                        (r) => units(r.cached_milli),
                      ),
                      textColumn<WmsSnapshot["reconciliation"][number]>(
                        "ledger_milli",
                        "Ledger total",
                        (r) => units(r.ledger_milli),
                      ),
                    ]}
                  />
                )}
              </>
            )}
            <p className="text-xs text-ink-secondary">
              Data cutoff: {new Date(data.generatedAt).toLocaleString()}
            </p>
          </>
        )
      )}
      <Dialog
        open={edit !== null}
        onOpenChange={(v) => {
          if (!v && !mutate.isPending) setEdit(null);
        }}
        title={edit?.title ?? "Warehouse operation"}
        busy={mutate.isPending}
      >
        <form
          className="space-y-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (mutate.isPending) return;
            setFormError("");
            mutate.mutate();
          }}
        >
          {edit?.kind === "warehouse" && (
            <>
              {field("code", "Warehouse code")}
              {field("name", "Name")}
              {field("site", "Branch / Site", undefined, false)}
              {field("address", "Address", undefined, false)}
              {field("active", "Active", yesNo)}
            </>
          )}
          {edit?.kind === "bin" && (
            <>
              {field("warehouseId", "Warehouse", warehouseOptions)}
              {field("code", "Unique bin code")}
              {field("zone", "Zone", undefined, false)}
              {field("aisle", "Aisle", undefined, false)}
              {field("rack", "Rack", undefined, false)}
              {field("shelf", "Shelf / Level", undefined, false)}
              {field(
                "type",
                "Bin type",
                [
                  "receiving",
                  "storage",
                  "pickFace",
                  "packing",
                  "dispatch",
                  "quarantine",
                  "returns",
                ].map((v) => ({ value: v, label: v })),
              )}
              {field("capacity", "Quantity capacity (blank = unknown)", undefined, false)}
              {field("mixedSku", "Allow mixed SKUs", yesNo)}
              {field("active", "Active", yesNo)}
              {field("blocked", "Blocked", yesNo)}
            </>
          )}
          {edit?.kind === "inbound" && (
            <>
              <p className="text-sm text-ink-secondary">
                This expected reference does not receive stock. Use a standalone reference only for
                goods that have not already been posted in IMS/MMS.
              </p>
              {field("warehouseId", "Warehouse", warehouseOptions)}
              {field("reference", "Inbound source reference")}
              {field("productId", "Product", productOptions)}
              {field("quantity", "Expected quantity")}
            </>
          )}
          {edit?.kind === "receive" && (
            <>
              <p className="text-sm text-ink-secondary">
                Post actual arrived quantity once. Damaged units go to quarantine and cannot be
                picked. Accepted units generate putaway work.
              </p>
              {field(
                "binId",
                "Receiving bin",
                bins((b) => b.type === "receiving"),
              )}
              {field("quantity", "Actual received quantity")}
              {field("damaged", "Damaged quantity", undefined, false)}
            </>
          )}
          {edit?.kind === "task" && (
            <>
              <p className="rounded-lg bg-surface-sunken p-3 text-sm">
                Scan source bin → scan SKU → scan destination → confirm actual quantity.
                Keyboard-wedge scanners and manual entry are supported. Press Tab between fields.
              </p>
              <p className="text-sm font-medium">
                Expected: {data?.tasks.find((t) => t.id === Number(edit.values["id"]))?.source} →{" "}
                {data?.tasks.find((t) => t.id === Number(edit.values["id"]))?.destination ??
                  "Choose eligible bin"}{" "}
                · SKU {data?.tasks.find((t) => t.id === Number(edit.values["id"]))?.sku}
              </p>
              {field("destinationBinId", "Destination bin", bins())}
              {field("sourceScan", "Scan source bin")}
              {field("productScan", "Scan SKU / barcode")}
              {field("destinationScan", "Scan destination bin")}
              {field("quantity", "Actual quantity")}
            </>
          )}
          {edit?.kind === "move" && (
            <>
              {field("sourceBinId", "Source bin", bins())}
              {field("productId", "Product", productOptions)}
              {field("destinationBinId", "Destination bin", bins())}
              {field("quantity", "Move quantity")}
            </>
          )}
          {edit?.kind === "map" && (
            <>
              {field("warehouseId", "Warehouse", warehouseOptions)}
              {field("code", "Unique bin code")}
            </>
          )}
          {edit?.kind === "count" && (
            <>
              {field(
                "binId",
                "Bin",
                bins((b) => ["storage", "pickFace"].includes(b.type)),
              )}
              {field("productId", "Product", productOptions)}
              {field("binScan", "Scan bin")}
              {field("productScan", "Scan SKU / barcode")}
              {field("quantity", "Counted quantity")}
              {field("reason", "Variance / count notes")}
            </>
          )}
          {edit?.kind === "adopt" && (
            <>
              <p className="text-sm text-ink-secondary">
                Select a receipt already posted by IMS or MMS. This command moves its existing
                quantity to receiving and creates putaway work. Company on-hand stays unchanged.
              </p>
              {field(
                "movementId",
                "Posted receipt movement",
                data?.adoptableReceipts.map((r) => ({
                  value: String(r.id),
                  label: `#${r.id} · ${r.source_kind} ${r.source_id ?? ""} · ${r.sku} · ${units(r.quantity_milli)}`,
                })) ?? [],
              )}
              {field(
                "receivingBinId",
                "Receiving bin",
                bins((b) => b.type === "receiving"),
              )}
            </>
          )}
          {edit?.kind === "return" && (
            <>
              {field(
                "lineId",
                "Original shipped line",
                data?.dispatches
                  .filter((d) => d.status === "handedOver")
                  .flatMap((d) =>
                    d.lines.map((l) => ({
                      value: String(l.id),
                      label: `${d.number} · ${l.sku} · ${units(l.quantity_milli)}`,
                    })),
                  ) ?? [],
              )}
              {field(
                "binId",
                "Returns / quarantine bin",
                bins((b) => ["returns", "quarantine"].includes(b.type)),
              )}
              {field("productScan", "Scan SKU / barcode")}
              {field("quantity", "Returned quantity")}
              {field("condition", "Returned condition")}
            </>
          )}
          {edit?.kind === "inspectReturn" && (
            <>
              {field("quantity", "Approved sellable quantity")}
              {field(
                "destinationBinId",
                "Sellable destination",
                bins((b) => ["storage", "pickFace"].includes(b.type)),
              )}
              {field("reason", "Inspection reason")}
            </>
          )}
          {edit?.kind === "replenishment" && (
            <>
              {field("productId", "Product", productOptions)}
              {field(
                "sourceBinId",
                "Bulk source bin",
                bins((b) => b.type === "storage"),
              )}
              {field(
                "destinationBinId",
                "Pick face bin",
                bins((b) => b.type === "pickFace"),
              )}
              {field("minimum", "Minimum quantity")}
              {field("target", "Target quantity")}
              {field("active", "Active", yesNo)}
            </>
          )}
          {edit?.kind === "dock" && (
            <>
              {field("warehouseId", "Warehouse", warehouseOptions)}
              {field("code", "Dock code")}
              {field("name", "Dock name")}
              {field("active", "Active", yesNo)}
            </>
          )}
          {edit?.kind === "appointment" && (
            <>
              {field("warehouseId", "Warehouse", warehouseOptions)}
              {field(
                "dockId",
                "Dock door",
                data?.docks
                  .filter((d) => d.active && d.warehouse_id === Number(edit.values["warehouseId"]))
                  .map((d) => ({ value: String(d.id), label: d.code })) ?? [],
              )}
              {field(
                "supplierId",
                "Supplier",
                data?.suppliers.map((s) => ({ value: String(s.id), label: s.name })) ?? [],
                false,
              )}
              {field("code", "Appointment code")}
              {field("name", "Inbound / ASN reference")}
              {field("startsAt", "Arrival window start", undefined, true, "datetime-local")}
              {field("endsAt", "Arrival window end", undefined, true, "datetime-local")}
              {field("carrier", "Carrier", undefined, false)}
              {field("vehicle", "Vehicle reference", undefined, false)}
              {field(
                "priority",
                "Priority",
                ["normal", "high", "urgent"].map((v) => ({ value: v, label: v })),
              )}
            </>
          )}
          {edit?.kind === "appointmentStatus" && field("reason", "Cancellation reason")}
          {edit?.kind === "assignment" &&
            field(
              "workerId",
              "Worker",
              data?.workers.map((w) => ({ value: String(w.id), label: w.display_name })) ?? [],
            )}
          {formError && (
            <p role="alert" className="text-sm text-danger">
              {formError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={mutate.isPending}
              onClick={() => setEdit(null)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={mutate.isPending}>
              {mutate.isPending
                ? "Saving…"
                : edit?.kind === "task"
                  ? "Confirm movement"
                  : edit?.kind === "receive"
                    ? "Post receipt"
                    : "Save"}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

function Overview({ data }: { data: WmsSnapshot }) {
  const open = data.tasks.filter((t) => t.status !== "completed" && t.status !== "cancelled");
  const sum = data.positions.reduce((s, p) => s + p.quantity_milli, 0);
  const known = data.bins.filter((b) => b.capacity_milli !== null);
  const capacity = known.reduce((s, b) => s + (b.capacity_milli ?? 0), 0);
  const usage = known.reduce((s, b) => s + b.quantity_milli, 0);
  const metrics: [string, string][] = [
    ["Total Warehouses", String(data.warehouses.length)],
    ["Total Active Bins", String(data.bins.filter((b) => b.active).length)],
    ["Total Warehouse Stock", units(sum)],
    [
      "Capacity Utilization",
      capacity ? `${Math.round((usage / capacity) * 100)}% (known bins)` : "Unknown capacity",
    ],
    [
      "Pending Inbound Receipts",
      String(data.inbounds.filter((d) => !["received", "cancelled"].includes(d.status)).length),
    ],
    ["Pending Putaway Tasks", String(open.filter((t) => t.type === "putaway").length)],
    [
      "Held / Damaged Quantity",
      units(
        data.positions
          .filter((p) => ["damaged", "quarantine"].includes(p.stock_status))
          .reduce((s, p) => s + p.quantity_milli, 0),
      ),
    ],
    ["Unassigned Stock Positions", String(data.unassigned.length)],
    ["Open Picking Tasks", String(open.filter((t) => t.type === "pick").length)],
    [
      "Shipments Awaiting Dispatch",
      String(
        data.dispatches.filter((d) => ["packed", "staged", "loaded"].includes(d.status)).length,
      ),
    ],
  ];
  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map(([label, value]) => (
          <StatCard
            key={label}
            label={label}
            value={value}
            icon={<WarehouseIcon className="h-5 w-5" />}
          />
        ))}
      </div>
      {data.warehouses.length === 0 && (
        <div className="card p-8 text-center">
          <WarehouseIcon className="mx-auto mb-3 h-10 w-10 text-ink-secondary" />
          <h2 className="text-lg font-semibold">Set up your first warehouse</h2>
          <p className="my-3 text-sm text-ink-secondary">
            Create receiving, quarantine and storage bins, then map existing IMS stock or receive a
            new inbound reference.
          </p>
          <Link className="text-brand underline" to="/wms/warehouses">
            Open warehouse setup
          </Link>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card p-5">
          <h2 className="font-semibold">Putaway queue</h2>
          {open
            .filter((t) => t.type === "putaway")
            .slice(0, 6)
            .map((t) => (
              <p className="mt-3 text-sm" key={t.id}>
                #{t.id} · {t.sku} · {units(t.quantity_milli)} · {t.source} →{" "}
                {t.destination ?? "Choose bin"}
              </p>
            ))}
          {!open.some((t) => t.type === "putaway") && (
            <p className="mt-3 text-sm text-ink-secondary">No pending putaway work.</p>
          )}
          <Link className="mt-4 inline-block text-sm text-brand underline" to="/wms/putaway">
            Open putaway workstation
          </Link>
        </div>
        <div className="card p-5">
          <h2 className="font-semibold">Stock exceptions</h2>
          <p className="mt-3 text-sm">{data.reconciliation.length} shared-ledger discrepancies</p>
          <p className="mt-3 text-sm">{data.unassigned.length} unmapped stock positions</p>
          <Link className="mt-4 inline-block text-sm text-brand underline" to="/wms/reconciliation">
            Review reconciliation
          </Link>
        </div>
      </div>
    </>
  );
}
