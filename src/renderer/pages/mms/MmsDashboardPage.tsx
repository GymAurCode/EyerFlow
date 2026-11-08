/**
 * MMS Production Dashboard.
 *
 * Real KPIs, charts and operational panels from the MMS backend. Every figure
 * is computed from posted manufacturing orders, work orders, consumption,
 * finished receipts, scrap and quality records - nothing is hardcoded.
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiException, call, errorMessage } from "../../lib/api";
import { formatMoney, formatQuantity } from "../../lib/format";
import { MixDonut } from "../../components/charts/MixDonut";
import { DropdownMenu, DropdownItem } from "../../components/ui/Dropdown";
import { addDaysIso, todayIso } from "../../lib/utils";
import { useApp } from "../../lib/app-context";
import { MMS_PATH } from "../../lib/ims-nav";
import { useNavigate } from "react-router-dom";
import { StatCard } from "../../components/ui/StatCard";
import { Card, CardBody, CardHeader } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { BarChart, Bar, Tooltip, ResponsiveContainer } from "recharts";
import {
  RefreshCw,
  Plus,
  PackageOpen,
  TriangleAlert,
  Factory,
  Layers,
  Boxes,
  CalendarDays,
  ChevronDown,
  ClipboardList,
  CheckCircle2,
  Clock,
  Coins,
} from "lucide-react";
import { EmptyState, PageHeader, Skeleton } from "../../components/ui/Feedback";

type StatTone = "brand" | "violet" | "success" | "warning" | "danger" | "info" | "neutral";
const PERIODS = [
  { days: 7, label: "Last 7 Days" },
  { days: 30, label: "Last 30 Days" },
  { days: 90, label: "Last 90 Days" },
];
const KPI_ICONS = [
  ClipboardList,
  Factory,
  CheckCircle2,
  TriangleAlert,
  Clock,
  Boxes,
  Layers,
  Coins,
];

export function MmsDashboardPage(): React.JSX.Element {
  const { can } = useApp();
  const navigate = useNavigate();
  const [days, setDays] = useState(30);
  const toDate = todayIso();
  const fromDate = addDaysIso(toDate, -(days - 1));

  const query = useQuery({
    queryKey: ["mms-dashboard", fromDate, toDate],
    queryFn: () => call("mms.dashboard", { fromDate, toDate }),
    enabled: can("manufacturing", "view"),
  });

  const data = query.data;
  const loading = query.isLoading;
  useEffect(() => {
    if (query.error && import.meta.env.DEV) {
      console.error(
        "MmsDashboardPage: mms.dashboard failed",
        {
          page: "MmsDashboardPage",
          method: "mms.dashboard",
          requestId: query.error instanceof ApiException ? query.error.requestId : undefined,
          message: query.error.message,
          stack: query.error.stack,
        },
        query.error,
      );
    }
  }, [query.error]);

  if (loading) return <DashboardSkeleton />;
  // A failed dashboard query is not an empty database: the two states must not
  // be conflated, otherwise an outage on the module's most prominent page reads
  // as "we have never manufactured anything".
  if (query.isError)
    return (
      <div className="glass card rounded-xl">
        <EmptyState
          title="The dashboard could not load"
          description={errorMessage(query.error)}
          icon={<TriangleAlert className="h-5 w-5" />}
          actionLabel="Try again"
          onAction={() => void query.refetch()}
        />
      </div>
    );
  if (!data)
    return (
      <div className="glass card rounded-xl">
        <EmptyState
          title="The dashboard could not load"
          description="No response from the production backend. Try again."
          icon={<TriangleAlert className="h-5 w-5" />}
          actionLabel="Try again"
          onAction={() => void query.refetch()}
        />
      </div>
    );

  const empty = data.totalMo === 0 && data.activeMo === 0 && data.completedMo === 0;

  const kpis = [
    { label: "Total Manufacturing Orders", value: String(data.totalMo), tone: "brand" as StatTone },
    { label: "Active Orders", value: String(data.activeMo), tone: "info" as StatTone },
    { label: "Completed Orders", value: String(data.completedMo), tone: "success" as StatTone },
    {
      label: "Material Shortages",
      value: String(data.materialShortageCount),
      tone: (data.materialShortageCount > 0 ? "danger" : "neutral") as StatTone,
    },
    {
      label: "Pending Work Orders",
      value: String(data.pendingWorkOrders),
      tone: "warning" as StatTone,
    },
    {
      label: "Produced Quantity",
      value: formatQuantity(data.producedUnits),
      tone: "success" as StatTone,
    },
    { label: "WIP Value", value: formatMoney(data.wipValueFils), tone: "violet" as StatTone },
    {
      label: "Production Cost",
      value: formatMoney(data.actualCostFils),
      tone: "brand" as StatTone,
    },
  ];

  const moByStatus = data.moByStatus.slice(0, 6);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Production Dashboard"
        description={`All-time production totals. Daily output from ${fromDate} to ${toDate}.`}
        actions={
          <>
            <DropdownMenu
              align="end"
              trigger={
                <Button
                  variant="secondary"
                  iconLeft={<CalendarDays className="h-4 w-4" />}
                  iconRight={<ChevronDown className="h-4 w-4" />}
                >
                  {PERIODS.find((period) => period.days === days)?.label}
                </Button>
              }
            >
              {PERIODS.map((period) => (
                <DropdownItem
                  key={period.days}
                  checked={period.days === days}
                  onSelect={() => setDays(period.days)}
                >
                  {period.label}
                </DropdownItem>
              ))}
            </DropdownMenu>
            <Button
              variant="ghost"
              iconLeft={<RefreshCw className="h-4 w-4" />}
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
            >
              Refresh
            </Button>
            {can("manufacturing", "create") && (
              <Button
                variant="primary"
                iconLeft={<Plus className="h-4 w-4" />}
                onClick={() => navigate(MMS_PATH.productionOrders)}
              >
                New Manufacturing Order
              </Button>
            )}
          </>
        }
      />

      <div
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
        aria-label="Key metrics"
      >
        {kpis.map((kpi, index) => {
          const Icon = KPI_ICONS[index] ?? Factory;
          return (
            <StatCard
              key={kpi.label}
              label={kpi.label}
              value={kpi.value}
              tone={kpi.tone}
              icon={<Icon className="h-5 w-5" aria-hidden="true" />}
            />
          );
        })}
      </div>

      {empty && (
        <div className="glass card rounded-xl">
          <EmptyState
            title="No manufacturing orders yet"
            description="Set up your factory floor to start production: register work centers, define a routing and a bill of materials, then create a manufacturing order."
            icon={<PackageOpen className="h-5 w-5" />}
          />
          <div className="flex flex-wrap justify-center gap-2 pb-8 px-4 -mt-4">
            <Button
              variant="primary"
              iconLeft={<Factory className="h-4 w-4" />}
              onClick={() => navigate(MMS_PATH.workCenters)}
            >
              Create Work Center
            </Button>
            <Button
              variant="ghost"
              iconLeft={<Layers className="h-4 w-4" />}
              onClick={() => navigate(MMS_PATH.boms)}
            >
              Create BOM
            </Button>
            <Button
              variant="ghost"
              iconLeft={<Boxes className="h-4 w-4" />}
              onClick={() => navigate(MMS_PATH.productionOrders)}
            >
              Create Manufacturing Order
            </Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <MoStatusDonut data={moByStatus} />
        <DailyOutputChart data={data.dailyOutput} />
        <QualityChart data={data.qualityPassFail} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <MaterialShortagesPanel
          shortages={data.materialShortages}
          canCreate={can("manufacturing", "create")}
          navigate={navigate}
        />
        <OrdersNeedingAttentionPanel orders={data.ordersNeedingAttention} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <RecentActivityPanel activity={data.recentActivity} />
        <WorkCenterPanel centers={data.workCenterUtilization} />
      </div>
    </div>
  );
}

function DashboardSkeleton(): React.JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-busy="true">
      {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
        <Skeleton key={i} className="h-[148px] rounded-panel" />
      ))}
    </div>
  );
}

function MoStatusDonut({ data }: { data: readonly { status: string; count: number }[] }) {
  const total = data.reduce((sum, r) => sum + r.count, 0);
  return (
    <Card flush>
      <CardHeader title="MO Status" description={`${total} orders`} />
      <CardBody>
        {total === 0 ? (
          <p className="py-10 text-center text-sm text-ink-secondary">
            Orders appear here by status once a manufacturing order is created.
          </p>
        ) : (
          <MixDonut
            data={data.map((row) => ({ name: row.status, value: row.count }))}
            total={total}
            centerValue={String(total)}
            centerLabel="orders"
          />
        )}
      </CardBody>
    </Card>
  );
}

function DailyOutputChart({ data }: { data: readonly { date: string; qty: number }[] }) {
  return (
    <Card flush>
      <CardHeader title="Daily Output" description="Accepted finished units" />
      <CardBody>
        {data.length === 0 ? (
          <p className="py-10 text-center text-sm text-ink-secondary">
            Daily output appears here once finished goods are received.
          </p>
        ) : (
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data.slice(0, 14)}
                margin={{ top: 20, right: 20, bottom: 40, left: 0 }}
              >
                <Tooltip />
                <Bar dataKey="qty" fill="var(--brand)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function QualityChart({ data }: { data: readonly { result: string; count: number }[] }) {
  const qualityTotal = data.reduce((sum, r) => sum + r.count, 0);
  return (
    <Card flush>
      <CardHeader title="Quality" description="Inspection results" />
      <CardBody>
        {qualityTotal === 0 ? (
          <p className="py-10 text-center text-sm text-ink-secondary">
            Inspection results appear here once quality checks are recorded.
          </p>
        ) : (
          <MixDonut
            data={data.map((row) => ({ name: row.result, value: row.count }))}
            total={qualityTotal}
            centerValue={String(qualityTotal)}
            centerLabel="checks"
          />
        )}
      </CardBody>
    </Card>
  );
}

function MaterialShortagesPanel({
  shortages,
  canCreate,
  navigate,
}: {
  shortages: readonly {
    productId: number;
    sku: string;
    name: string;
    required: number;
    available: number;
    shortage: number;
  }[];
  canCreate: boolean;
  navigate: ReturnType<typeof useNavigate>;
}) {
  return (
    <Card flush>
      <CardHeader
        title="Material Shortages"
        description={`${shortages.length} components below required`}
        actions={
          canCreate && (
            <Button variant="ghost" size="sm" onClick={() => navigate(MMS_PATH.productionOrders)}>
              New MO
            </Button>
          )
        }
      />
      <CardBody>
        {shortages.length === 0 ? (
          <p className="text-sm text-ink-secondary">No material shortages detected.</p>
        ) : (
          <div className="space-y-2">
            {shortages.map((s) => (
              <div key={s.productId} className="flex justify-between text-sm">
                <span className="text-ink truncate">
                  {s.sku} — {s.name}
                </span>
                <span className="text-ink-secondary">
                  need {Math.round(s.required / 1000)}, have {Math.round(s.available / 1000)}
                </span>
                <span className="text-sm font-medium text-danger">
                  short {Math.round(s.shortage / 1000)}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function OrdersNeedingAttentionPanel({
  orders,
}: {
  orders: readonly {
    id: number;
    number: string;
    productName: string;
    status: string;
    issue: string;
  }[];
}) {
  return (
    <Card flush>
      <CardHeader title="Orders Requiring Attention" description={`${orders.length} items`} />
      <CardBody>
        {orders.length === 0 ? (
          <p className="text-sm text-ink-secondary">All orders are on track.</p>
        ) : (
          <div className="space-y-2">
            {orders.map((o) => (
              <div key={o.id} className="flex justify-between text-sm gap-2">
                <span className="text-ink truncate">{o.number}</span>
                <span className="text-ink-secondary truncate">{o.productName}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--warning-soft)] text-warning">
                  {o.status}
                </span>
                <span className="text-sm text-ink-secondary">{o.issue}</span>
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function RecentActivityPanel({
  activity,
}: {
  activity: readonly {
    id: number;
    occurredAt: string;
    actorName: string;
    action: string;
    module: string;
  }[];
}) {
  return (
    <Card flush>
      <CardHeader title="Recent Activity" description={`${activity.length} events`} />
      <CardBody>
        {activity.length === 0 ? (
          <p className="text-sm text-ink-secondary">No recent activity.</p>
        ) : (
          <div className="space-y-2">
            {activity.map((a) => (
              <div key={a.id} className="flex justify-between text-sm gap-2">
                <span className="text-ink-secondary">{a.occurredAt.slice(0, 16)}</span>
                <span className="text-ink truncate">
                  {a.actorName} — {a.action}
                </span>
                <span className="text-sm text-ink-secondary">{a.module}</span>
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function WorkCenterPanel({
  centers,
}: {
  centers: readonly { workCenter: string; utilizationPct: number }[];
}) {
  return (
    <Card flush>
      <CardHeader title="Work Centers" description={`${centers.length} centers`} />
      <CardBody>
        {centers.length === 0 ? (
          <p className="text-sm text-ink-secondary">No work center data.</p>
        ) : (
          <div className="space-y-2">
            {centers.map((c) => (
              <div key={c.workCenter} className="flex justify-between text-sm gap-2">
                <span className="text-ink truncate">{c.workCenter}</span>
                <span className="text-sm text-ink-secondary">Active</span>
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
