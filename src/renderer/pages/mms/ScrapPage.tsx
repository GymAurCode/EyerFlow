/**
 * Scrap & By-products page.
 *
 * Real scrap records against manufacturing orders: quantity, type (material /
 * process / finished product), reason, work center and derived cost. Saved
 * through `mms.scrap.save`.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Truck, Pencil } from "lucide-react";
import { call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { MmsTable as DataTable } from "./MmsTable";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { PageHeader, EmptyState, TableSkeleton } from "../../components/ui/Feedback";
import { StatCard } from "../../components/ui/StatCard";
import type { ScrapDto } from "../../../shared/types";

const inputClass =
  "w-full rounded-lg border border-[var(--line)] bg-[var(--input-bg)] px-3 py-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-[var(--brand)]";

const typeLabel: Record<string, string> = {
  material: "Material",
  process: "Process",
  finishedProduct: "Finished Product",
};

type ScrapPageType = "material" | "process" | "finishedProduct";

export function ScrapPage(): React.JSX.Element {
  const { can } = useApp();
  const [openCreate, setOpenCreate] = useState(false);
  const [record, setRecord] = useState<ScrapDto | null>(null);

  const query = useQuery({
    queryKey: ["mms-scrap"],
    queryFn: () => call("mms.scrap.list", {}),
    enabled: can("manufacturing", "view"),
  });

  const records = query.data ?? [];
  const totalQty = records.reduce((sum, r) => sum + r.quantityMilli, 0);
  const totalCost = records.reduce((sum, r) => sum + r.costFils, 0);

  const openNew = (): void => {
    setRecord(null);
    setOpenCreate(true);
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Scrap & By-products"
        description="Material and output written off during production, with its cost."
        actions={
          <Button
            variant="primary"
            disabled={!can("manufacturing", "edit")}
            iconLeft={<Truck className="h-4 w-4" />}
            onClick={openNew}
          >
            Record Scrap
          </Button>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatCard label="Scrapped units" value={String(Math.round(totalQty / 1000))} tone="danger" hint="Across all scrap records" />
        <StatCard label="Scrap cost" value={`Rs ${(totalCost / 100).toLocaleString()}`} tone="danger" hint="Derived from average cost" />
        <StatCard label="Records" value={String(records.length)} tone="neutral" hint="Logged scrapped items" />
      </div>

      {query.isLoading ? (
        <TableSkeleton columns={7} />
      ) : (
        <DataTable
        loading={query.isLoading} error={query.error} onRetry={() => void query.refetch()}
          frameless
          columns={[
            { id: "moNumber", header: "MO", cell: (row: ScrapDto) => row.moNumber },
            { id: "productName", header: "Item", cell: (row: ScrapDto) => `${row.productSku} — ${row.productName}` },
            {
              id: "quantityMilli",
              header: "Qty",
              align: "end" as const,
              cell: (row: ScrapDto) => String(Math.round(row.quantityMilli / 1000)),
              sortValue: (r: ScrapDto) => r.quantityMilli,
            },
            { id: "scrapType", header: "Type", cell: (row: ScrapDto) => typeLabel[row.scrapType] ?? row.scrapType },
            { id: "scrapReason", header: "Reason", cell: (row: ScrapDto) => row.scrapReason ?? "—" },
            {
              id: "workCenterName",
              header: "Work Center",
              cell: (row: ScrapDto) => row.workCenterName ?? "—",
            },
            {
              id: "costFils",
              header: "Cost",
              align: "end" as const,
              cell: (row: ScrapDto) => `Rs ${(row.costFils / 100).toLocaleString()}`,
              sortValue: (r: ScrapDto) => r.costFils,
            },
            {
              id: "actions",
              header: "",
              cell: (row: ScrapDto) => (
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
              title="No scrap recorded yet"
              description="Scrap appears here when a production run writes off material or output against a manufacturing order."
              actionLabel={can("manufacturing", "edit") ? "Record Scrap" : undefined}
              onAction={can("manufacturing", "edit") ? openNew : undefined}
              icon={<Truck className="h-5 w-5" />}
            />
          }
        />
      )}
      {openCreate && (
        <ScrapDialog record={record} onClose={() => setOpenCreate(false)} />
      )}
    </div>
  );
}

function ScrapDialog({
  record,
  onClose,
}: {
  readonly record: ScrapDto | null;
  readonly onClose: () => void;
}): React.JSX.Element {
  const client = useQueryClient();
  const [moId, setMoId] = useState(record?.moId ?? null);
  const [workOrderId, setWorkOrderId] = useState<number | null>(record?.workOrderId ?? null);
  const [productId, setProductId] = useState(record?.productId ?? null);
  const [quantity, setQuantity] = useState(record ? String(record.quantityMilli / 1000) : "");
  const [scrapType, setScrapType] = useState(record?.scrapType ?? "material");
  const [scrapReason, setScrapReason] = useState(record?.scrapReason ?? "");
  const [workCenterId, setWorkCenterId] = useState<number | null>(record?.workCenterId ?? null);
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    if (moId === null) {
      toast.error("Select a manufacturing order.");
      return;
    }
    if (productId === null) {
      toast.error("Choose the product being scrapped.");
      return;
    }
    const quantityMilli = Math.round(Number(quantity) * 1000 || 0);
    if (!Number.isFinite(quantityMilli) || quantityMilli <= 0) {
      toast.error("Quantity must be greater than zero.");
      return;
    }

    setSaving(true);
    try {
      await call("mms.scrap.save", {
        ...(record !== null ? { id: record.id } : {}),
        moId,
        workOrderId,
        productId,
        quantityMilli,
        scrapType,
        scrapReason: scrapReason.trim() || null,
        workCenterId,
      });
      toast.success(record !== null ? "Scrap record updated." : "Scrap recorded.");
      void client.invalidateQueries({ queryKey: ["mms-scrap"] });
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
      title={record !== null ? "Edit Scrap Record" : "Record Scrap"}
      description="Write off production material or output against a manufacturing order."
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
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Product</span>
            <input
              className={inputClass}
              type="number"
              min="1"
              step="1"
              value={productId ?? ""}
              onChange={(event) => {
                const value = Number(event.target.value);
                setProductId(Number.isFinite(value) ? value : null);
              }}
            />
          </label>
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
        </div>
        <label className="block space-y-1 text-sm">
          <span className="text-ink">Type</span>
            <select
              className={inputClass}
              value={scrapType}
              onChange={(event) => setScrapType(event.target.value as ScrapPageType)}
            >
            <option value="material">Material</option>
            <option value="process">Process</option>
            <option value="finishedProduct">Finished Product</option>
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Reason</span>
            <input
              className={inputClass}
              placeholder="e.g. Damaged during assembly"
              value={scrapReason}
              onChange={(event) => setScrapReason(event.target.value)}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Work center</span>
            <input
              className={inputClass}
              type="number"
              min="1"
              step="1"
              value={workCenterId ?? ""}
              onChange={(event) => {
                const value = Number(event.target.value);
                setWorkCenterId(Number.isFinite(value) ? value : null);
              }}
            />
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : record !== null ? "Update" : "Record Scrap"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
