/**
 * Manufacturing Orders list page.
 *
 * Lists MOs with status and progress, creates a new one from an approved BOM
 * and releases it to production. Release is where the server checks component
 * availability, reserves stock and creates the work orders from the routing, so
 * its refusal is shown verbatim rather than replaced with a generic message.
 */

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Plus, Edit2, Play } from "lucide-react";
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

export function MoListPage(): React.JSX.Element {
  const { can } = useApp();
  const navigate = useNavigate();
  const [openCreate, setOpenCreate] = useState(false);

  const query = useQuery({
    queryKey: ["mms-orders"],
    queryFn: () => call("mms.orders.list", {}),
    enabled: can("manufacturing", "view"),
  });

  const orders = query.data ?? [];

  const release = (id: number): void => {
    void call("mms.orders.release", { id })
      .then(() => {
        toast.success("Order released. Work orders and reservations created.");
        return query.refetch();
      })
      .catch((error: unknown) => {
        toast.error(errorMessage(error));
      });
  };

  const columns = [
    { id: "number", header: "MO No", cell: (row: any) => row.number, sortValue: (r: any) => r.number },
    { id: "productName", header: "Product", cell: (row: any) => row.productName },
    { id: "sku", header: "SKU", cell: (row: any) => row.productSku },
    {
      id: "plannedQty",
      header: "Planned Qty",
      cell: (row: any) => `${Math.round(row.plannedQuantity / 1000)}`,
      align: "end",
    },
    {
      id: "acceptedQty",
      header: "Accepted",
      cell: (row: any) => `${Math.round(row.acceptedQuantity / 1000)}`,
      align: "end",
    },
    { id: "status", header: "Status", cell: (row: any) => row.status },
    {
      id: "actions",
      header: "",
      cell: (row: any) => (
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            title="Open order"
            onClick={() => navigate(`${MMS_PATH.moDetail.replace(":id", String(row.id))}`)}
          >
            <Edit2 className="h-4 w-4" />
          </Button>
          {(row.status === "planned" || row.status === "confirmed") &&
            can("manufacturing", "edit") && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => release(row.id)}
                iconLeft={<Play className="h-4 w-4" />}
              >
                Release
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
          <h1 className="text-lg font-semibold text-ink">Manufacturing Orders</h1>
          <p className="text-sm text-ink-secondary">
            Production orders with BOM snapshots, routing and material requirements.
          </p>
        </div>
        <Button
          variant="primary"
          disabled={!can("manufacturing", "create")}
          iconLeft={<Plus className="h-4 w-4" />}
          onClick={() => setOpenCreate(true)}
        >
          New MO
        </Button>
      </div>

      <DataTable
        loading={query.isLoading} error={query.error} onRetry={() => void query.refetch()}
        frameless
        columns={columns as any}
        rows={orders}
        rowKey={(row) => row.id}
        emptyState="No manufacturing orders defined yet."
      />

      {openCreate && <CreateMoDialog onClose={() => setOpenCreate(false)} />}
    </div>
  );
}

/**
 * A manufacturing order needs an approved BOM - the server refuses anything
 * else - so the picker only offers approved revisions and says so when there
 * are none, instead of letting the user fill a form that cannot be saved.
 */
function CreateMoDialog({ onClose }: { readonly onClose: () => void }): React.JSX.Element {
  const navigate = useNavigate();
  const products = useLookup<ProductDto>("product");
  const [productId, setProductId] = useState<number | null>(null);
  const [bomId, setBomId] = useState<number | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [routeId, setRouteId] = useState<string>("");
  const [saving, setSaving] = useState(false);

  const boms = useQuery({
    queryKey: ["mms-boms-approved"],
    queryFn: () => call("mms.boms.list", { status: "approved", limit: 500 }),
  });

  const routes = useQuery({
    queryKey: ["mms-routes"],
    queryFn: () => call("mms.routes.list", {}),
  });

  const approvedBoms = (boms.data ?? []) as readonly {
    id: number;
    number: string;
    productId: number;
    productName: string;
  }[];

  const usableBoms =
    productId === null ? approvedBoms : approvedBoms.filter((bom) => bom.productId === productId);

  const save = async (): Promise<void> => {
    if (productId === null || bomId === null) {
      toast.error("Choose the product and one of its approved BOMs.");
      return;
    }
    const plannedQuantity = Math.round(Number(quantity) * 1000);
    if (!Number.isFinite(plannedQuantity) || plannedQuantity <= 0) {
      toast.error("Planned quantity must be greater than zero.");
      return;
    }

    setSaving(true);
    try {
      const created = await call("mms.orders.save", {
        productId,
        bomId,
        plannedQuantity,
        routeId: routeId === "" ? null : Number(routeId),
      });
      toast.success("Manufacturing order created. Release it to start production.");
      onClose();
      navigate(`${MMS_PATH.moDetail.replace(":id", String((created as { id: number }).id))}`);
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
      title="Create Manufacturing Order"
      description="An order is planned from an approved BOM. Releasing it reserves materials and creates work orders."
    >
      <div className="space-y-3">
        <label className="block space-y-1 text-sm">
          <span className="text-ink">Product to produce</span>
          <select
            className={inputClass}
            value={productId ?? ""}
            onChange={(event) => {
              const id = Number(event.target.value);
              setProductId(Number.isNaN(id) || id === 0 ? null : id);
              setBomId(null);
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
          <span className="text-ink">Approved BOM</span>
          <select
            className={inputClass}
            value={bomId ?? ""}
            onChange={(event) => {
              const id = Number(event.target.value);
              setBomId(Number.isNaN(id) || id === 0 ? null : id);
            }}
          >
            <option value="">
              {approvedBoms.length === 0
                ? "No approved BOM yet — approve one first"
                : "Select an approved BOM…"}
            </option>
            {usableBoms.map((bom) => (
              <option key={bom.id} value={bom.id}>
                {bom.number} — {bom.productName}
              </option>
            ))}
          </select>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1 text-sm">
            <span className="text-ink">Planned quantity</span>
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
            <span className="text-ink">Routing (optional)</span>
            <select
              className={inputClass}
              value={routeId}
              onChange={(event) => {
                setRouteId(event.target.value);
              }}
            >
              <option value="">No routing</option>
              {((routes.data ?? []) as readonly { id: number; number: string; name: string }[]).map(
                (route) => (
                  <option key={route.id} value={route.id}>
                    {route.number} — {route.name}
                  </option>
                ),
              )}
            </select>
          </label>
        </div>

        <p className="text-xs text-ink-secondary">
          Without a routing the order creates no work orders, and no operation can be recorded.
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={saving || boms.isLoading}
            onClick={() => {
              void save();
            }}
          >
            {saving ? "Creating…" : "Create MO"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
