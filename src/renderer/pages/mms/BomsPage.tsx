/**
 * Bills of Materials list page.
 *
 * Lists every BOM revision with its product, type and component count. A new
 * BOM is created here and then completed on its own screen, where its
 * components are added and the revision is approved.
 */

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Plus, Edit2, CheckCircle2 } from "lucide-react";
import { useState } from "react";
import { call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { useLookup } from "../../lib/lookups";
import type { ProductDto } from "../../../shared/types";
import { MmsTable as DataTable } from "./MmsTable";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { MMS_PATH } from "../../lib/ims-nav";

const inputClass =
  "w-full rounded-lg border border-[var(--line)] bg-[var(--input-bg)] px-3 py-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-[var(--brand)]";

export function BomsPage(): React.JSX.Element {
  const { can } = useApp();
  const navigate = useNavigate();
  const [openCreate, setOpenCreate] = useState(false);

  const query = useQuery({
    queryKey: ["mms-boms"],
    queryFn: () => call("mms.boms.list", {}),
    enabled: can("manufacturing", "view"),
  });

  const boms = query.data ?? [];

  const approve = (id: number): void => {
    void call("mms.boms.approve", { id })
      .then(() => query.refetch())
      .catch((error: unknown) => {
        toast.error(errorMessage(error));
      });
  };

  const columns = [
    { id: "number", header: "BOM No", cell: (row: any) => row.number, sortValue: (r: any) => r.number },
    { id: "productName", header: "Product", cell: (row: any) => row.productName },
    { id: "sku", header: "SKU", cell: (row: any) => row.productSku },
    { id: "bomType", header: "Type", cell: (row: any) => row.bomType },
    { id: "status", header: "Status", cell: (row: any) => row.status },
    { id: "components", header: "Components", cell: (row: any) => String(row.components.length) },
    { id: "effectiveFrom", header: "Effective From", cell: (row: any) => row.effectiveFrom },
    {
      id: "actions",
      header: "",
      cell: (row: any) => (
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            title="Open BOM"
            onClick={() => navigate(`${MMS_PATH.bomDetail.replace(":id", String(row.id))}`)}
          >
            <Edit2 className="h-4 w-4" />
          </Button>
          {row.status !== "approved" && can("manufacturing", "edit") && (
            <Button variant="ghost" size="sm" title="Approve BOM" onClick={() => approve(row.id)}>
              <CheckCircle2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-ink">Bills of Materials</h1>
          <p className="text-sm text-ink-secondary">
            Approved BOMs are released to manufacturing orders.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="primary"
            disabled={!can("manufacturing", "create")}
            iconLeft={<Plus className="h-4 w-4" />}
            onClick={() => setOpenCreate(true)}
          >
            New BOM
          </Button>
        </div>
      </div>

      <DataTable
        loading={query.isLoading} error={query.error} onRetry={() => void query.refetch()}
        frameless
        columns={columns as any}
        rows={boms}
        rowKey={(row) => row.id}
        emptyState="No BOMs defined yet."
      />

      {openCreate && <CreateBomDialog onClose={() => setOpenCreate(false)} />}
    </div>
  );
}

/**
 * The minimum a BOM needs to exist: what it makes and in what quantity.
 *
 * Components are added on the BOM's own screen, because the list page has no
 * business knowing whether a revision is a one-line assembly or a multi-level
 * recipe.
 */
function CreateBomDialog({ onClose }: { readonly onClose: () => void }): React.JSX.Element {
  const navigate = useNavigate();
  const products = useLookup<ProductDto>("product");
  const [productId, setProductId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [bomType, setBomType] = useState<"assembly" | "recipe" | "subcontract" | "multiLevel">(
    "assembly",
  );
  const [quantity, setQuantity] = useState("1");
  const [unit, setUnit] = useState("pcs");
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    if (productId === null || name.trim().length === 0) {
      toast.error("Choose the product this BOM makes and give it a name.");
      return;
    }
    const baseOutput = Math.round(Number(quantity) * 1000);
    if (!Number.isFinite(baseOutput) || baseOutput <= 0) {
      toast.error("Base output quantity must be greater than zero.");
      return;
    }

    setSaving(true);
    try {
      const created = await call("mms.boms.save", {
        productId,
        name: name.trim(),
        bomType,
        baseOutputQuantity: baseOutput,
        outputUnit: unit.trim() || "pcs",
      });
      toast.success("BOM created. Add its components next.");
      onClose();
      navigate(`${MMS_PATH.bomDetail.replace(":id", String((created as { id: number }).id))}`);
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
      title="Create BOM"
      description="A BOM starts as a draft. Add components, then approve it before producing."
    >
      <div className="space-y-3">
        <label className="block space-y-1 text-sm">
          <span className="text-ink">Product made by this BOM</span>
          <select
            className={inputClass}
            value={productId ?? ""}
            onChange={(event) => {
              const id = Number(event.target.value);
              setProductId(Number.isNaN(id) || id === 0 ? null : id);
              const chosen = products.find((product) => product.id === id);
              if (chosen !== undefined && name.trim().length === 0) {
                setName(`${chosen.name} BOM`);
                setUnit(chosen.unit);
              }
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

        <label className="block space-y-1 text-sm">
          <span className="text-ink">BOM name</span>
          <input
            className={inputClass}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Type</span>
            <select
              className={inputClass}
              value={bomType}
              onChange={(event) => {
                setBomType(
                  event.target.value as "assembly" | "recipe" | "subcontract" | "multiLevel",
                );
              }}
            >
              <option value="assembly">Assembly</option>
              <option value="recipe">Recipe / formulation</option>
              <option value="subcontract">Subcontract</option>
              <option value="multiLevel">Multi-level</option>
            </select>
          </label>

          <label className="block space-y-1 text-sm">
            <span className="text-ink">Base output</span>
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
        </div>

        <label className="block space-y-1 text-sm">
          <span className="text-ink">Output unit</span>
          <input
            className={inputClass}
            value={unit}
            onChange={(event) => {
              setUnit(event.target.value);
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
            {saving ? "Creating…" : "Create BOM"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
