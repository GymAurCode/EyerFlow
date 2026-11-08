/**
 * Rework Management page.
 *
 * Real rework orders linked to manufacturing orders: quantity sent back
 * through production, reason, extra material/labor cost and status.
 * Saving persists through `mms.rework.save`.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Radio, Pencil } from "lucide-react";
import { call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { MmsTable as DataTable } from "./MmsTable";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { PageHeader, EmptyState, TableSkeleton } from "../../components/ui/Feedback";
import { StatCard } from "../../components/ui/StatCard";
import type { ReworkDto } from "../../../shared/types";

const inputClass =
  "w-full rounded-lg border border-[var(--line)] bg-[var(--input-bg)] px-3 py-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-[var(--brand)]";

const statusTone: Record<string, string> = {
  requested: "bg-[var(--surface-3)] text-ink-secondary",
  approved: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  inProgress: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  completed: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  cancelled: "bg-[var(--surface-3)] text-ink-secondary",
};

export function ReworkPage(): React.JSX.Element {
  const { can } = useApp();
  const [openCreate, setOpenCreate] = useState(false);
  const [record, setRecord] = useState<ReworkDto | null>(null);

  const query = useQuery({
    queryKey: ["mms-rework"],
    queryFn: () => call("mms.rework.list", {}),
    enabled: can("manufacturing", "view"),
  });

  const records = query.data ?? [];
  const totalQty = records.reduce((sum, r) => sum + r.quantityMilli, 0);

  const openNew = (): void => {
    setRecord(null);
    setOpenCreate(true);
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Rework Management"
        description="Output sent back for rework, and where each item has reached."
        actions={
          <Button
            variant="primary"
            disabled={!can("manufacturing", "edit")}
            iconLeft={<Radio className="h-4 w-4" />}
            onClick={openNew}
          >
            New Rework Request
          </Button>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatCard label="Rework units" value={String(Math.round(totalQty / 1000))} tone="warning" hint="Requested to complete" />
        <StatCard label="Records" value={String(records.length)} tone="neutral" hint="Rework orders raised" />
        <StatCard
          label="Open"
          value={String(records.filter((r) => r.status !== "completed" && r.status !== "cancelled").length)}
          tone="warning"
          hint="Still awaiting completion"
        />
      </div>

      {query.isLoading ? (
        <TableSkeleton columns={7} />
      ) : (
        <DataTable
        loading={query.isLoading} error={query.error} onRetry={() => void query.refetch()}
          frameless
          columns={[
            { id: "moNumber", header: "MO", cell: (row: ReworkDto) => row.moNumber },
            { id: "outputProductName", header: "Output", cell: (row: ReworkDto) => `${row.outputProductSku} — ${row.outputProductName}` },
            {
              id: "quantityMilli",
              header: "Qty",
              align: "end" as const,
              cell: (row: ReworkDto) => String(Math.round(row.quantityMilli / 1000)),
              sortValue: (r: ReworkDto) => r.quantityMilli,
            },
            {
              id: "status",
              header: "Status",
              cell: (row: ReworkDto) => (
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                    statusTone[row.status] ?? "bg-[var(--surface-3)]"
                  }`}
                >
                  {row.status}
                </span>
              ),
            },
            { id: "reason", header: "Reason", cell: (row: ReworkDto) => row.reason ?? "—" },
            { id: "createdAt", header: "Raised", cell: (row: ReworkDto) => row.createdAt?.slice(0, 16) ?? "—" },
            {
              id: "actions",
              header: "",
              cell: (row: ReworkDto) => (
                <Button variant="ghost" size="sm" title="Record again" onClick={() => {
                  setRecord(row);
                  setOpenCreate(true);
                }}>
                  <Pencil className="h-4 w-4" />
                </Button>
              ),
            },
          ]}
          rows={records}
          rowKey={(row) => row.id}
          emptyState={
            <EmptyState
              title="No rework recorded yet"
              description="Rework orders appear here when production output is sent back through a manufacturing order."
              actionLabel={can("manufacturing", "edit") ? "New Rework Request" : undefined}
              onAction={can("manufacturing", "edit") ? openNew : undefined}
              icon={<Radio className="h-5 w-5" />}
            />
          }
        />
      )}
      {openCreate && (
        <ReworkDialog record={record} onClose={() => setOpenCreate(false)} />
      )}
    </div>
  );
}

function ReworkDialog({
  record,
  onClose,
}: {
  readonly record: ReworkDto | null;
  readonly onClose: () => void;
}): React.JSX.Element {
  const client = useQueryClient();
  const [moId, setMoId] = useState(record?.moId ?? null);
  const [workOrderId, setWorkOrderId] = useState<number | null>(record?.workOrderId ?? null);
  const [outputProductId, setOutputProductId] = useState(record?.outputProductId ?? null);
  const [quantity, setQuantity] = useState(record ? String(record.quantityMilli / 1000) : "");
  const [reason, setReason] = useState(record?.reason ?? "");
  const [status, setStatus] = useState(record?.status ?? "requested");
  const [extraMaterial, setExtraMaterial] = useState(
    String(record?.extraMaterialCostFils ?? 0 / 100),
  );
  const [extraLabor, setExtraLabor] = useState(
    String(record?.extraLaborCostFils ?? 0 / 100),
  );
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    if (moId === null) {
      toast.error("Select a manufacturing order.");
      return;
    }
    if (outputProductId === null) {
      toast.error("Choose the output product being reworked.");
      return;
    }
    const quantityMilli = Math.round(Number(quantity) * 1000 || 0);
    if (!Number.isFinite(quantityMilli) || quantityMilli <= 0) {
      toast.error("Quantity must be greater than zero.");
      return;
    }

    setSaving(true);
    try {
      await call("mms.rework.save", {
        ...(record !== null ? { id: record.id } : {}),
        moId,
        workOrderId,
        outputProductId,
        quantityMilli,
        reason: reason.trim() || null,
        status,
        extraMaterialCostFils: Math.round(Number(extraMaterial || 0) * 100),
        extraLaborCostFils: Math.round(Number(extraLabor || 0) * 100),
      });
      toast.success(record !== null ? "Rework order updated." : "Rework order created.");
      void client.invalidateQueries({ queryKey: ["mms-rework"] });
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
      title={record !== null ? "Edit Rework Order" : "New Rework Request"}
      description="Send output back through production with reason and extra cost."
    >
      <div className="space-y-3">
        <label className="block space-y-1 text-sm">
          <span className="text-ink">Manufacturing order</span>
          <input
            className={inputClass}
            type="number"
            min="1"
            step="1"
            value={moId ?? ""}
            autoFocus
            onChange={(event) => {
              const value = Number(event.target.value);
              setMoId(Number.isFinite(value) ? value : null);
            }}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Work order (optional)</span>
            <input
              className={inputClass}
              type="number"
              min="1"
              step="1"
              value={workOrderId ?? ""}
              onChange={(event) => {
                const value = Number(event.target.value);
                setWorkOrderId(Number.isFinite(value) ? value : null);
              }}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Output product</span>
            <input
              className={inputClass}
              type="number"
              min="1"
              step="1"
              value={outputProductId ?? ""}
              onChange={(event) => {
                const value = Number(event.target.value);
                setOutputProductId(Number.isFinite(value) ? value : null);
              }}
            />
          </label>
        </div>
        <label className="block space-y-1 text-sm">
          <span className="text-ink">Quantity</span>
          <input
            className={inputClass}
            type="number"
            min="0.001"
            step="any"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-ink">Reason</span>
          <input
            className={inputClass}
            placeholder="e.g. Dimensions out of tolerance"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <div className="grid grid-cols-3 gap-3">
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Status</span>
            <select
              className={inputClass}
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="requested">Requested</option>
              <option value="approved">Approved</option>
              <option value="inProgress">In progress</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Extra material (Rs)</span>
            <input
              className={inputClass}
              type="number"
              min="0"
              step="any"
              value={extraMaterial}
              onChange={(event) => setExtraMaterial(event.target.value)}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Extra labor (Rs)</span>
            <input
              className={inputClass}
              type="number"
              min="0"
              step="any"
              value={extraLabor}
              onChange={(event) => setExtraLabor(event.target.value)}
            />
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : record !== null ? "Update" : "Create Request"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
