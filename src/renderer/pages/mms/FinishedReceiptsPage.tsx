/**
 * Finished Goods Receipts page.
 *
 * Lists finished-goods receipts posted from manufacturing orders. Each receipt
 * posts exactly one finished-stock movement through the IMS stock engine, with
 * idempotency protection against duplicate receipts.
 */

import { useQuery } from "@tanstack/react-query";
import { call } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { MmsTable as DataTable } from "./MmsTable";
import { Button } from "../../components/ui/Button";
import { MMS_PATH } from "../../lib/ims-nav";
import { useNavigate } from "react-router-dom";
import { Truck } from "lucide-react";

export function FinishedReceiptsPage(): React.JSX.Element {
  const { can } = useApp();
  const navigate = useNavigate();

  const query = useQuery({
    queryKey: ["mms-finished-receipts"],
    queryFn: () => call("mms.finishedReceipts.list", {}),
    enabled: can("manufacturing", "view"),
  });

  const receipts = query.data ?? [];

  const columns = [
    { id: "moNumber", header: "MO", cell: (row: any) => row.moNumber },
    { id: "productSku", header: "SKU", cell: (row: any) => row.productSku },
    { id: "productName", header: "Product", cell: (row: any) => row.productName },
    {
      id: "quantityMilli",
      header: "Qty",
      cell: (row: any) => `${Math.round(row.quantityMilli / 1000)}`,
      align: "end",
    },
    {
      id: "acceptedQty",
      header: "Accepted",
      cell: (row: any) => `${Math.round(row.acceptedQty / 1000)}`,
      align: "end",
    },
    {
      id: "rejectedQty",
      header: "Rejected",
      cell: (row: any) => `${Math.round(row.rejectedQty / 1000)}`,
      align: "end",
    },
    {
      id: "totalCostFils",
      header: "Total Cost",
      cell: (row: any) => `Rs ${(row.totalCostFils / 100).toLocaleString()}`,
      align: "end",
    },
    { id: "receivedAt", header: "Received", cell: (row: any) => row.receivedAt.slice(0, 16) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-ink">Finished Goods Receipts</h1>
          <p className="text-sm text-ink-secondary">
            Accepted finished output posted to IMS stock. QC-gated and idempotent.
          </p>
        </div>
        <Button
          variant="primary"
          disabled={!can("manufacturing", "edit")}
          iconLeft={<Truck className="h-4 w-4" />}
          onClick={() => navigate(MMS_PATH.productionOrders)}
        >
          New Receipt
        </Button>
      </div>

      <DataTable
        loading={query.isLoading} error={query.error} onRetry={() => void query.refetch()}
        frameless
        columns={columns as any}
        rows={receipts}
        rowKey={(row) => row.id}
        emptyState="No finished goods receipts posted yet."
        
      />
    </div>
  );
}
