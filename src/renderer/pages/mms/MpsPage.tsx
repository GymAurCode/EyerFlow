import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { MpsPlanDto, SaveMpsPlanRequest, MpsBucketDto } from "../../../shared/mms";
import { call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { todayIso, addDaysIso } from "../../lib/utils";
import { formatQuantity } from "../../lib/format";
import { MmsTable } from "./MmsTable";
import { PageHeader, EmptyState } from "../../components/ui/Feedback";
import { Card, CardHeader, CardBody } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input, Select } from "../../components/ui/Input";

export function MpsPage(): React.JSX.Element {
  const { can } = useApp(),
    client = useQueryClient();
  const [editing, setEditing] = useState<MpsPlanDto | null | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [historyId, setHistoryId] = useState<number | null>(null);
  const [fromDate, setFromDate] = useState(""),
    [toDate, setToDate] = useState("");
  const query = useQuery({
    queryKey: ["mps-plans", fromDate, toDate],
    queryFn: () =>
      call("mms.mps.plans.list", {
        ...(fromDate ? { fromDate } : {}),
        ...(toDate ? { toDate } : {}),
      }),
    enabled: can("manufacturing", "view"),
  });
  const history = useQuery({
    queryKey: ["mps-history", historyId],
    queryFn: () => call("mms.mps.history", { id: historyId! }),
    enabled: historyId !== null,
  });
  const action = useMutation({
    mutationFn: async ({
      id,
      kind,
    }: {
      id: number;
      kind: "calculate" | "approve" | "generate";
    }) => {
      if (kind === "calculate") return call("mms.mps.calculate", { id });
      if (kind === "approve") return call("mms.mps.approve", { id });
      return call("mms.mps.generateOrders", { id });
    },
    onSuccess: (p) => {
      setSelectedId(p.id);
      void client.invalidateQueries({ queryKey: ["mps-plans"] });
      void client.invalidateQueries({ queryKey: ["mps-history"] });
      void client.invalidateQueries({ queryKey: ["mms-orders"] });
      toast.success("Production schedule updated.");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const rows = query.data ?? [],
    selected = rows.find((r) => r.id === selectedId);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Master Production Schedule"
        description="Plan production against available IMS inventory and expected manufacturing receipts."
        actions={
          <>
            <Button
              variant="ghost"
              iconLeft={<RefreshCw className="h-4 w-4" />}
              onClick={() => void query.refetch()}
            >
              Refresh
            </Button>
            {can("manufacturing", "create") && (
              <Button
                variant="primary"
                iconLeft={<Plus className="h-4 w-4" />}
                onClick={() => setEditing(null)}
              >
                Create Production Schedule
              </Button>
            )}
          </>
        }
      />
      <div className="flex flex-wrap gap-3">
        <Field label="Schedules from">
          {(id) => (
            <Input
              id={id}
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
            />
          )}
        </Field>
        <Field label="Schedules to">
          {(id) => (
            <Input id={id} type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          )}
        </Field>
      </div>
      <MmsTable
        rows={rows}
        rowKey={(p) => p.id}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={
          <EmptyState
            title="No production schedules yet"
            description="Create a schedule to calculate projected stock and production requirements."
            {...(can("manufacturing", "create")
              ? { actionLabel: "Create Schedule", onAction: () => setEditing(null) }
              : {})}
          />
        }
        columns={[
          {
            id: "productName",
            header: "Product",
            cell: (p) => `${p.productName} · ${p.productUnit}`,
          },
          { id: "bucketDate", header: "Period", cell: (p) => `${p.bucketDate} – ${p.periodEnd}` },
          { id: "horizon", header: "Horizon", cell: (p) => p.horizon },
          { id: "status", header: "Status", cell: (p) => p.status },
          { id: "plannedDemand", header: "Demand", cell: (p) => formatQuantity(p.plannedDemand) },
          { id: "openingStock", header: "Opening", cell: (p) => formatQuantity(p.openingStock) },
          {
            id: "scheduledReceipts",
            header: "Expected supply",
            cell: (p) => formatQuantity(p.scheduledReceipts),
          },
          {
            id: "projectedStock",
            header: "Projected",
            cell: (p) => formatQuantity(p.projectedStock),
          },
          {
            id: "recommendedProduction",
            header: "Recommended",
            cell: (p) => formatQuantity(p.recommendedProduction),
          },
          {
            id: "actions",
            header: "Actions",
            cell: (p) => (
              <div className="flex flex-wrap gap-1">
                <Button size="sm" variant="ghost" onClick={() => setSelectedId(p.id)}>
                  Details
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setHistoryId(p.id)}>
                  History
                </Button>
                {p.status === "draft" && can("manufacturing", "edit") && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={action.isPending}
                      onClick={() => action.mutate({ id: p.id, kind: "calculate" })}
                    >
                      Calculate
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={action.isPending}
                      onClick={() => action.mutate({ id: p.id, kind: "approve" })}
                    >
                      Approve Plan
                    </Button>
                  </>
                )}
                {p.status === "approved" && can("manufacturing", "create") && (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={action.isPending}
                    onClick={() => action.mutate({ id: p.id, kind: "generate" })}
                  >
                    Generate Manufacturing Orders
                  </Button>
                )}
              </div>
            ),
          },
        ]}
      />
      {action.isError && (
        <p role="alert" className="text-danger">
          {errorMessage(action.error)}
        </p>
      )}
      {selected && (
        <Card flush>
          <CardHeader
            title={`${selected.productName} · Schedule results`}
            description="Demand is the greater of forecast and confirmed demand. Recommendations include safety stock and exclude existing supply."
          />
          <CardBody>
            <p className="mb-3 text-sm text-ink-secondary">
              Period totals are spread evenly across buckets. Projected stock is the saved balance
              before recommendations; generated orders are linked below. Recommended production
              carries forward between buckets.
            </p>
            <MmsTable rows={selected.buckets} rowKey={(b) => b.id} columns={bucketColumns} />
          </CardBody>
        </Card>
      )}
      {editing !== undefined && (
        <MpsEditor
          plan={editing}
          onClose={() => setEditing(undefined)}
          onSaved={(p) => {
            setSelectedId(p.id);
            setEditing(undefined);
            void client.invalidateQueries({ queryKey: ["mps-plans"] });
          }}
        />
      )}
      <Dialog
        open={historyId !== null}
        onOpenChange={(open) => {
          if (!open) setHistoryId(null);
        }}
        title="Planning History"
        size="xl"
      >
        <MmsTable
          rows={history.data ?? []}
          rowKey={(r) => r.id}
          loading={history.isLoading}
          error={history.error}
          onRetry={() => void history.refetch()}
          columns={[
            { id: "revision", header: "Revision", cell: (r) => r.revision },
            { id: "operation", header: "Operation", cell: (r) => r.operation },
            { id: "createdAt", header: "Recorded", cell: (r) => r.createdAt },
            { id: "actorName", header: "Planner", cell: (r) => r.actorName },
            {
              id: "recommendation",
              header: "Recommended production",
              cell: (r) =>
                formatQuantity((JSON.parse(r.snapshotJson) as MpsPlanDto).recommendedProduction),
            },
          ]}
        />
      </Dialog>
    </div>
  );
}
const bucketColumns = [
  {
    id: "bucketDate",
    header: "Bucket",
    cell: (b: MpsBucketDto) => `${b.bucketDate} – ${b.endDate}`,
  },
  ...(
    [
      "openingStock",
      "forecastDemand",
      "confirmedDemand",
      "demand",
      "scheduledReceipts",
      "plannedProduction",
      "projectedStock",
      "shortage",
      "recommendedProduction",
    ] as const
  ).map((key, i) => ({
    id: key,
    header: [
      "Opening",
      "Forecast",
      "Confirmed",
      "Demand",
      "Expected supply",
      "Planned production",
      "Projected",
      "Shortage",
      "Recommended",
    ][i]!,
    cell: (b: MpsBucketDto) => formatQuantity(b[key]),
  })),
  {
    id: "generatedMoId",
    header: "Manufacturing Order",
    cell: (b: MpsBucketDto) =>
      b.generatedMoId === null ? (
        "—"
      ) : (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            window.location.hash = `/mms/production/orders/${b.generatedMoId}`;
          }}
        >
          MO #{b.generatedMoId}
        </Button>
      ),
  },
];
function MpsEditor({
  plan,
  onClose,
  onSaved,
}: {
  plan: MpsPlanDto | null;
  onClose: () => void;
  onSaved: (p: MpsPlanDto) => void;
}) {
  const [productId, setProductId] = useState(String(plan?.productId ?? "")),
    [bomId, setBomId] = useState(String(plan?.bomId ?? ""));
  const [location, setLocation] = useState(String(plan?.locationId ?? ""));
  const [fromDate, setFrom] = useState(plan?.bucketDate ?? todayIso()),
    [toDate, setTo] = useState(plan?.periodEnd ?? addDaysIso(todayIso(), 29));
  const [horizon, setHorizon] = useState<SaveMpsPlanRequest["horizon"]>(plan?.horizon ?? "weekly");
  const [forecast, setForecast] = useState(String((plan?.forecastDemand ?? 0) / 1000)),
    [confirmed, setConfirmed] = useState(String((plan?.confirmedDemand ?? 0) / 1000));
  const [production, setProduction] = useState(String((plan?.plannedProduction ?? 0) / 1000)),
    [safety, setSafety] = useState(String((plan?.safetyStock ?? 0) / 1000));
  const boms = useQuery({ queryKey: ["planning-boms"], queryFn: () => call("mms.boms.list", {}) });
  const locations = useQuery({
    queryKey: ["planning-locations"],
    queryFn: () => call("ims.locations.list", {}),
  });
  const approved = (boms.data ?? []).filter((b) => b.status === "approved");
  const products = [
    ...new Map(
      approved.map((b) => [b.productId, { value: String(b.productId), label: b.productName }]),
    ).values(),
  ];
  const save = useMutation({
    mutationFn: () =>
      call("mms.mps.save", {
        ...(plan ? { id: plan.id, revision: plan.revision } : {}),
        productId: Number(productId),
        bomId: Number(bomId),
        locationId: location ? Number(location) : null,
        fromDate,
        toDate,
        horizon,
        forecastDemand: Math.round(Number(forecast) * 1000),
        confirmedDemand: Math.round(Number(confirmed) * 1000),
        plannedProduction: Math.round(Number(production) * 1000),
        safetyStock: Math.round(Number(safety) * 1000),
      }),
    onSuccess: (p) => {
      toast.success("Draft saved and projected stock calculated.");
      onSaved(p);
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={plan ? "Edit Production Schedule" : "Create Production Schedule"}
      size="lg"
      busy={save.isPending}
      description="Enter total new demand for the period in the product’s IMS stock unit. Confirmed demand consumes forecast demand. Opening stock excludes active reservations; exclude demand already covered by those reservations."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={save.isPending || !productId || !bomId}
            onClick={() => save.mutate()}
          >
            Save Draft Plan
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Product">
          {(id) => (
            <Select
              id={id}
              value={productId}
              onChange={(v) => {
                setProductId(v);
                setBomId("");
              }}
              options={products}
              placeholder="Select Product"
            />
          )}
        </Field>
        <Field label="Approved BOM">
          {(id) => (
            <Select
              id={id}
              value={bomId}
              onChange={setBomId}
              options={approved
                .filter((b) => String(b.productId) === productId)
                .map((b) => ({ value: String(b.id), label: b.name }))}
              placeholder="Select BOM"
            />
          )}
        </Field>
        <Field label="Plant / Branch">
          {(id) => (
            <Select
              id={id}
              value={location}
              placeholder="All company locations"
              onChange={setLocation}
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
        <Field label="Planning Horizon">
          {(id) => (
            <Select
              id={id}
              value={horizon}
              onChange={(v) => setHorizon(v as typeof horizon)}
              options={["daily", "weekly", "monthly"].map((v) => ({
                value: v,
                label: v[0]!.toUpperCase() + v.slice(1),
              }))}
            />
          )}
        </Field>
        <Field label="Period Start">
          {(id) => (
            <Input id={id} type="date" value={fromDate} onChange={(e) => setFrom(e.target.value)} />
          )}
        </Field>
        <Field label="Period End">
          {(id) => (
            <Input id={id} type="date" value={toDate} onChange={(e) => setTo(e.target.value)} />
          )}
        </Field>
        {[
          ["Forecast Demand", forecast, setForecast],
          ["Confirmed Demand", confirmed, setConfirmed],
          ["Planned Production", production, setProduction],
          ["Safety Stock", safety, setSafety],
        ].map(([label, value, set]) => (
          <Field key={label as string} label={label as string}>
            {(id) => (
              <Input
                id={id}
                type="number"
                min="0"
                step="0.001"
                value={value as string}
                onChange={(e) => (set as (v: string) => void)(e.target.value)}
              />
            )}
          </Field>
        ))}
      </div>
      {(save.error || boms.error || locations.error) && (
        <p className="mt-3 text-danger" role="alert">
          {errorMessage(save.error ?? boms.error ?? locations.error)}
        </p>
      )}
      {(boms.error || locations.error) && (
        <Button
          variant="ghost"
          onClick={() => {
            void boms.refetch();
            void locations.refetch();
          }}
        >
          Retry loading planning data
        </Button>
      )}
      {approved.length === 0 && !boms.isLoading && (
        <p className="mt-3 text-sm text-ink-secondary">
          Create and approve a BOM before scheduling production.
        </p>
      )}
    </Dialog>
  );
}
