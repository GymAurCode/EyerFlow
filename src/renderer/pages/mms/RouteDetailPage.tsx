/**
 * Route detail page.
 *
 * The routing document: its header, its ordered operations and the actions a
 * production planner needs — add/edit operations against work centers, set
 * times, mark a quality checkpoint and approve the route for use in
 * manufacturing orders.
 *
 * Every operation is persisted through `mms.routeOperations.save` and the
 * route header through `mms.routes.save`; a route cannot be approved while it
 * has no operations, mirroring the server-side release requirement.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate, Link } from "react-router-dom";
import { toast } from "sonner";
import { useState } from "react";
import { ArrowLeft, Plus, CheckCircle2, Pencil } from "lucide-react";
import { call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { MmsTable as DataTable } from "./MmsTable";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { PageHeader, EmptyState, TableSkeleton } from "../../components/ui/Feedback";
import { StatCard } from "../../components/ui/StatCard";
import { MMS_PATH } from "../../lib/ims-nav";
import type { RouteDto, RouteOperationDto, WorkCenterDto } from "../../../shared/types";

const inputClass =
  "w-full rounded-lg border border-[var(--line)] bg-[var(--input-bg)] px-3 py-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-[var(--brand)]";

export function RouteDetailPage(): React.JSX.Element {
  const { id } = useParams<{ readonly id: string }>();
  const routeId = Number(id);
  const { can } = useApp();
  const navigate = useNavigate();
  const client = useQueryClient();

  const [headerOpen, setHeaderOpen] = useState(false);
  const [operationDialog, setOperationDialog] = useState<
    { op: RouteOperationDto | null } | null
  >(null);

  const query = useQuery({
    queryKey: ["mms-route", routeId],
    queryFn: () => call("mms.routes.get", { id: routeId }),
    enabled: Number.isFinite(routeId) && routeId > 0 && can("manufacturing", "view"),
  });

  const workCenters = useQuery({
    queryKey: ["mms-work-centers", true],
    queryFn: () => call("mms.workCenters.list", { isActive: true }),
    enabled: can("manufacturing", "view"),
  });

  const route = query.data;

  const approve = async (): Promise<void> => {
    if (route === undefined) return;
    try {
      await call("mms.routes.save", { id: route.id, name: route.name, status: "approved" });
      toast.success("Route approved. Manufacturing orders can now use it.");
      void client.invalidateQueries({ queryKey: ["mms-route", routeId] });
      void client.invalidateQueries({ queryKey: ["mms-routes"] });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  if (query.isLoading) {
    return <div className="space-y-4"><TableSkeleton rows={8} /></div>;
  }

  if (query.isError || route === undefined) {
    return (
      <div className="glass card rounded-xl">
        <EmptyState
          title="Route not found"
          description="The routing may have been removed, or the address is out of date."
          actionLabel="Back to Routes"
          onAction={() => navigate(MMS_PATH.routes)}
        />
      </div>
    );
  }

  const editable = route.status === "draft" || route.status === "review";
  const totalCycle = route.operations.reduce((sum, op) => sum + op.cycleTimeMinutes, 0);
  const totalSetup = route.operations.reduce((sum, op) => sum + op.setupTimeMinutes, 0);

  const operationColumns = [
    { id: "sequence", header: "#", cell: (row: RouteOperationDto) => row.sequence, sortValue: (r: RouteOperationDto) => r.sequence },
    { id: "operationCode", header: "Code", cell: (row: RouteOperationDto) => row.operationCode },
    { id: "name", header: "Operation", cell: (row: RouteOperationDto) => row.name },
    {
      id: "workCenterName",
      header: "Work Center",
      cell: (row: RouteOperationDto) => row.workCenterName ?? "—",
    },
    { id: "setupTimeMinutes", header: "Setup (min)", align: "end" as const, cell: (row: RouteOperationDto) => String(row.setupTimeMinutes) },
    { id: "cycleTimeMinutes", header: "Cycle (min)", align: "end" as const, cell: (row: RouteOperationDto) => String(row.cycleTimeMinutes) },
    {
      id: "qualityCheckpoint",
      header: "QC",
      cell: (row: RouteOperationDto) =>
        row.qualityCheckpoint ? (
          <span className="inline-flex rounded-full bg-cyan-500/10 px-2 py-0.5 text-xs font-medium text-cyan-700 dark:text-cyan-300">
            checkpoint
          </span>
        ) : (
          "—"
        ),
    },
    {
      id: "prerequisiteName",
      header: "After",
      cell: (row: RouteOperationDto) => row.prerequisiteName ?? "—",
    },
    {
      id: "actions",
      header: "",
      cell: (row: RouteOperationDto) =>
        editable && can("manufacturing", "edit") ? (
          <Button
            variant="ghost"
            size="sm"
            title="Edit operation"
            onClick={() => setOperationDialog({ op: row })}
          >
            <Pencil className="h-4 w-4" />
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      <Link
        to={MMS_PATH.routes}
        className="inline-flex items-center gap-1 text-sm text-ink-secondary transition-colors hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Routes
      </Link>

      <PageHeader
        title={`${route.number} — ${route.name}`}
        description={
          route.description ?? `Routing effective from ${route.effectiveFrom?.slice(0, 10)}.`
        }
        actions={
          <>
            {editable && can("manufacturing", "edit") && (
              <>
                <Button
                  variant="ghost"
                  iconLeft={<Pencil className="h-4 w-4" />}
                  onClick={() => setHeaderOpen(true)}
                >
                  Edit Details
                </Button>
                <Button
                  variant="ghost"
                  iconLeft={<Plus className="h-4 w-4" />}
                  onClick={() => setOperationDialog({ op: null })}
                >
                  Add Operation
                </Button>
                <Button
                  variant="primary"
                  iconLeft={<CheckCircle2 className="h-4 w-4" />}
                  disabled={route.operations.length === 0}
                  title={
                    route.operations.length === 0
                      ? "Add at least one operation before approving"
                      : undefined
                  }
                  onClick={() => void approve()}
                >
                  Approve Route
                </Button>
              </>
            )}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Status"
          value={route.status}
          icon={<CheckCircle2 className="h-5 w-5" />}
          tone={
            route.status === "approved" ? "success" : editable ? "warning" : "neutral"
          }
          hint={editable ? "Routing header and operations can still be edited" : "Read-only"}
        />
        <StatCard label="Operations" value={String(route.operations.length)} tone="brand" hint="Sequenced production steps" />
        <StatCard label="Setup Time" value={`${String(totalSetup)} min`} tone="info" hint="All operations, one batch" />
        <StatCard label="Cycle Time" value={`${String(totalCycle)} min`} tone="info" hint="Sum across operations" />
      </div>

      <section className="space-y-2">
        <h2 className="text-[15px] font-semibold text-ink">Operations</h2>
        <DataTable
        loading={query.isLoading} error={query.error} onRetry={() => void query.refetch()}
          frameless
          columns={operationColumns}
          rows={route.operations}
          rowKey={(row) => row.id}
          emptyState={
            <EmptyState
              title="No operations yet"
              description="A manufacturing order released against a route without operations can record no work. Add the production steps in order."
              actionLabel={
                editable && can("manufacturing", "create") ? "Add Operation" : undefined
              }
              onAction={
                editable && can("manufacturing", "create")
                  ? () => setOperationDialog({ op: null })
                  : undefined
              }
            />
          }
        />
      </section>

      {headerOpen && (
        <RouteHeaderDialog
          route={route}
          onClose={() => setHeaderOpen(false)}
        />
      )}
      {operationDialog !== null && (
        <OperationDialog
          routeId={route.id}
          operation={operationDialog.op}
          operations={route.operations}
          workCenters={workCenters.data ?? []}
          onClose={() => setOperationDialog(null)}
        />
      )}
    </div>
  );
}

function RouteHeaderDialog({
  route,
  onClose,
}: {
  readonly route: RouteDto;
  readonly onClose: () => void;
}): React.JSX.Element {
  const client = useQueryClient();
  const [name, setName] = useState(route.name);
  const [description, setDescription] = useState(route.description ?? "");
  const [effectiveFrom, setEffectiveFrom] = useState(route.effectiveFrom?.slice(0, 10) ?? "");
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    if (name.trim().length === 0) {
      toast.error("Give the routing a name.");
      return;
    }
    setSaving(true);
    try {
      await call("mms.routes.save", {
        id: route.id,
        name: name.trim(),
        description: description.trim() || null,
        effectiveFrom,
      });
      toast.success("Route updated.");
      void client.invalidateQueries({ queryKey: ["mms-route", route.id] });
      void client.invalidateQueries({ queryKey: ["mms-routes"] });
      onClose();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }} title="Edit Route" description="Header details for this routing.">
      <div className="space-y-3">
        <label className="block space-y-1 text-sm">
          <span className="text-ink">Route name</span>
          <input
            className={inputClass}
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-ink">Description (optional)</span>
          <textarea
            className={inputClass}
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-ink">Effective from</span>
          <input
            className={inputClass}
            type="date"
            value={effectiveFrom}
            onChange={(event) => setEffectiveFrom(event.target.value)}
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function OperationDialog({
  routeId,
  operation,
  operations,
  workCenters,
  onClose,
}: {
  readonly routeId: number;
  readonly operation: RouteOperationDto | null;
  readonly operations: readonly RouteOperationDto[];
  readonly workCenters: readonly WorkCenterDto[];
  readonly onClose: () => void;
}): React.JSX.Element {
  const client = useQueryClient();
  const [operationCode, setOperationCode] = useState(operation?.operationCode ?? `OP${String(operations.length + 1).padStart(2, "0")}`);
  const [name, setName] = useState(operation?.name ?? "");
  const [workCenterId, setWorkCenterId] = useState<number | null>(operation?.workCenterId ?? null);
  const [setupTime, setSetupTime] = useState(String(operation?.setupTimeMinutes ?? 0));
  const [cycleTime, setCycleTime] = useState(String(operation?.cycleTimeMinutes ?? 0));
  const [prerequisiteOpId, setPrerequisiteOpId] = useState<number | null>(
    operation?.prerequisiteOpId ?? null,
  );
  const [qualityCheckpoint, setQualityCheckpoint] = useState(operation?.qualityCheckpoint ?? false);
  const [workInstructions, setWorkInstructions] = useState(operation?.workInstructions ?? "");
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    if (name.trim().length === 0) {
      toast.error("Give the operation a name.");
      return;
    }
    if (operationCode.trim().length === 0) {
      toast.error("Give the operation a code.");
      return;
    }
    setSaving(true);
    try {
      await call("mms.routeOperations.save", {
        ...(operation !== null ? { id: operation.id } : {}),
        routeId,
        operationCode: operationCode.trim(),
        name: name.trim(),
        workCenterId,
        setupTimeMinutes: Math.max(0, Math.round(Number(setupTime) || 0)),
        cycleTimeMinutes: Math.max(0, Math.round(Number(cycleTime) || 0)),
        prerequisiteOpId,
        qualityCheckpoint,
        workInstructions: workInstructions.trim() || null,
      });
      toast.success(operation !== null ? "Operation updated." : "Operation added to the route.");
      void client.invalidateQueries({ queryKey: ["mms-route", routeId] });
      void client.invalidateQueries({ queryKey: ["mms-routes"] });
      onClose();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  // A prerequisite must be an operation other than the one being edited.
  const prerequisiteOptions = operations.filter((op) => op.id !== operation?.id);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={operation !== null ? "Edit Operation" : "Add Operation"}
      description="Each operation runs at a work center, after the prerequisite it depends on."
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Code</span>
            <input
              className={inputClass}
              value={operationCode}
              autoFocus={operation === null}
              onChange={(event) => setOperationCode(event.target.value)}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Operation name</span>
            <input
              className={inputClass}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        </div>

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
            <option value="">Unassigned — assign before production</option>
            {workCenters.map((workCenter) => (
              <option key={workCenter.id} value={workCenter.id}>
                {workCenter.code} — {workCenter.name}
              </option>
            ))}
          </select>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Setup time (min)</span>
            <input
              className={inputClass}
              type="number"
              min="0"
              step="1"
              value={setupTime}
              onChange={(event) => setSetupTime(event.target.value)}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Cycle time (min)</span>
            <input
              className={inputClass}
              type="number"
              min="0"
              step="1"
              value={cycleTime}
              onChange={(event) => setCycleTime(event.target.value)}
            />
          </label>
        </div>

        <label className="block space-y-1 text-sm">
          <span className="text-ink">Runs after (prerequisite)</span>
          <select
            className={inputClass}
            value={prerequisiteOpId ?? ""}
            onChange={(event) => {
              const value = Number(event.target.value);
              setPrerequisiteOpId(Number.isNaN(value) || value === 0 ? null : value);
            }}
          >
            <option value="">No prerequisite</option>
            {prerequisiteOptions.map((op) => (
              <option key={op.id} value={op.id}>
                {op.sequence}. {op.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-[var(--line)]"
            checked={qualityCheckpoint}
            onChange={(event) => setQualityCheckpoint(event.target.checked)}
          />
          <span className="text-ink">Quality checkpoint at this operation</span>
        </label>

        <label className="block space-y-1 text-sm">
          <span className="text-ink">Work instructions (optional)</span>
          <textarea
            className={inputClass}
            rows={3}
            value={workInstructions}
            onChange={(event) => setWorkInstructions(event.target.value)}
          />
        </label>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : operation !== null ? "Save changes" : "Add Operation"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
