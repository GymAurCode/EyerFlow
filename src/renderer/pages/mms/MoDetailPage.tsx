/**
 * Manufacturing Order Detail page.
 *
 * The order in full: material requirements, cost, and the production actions
 * that move it along. The actions post through the same repositories the
 * automatic paths use, so an order moved by hand and an order moved by the
 * shop floor leave the same ledger behind.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { toast } from "sonner";
import { Play, ArrowLeft, PackageOpen, Factory, PackageCheck, Ban } from "lucide-react";
import { call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { MmsTable as DataTable } from "./MmsTable";
import { Button } from "../../components/ui/Button";
import { Card, CardBody, CardHeader } from "../../components/ui/Card";
import { Dialog } from "../../components/ui/Dialog";

const inputClass =
  "w-full rounded-lg border border-[var(--line)] bg-[var(--input-bg)] px-3 py-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-[var(--brand)]";

export function MoDetailPage(): React.JSX.Element {
  const { can } = useApp();
  const { id } = useParams();
  const moId = id ? Number(id) : 0;
  const [openReceive, setOpenReceive] = useState(false);
  const [openCancel, setOpenCancel] = useState(false);
  const [working, setWorking] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["mms-mo-detail", moId],
    queryFn: () => call("mms.orders.get", { id: moId }),
    enabled: can("manufacturing", "view") && !!moId,
  });

  const mo = query.data;

  if (!mo) return <div className="card p-8 text-center">Loading MO…</div>;

  const progress = mo.plannedQuantity > 0 ? (mo.acceptedQuantity / mo.plannedQuantity) * 100 : 0;
  const outstandingIssues = mo.components.filter(
    (component) => component.requiredQuantity - component.issuedQuantity > 0,
  );
  const outstandingConsumption = mo.components.filter(
    (component) => component.issuedQuantity - component.consumedQuantity > 0,
  );
  const unacceptedOutput = Math.max(mo.actualQuantity - mo.acceptedQuantity, 0);
  const editable = can("manufacturing", "edit");
  const closed = mo.status === "cancelled" || mo.status === "closed";

  /**
   * Move stock for every outstanding component line.
   *
   * The server posts one movement per component, so a batch is a loop of
   * single-component requests: a partial failure leaves the completed lines
   * posted instead of hiding them behind one rolled-back transaction.
   */
  const runBatch = async (
    kind: "issue" | "consume",
    lines: readonly { componentProductId: number; quantityMilli: number }[],
  ): Promise<void> => {
    setWorking(kind);
    let done = 0;
    try {
      for (const line of lines) {
        if (kind === "issue") {
          await call("mms.materialIssues.issueToWip", {
            moId: mo.id,
            componentProductId: line.componentProductId,
            quantityMilli: line.quantityMilli,
          });
        } else {
          await call("mms.materialIssues.consume", {
            moId: mo.id,
            componentProductId: line.componentProductId,
            quantityMilli: line.quantityMilli,
          });
        }
        done += 1;
      }
      toast.success(
        kind === "issue"
          ? `Issued ${String(done)} component line(s) to the shop floor.`
          : `Consumed ${String(done)} component line(s).`,
      );
    } catch (error) {
      toast.error(
        done > 0
          ? `${String(done)} line(s) posted, then: ${errorMessage(error)}`
          : errorMessage(error),
      );
    } finally {
      setWorking(null);
      void query.refetch();
    }
  };

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
            Back to MOs
          </Button>
          <h1 className="text-lg font-semibold text-ink mt-2 md:mt-0">{mo.number}</h1>
          <p className="text-sm text-ink-secondary">
            {mo.productSku} — {mo.productName}
            {mo.variantLabel ? ` (${mo.variantLabel})` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {(mo.status === "planned" || mo.status === "confirmed") && editable && (
            <Button
              variant="primary"
              iconLeft={<Play className="h-4 w-4" />}
              onClick={() => {
                void call("mms.orders.release", { id: mo.id })
                  .then(() => query.refetch())
                  .catch((error: unknown) => {
                    toast.error(errorMessage(error));
                  });
              }}
            >
              Release to Production
            </Button>
          )}

          {!closed && editable && (
            <>
              <Button
                variant="secondary"
                iconLeft={<PackageOpen className="h-4 w-4" />}
                disabled={outstandingIssues.length === 0 || working !== null}
                onClick={() => {
                  void runBatch(
                    "issue",
                    outstandingIssues.map((component) => ({
                      componentProductId: component.componentProductId,
                      quantityMilli: component.requiredQuantity - component.issuedQuantity,
                    })),
                  );
                }}
              >
                {working === "issue" ? "Issuing…" : "Issue Materials"}
              </Button>

              <Button
                variant="secondary"
                iconLeft={<Factory className="h-4 w-4" />}
                disabled={outstandingConsumption.length === 0 || working !== null}
                onClick={() => {
                  void runBatch(
                    "consume",
                    outstandingConsumption.map((component) => ({
                      componentProductId: component.componentProductId,
                      quantityMilli: component.issuedQuantity - component.consumedQuantity,
                    })),
                  );
                }}
              >
                {working === "consume" ? "Consuming…" : "Consume Materials"}
              </Button>

              <Button
                variant="secondary"
                iconLeft={<PackageCheck className="h-4 w-4" />}
                disabled={unacceptedOutput <= 0}
                onClick={() => setOpenReceive(true)}
              >
                Receive Finished Goods
              </Button>
            </>
          )}

          {!closed && can("manufacturing", "cancel") && (
            <Button variant="ghost" iconLeft={<Ban className="h-4 w-4" />} onClick={() => setOpenCancel(true)}>
              Cancel MO
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">
        <Card flush>
          <CardBody className="py-4">
            <div className="text-xs text-ink-secondary uppercase tracking-wider mb-1">Status</div>
            <div className="text-sm font-medium text-ink">{mo.status}</div>
          </CardBody>
        </Card>
        <Card flush>
          <CardBody className="py-4">
            <div className="text-xs text-ink-secondary uppercase tracking-wider mb-1">Planned Qty</div>
            <div className="text-sm font-medium text-ink">
              {Math.round(mo.plannedQuantity / 1000)} {mo.unit}
            </div>
          </CardBody>
        </Card>
        <Card flush>
          <CardBody className="py-4">
            <div className="text-xs text-ink-secondary uppercase tracking-wider mb-1">Produced</div>
            <div className="text-sm font-medium text-ink">
              {Math.round(mo.actualQuantity / 1000)} {mo.unit}
            </div>
          </CardBody>
        </Card>
        <Card flush>
          <CardBody className="py-4">
            <div className="text-xs text-ink-secondary uppercase tracking-wider mb-1">Accepted</div>
            <div className="text-sm font-medium text-ink">
              {Math.round(mo.acceptedQuantity / 1000)} {mo.unit}
            </div>
          </CardBody>
        </Card>
        <Card flush>
          <CardBody className="py-4">
            <div className="text-xs text-ink-secondary uppercase tracking-wider mb-1">Progress</div>
            <div className="text-sm font-medium text-ink">{progress.toFixed(0)}%</div>
          </CardBody>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card flush>
          <CardHeader title="Material Requirements" description={`${mo.components.length} components`} />
          <CardBody>
            <DataTable
        loading={query.isLoading} error={query.error} onRetry={() => void query.refetch()}
              frameless
              columns={[
                { id: "componentSku", header: "SKU", cell: (row: any) => row.componentSku },
                { id: "componentName", header: "Component", cell: (row: any) => row.componentName },
                {
                  id: "requiredQuantity",
                  header: "Required",
                  cell: (row: any) => `${Math.round(row.requiredQuantity / 1000)}`,
                  align: "end",
                },
                {
                  id: "issuedQuantity",
                  header: "Issued",
                  cell: (row: any) => `${Math.round(row.issuedQuantity / 1000)}`,
                  align: "end",
                },
                {
                  id: "consumedQuantity",
                  header: "Consumed",
                  cell: (row: any) => `${Math.round(row.consumedQuantity / 1000)}`,
                  align: "end",
                },
              ]}
              rows={mo.components}
              rowKey={(row: any) => row.id}
              emptyState="No material requirements."
            />
          </CardBody>
        </Card>

        <Card flush>
          <CardHeader
            title="Cost Summary"
            description={`Planned: Rs ${(mo.plannedCostFils / 100).toLocaleString()}`}
          />
          <CardBody>
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-ink-secondary">Planned Cost</span>
                <span className="text-ink">Rs {(mo.plannedCostFils / 100).toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-ink-secondary">Actual Cost</span>
                <span className="text-ink">Rs {(mo.actualCostFils / 100).toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-sm border-t border-[var(--line-soft)] pt-2">
                <span className="text-ink-secondary">Variance</span>
                <span
                  className={`text-ink font-medium ${
                    mo.actualCostFils > mo.plannedCostFils ? "text-danger" : "text-success"
                  }`}
                >
                  Rs {((mo.actualCostFils - mo.plannedCostFils) / 100).toLocaleString()}
                </span>
              </div>
            </div>
          </CardBody>
        </Card>
      </div>

      {openReceive && (
        <ReceiveDialog
          moId={mo.id}
          suggestedUnits={unacceptedOutput / 1000}
          unit={mo.unit}
          onClose={() => setOpenReceive(false)}
          onSaved={() => {
            setOpenReceive(false);
            void query.refetch();
          }}
        />
      )}

      {openCancel && (
        <CancelDialog
          moId={mo.id}
          onClose={() => setOpenCancel(false)}
          onSaved={() => {
            setOpenCancel(false);
            void query.refetch();
          }}
        />
      )}
    </div>
  );
}

/** Accept produced units into finished stock through the IMS stock engine. */
function ReceiveDialog({
  moId,
  suggestedUnits,
  unit,
  onClose,
  onSaved,
}: {
  readonly moId: number;
  readonly suggestedUnits: number;
  readonly unit: string;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): React.JSX.Element {
  const [quantity, setQuantity] = useState(String(suggestedUnits));
  const [batchNo, setBatchNo] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    const quantityMilli = Math.round(Number(quantity) * 1000);
    if (!Number.isFinite(quantityMilli) || quantityMilli <= 0) {
      toast.error("Accepted quantity must be greater than zero.");
      return;
    }

    setSaving(true);
    try {
      await call("mms.finishedReceipts.save", {
        moId,
        quantityMilli,
        batchNo: batchNo.trim().length > 0 ? batchNo.trim() : null,
      });
      toast.success("Finished goods received into stock.");
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
      title="Receive Finished Goods"
      description="Posts accepted output to IMS stock at this order's unit cost."
    >
      <div className="space-y-3">
        <label className="block space-y-1 text-sm">
          <span className="text-ink">Accepted quantity ({unit})</span>
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
          <span className="text-ink">Batch number (optional)</span>
          <input
            className={inputClass}
            value={batchNo}
            onChange={(event) => {
              setBatchNo(event.target.value);
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
            {saving ? "Receiving…" : "Receive"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function CancelDialog({
  moId,
  onClose,
  onSaved,
}: {
  readonly moId: number;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): React.JSX.Element {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    if (reason.trim().length === 0) {
      toast.error("Give a reason for cancelling the order.");
      return;
    }
    setSaving(true);
    try {
      await call("mms.orders.cancel", { id: moId, reason: reason.trim() });
      toast.success("Manufacturing order cancelled.");
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
      title="Cancel Manufacturing Order"
      description="Reserved materials are released back to available stock."
    >
      <div className="space-y-3">
        <label className="block space-y-1 text-sm">
          <span className="text-ink">Reason</span>
          <input
            className={inputClass}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Keep order
          </Button>
          <Button
            variant="destructive"
            disabled={saving}
            onClick={() => {
              void save();
            }}
          >
            {saving ? "Cancelling…" : "Cancel order"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
