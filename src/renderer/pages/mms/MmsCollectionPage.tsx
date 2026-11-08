/**
 * The MMS registers that are a table and nothing else.
 *
 * Planning output, factory resources and the production-control registers all
 * have the same shape: one server query, one table, an empty state that says
 * what the screen will hold once it is used. Eleven separate files would be
 * eleven copies of that shape, so they share one component and a definition
 * table; the sidebar entry, the route and the screen title all come from
 * `ims-nav.ts`, so a register cannot be added to one and forgotten in another.
 *
 * The two screens with a real action - running MRP and recording a maintenance
 * request - keep it here, next to the table it feeds, rather than in a second
 * screen for one button.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { call } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { MmsTable as DataTable } from "./MmsTable";
import { Button } from "../../components/ui/Button";
import { RefreshCw } from "lucide-react";
import type { RpcMethod } from "../../../shared/ipc";

type Cell = (row: Record<string, unknown>) => string;

interface Column {
  readonly id: string;
  readonly header: string;
  readonly cell: Cell;
  readonly align?: "end" | undefined;
}

interface ViewDefinition {
  readonly title: string;
  readonly subtitle: string;
  /** RPC method that returns the rows. */
  readonly method: RpcMethod;
  /** Fixed filters, for a register that is a filtered view of a bigger one. */
  readonly params?: Readonly<Record<string, unknown>>;
  readonly empty: string;
  readonly columns: readonly Column[];
  /**
   * Set when the register's backend endpoint is a placeholder that returns no
   * rows. Saying so is the difference between "nothing recorded yet" and "this
   * screen does not work yet", and the second is what the user needs to know.
   */
  readonly incomplete?: string | undefined;
  /** A one-click action that produces the rows this table shows. */
  readonly action?: {
    readonly label: string;
    readonly method: RpcMethod;
    readonly requiresEdit: boolean;
  };
}

const text = (value: unknown): string =>
  value === null || value === undefined || value === "" ? "—" : String(value);

/** Quantities are stored in thousandths; money in fils. */
const qty = (row: Record<string, unknown>, key: string): string =>
  String(Math.round(Number(row[key] ?? 0) / 1000));

const money = (row: Record<string, unknown>, key: string): string =>
  `Rs ${(Number(row[key] ?? 0) / 100).toLocaleString()}`;

const day = (row: Record<string, unknown>, key: string): string => {
  const value = row[key];
  return typeof value === "string" && value.length >= 10 ? value.slice(0, 10) : "—";
};

export type MmsCollectionView = "recipes" | "maintenance" | "wip" | "subcontracting";

