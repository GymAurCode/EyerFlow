/**
 * Work Centers page.
 *
 * Lists factory work centers with capacity, cost rate, maintenance status and
 * availability. Creating and editing are wired to `mms.workCenters.save`, which
 * both creates (code, name required) and updates (any field supplied).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Plus, Pencil, PowerOff, Factory } from "lucide-react";
import { call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { MmsTable as DataTable } from "./MmsTable";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { PageHeader, EmptyState, TableSkeleton } from "../../components/ui/Feedback";
import type { WorkCenterDto } from "../../../shared/types";

const inputClass =
  "w-full rounded-lg border border-[var(--line)] bg-[var(--input-bg)] px-3 py-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-[var(--brand)]";

const maintenanceTone: Record<string, string> = {
  operational: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  underMaintenance: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  down: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
};

const maintenanceLabel: Record<string, string> = {
  operational: "Operational",
  underMaintenance: "Under Maintenance",
  down: "Down",
};

const typeLabel: Record<string, string> = {
  assembly: "Assembly",
  machining: "Machining",
  packaging: "Packaging",
  quality: "Quality",
  tooling: "Tooling",
  external: "External",
};

export function WorkCentersPage(): React.JSX.Element {
  const { can } = useApp();
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<WorkCenterDto | null>(null);

  const query = useQuery({
    queryKey: ["mms-work-centers", search],
    queryFn: () =>
      call(
        "mms.workCenters.list",
        search.trim() === "" ? {} : { search: search.trim() },
      ),
    enabled: can("manufacturing", "view"),
  });

  const centers = query.data ?? [];

  const setActive = useMutation({
    mutationFn: ({ id, isActive, name, code }: { readonly id: number; readonly isActive: boolean; readonly name: string; readonly code: string }) =>
      call("mms.workCenters.save", { id, code, name, isActive }),
    onSuccess: (saved: WorkCenterDto) => {
      toast.success(
        saved.isActive ? "Work center activated." : "Work center deactivated.",
      );
      void client.invalidateQueries({ queryKey: ["mms-work-centers"] });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const openCreate = (): void => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (center: WorkCenterDto): void => {
    setEditing(center);
    setDialogOpen(true);
  };

  const columns = [
    { id: "code", header: "Code", cell: (row: WorkCenterDto) => row.code, sortValue: (r: WorkCenterDto) => r.code },
    { id: "name", header: "Name", cell: (row: WorkCenterDto) => row.name },
    { id: "plant", header: "Plant", cell: (row: WorkCenterDto) => row.plant ?? "—" },
    { id: "type", header: "Type", cell: (row: WorkCenterDto) => typeLabel[row.type] ?? row.type },
    {
      id: "capacity",
      header: "Capacity",
      align: "end" as const,
      cell: (row: WorkCenterDto) => `${row.capacity} ${row.capacityUnit}`,
      sortValue: (r: WorkCenterDto) => r.capacity,
    },
    {
      id: "hourlyOperatingCostFils",
      header: "Cost/Hr",
      align: "end" as const,
      cell: (row: WorkCenterDto) => `Rs ${(row.hourlyOperatingCostFils / 100).toLocaleString()}`,
      sortValue: (r: WorkCenterDto) => r.hourlyOperatingCostFils,
    },
    {
      id: "availabilityPct",
      header: "Availability",
      align: "end" as const,
      cell: (row: WorkCenterDto) => `${Math.round(row.availabilityPct)}%`,
    },
    {
      id: "maintenanceStatus",
      header: "Status",
      cell: (row: WorkCenterDto) => (
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
            maintenanceTone[row.maintenanceStatus] ?? "bg-[var(--surface-3)]"
          }`}
        >
          {maintenanceLabel[row.maintenanceStatus] ?? row.maintenanceStatus}
        </span>
      ),
    },
    {
      id: "isActive",
      header: "Active",
      cell: (row: WorkCenterDto) =>
        row.isActive ? (
          <span className="text-emerald-600 dark:text-emerald-400">Yes</span>
        ) : (
          <span className="text-[var(--text-3)]">No</span>
        ),
    },
    {
      id: "actions",
      header: "",
      cell: (row: WorkCenterDto) =>
        can("manufacturing", "edit") ? (
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" title="Edit work center" onClick={() => openEdit(row)}>
              <Pencil className="h-4 w-4" />
            </Button>
            {row.isActive && (
              <Button
                variant="ghost"
                size="sm"
                title="Deactivate work center"
                disabled={setActive.isPending}
                onClick={() =>
                  setActive.mutate({ id: row.id, isActive: false, name: row.name, code: row.code })
                }
              >
                <PowerOff className="h-4 w-4" />
              </Button>
            )}
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Work Centers"
        description="Production resources: capacity, cost rate, maintenance status."
        actions={
          <Button
            variant="primary"
            disabled={!can("manufacturing", "create")}
            iconLeft={<Plus className="h-4 w-4" />}
            onClick={openCreate}
          >
            New Work Center
          </Button>
        }
      />

      <div className="relative max-w-sm">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-secondary"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.35-4.35" strokeLinecap="round" />
        </svg>
        <input
          className={`${inputClass} pl-9`}
          placeholder="Search work centers…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      {query.isLoading ? (
        <TableSkeleton columns={7} />
      ) : (
        <DataTable
        loading={query.isLoading} error={query.error} onRetry={() => void query.refetch()}
          frameless
          columns={columns}
          rows={centers}
          rowKey={(row) => row.id}
          emptyState={
            <EmptyState
              title="No work centers defined"
              description="Register the production resources and their hourly cost before routing operations against them."
              actionLabel={can("manufacturing", "create") ? "New Work Center" : undefined}
              onAction={can("manufacturing", "create") ? openCreate : undefined}
              icon={<Factory className="h-5 w-5" />}
            />
          }
        />
      )}

      {dialogOpen && (
        <WorkCenterDialog
          center={editing}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </div>
  );
}

function WorkCenterDialog({
  center,
  onClose,
}: {
  readonly center: WorkCenterDto | null;
  readonly onClose: () => void;
}): React.JSX.Element {
  const client = useQueryClient();
  const [code, setCode] = useState(center?.code ?? "");
  const [name, setName] = useState(center?.name ?? "");
  const [plant, setPlant] = useState(center?.plant ?? "");
  const [type, setType] = useState(center?.type ?? "assembly");
  const [capacity, setCapacity] = useState(String(center?.capacity ?? 1));
  const [capacityUnit, setCapacityUnit] = useState(center?.capacityUnit ?? "units_per_hour");
  const [costPerHour, setCostPerHour] = useState(
    String(center ? center.hourlyOperatingCostFils / 100 : 0),
  );
  const [operatingSchedule, setOperatingSchedule] = useState(center?.operatingSchedule ?? "");
  const [availability, setAvailability] = useState(String(center?.availabilityPct ?? 100));
  const [maintenanceStatus, setMaintenanceStatus] = useState(
    center?.maintenanceStatus ?? "operational",
  );
  const [isActive, setIsActive] = useState(center?.isActive ?? true);
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    if (code.trim().length === 0 || name.trim().length === 0) {
      toast.error("Give the work center a code and a name.");
      return;
    }
    const capacityValue = Number(capacity);
    if (!Number.isFinite(capacityValue) || capacityValue <= 0) {
      toast.error("Capacity must be greater than zero.");
      return;
    }
    const cost = Math.round(Number(costPerHour) * 100 || 0);
    if (cost < 0) {
      toast.error("Cost per hour cannot be negative.");
      return;
    }
    const availabilityValue = Number(availability);
    if (!Number.isFinite(availabilityValue) || availabilityValue < 0 || availabilityValue > 100) {
      toast.error("Availability must be between 0 and 100 percent.");
      return;
    }

    setSaving(true);
    try {
      await call("mms.workCenters.save", {
        ...(center !== null ? { id: center.id } : {}),
        code: code.trim(),
        name: name.trim(),
        plant: plant.trim() || null,
        type,
        capacity: capacityValue,
        capacityUnit,
        hourlyOperatingCostFils: cost,
        operatingSchedule: operatingSchedule.trim() || null,
        availabilityPct: Math.round(availabilityValue),
        maintenanceStatus,
        isActive,
      });
      toast.success(center !== null ? "Work center updated." : "Work center created.");
      void client.invalidateQueries({ queryKey: ["mms-work-centers"] });
      onClose();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={center !== null ? "Edit Work Center" : "New Work Center"}
      description="Define a production resource with capacity, availability and hourly cost rate."
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Code</span>
            <input
              className={inputClass}
              value={code}
              autoFocus
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Name</span>
            <input
              className={inputClass}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Plant (optional)</span>
            <input
              className={inputClass}
              value={plant ?? ""}
              onChange={(event) => setPlant(event.target.value)}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Type</span>
            <select
              className={inputClass}
              value={type}
              onChange={(event) => setType(event.target.value)}
            >
              <option value="assembly">Assembly</option>
              <option value="machining">Machining</option>
              <option value="packaging">Packaging</option>
              <option value="quality">Quality</option>
              <option value="tooling">Tooling</option>
              <option value="external">External</option>
            </select>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Capacity</span>
            <input
              className={inputClass}
              type="number"
              min="0.001"
              step="any"
              value={capacity}
              onChange={(event) => setCapacity(event.target.value)}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Capacity unit</span>
            <select
              className={inputClass}
              value={capacityUnit}
              onChange={(event) => setCapacityUnit(event.target.value)}
            >
              <option value="units_per_hour">Units per hour</option>
              <option value="units_per_day">Units per day</option>
              <option value="kg_per_hour">Kg per hour</option>
              <option value="kg_per_day">Kg per day</option>
              <option value="litres_per_hour">Litres per hour</option>
              <option value="litres_per_day">Litres per day</option>
            </select>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Cost per hour (Rs)</span>
            <input
              className={inputClass}
              type="number"
              min="0"
              step="any"
              value={costPerHour}
              onChange={(event) => setCostPerHour(event.target.value)}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Availability (%)</span>
            <input
              className={inputClass}
              type="number"
              min="0"
              max="100"
              step="1"
              value={availability}
              onChange={(event) => setAvailability(event.target.value)}
            />
          </label>
        </div>

        <label className="block space-y-1 text-sm">
          <span className="text-ink">Shift / operating schedule (optional)</span>
          <input
            className={inputClass}
            placeholder="e.g. Mon–Fri 08:00–16:00"
            value={operatingSchedule ?? ""}
            onChange={(event) => setOperatingSchedule(event.target.value)}
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Maintenance status</span>
            <select
              className={inputClass}
              value={maintenanceStatus}
              onChange={(event) => setMaintenanceStatus(event.target.value)}
            >
              <option value="operational">Operational</option>
              <option value="underMaintenance">Under maintenance</option>
              <option value="down">Down</option>
            </select>
          </label>
          <label className="flex items-end gap-2 pb-1 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-[var(--line)]"
              checked={isActive}
              onChange={(event) => setIsActive(event.target.checked)}
            />
            <span className="text-ink">Active</span>
          </label>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : center !== null ? "Save changes" : "Create Work Center"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
