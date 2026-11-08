/**
 * Quality Control page.
 *
 * Inspections recorded against manufacturing orders: checkpoint, type,
 * measured value vs tolerance, pass/fail, inspector and evidence. Saving a
 * check persists through `mms.qualityChecks.save` and, on failure, moves the
 * MO into quality review so the finished-goods receipt gate can see it.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Pencil } from "lucide-react";
import { call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { MmsTable as DataTable } from "./MmsTable";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { PageHeader, EmptyState, TableSkeleton } from "../../components/ui/Feedback";
import type { QualityCheckDto } from "../../../shared/types";

const inputClass =
  "w-full rounded-lg border border-[var(--line)] bg-[var(--input-bg)] px-3 py-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-[var(--brand)]";

const resultTone: Record<string, string> = {
  pending: "bg-[var(--surface-3)] text-ink-secondary",
  passed: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  failed: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
  quarantined: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  reworkRequired: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  rejected: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
  released: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
};

type QualityPageTypeInspection =
  | "passFail" | "numerical" | "checklist" | "visual" | "evidence";
type QualityPageTypeResult =
  | "pending" | "passed" | "failed" | "quarantined" | "reworkRequired" | "rejected" | "released";

export function QualityPage(): React.JSX.Element {
  const { can } = useApp();
  const [openCreate, setOpenCreate] = useState(false);
  const [inspection, setInspection] = useState<QualityCheckDto | null>(null);

  const query = useQuery({
    queryKey: ["mms-quality-checks"],
    queryFn: () => call("mms.qualityChecks.list", {}),
    enabled: can("manufacturing", "view"),
  });

  const checks = query.data ?? [];

  const openNew = (): void => {
    setInspection(null);
    setOpenCreate(true);
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Quality Control"
        description="Inspection checkpoints and their results per manufacturing order."
        actions={
          <Button
            variant="primary"
            disabled={!can("manufacturing", "edit")}
            iconLeft={<AlertTriangle className="h-4 w-4" />}
            onClick={openNew}
          >
            Record Inspection
          </Button>
        }
      />

      {query.isLoading ? (
        <TableSkeleton columns={6} />
      ) : (
        <div className="space-y-4">
          <DataTable
        loading={query.isLoading} error={query.error} onRetry={() => void query.refetch()}
            frameless
            columns={[
              { id: "moNumber", header: "MO", cell: (row: QualityCheckDto) => row.moNumber },
              { id: "checkpoint", header: "Checkpoint", cell: (row: QualityCheckDto) => row.checkpoint },
              { id: "inspectionType", header: "Type", cell: (row: QualityCheckDto) => row.inspectionType },
              { id: "result", header: "Result", cell: (row: QualityCheckDto) => (
                <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${resultTone[row.result] ?? "bg-[var(--surface-3)]"}`}>
                  {row.result}
                </span>
              )},
              { id: "inspectorName", header: "Inspector", cell: (row: QualityCheckDto) => row.inspectorName ?? "—" },
              { id: "inspectedAt", header: "Inspected", cell: (row: QualityCheckDto) => row.inspectedAt?.slice(0, 16) ?? "—" },
              {
                id: "actions",
                header: "",
                cell: (row: QualityCheckDto) => (
                  <Button variant="ghost" size="sm" title="Inspect again" onClick={() => {
                    setInspection(row);
                    setOpenCreate(true);
                  }}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                ),
              },
            ]}
            rows={checks}
            rowKey={(row) => row.id}
            emptyState={
              <EmptyState
                title="No quality checks recorded yet"
                description="Inspections appear here when an inspection is recorded against a manufacturing order."
                actionLabel={can("manufacturing", "edit") ? "Record Inspection" : undefined}
                onAction={can("manufacturing", "edit") ? openNew : undefined}
                icon={<AlertTriangle className="h-5 w-5" />}
              />
            }
          />
          {openCreate && (
            <QualityDialog
              inspection={inspection}
              onClose={() => setOpenCreate(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function QualityDialog({
  inspection,
  onClose,
}: {
  readonly inspection: QualityCheckDto | null;
  readonly onClose: () => void;
}): React.JSX.Element {
  const client = useQueryClient();
  const [moId, setMoId] = useState(inspection?.moId ?? null);
  const [workOrderId, setWorkOrderId] = useState<number | null>(inspection?.workOrderId ?? null);
  const [checkpoint, setCheckpoint] = useState(inspection?.checkpoint ?? "");
  const [inspectionType, setInspectionType] = useState(inspection?.inspectionType ?? "passFail");
  const [result, setResult] = useState(inspection?.result ?? "pending");
  const [measuredValue, setMeasuredValue] = useState(inspection?.measuredValue ?? "");
  const [toleranceMin, setToleranceMin] = useState(inspection?.toleranceMin ?? "");
  const [toleranceMax, setToleranceMax] = useState(inspection?.toleranceMax ?? "");
  const [notes, setNotes] = useState(inspection?.notes ?? "");
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    if (moId === null) {
      toast.error("Select a manufacturing order.");
      return;
    }
    if (checkpoint.trim().length === 0) {
      toast.error("Give the checkpoint a name.");
      return;
    }
    setSaving(true);
    try {
      await call("mms.qualityChecks.save", {
        ...(inspection !== null ? { id: inspection.id } : {}),
        moId,
        workOrderId,
        checkpoint: checkpoint.trim(),
        inspectionType,
        result,
        measuredValue: measuredValue.trim() || null,
        toleranceMin: toleranceMin.trim() || null,
        toleranceMax: toleranceMax.trim() || null,
        notes: notes.trim() || null,
      });
      toast.success(
        inspection !== null ? "Inspection updated." : "Inspection recorded.",
      );
      void client.invalidateQueries({ queryKey: ["mms-quality-checks"] });
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
      title={inspection !== null ? "Inspect Again" : "Record Inspection"}
      description="Record a quality checkpoint against a manufacturing order. Failed output routes the MO into quality review."
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
          <span className="text-ink">Checkpoint</span>
          <input
            className={inputClass}
            placeholder="e.g. Final dimensions"
            value={checkpoint}
            onChange={(event) => setCheckpoint(event.target.value)}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Inspection type</span>
            <select
              className={inputClass}
              value={inspectionType}
              onChange={(event) => setInspectionType(event.target.value as QualityPageTypeInspection)}
            >
              <option value="passFail">Pass / Fail</option>
              <option value="numerical">Numerical</option>
              <option value="checklist">Checklist</option>
              <option value="visual">Visual</option>
              <option value="evidence">Evidence</option>
            </select>
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Result</span>
            <select
              className={inputClass}
              value={result}
              onChange={(event) => setResult(event.target.value as QualityPageTypeResult)}
            >
              <option value="pending">Pending</option>
              <option value="passed">Passed</option>
              <option value="failed">Failed</option>
              <option value="quarantined">Quarantined</option>
              <option value="reworkRequired">Rework required</option>
              <option value="rejected">Rejected</option>
              <option value="released">Released</option>
            </select>
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Measured value</span>
            <input
              className={inputClass}
              placeholder="e.g. 10.02 mm"
              value={measuredValue}
              onChange={(event) => setMeasuredValue(event.target.value)}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Tolerance min</span>
            <input
              className={inputClass}
              placeholder="e.g. 9.98"
              value={toleranceMin}
              onChange={(event) => setToleranceMin(event.target.value)}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Tolerance max</span>
            <input
              className={inputClass}
              placeholder="e.g. 10.05"
              value={toleranceMax}
              onChange={(event) => setToleranceMax(event.target.value)}
            />
          </label>
        </div>
        <label className="block space-y-1 text-sm">
          <span className="text-ink">Notes</span>
          <textarea
            className={inputClass}
            rows={2}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : inspection !== null ? "Update" : "Record"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
