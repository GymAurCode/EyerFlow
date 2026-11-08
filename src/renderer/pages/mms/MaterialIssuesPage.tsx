/**
 * Material Issues page.
 *
 * Lists material reservations, issues to WIP, returns from WIP and consumption
 * records for manufacturing orders. Every movement posts through the IMS stock
 * engine - there is one shared ledger.
 */

import { useQuery } from "@tanstack/react-query";
import { call } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { MmsTable as DataTable } from "./MmsTable";
import { Button } from "../../components/ui/Button";
import { MMS_PATH } from "../../lib/ims-nav";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";

export function MaterialIssuesPage(): React.JSX.Element {
  const { can } = useApp();
  const navigate = useNavigate();

  const query = useQuery({
    queryKey: ["mms-material-issues"],
    queryFn: () => call("mms.materialIssues.list", {}),
    enabled: can("manufacturing", "view"),
  });

  const issues = query.data ?? [];

  const columns = [
    { id: "moNumber", header: "MO", cell: (row: any) => row.moNumber },
    { id: "componentSku", header: "SKU", cell: (row: any) => row.componentSku },
    { id: "componentName", header: "Component", cell: (row: any) => row.componentName },
    {
      id: "quantityMilli",
      header: "Qty",
      cell: (row: any) => `${Math.round(row.quantityMilli / 1000)}`,
      align: "end" as const,
    },
    { id: "issueType", header: "Type", cell: (row: any) => row.issueType },
    { id: "createdAt", header: "Created", cell: (row: any) => row.createdAt.slice(0, 16) },
    { id: "createdBy", header: "By", cell: (row: any) => row.createdBy ?? "—" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-ink">Material Issues</h1>
          <p className="text-sm text-ink-secondary">
            Reservations, WIP transfers and consumption. Posted through IMS stock.
          </p>
        </div>
        <Button
          variant="primary"
          disabled={!can("manufacturing", "edit")}
          iconLeft={<Plus className="h-4 w-4" />}
          onClick={() => navigate(MMS_PATH.productionOrders)}
        >
          New Issue
        </Button>
      </div>

      <DataTable
        loading={query.isLoading} error={query.error} onRetry={() => void query.refetch()}
        frameless
        columns={columns as any}
        rows={issues}
        rowKey={(row) => row.id}
        emptyState="No material issues recorded yet."
      />
    </div>
  );
}
