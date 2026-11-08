import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Play, RefreshCw } from "lucide-react";
import type { MrpRunDto, MrpRequirementDto } from "../../../shared/mms";
import { call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { todayIso, addDaysIso } from "../../lib/utils";
import { formatQuantity } from "../../lib/format";
import { MmsTable } from "./MmsTable";
import { PageHeader, EmptyState } from "../../components/ui/Feedback";
import { Card, CardBody, CardHeader } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input, Select } from "../../components/ui/Input";

export function MrpPage(): React.JSX.Element {
  const { can } = useApp(),
    client = useQueryClient(),
    navigate = useNavigate();
  const [open, setOpen] = useState(false),
    [selectedId, setSelected] = useState<number | null>(null),
    [history, setHistory] = useState(false);
  const [requisitionId, setRequisition] = useState<number | null>(null),
    [shortages, setShortages] = useState(false);
  const runs = useQuery({
    queryKey: ["mrp-runs"],
    queryFn: () => call("mms.mrp.runs.list", {}),
    enabled: can("manufacturing", "view"),
  });
  const selected = (runs.data ?? []).find((r) => r.id === selectedId) ?? runs.data?.[0];
  const document = useQuery({
    queryKey: ["mrp-requisition", requisitionId],
    queryFn: () => call("ims.documents.get", { id: requisitionId! }),
    enabled: requisitionId !== null,
  });
  const refresh = (r: MrpRunDto) => {
    setSelected(r.id);
    void client.invalidateQueries({ queryKey: ["mrp-runs"] });
    toast.success("Planning operation completed.");
  };
  const action = useMutation({
    mutationFn: async (kind: "approve" | "purchase" | "manufacture") => {
      if (!selected) throw new Error("Select an MRP run first.");
      if (kind === "approve") return call("mms.mrp.approve", { id: selected.id });
      if (kind === "purchase")
        return call("mms.mrp.generateRequisitions", { id: selected.id }, { timeoutMs: 60_000 });
      return call("mms.mrp.generateOrders", { id: selected.id }, { timeoutMs: 60_000 });
    },
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const rows = (selected?.requirements ?? []).filter((r) => !shortages || r.shortageQty > 0);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Material Requirements Planning"
        description="Explode approved BOMs, allocate available IMS stock and firm receipts, then approve purchase or subassembly suggestions."
        actions={
          <>
            <Button
              variant="ghost"
              iconLeft={<RefreshCw className="h-4 w-4" />}
              onClick={() => void runs.refetch()}
            >
              Refresh
            </Button>
            <Button variant="secondary" onClick={() => setHistory(true)}>
              MRP Run History
            </Button>
            {can("manufacturing", "create") && (
              <Button
                variant="primary"
                iconLeft={<Play className="h-4 w-4" />}
                onClick={() => setOpen(true)}
              >
                Run MRP
              </Button>
            )}
          </>
        }
      />
      {runs.isError && (
        <EmptyState
          title="MRP history could not load"
          description={errorMessage(runs.error)}
          actionLabel="Try again"
          onAction={() => void runs.refetch()}
        />
      )}
      {!selected && !runs.isLoading && !runs.isError && (
        <Card>
          <EmptyState
            title="No MRP run yet"
            description="Choose manufacturing demand and a planning horizon to calculate component requirements."
            {...(can("manufacturing", "create")
              ? { actionLabel: "Run MRP", onAction: () => setOpen(true) }
              : {})}
          />
        </Card>
      )}
      {selected && (
        <Card flush>
          <CardHeader
            title={`MRP Run #${selected.id}`}
            description={`${selected.fromDate} – ${selected.toDate} · ${selected.sourceMoIds.length} orders · ${selected.status}`}
          />
          <CardBody>
            <p className="mb-3 text-sm text-ink-secondary">
              All quantities use each component’s IMS stock unit. Expected receipts are firm supply
              due by the required date; open requisitions are shown separately. Calculations are
              saved snapshots.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={shortages}
                  onChange={(e) => setShortages(e.target.checked)}
                />
                Shortages only
              </label>
              {selected.status === "completed" && can("manufacturing", "edit") && (
                <Button
                  variant="secondary"
                  disabled={action.isPending}
                  onClick={() => action.mutate("approve")}
                >
                  Approve MRP Run
                </Button>
              )}
              {selected.status === "approved" && can("manufacturing", "create") && (
                <>
                  {can("purchases", "create") && (
                    <Button
                      variant="primary"
                      disabled={
                        action.isPending ||
                        !selected.requirements.some(
                          (r) => r.suggestedAction === "purchase" && r.requisitionId === null,
                        )
                      }
                      onClick={() => action.mutate("purchase")}
                    >
                      Generate IMS Purchase Requisitions
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    disabled={
                      action.isPending ||
                      !selected.requirements.some(
                        (r) => r.suggestedAction === "manufacture" && r.generatedMoId === null,
                      )
                    }
                    onClick={() => action.mutate("manufacture")}
                  >
                    Generate Subassembly Manufacturing Orders
                  </Button>
                </>
              )}
              {selected.status === "superseded" && (
                <p className="text-sm text-ink-secondary">
                  A newer run covers this inventory scope. Use its current suggestions.
                </p>
              )}
            </div>
          </CardBody>
        </Card>
      )}
      {action.isError && (
        <p className="text-danger" role="alert">
          {errorMessage(action.error)}
        </p>
      )}
      <MmsTable
        rows={rows}
        rowKey={(r) => r.id}
        loading={runs.isLoading}
        emptyState={
          selected?.status === "empty"
            ? "No eligible manufacturing demand in this scope."
            : "No component requirements for the selected run."
        }
        columns={[
          {
            id: "productName",
            header: "Component",
            cell: (r) => `${r.productName} (${r.productSku}) · ${r.productUnit}`,
          },
          ...(
            [
              "grossRequirement",
              "availableSupply",
              "reservedQuantity",
              "scheduledReceipts",
              "safetyStock",
              "netRequirement",
              "requestedSupply",
              "suggestedQuantity",
            ] as const
          ).map((key, i) => ({
            id: key,
            header: [
              "Gross required",
              "Available stock",
              "Other reservations",
              "Expected receipts",
              "Safety stock",
              "Net shortage",
              "Open requisitions",
              "Suggested quantity",
            ][i]!,
            cell: (r: MrpRequirementDto) => formatQuantity(r[key]),
          })),
          { id: "requiredByDate", header: "Required by", cell: (r) => r.requiredByDate },
          { id: "plannedReleaseDate", header: "Release date", cell: (r) => r.plannedReleaseDate },
          {
            id: "suggestedAction",
            header: "Suggested action",
            cell: (r) => (r.suggestedAction === "none" ? "Covered" : r.suggestedAction),
          },
          { id: "sourceMoNumber", header: "Demand reference", cell: (r) => r.sourceMoNumber },
          {
            id: "actions",
            header: "Generated documents",
            cell: (r) => (
              <div className="flex gap-1">
                {r.requisitionId !== null && can("purchases", "view") && (
                  <Button size="sm" variant="ghost" onClick={() => setRequisition(r.requisitionId)}>
                    View requisition #{r.requisitionId}
                  </Button>
                )}
                {r.generatedMoId !== null && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void navigate(`/mms/production/orders/${r.generatedMoId}`)}
                  >
                    View MO #{r.generatedMoId}
                  </Button>
                )}
              </div>
            ),
          },
        ]}
      />
      {open && (
        <RunMrpDialog
          onClose={() => setOpen(false)}
          onSaved={(r) => {
            setOpen(false);
            refresh(r);
          }}
        />
      )}
      <Dialog open={history} onOpenChange={setHistory} title="MRP Run History" size="xl">
        <MmsTable
          rows={runs.data ?? []}
          rowKey={(r) => r.id}
          columns={[
            { id: "id", header: "Run", cell: (r) => `MRP #${r.id}` },
            { id: "runDate", header: "Run date", cell: (r) => r.runDate },
            { id: "fromDate", header: "Horizon", cell: (r) => `${r.fromDate} – ${r.toDate}` },
            { id: "status", header: "Status", cell: (r) => r.status },
            { id: "orders", header: "Manufacturing orders", cell: (r) => r.sourceMoIds.length },
            {
              id: "actions",
              header: "",
              cell: (r) => (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSelected(r.id);
                    setHistory(false);
                  }}
                >
                  View Run
                </Button>
              ),
            },
          ]}
        />
      </Dialog>
      <Dialog
        open={requisitionId !== null}
        onOpenChange={(o) => {
          if (!o) setRequisition(null);
        }}
        title={document.data?.number ?? "IMS Purchase Requisition"}
        size="lg"
      >
        {document.data && (
          <p className="mb-3 text-sm text-ink-secondary">
            {document.data.status} · {document.data.reference} · {document.data.notes}
          </p>
        )}
        <MmsTable
          rows={document.data?.lines ?? []}
          rowKey={(r) => r.id}
          loading={document.isLoading}
          error={document.error}
          onRetry={() => void document.refetch()}
          columns={[
            { id: "description", header: "Product", cell: (r) => r.description },
            {
              id: "quantityMilli",
              header: "Requested quantity",
              cell: (r) => formatQuantity(r.quantityMilli),
            },
          ]}
        />
      </Dialog>
    </div>
  );
}
function RunMrpDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (r: MrpRunDto) => void;
}) {
  const [fromDate, setFrom] = useState(todayIso()),
    [toDate, setTo] = useState(addDaysIso(todayIso(), 89));
  const [location, setLocation] = useState(""),
    [plant, setPlant] = useState(""),
    [selection, setSelection] = useState<number[] | null>(null);
  const orders = useQuery({
    queryKey: ["planning-orders"],
    queryFn: () => call("mms.orders.list", { limit: 1000 }),
  });
  const locations = useQuery({
    queryKey: ["planning-locations"],
    queryFn: () => call("ims.locations.list", {}),
  });
  const eligible = (orders.data ?? []).filter(
    (o) =>
      ["planned", "confirmed", "released", "inProgress", "qualityReview"].includes(o.status) &&
      (!plant || o.plant === plant) &&
      (!location ||
        String(
          o.planningLocationId ??
            locations.data?.find((l) => l.name === o.plant)?.id ??
            locations.data?.find((l) => l.isDefault)?.id,
        ) === location) &&
      (o.plannedStart ?? o.plannedFinish ?? o.createdAt.slice(0, 10)) <= toDate,
  );
  const selected =
    selection === null
      ? eligible.map((o) => o.id)
      : selection.filter((id) => eligible.some((o) => o.id === id));
  const plants = [
    ...new Set((orders.data ?? []).map((o) => o.plant).filter((v): v is string => !!v)),
  ];
  const run = useMutation({
    mutationFn: () =>
      call(
        "mms.mrp.run",
        {
          fromDate,
          toDate,
          locationId: location ? Number(location) : null,
          plant: plant || null,
          moIds: selected,
        },
        { timeoutMs: 60_000 },
      ),
    onSuccess: onSaved,
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Run Material Requirements Planning"
      size="xl"
      busy={run.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={
              run.isPending ||
              orders.isLoading ||
              !!orders.error ||
              !!locations.error ||
              selected.length > 200
            }
            onClick={() => run.mutate()}
          >
            Calculate MRP
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Plant / Branch">
          {(id) => (
            <Select
              id={id}
              value={location}
              placeholder="All company locations"
              onChange={(v) => {
                setLocation(v);
                setSelection(null);
              }}
              options={[
                { value: "", label: "All company locations" },
                ...(locations.data ?? [])
                  .filter(
                    (l) => l.isActive && !["quarantine", "damaged", "transit"].includes(l.type),
                  )
                  .map((l) => ({ value: String(l.id), label: l.name })),
              ]}
            />
          )}
        </Field>
        <Field label="Plant">
          {(id) => (
            <Select
              id={id}
              value={plant}
              placeholder="All plants"
              onChange={(v) => {
                setPlant(v);
                setSelection(null);
              }}
              options={[
                { value: "", label: "All plants" },
                ...plants.map((p) => ({ value: p, label: p })),
              ]}
            />
          )}
        </Field>
        <Field label="Planning Start">
          {(id) => (
            <Input id={id} type="date" value={fromDate} onChange={(e) => setFrom(e.target.value)} />
          )}
        </Field>
        <Field label="Planning End">
          {(id) => (
            <Input id={id} type="date" value={toDate} onChange={(e) => setTo(e.target.value)} />
          )}
        </Field>
      </div>
      <p className="my-3 text-sm text-ink-secondary">
        Select up to 200 open manufacturing orders. Overdue demand is included at the planning
        start. Component release dates include IMS lead times and may precede this period.
      </p>
      <label className="mb-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={selected.length === eligible.length && eligible.length > 0}
          onChange={(e) => setSelection(e.target.checked ? null : [])}
        />
        All eligible manufacturing orders
      </label>
      <MmsTable
        rows={eligible}
        rowKey={(r) => r.id}
        loading={orders.isLoading}
        error={orders.error}
        onRetry={() => void orders.refetch()}
        emptyState="No eligible manufacturing demand in the selected period and branch. An empty run can still be saved."
        columns={[
          {
            id: "select",
            header: "Select",
            cell: (r) => (
              <input
                type="checkbox"
                aria-label={`Select ${r.number}`}
                checked={selected.includes(r.id)}
                onChange={(e) =>
                  setSelection(
                    e.target.checked ? [...selected, r.id] : selected.filter((id) => id !== r.id),
                  )
                }
              />
            ),
          },
          { id: "number", header: "Order", cell: (r) => r.number },
          { id: "productName", header: "Product", cell: (r) => r.productName },
          {
            id: "plannedQuantity",
            header: "Planned quantity",
            cell: (r) => formatQuantity(r.plannedQuantity),
          },
          { id: "status", header: "Status", cell: (r) => r.status },
          { id: "plant", header: "Plant", cell: (r) => r.plant ?? "Company-wide" },
        ]}
      />
      {(run.error || locations.error) && (
        <p className="mt-3 text-danger" role="alert">
          {errorMessage(run.error ?? locations.error)}
        </p>
      )}
      {locations.error && (
        <Button variant="ghost" onClick={() => void locations.refetch()}>
          Retry loading branches
        </Button>
      )}
    </Dialog>
  );
}