const VIEWS: Readonly<Record<MmsCollectionView, ViewDefinition>> = {
  recipes: {
    title: "Recipes & Formulations",
    subtitle: "Bill of materials of type recipe: the formulation behind a batch.",
    method: "mms.boms.list",
    params: { bomType: "recipe" },
    empty: "No recipes defined yet. Create one as a BOM with type recipe.",
    columns: [
      { id: "number", header: "Recipe No", cell: (row) => text(row["number"]) },
      { id: "productName", header: "Product", cell: (row) => text(row["productName"]) },
      {
        id: "baseOutputQuantity",
        header: "Output",
        cell: (row) => qty(row, "baseOutputQuantity"),
        align: "end",
      },
      { id: "outputUnit", header: "Unit", cell: (row) => text(row["outputUnit"]) },
      { id: "status", header: "Status", cell: (row) => text(row["status"]) },
      { id: "effectiveFrom", header: "Effective From", cell: (row) => day(row, "effectiveFrom") },
    ],
  },
  /* equipment was a read-only register here; it is now a dedicated page with a
     create/edit form (`EquipmentPage.tsx`). */
  maintenance: {
    title: "Maintenance Requests",
    subtitle: "Breakdowns and planned maintenance raised against factory resources.",
    method: "mms.maintenanceRequests.list",
    empty: "No maintenance requests recorded yet.",
    incomplete: "Maintenance requests are not implemented yet; this register will stay empty.",
    columns: [
      { id: "title", header: "Request", cell: (row) => text(row["title"]) },
      { id: "machineName", header: "Machine", cell: (row) => text(row["machineName"]) },
      { id: "workCenterName", header: "Work Center", cell: (row) => text(row["workCenterName"]) },
      { id: "priority", header: "Priority", cell: (row) => text(row["priority"]) },
      { id: "status", header: "Status", cell: (row) => text(row["status"]) },
      { id: "createdAt", header: "Raised", cell: (row) => day(row, "createdAt") },
    ],
  },
  wip: {
    title: "Work in Progress",
    subtitle: "Material and cost held on the shop floor against each order.",
    method: "mms.wip.list",
    empty: "No work in progress recorded yet.",
    incomplete: "WIP valuation is not implemented yet; this register will stay empty.",
    columns: [
      { id: "moNumber", header: "MO", cell: (row) => text(row["moNumber"]) },
      { id: "productName", header: "Product", cell: (row) => text(row["productName"]) },
      {
        id: "quantityMilli",
        header: "Qty",
        cell: (row) => qty(row, "quantityMilli"),
        align: "end",
      },
      { id: "stage", header: "Stage", cell: (row) => text(row["stage"]) },
      { id: "workCenterName", header: "Work Center", cell: (row) => text(row["workCenterName"]) },
      {
        id: "materialCostFils",
        header: "Material",
        cell: (row) => money(row, "materialCostFils"),
        align: "end",
      },
      { id: "updatedAt", header: "Updated", cell: (row) => day(row, "updatedAt") },
    ],
  },
  subcontracting: {
    title: "Subcontract Orders",
    subtitle: "Work sent to an outside processor, and when it is due back.",
    method: "mms.subcontractOrders.list",
    empty: "No subcontract orders recorded yet.",
    incomplete: "Subcontract orders are not implemented yet; this register will stay empty.",
    columns: [
      { id: "number", header: "Order No", cell: (row) => text(row["number"]) },
      {
        id: "subcontractorName",
        header: "Processor",
        cell: (row) => text(row["subcontractorName"]),
      },
      { id: "productName", header: "Product", cell: (row) => text(row["productName"]) },
      {
        id: "quantityMilli",
        header: "Qty",
        cell: (row) => qty(row, "quantityMilli"),
        align: "end",
      },
      {
        id: "processingCostFils",
        header: "Cost",
        cell: (row) => money(row, "processingCostFils"),
        align: "end",
      },
      { id: "plannedDelivery", header: "Due", cell: (row) => day(row, "plannedDelivery") },
      { id: "status", header: "Status", cell: (row) => text(row["status"]) },
    ],
  },
};

export function MmsCollectionPage({
  view,
}: {
  readonly view: MmsCollectionView;
}): React.JSX.Element {
  const { can } = useApp();
  const client = useQueryClient();
  const definition = VIEWS[view];

  const query = useQuery({
    queryKey: ["mms-register", view],
    queryFn: () => call(definition.method, definition.params ?? {}),
    enabled: can("manufacturing", "view"),
  });

  const action = useMutation({
    mutationFn: (method: RpcMethod) => call(method, {}),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["mms-register", view] });
    },
  });

  const rows = (query.data ?? []) as readonly Record<string, unknown>[];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink">{definition.title}</h1>
          <p className="text-sm text-ink-secondary">{definition.subtitle}</p>
        </div>
        <div className="flex gap-2">
          {definition.action !== undefined && (
            <Button
              variant="primary"
              disabled={
                !can("manufacturing", "edit") || !definition.action.requiresEdit || action.isPending
              }
              onClick={() => {
                if (definition.action !== undefined) action.mutate(definition.action.method);
              }}
            >
              {definition.action.label}
            </Button>
          )}
          <Button
            variant="ghost"
            iconLeft={<RefreshCw className="h-4 w-4" />}
            disabled={query.isFetching}
            onClick={() => {
              void query.refetch();
            }}
          >
            Refresh
          </Button>
        </div>
      </div>

      {definition.incomplete !== undefined && (
        <div className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)] px-4 py-3 text-sm text-ink-secondary">
          {definition.incomplete}
        </div>
      )}

      {action.isError && (
        <p className="text-sm text-danger">
          {action.error instanceof Error
            ? action.error.message
            : "The action could not be completed."}
        </p>
      )}

      <DataTable
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        frameless
        columns={definition.columns as never}
        rows={rows as never}
        rowKey={(row) => String((row as { id: number }).id)}
        emptyState={definition.empty}
      />
    </div>
  );
}
