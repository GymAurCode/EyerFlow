/**
 * BOM Detail page.
 *
 * Shows a single BOM with its components, revision history and approval status.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { useLookup } from "../../lib/lookups";
import type { ProductDto } from "../../../shared/types";
import { useParams } from "react-router-dom";
import { MmsTable as DataTable } from "./MmsTable";
import { Button } from "../../components/ui/Button";
import { Card, CardBody, CardHeader } from "../../components/ui/Card";
import { Dialog } from "../../components/ui/Dialog";
import { ArrowLeft, Plus } from "lucide-react";

const inputClass =
  "w-full rounded-lg border border-[var(--line)] bg-[var(--input-bg)] px-3 py-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-[var(--brand)]";

export function BomDetailPage(): React.JSX.Element {
  const { can } = useApp();
  const { id } = useParams();
  const bomId = id ? Number(id) : 0;
  const [openComponent, setOpenComponent] = useState(false);

  const query = useQuery({
    queryKey: ["mms-bom-detail", bomId],
    queryFn: () => call("mms.boms.get", { id: bomId }),
    enabled: can("manufacturing", "view") && !!bomId,
  });

  const bom = query.data;

  if (!bom) return <div className="card p-8 text-center">Loading BOM…</div>;

  const columns = [
    { id: "componentSku", header: "SKU", cell: (row: any) => row.componentSku },
    { id: "componentName", header: "Component", cell: (row: any) => row.componentName },
    {
      id: "quantityPerUnit",
      header: "Qty per Unit",
      cell: (row: any) => `${Math.round(row.quantityPerUnit / 1000)} ${row.unit}`,
      align: "end" as const,
    },
    {
      id: "scrapPercent",
      header: "Scrap %",
      cell: (row: any) => `${row.scrapPercent.toFixed(1)}%`,
      align: "end" as const,
    },
    { id: "lineNo", header: "Line", cell: (row: any) => String(row.lineNo), align: "end" as const },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => window.history.back()}
            iconLeft={<ArrowLeft className="h-4 w-4" />}
          >
            Back to BOMs
          </Button>
          <h1 className="text-lg font-semibold text-ink mt-2 md:mt-0">
            {bom.number} — {bom.name}
          </h1>
          <p className="text-sm text-ink-secondary">
            {bom.productSku} — {bom.productName} {bom.variantLabel ? `(${bom.variantLabel})` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="primary"
            disabled={bom.status === "approved" || !can("manufacturing", "edit")}
            iconLeft={<Plus className="h-4 w-4" />}
            onClick={() => setOpenComponent(true)}
          >
            Add Component
          </Button>
          {bom.status !== "approved" && can("manufacturing", "edit") && (
            <Button
              variant="secondary"
              onClick={() => {
                void call("mms.boms.approve", { id: bom.id })
                  .then(() => query.refetch())
                  .catch((error: unknown) => {
                    toast.error(errorMessage(error));
                  });
              }}
            >
              Approve BOM
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card flush>
          <CardBody className="py-4">
            <div className="text-xs text-ink-secondary uppercase tracking-wider mb-1">Type</div>
            <div className="text-sm font-medium text-ink">{bom.bomType}</div>
          </CardBody>
        </Card>
        <Card flush>
          <CardBody className="py-4">
            <div className="text-xs text-ink-secondary uppercase tracking-wider mb-1">Status</div>
            <div className="text-sm font-medium text-ink">{bom.status}</div>
          </CardBody>
        </Card>
        <Card flush>
          <CardBody className="py-4">
            <div className="text-xs text-ink-secondary uppercase tracking-wider mb-1">Base Output</div>
            <div className="text-sm font-medium text-ink">
              {Math.round(bom.baseOutputQuantity / 1000)} {bom.outputUnit}
            </div>
          </CardBody>
        </Card>
      </div>

      <Card flush>
        <CardHeader title="Components" description={`${bom.components.length} line items`} />
        <CardBody>
          <DataTable
        loading={query.isLoading} error={query.error} onRetry={() => void query.refetch()}
            frameless
            columns={columns as any}
            rows={bom.components}
            rowKey={(row: any) => row.id}
            emptyState="No components defined."
          />
        </CardBody>
      </Card>

      {openComponent && (
        <AddComponentDialog
          bomId={bom.id}
          onClose={() => setOpenComponent(false)}
          onSaved={() => {
            setOpenComponent(false);
            void query.refetch();
          }}
        />
      )}
    </div>
  );
}

/** One component line: what goes in, and how much of it per base unit. */
function AddComponentDialog({
  bomId,
  onClose,
  onSaved,
}: {
  readonly bomId: number;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): React.JSX.Element {
  const products = useLookup<ProductDto>("product");
  const [productId, setProductId] = useState<number | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [unit, setUnit] = useState("pcs");
  const [scrapPercent, setScrapPercent] = useState("0");
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    if (productId === null) {
      toast.error("Choose the component product.");
      return;
    }
    const quantityPerUnit = Math.round(Number(quantity) * 1000);
    if (!Number.isFinite(quantityPerUnit) || quantityPerUnit <= 0) {
      toast.error("Quantity per unit must be greater than zero.");
      return;
    }

    setSaving(true);
    try {
      await call("mms.bomComponents.save", {
        bomId,
        componentProductId: productId,
        quantityPerUnit,
        unit: unit.trim() || "pcs",
        scrapPercent: Number(scrapPercent) || 0,
      });
      toast.success("Component added.");
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
      title="Add Component"
      description="Quantity is per one base output of the BOM."
    >
      <div className="space-y-3">
        <label className="block space-y-1 text-sm">
          <span className="text-ink">Component</span>
          <select
            className={inputClass}
            value={productId ?? ""}
            onChange={(event) => {
              const id = Number(event.target.value);
              setProductId(Number.isNaN(id) || id === 0 ? null : id);
              const chosen = products.find((product) => product.id === id);
              if (chosen !== undefined) setUnit(chosen.unit);
            }}
          >
            <option value="">Select a product…</option>
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.sku} — {product.name}
              </option>
            ))}
          </select>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Qty per unit</span>
            <input
              className={inputClass}
              type="number"
              min="0.001"
              step="any"
              value={quantity}
              onChange={(event) => {
                setQuantity(event.target.value);
              }}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Unit</span>
            <input
              className={inputClass}
              value={unit}
              onChange={(event) => {
                setUnit(event.target.value);
              }}
            />
          </label>
        </div>

        <label className="block space-y-1 text-sm">
          <span className="text-ink">Scrap allowance (%)</span>
          <input
            className={inputClass}
            type="number"
            min="0"
            max="100"
            step="any"
            value={scrapPercent}
            onChange={(event) => {
              setScrapPercent(event.target.value);
            }}
          />
        </label>

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
            {saving ? "Adding…" : "Add Component"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
