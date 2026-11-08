/**
 * Machines & Equipment page.
 *
 * The machines attached to each work center, with their cost rate. Creating and
 * editing are wired to `mms.equipment.save`; the register was read-only in the
 * interface even though the backend transaction existed.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Plus, Pencil, Cog } from "lucide-react";
import { call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { MmsTable as DataTable } from "./MmsTable";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { PageHeader, EmptyState, TableSkeleton } from "../../components/ui/Feedback";
import type { EquipmentDto, WorkCenterDto } from "../../../shared/types";

const inputClass =
  "w-full rounded-lg border border-[var(--line)] bg-[var(--input-bg)] px-3 py-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-[var(--brand)]";

const statusTone: Record<string, string> = {
  active: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  idle: "bg-[var(--surface-3)] text-ink-secondary",
  underMaintenance: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  down: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
};

export function EquipmentPage(): React.JSX.Element {
  const { can } = useApp();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<EquipmentDto | null>(null);

  const query = useQuery({
    queryKey: ["mms-equipment"],
    queryFn: () => call("mms.equipment.list", {}),
    enabled: can("manufacturing", "view"),
  });

  const workCenters = useQuery({
    queryKey: ["mms-work-centers", true],
    queryFn: () => call("mms.workCenters.list", {}),
    enabled: can("manufacturing", "view"),
  });

  const machines = query.data ?? [];

  const openCreate = (): void => {
    setEditing(null);
    setDialogOpen(true);
  };

  const columns = [
    {
      id: "machineCode",
      header: "Code",
      cell: (row: EquipmentDto) => row.machineCode,
      sortValue: (r: EquipmentDto) => r.machineCode,
    },
    { id: "name", header: "Machine", cell: (row: EquipmentDto) => row.name },
    {
      id: "workCenterName",
      header: "Work Center",
      cell: (row: EquipmentDto) => row.workCenterName ?? "—",
    },
    {
      id: "status",
      header: "Status",
      cell: (row: EquipmentDto) => (
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
            statusTone[row.status] ?? "bg-[var(--surface-3)]"
          }`}
        >
          {row.status}
        </span>
      ),
    },
    {
      id: "capacity",
      header: "Capacity",
      align: "end" as const,
      cell: (row: EquipmentDto) => (row.capacity === null ? "—" : String(row.capacity)),
    },
    {
      id: "operatingRateFilsPerHour",
      header: "Cost / Hr",
      align: "end" as const,
      cell: (row: EquipmentDto) => `Rs ${(row.operatingRateFilsPerHour / 100).toLocaleString()}`,
      sortValue: (r: EquipmentDto) => r.operatingRateFilsPerHour,
    },
    {
      id: "actions",
      header: "",
      cell: (row: EquipmentDto) =>
        can("manufacturing", "edit") ? (
          <Button
            variant="ghost"
            size="sm"
            title="Edit machine"
            onClick={() => {
              setEditing(row);
              setDialogOpen(true);
            }}
          >
            <Pencil className="h-4 w-4" />
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Machines & Equipment"
        description="The machines attached to each work center, with their cost rate."
        actions={
          <Button
            variant="primary"
            disabled={!can("manufacturing", "create")}
            iconLeft={<Plus className="h-4 w-4" />}
            onClick={openCreate}
          >
            Add Machine
          </Button>
        }
      />

      {query.isLoading ? (
        <TableSkeleton columns={6} />
      ) : (
        <DataTable
        loading={query.isLoading} error={query.error} onRetry={() => void query.refetch()}
          frameless
          columns={columns}
          rows={machines}
          rowKey={(row) => row.id}
          emptyState={
            <EmptyState
              title="No machines registered"
              description="Machines document the real equipment inside each work center: its rate and its current state."
              actionLabel={can("manufacturing", "create") ? "Add Machine" : undefined}
              onAction={can("manufacturing", "create") ? openCreate : undefined}
              icon={<Cog className="h-5 w-5" />}
            />
          }
        />
      )}

      {dialogOpen && (
        <EquipmentDialog
          machine={editing}
          workCenters={workCenters.data ?? []}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </div>
  );
}

function EquipmentDialog({
  machine,
  workCenters,
  onClose,
}: {
  readonly machine: EquipmentDto | null;
  readonly workCenters: readonly WorkCenterDto[];
  readonly onClose: () => void;
}): React.JSX.Element {
  const client = useQueryClient();
  const [machineCode, setMachineCode] = useState(machine?.machineCode ?? "");
  const [name, setName] = useState(machine?.name ?? "");
  const [workCenterId, setWorkCenterId] = useState<number | null>(machine?.workCenterId ?? null);
  const [status, setStatus] = useState(machine?.status ?? "active");
  const [capacity, setCapacity] = useState(
    machine?.capacity === null || machine?.capacity === undefined ? "" : String(machine.capacity),
  );
  const [rate, setRate] = useState(
    String(machine ? machine.operatingRateFilsPerHour / 100 : 0),
  );
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    if (machineCode.trim().length === 0 || name.trim().length === 0) {
      toast.error("Give the machine a code and a name.");
      return;
    }
    const capacityValue = capacity.trim() === "" ? null : Number(capacity);
    if (capacityValue !== null && (!Number.isFinite(capacityValue) || capacityValue < 0)) {
      toast.error("Capacity must be zero or greater.");
      return;
    }
    const rateFils = Math.round(Number(rate) * 100 || 0);
    if (rateFils < 0) {
      toast.error("Cost per hour cannot be negative.");
      return;
    }
    setSaving(true);
    try {
      await call("mms.equipment.save", {
        ...(machine !== null ? { id: machine.id } : {}),
        machineCode: machineCode.trim(),
        name: name.trim(),
        workCenterId,
        status,
        capacity: capacityValue,
        operatingRateFilsPerHour: rateFils,
      });
      toast.success(machine !== null ? "Machine updated." : "Machine registered.");
      void client.invalidateQueries({ queryKey: ["mms-equipment"] });
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
      title={machine !== null ? "Edit Machine" : "Add Machine"}
      description="Register a machine against a work center with its operating rate."
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Machine code</span>
            <input
              className={inputClass}
              value={machineCode}
              autoFocus
              onChange={(event) => setMachineCode(event.target.value)}
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
            <span className="text-ink">Work center</span>
            <select
              className={inputClass}
              value={workCenterId ?? ""}
              onChange={(event) => {
                const value = Number(event.target.value);
                setWorkCenterId(Number.isNaN(value) || value === 0 ? null : value);
              }}
            >
              <option value="">Unassigned</option>
              {workCenters.map((workCenter) => (
                <option key={workCenter.id} value={workCenter.id}>
                  {workCenter.code} — {workCenter.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Status</span>
            <select
              className={inputClass}
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="active">Active</option>
              <option value="idle">Idle</option>
              <option value="underMaintenance">Under maintenance</option>
              <option value="down">Down</option>
            </select>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Capacity (optional)</span>
            <input
              className={inputClass}
              type="number"
              min="0"
              step="any"
              value={capacity}
              onChange={(event) => setCapacity(event.target.value)}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Cost per hour (Rs)</span>
            <input
              className={inputClass}
              type="number"
              min="0"
              step="any"
              value={rate}
              onChange={(event) => setRate(event.target.value)}
            />
          </label>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : machine !== null ? "Save changes" : "Add Machine"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
