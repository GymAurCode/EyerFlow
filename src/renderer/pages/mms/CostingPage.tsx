/**
 * Production Costing page.
 *
 * Shows planned vs actual manufacturing cost per MO with cost breakdown by
 * category (material, labor, machine, overhead, subcontract, rework, scrap).
 */

import { useQuery } from "@tanstack/react-query";
import { call } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { MmsTable as DataTable } from "./MmsTable";
import { Button } from "../../components/ui/Button";
import { StatCard } from "../../components/ui/StatCard";
import { Card, CardBody, CardHeader } from "../../components/ui/Card";
import { MMS_PATH } from "../../lib/ims-nav";
import { useNavigate } from "react-router-dom";
import { Edit2 } from "lucide-react";

export function CostingPage(): React.JSX.Element {
  const { can } = useApp();
  const navigate = useNavigate();

  const query = useQuery({
    queryKey: ["mms-costing"],
    queryFn: () => call("mms.costRecords.list", {}),
    enabled: can("manufacturing", "view"),
  });

  const records = query.data ?? [];

  const totalCost = records.reduce((sum, r) => sum + r.amountFils, 0);

  const columns = [
    { id: "moNumber", header: "MO", cell: (row: any) => row.moNumber },
    { id: "costType", header: "Cost Type", cell: (row: any) => row.costType },
    {
      id: "amountFils",
      header: "Amount",
      cell: (row: any) => `Rs ${(row.amountFils / 100).toLocaleString()}`,
      align: "end",
    },
    {
      id: "quantityBasis",
      header: "Qty Basis",
      cell: (row: any) =>
        row.quantityBasis === null ? "—" : `${Math.round(row.quantityBasis / 1000)}`,
      align: "end",
    },
    { id: "recordedAt", header: "Recorded", cell: (row: any) => row.recordedAt.slice(0, 16) },
    { id: "recordedBy", header: "By", cell: (row: any) => row.recordedBy ?? "—" },
    {
      id: "actions",
      header: "",
      cell: (row: any) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(`${MMS_PATH.moDetail.replace(":id", row.moId)}`)}
        >
          <Edit2 className="h-4 w-4" />
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-ink">Production Costing</h1>
        <p className="text-sm text-ink-secondary">
          Planned vs actual manufacturing cost per order.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatCard label="Total Cost Recorded" value={`Rs ${(totalCost / 100).toLocaleString()}`} tone="brand" />
        <StatCard label="Cost Records" value={String(records.length)} tone="neutral" />
        <StatCard label="MOs with Costs" value={String(new Set(records.map((r) => r.moId)).size)} tone="info" />
      </div>

      <Card flush>
        <CardHeader title="Cost Records" description={`${records.length} entries`} />
        <CardBody>
          <DataTable
        loading={query.isLoading} error={query.error} onRetry={() => void query.refetch()}
            frameless
            columns={columns as any}
            rows={records}
            rowKey={(row) => row.id}
            emptyState="No cost records yet."
            
          />
        </CardBody>
      </Card>
    </div>
  );
}
