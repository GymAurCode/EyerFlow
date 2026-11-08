/**
 * Routes & Operations page.
 *
 * Lists manufacturing routings with their operations, sequences, work centers
 * and times. Supports creating routes, opening the routing on its own screen,
 * approving a draft routing and editing its header.
 *
 * Save calls `mms.routes.save`. The number is generated server-side (RT-00001…)
 * when left empty, so the dialog only asks for the name a user cares about.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useState } from "react";
import { Plus, Route as RouteIcon, CheckCircle2, Pencil } from "lucide-react";
import { call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { MmsTable as DataTable } from "./MmsTable";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { PageHeader, EmptyState, TableSkeleton } from "../../components/ui/Feedback";
import { MMS_PATH } from "../../lib/ims-nav";
import type { RouteDto } from "../../../shared/types";

const inputClass =
  "w-full rounded-lg border border-[var(--line)] bg-[var(--input-bg)] px-3 py-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-[var(--brand)]";

const statusTone: Record<string, string> = {
  draft: "bg-[var(--surface-3)] text-ink-secondary",
  review: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  approved: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  superseded: "bg-[var(--surface-3)] text-ink-secondary",
  archived: "bg-[var(--surface-3)] text-ink-secondary",
};

export function RoutesPage(): React.JSX.Element {
  const { can } = useApp();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<RouteDto | null>(null);

  const query = useQuery({
    queryKey: ["mms-routes", search],
    queryFn: () =>
      call(
        "mms.routes.list",
        search.trim() === "" ? {} : { search: search.trim() },
      ),
    enabled: can("manufacturing", "view"),
  });

  const routes = query.data ?? [];

  const approve = useMutation({
    mutationFn: (route: RouteDto) =>
      call("mms.routes.save", { id: route.id, name: route.name, status: "approved" }),
    onSuccess: () => {
      toast.success("Route approved. Manufacturing orders can now use it.");
      void client.invalidateQueries({ queryKey: ["mms-routes"] });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const openCreate = (): void => {
    setEditing(null);
    setDialogOpen(true);
  };

  const columns = [
    { id: "number", header: "Route No", cell: (row: RouteDto) => row.number, sortValue: (r: RouteDto) => r.number },
    { id: "name", header: "Name", cell: (row: RouteDto) => row.name },
    {
      id: "status",
      header: "Status",
      cell: (row: RouteDto) => (
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
      id: "effectiveFrom",
      header: "Effective From",
      cell: (row: RouteDto) => row.effectiveFrom?.slice(0, 10),
    },
    {
      id: "operations",
      header: "Operations",
      align: "end" as const,
      cell: (row: RouteDto) => String(row.operations?.length ?? 0),
    },
    {
      id: "actions",
      header: "",
      cell: (row: RouteDto) => (
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            title="Open route"
            onClick={() => navigate(MMS_PATH.routeDetail.replace(":id", String(row.id)))}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          {(row.status === "draft" || row.status === "review") && can("manufacturing", "edit") && (
            <Button
              variant="ghost"
              size="sm"
              title={
                (row.operations?.length ?? 0) === 0
                  ? "Add operations before approving"
                  : "Approve route"
              }
              disabled={(row.operations?.length ?? 0) === 0 || approve.isPending}
              onClick={() => approve.mutate(row)}
            >
              <CheckCircle2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Routes & Operations"
        description="Manufacturing routings: operation sequence, work centers, times."
        actions={
          <Button
            variant="primary"
            disabled={!can("manufacturing", "create")}
            iconLeft={<Plus className="h-4 w-4" />}
            onClick={openCreate}
          >
            New Route
          </Button>
        }
      />

      <div className="relative max-w-sm">
        <SearchIcon />
        <input
          className={`${inputClass} pl-9`}
          placeholder="Search routes by number or name…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      {query.isLoading ? (
        <TableSkeleton columns={5} />
      ) : (
        <DataTable
        loading={query.isLoading} error={query.error} onRetry={() => void query.refetch()}
          frameless
          columns={columns}
          rows={routes}
          rowKey={(row) => row.id}
          emptyState={
            <EmptyState
              title="No routes created"
              description="Define production operations and assign work centers before releasing routed manufacturing orders."
              actionLabel={can("manufacturing", "create") ? "Create Route" : undefined}
              onAction={can("manufacturing", "create") ? openCreate : undefined}
              icon={<RouteIcon className="h-5 w-5" />}
            />
          }
        />
      )}

      {dialogOpen && (
        <RouteDialog
          route={editing}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </div>
  );
}

function SearchIcon(): React.JSX.Element {
  return (
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
  );
}

/**
 * Create / edit a routing header. Operations live on the route's own detail
 * screen so the list page never decides how many steps production has.
 */
function RouteDialog({
  route,
  onClose,
}: {
  readonly route: RouteDto | null;
  readonly onClose: () => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [name, setName] = useState(route?.name ?? "");
  const [description, setDescription] = useState(route?.description ?? "");
  const [effectiveFrom, setEffectiveFrom] = useState(
    route?.effectiveFrom?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
  );
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    if (name.trim().length === 0) {
      toast.error("Give the routing a name.");
      return;
    }
    setSaving(true);
    try {
      const saved = await call("mms.routes.save", {
        ...(route?.id !== undefined ? { id: route.id } : {}),
        name: name.trim(),
        description: description.trim() || null,
        effectiveFrom,
      });
      toast.success(
        route?.id !== undefined ? "Route updated." : "Route created. Add its operations next.",
      );
      void client.invalidateQueries({ queryKey: ["mms-routes"] });
      onClose();
      if (route?.id === undefined) {
        navigate(MMS_PATH.routeDetail.replace(":id", String((saved as { id: number }).id)));
      }
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
      title={route?.id !== undefined ? "Edit Route" : "Create Route"}
      description="Define a routing with operations, work centers and cycle times."
    >
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
            value={description ?? ""}
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
            {saving ? "Saving…" : route?.id !== undefined ? "Save changes" : "Create Route"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
