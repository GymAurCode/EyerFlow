/**
 * Work Orders list page.
 *
 * Every operation of every released order, with its own start/pause/complete
 * controls. Completing a work order is what records produced quantity; the
 * server rolls that up into the manufacturing order, which is what makes the
 * order receivable as finished stock.
 */

import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Play, Pause, CheckCircle2 } from "lucide-react";
import { useState } from "react";
import { call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { MmsTable as DataTable } from "./MmsTable";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import type { RpcMethod } from "../../../shared/ipc";

const inputClass =
  "w-full rounded-lg border border-[var(--line)] bg-[var(--input-bg)] px-3 py-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-[var(--brand)]";

interface CompletionTarget {
  readonly id: number;
  readonly operationName: string;
  readonly plannedUnits: number;
}

export function WorkOrderListPage(): React.JSX.Element {
  const { can } = useApp();
  const [target, setTarget] = useState<CompletionTarget | null>(null);

  const query = useQuery({
    queryKey: ["mms-work-orders"],
    queryFn: () => call("mms.workOrders.list", {}),
    enabled: can("manufacturing", "view"),
  });

  const orders = query.data ?? [];

  const act = (method: RpcMethod, id: number): void => {
    void call(method, { id })
      .then(() => query.refetch())
      .catch((error: unknown) => {
        toast.error(errorMessage(error));
      });
  };

  const columns = [
    { id: "moNumber", header: "MO", cell: (row: any) => row.moNumber },
    { id: "operationName", header: "Operation", cell: (row: any) => row.operationName },
    { id: "workCenterName", header: "Work Center", cell: (row: any) => row.workCenterName ?? "—" },
    { id: "operatorName", header: "Operator", cell: (row: any) => row.operatorName ?? "—" },
    {
      id: "plannedQty",
      header: "Planned",
      cell: (row: any) => `${Math.round(row.plannedQuantity / 1000)}`,
      align: "end",
    },
    {
      id: "actualQty",
      header: "Actual",
      cell: (row: any) => `${Math.round(row.actualQuantity / 1000)}`,
      align: "end",
    },
    { id: "status", header: "Status", cell: (row: any) => row.status },
    {
      id: "actions",
      header: "",
      cell: (row: any) => {
        const canEdit = can("manufacturing", "edit");
        return (
          <div className="flex gap-1">
            {row.status === "ready" && canEdit && (
              <Button
                variant="primary"
                size="sm"
                title="Start"
                onClick={() => act("mms.workOrders.start", row.id)}
              >
                <Play className="h-4 w-4" />
              </Button>
            )}
            {row.status === "inProgress" && canEdit && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  title="Pause"
                  onClick={() => act("mms.workOrders.pause", row.id)}
                >
                  <Pause className="h-4 w-4" />
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  title="Complete"
                  onClick={() =>
                    setTarget({
                      id: row.id,
                      operationName: row.operationName,
                      plannedUnits: row.plannedQuantity / 1000,
                    })
                  }
                >
                  <CheckCircle2 className="h-4 w-4" />
                </Button>
              </>
            )}
            {row.status === "paused" && canEdit && (
              <Button
                variant="primary"
                size="sm"
                title="Resume"
                onClick={() => act("mms.workOrders.resume", row.id)}
              >
                <Play className="h-4 w-4" />
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-ink">Work Orders / Job Cards</h1>
          <p className="text-sm text-ink-secondary">
            Shop floor operations with time tracking and material consumption.
          </p>
        </div>
      </div>

      <DataTable
        loading={query.isLoading} error={query.error} onRetry={() => void query.refetch()}
        frameless
        columns={columns as any}
        rows={orders}
        rowKey={(row) => row.id}
        emptyState="No work orders defined yet."
      />

      {target !== null && (
        <CompleteDialog
          target={target}
          onClose={() => setTarget(null)}
          onSaved={() => {
            setTarget(null);
            void query.refetch();
          }}
        />
      )}
    </div>
  );
}

function CompleteDialog({
  target,
  onClose,
  onSaved,
}: {
  readonly target: CompletionTarget;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): React.JSX.Element {
  const [actual, setActual] = useState(String(target.plannedUnits));
  const [accepted, setAccepted] = useState(String(target.plannedUnits));
  const [rejected, setRejected] = useState("0");
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    const actualQuantity = Math.round(Number(actual) * 1000);
    const acceptedQuantity = Math.round(Number(accepted) * 1000);
    const rejectedQuantity = Math.round(Number(rejected) * 1000);

    if (!Number.isFinite(actualQuantity) || actualQuantity <= 0) {
      toast.error("Actual quantity must be greater than zero.");
      return;
    }

    setSaving(true);
    try {
      await call("mms.workOrders.complete", {
        id: target.id,
        actualQuantity,
        acceptedQuantity: Number.isFinite(acceptedQuantity) ? acceptedQuantity : 0,
        rejectedQuantity: Number.isFinite(rejectedQuantity) ? rejectedQuantity : 0,
      });
      toast.success("Work order completed; the manufacturing order has been updated.");
      onSaved();
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
      title={`Complete ${target.operationName}`}
      description="Produced quantity rolls up into the manufacturing order."
    >
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Actual</span>
            <input
              className={inputClass}
              type="number"
              min="0.001"
              step="any"
              value={actual}
              onChange={(event) => {
                setActual(event.target.value);
              }}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Accepted</span>
            <input
              className={inputClass}
              type="number"
              min="0"
              step="any"
              value={accepted}
              onChange={(event) => {
                setAccepted(event.target.value);
              }}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Rejected</span>
            <input
              className={inputClass}
              type="number"
              min="0"
              step="any"
              value={rejected}
              onChange={(event) => {
                setRejected(event.target.value);
              }}
            />
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={saving}
            onClick={() => {
              void save();
            }}
          >
            {saving ? "Completing…" : "Complete"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
