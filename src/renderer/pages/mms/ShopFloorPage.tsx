/**
 * Shop Floor page.
 *
 * Operator-facing board of the work orders that are live right now, grouped by
 * state: ready to start, in progress, paused. Each card carries Start / Pause /
 * Resume / Complete actions; completing records produced quantity through the
 * same dialog the work-orders register uses.
 *
 * Every action toasts its refusal verbatim and refetches, so a failed action
 * never looks like a dead button.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useState } from "react";
import { call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { Card, CardBody } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { PageHeader, EmptyState, TableSkeleton } from "../../components/ui/Feedback";
import { Play, Pause, Package, Clock, CheckCircle2, HardHat } from "lucide-react";
import type { RpcMethod } from "../../../shared/ipc";

interface JobCardData {
  readonly id: number;
  readonly moNumber: string;
  readonly operationName: string;
  readonly workCenterName: string | null;
  readonly operatorName: string | null;
  readonly status: string;
  readonly plannedQuantity: number;
  readonly actualQuantity: number;
  readonly expectedDurationMinutes: number;
  readonly actualDurationMinutes: number;
}

export function ShopFloorPage(): React.JSX.Element {
  const { can } = useApp();

  const query = useQuery({
    queryKey: ["mms-work-orders", "shopfloor"],
    queryFn: () => call("mms.workOrders.list", {}),
    enabled: can("manufacturing", "view"),
  });

  const orders = query.data ?? [];

  const ready = orders.filter((wo) => wo.status === "ready");
  const active = orders.filter((wo) => wo.status === "inProgress");
  const paused = orders.filter((wo) => wo.status === "paused");

  if (query.isLoading) {
    return <TableSkeleton rows={6} />;
  }

  if (query.isError) {
    return (
      <div className="glass card rounded-xl">
        <EmptyState
          title="The shop floor could not load"
          description={errorMessage(query.error)}
          icon={<HardHat className="h-5 w-5" />}
          actionLabel="Try again"
          onAction={() => void query.refetch()}
        />
      </div>
    );
  }

  if (orders.length === 0) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Shop Floor"
          description="Live work orders: ready, in progress and paused jobs."
        />
        <Card flush>
          <CardBody>
            <EmptyState
              title="No active jobs"
              description="Work orders appear here when a released manufacturing order has operations to run. Start one from the work orders register."
              icon={<Package className="h-6 w-6" />}
            />
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Shop Floor"
        description="Live work orders: ready, in progress and paused jobs."
        actions={
          <Button
            variant="ghost"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Refresh
          </Button>
        }
      />

      {can("manufacturing", "edit") ? (
        <div className="space-y-5">
          {ready.length > 0 && <JobSection heading="Ready" jobs={ready} tone="neutral" canEdit />}
          {active.length > 0 && (
            <JobSection heading="In progress" jobs={active} tone="success" canEdit />
          )}
          {paused.length > 0 && (
            <JobSection heading="Paused" jobs={paused} tone="warning" canEdit />
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {orders.map((wo) => (
            <JobCard key={wo.id} wo={wo} canEdit={false} />
          ))}
        </div>
      )}
    </div>
  );
}

function JobSection({
  heading,
  jobs,
  tone,
  canEdit,
}: {
  readonly heading: string;
  readonly jobs: readonly JobCardData[];
  readonly tone: "neutral" | "success" | "warning";
  readonly canEdit: boolean;
}): React.JSX.Element {
  return (
    <section className="space-y-2">
      <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
        {heading} · {jobs.length}
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {jobs.map((wo) => (
          <JobCard key={wo.id} wo={wo} canEdit={canEdit} tone={tone} />
        ))}
      </div>
    </section>
  );
}

function JobCard({
  wo,
  canEdit,
  tone = "neutral",
}: {
  wo: JobCardData;
  canEdit: boolean;
  tone?: "neutral" | "success" | "warning";
}) {
  const [completing, setCompleting] = useState(false);
  const client = useQueryClient();

  const isActive = wo.status === "inProgress";
  const isReady = wo.status === "ready";
  const isPaused = wo.status === "paused";

  const act = (method: RpcMethod): void => {
    void call(method, { id: wo.id })
      .then(() => {
        toast.success(
          method === "mms.workOrders.start"
            ? "Job started."
            : method === "mms.workOrders.pause"
              ? "Job paused; the time log was closed."
              : "Job resumed.",
        );
        void client.invalidateQueries({ queryKey: ["mms-work-orders"] });
      })
      .catch((error: unknown) => toast.error(errorMessage(error)));
  };

  return (
    <Card flush className="overflow-hidden">
      <div className="border-b border-[var(--line-soft)] px-4 py-3">
        <div className="flex justify-between items-start gap-2">
          <div>
            <h3 className="text-sm font-semibold text-ink">
              {wo.operationName}{" "}
              {isActive && (
                <Clock className="ml-1 h-3 w-3 animate-spin text-brand" aria-label="running" />
              )}
            </h3>
            <p className="text-xs text-ink-secondary truncate">
              MO {wo.moNumber} • {wo.workCenterName ?? "Unassigned"}
              {wo.operatorName !== null ? ` • ${wo.operatorName}` : ""}
            </p>
          </div>
          <span
            className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-md ${
              tone === "success"
                ? "bg-[var(--success-soft)] text-success"
                : tone === "warning"
                  ? "bg-[var(--warning-soft)] text-warning"
                  : "bg-[var(--surface-2)] text-ink-secondary"
            }`}
          >
            {isActive ? "In Progress" : isPaused ? "Paused" : "Ready"}
          </span>
        </div>
      </div>
      <div className="px-4 py-3 space-y-3">
        <div className="flex justify-between text-sm">
          <span className="text-ink-secondary">Planned Qty</span>
          <span className="text-ink">{Math.round(wo.plannedQuantity / 1000)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-ink-secondary">Actual Qty</span>
          <span className="text-ink font-medium">{Math.round(wo.actualQuantity / 1000)}</span>
        </div>
        {wo.expectedDurationMinutes > 0 && (
          <div className="flex justify-between text-sm">
            <span className="text-ink-secondary">Expected Duration</span>
            <span className="text-ink">{wo.expectedDurationMinutes} min</span>
          </div>
        )}
        {wo.actualDurationMinutes > 0 && (
          <div className="flex justify-between text-sm">
            <span className="text-ink-secondary">Actual Duration</span>
            <span className="text-ink">{wo.actualDurationMinutes} min</span>
          </div>
        )}
      </div>
      <div className="px-4 py-3 border-t border-[var(--line-soft)] flex gap-2">
        {canEdit ? (
          <>
            {isReady && (
              <Button
                variant="primary"
                onClick={() => act("mms.workOrders.start")}
                iconLeft={<Play className="h-4 w-4" />}
              >
                Start
              </Button>
            )}
            {isActive && (
              <>
                <Button
                  variant="secondary"
                  onClick={() => act("mms.workOrders.pause")}
                  iconLeft={<Pause className="h-4 w-4" />}
                >
                  Pause
                </Button>
                <Button
                  variant="primary"
                  onClick={() => setCompleting(true)}
                  iconLeft={<CheckCircle2 className="h-4 w-4" />}
                >
                  Complete
                </Button>
              </>
            )}
            {isPaused && (
              <Button
                variant="primary"
                onClick={() => act("mms.workOrders.resume")}
                iconLeft={<Play className="h-4 w-4" />}
              >
                Resume
              </Button>
            )}
          </>
        ) : (
          <Button variant="ghost" size="sm" disabled>
            View Only
          </Button>
        )}
      </div>
      {completing && (
        <CompleteDialog
          target={wo}
          onClose={() => setCompleting(false)}
        />
      )}
    </Card>
  );
}

/**
 * The same dialog the work-orders register uses to complete a job: actual,
 * accepted and rejected quantities, rolled up into the manufacturing order.
 */
function CompleteDialog({
  target,
  onClose,
}: {
  readonly target: JobCardData;
  readonly onClose: () => void;
}): React.JSX.Element {
  const inputClass =
    "w-full rounded-lg border border-[var(--line)] bg-[var(--input-bg)] px-3 py-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-[var(--brand)]";
  const client = useQueryClient();
  const [actual, setActual] = useState(
    String(Math.round((target.plannedQuantity - target.actualQuantity) / 1000) || 1),
  );
  const [accepted, setAccepted] = useState(actual);
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
        acceptedQuantity: Number.isFinite(acceptedQuantity) ? Math.max(0, acceptedQuantity) : 0,
        rejectedQuantity: Number.isFinite(rejectedQuantity) ? Math.max(0, rejectedQuantity) : 0,
      });
      toast.success("Work order completed; the manufacturing order has been updated.");
      void client.invalidateQueries({ queryKey: ["mms-work-orders"] });
      void client.invalidateQueries({ queryKey: ["mms-shopfloor"] });
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
              onChange={(event) => setActual(event.target.value)}
              autoFocus
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
              onChange={(event) => setAccepted(event.target.value)}
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
              onChange={(event) => setRejected(event.target.value)}
            />
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            {saving ? "Completing…" : "Complete"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
