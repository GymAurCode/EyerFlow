/**
 * The Finance overview.
 *
 * The first screen a business owner opens when they want to know where they
 * stand. It answers three questions in order:
 *
 *  1. What have I got? Cash and money at the bank, what people owe me, and
 *     what I owe them.
 *  2. How am I doing? Income, costs and profit for the period, each against
 *     the same length of time before it.
 *  3. Where is it going? The charts, each one question.
 *
 * Six figures, and no more. Balances and period figures are kept visibly
 * apart. Cash, receivables and payables are what the business holds *now*;
 * income, expenses and profit are what happened *over* the chosen period. A
 * card says which it is, so a reader is never left guessing whether a figure
 * is a stock or a flow.
 */

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Banknote,
  CircleDollarSign,
  Package,
  PiggyBank,
  Receipt,
  TrendingUp,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { call } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { formatMoney } from "../../lib/format";
import { DATE_RANGE_PRESETS, resolveDateRange, type DateRangePreset } from "../../lib/finance";
import { IMS_PATH } from "../../lib/ims-nav";
import { Card, CardHeader } from "../../components/ui/Card";
import { StatCard, type StatTone } from "../../components/ui/StatCard";

import { EmptyState, PageHeader, TableSkeleton } from "../../components/ui/Feedback";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import {
  CashFlowChart,
  ExpenseBreakdownChart,
  IncomeExpenseChart,
  ProfitTrendChart,
  ReceivablesPayablesChart,
  RevenueCostProfitChart,
  type SeriesGranularity,
} from "../../components/charts/FinanceCharts";
import { DateRangePicker, FinanceLayout } from "./FinanceLayout";

interface MetricPresentation {
  readonly icon: LucideIcon;
  readonly tone: StatTone;
}

/** The icon and colour each headline figure wears. */
const METRIC_PRESENTATION: Readonly<Record<string, MetricPresentation>> = {
  cash: { icon: Banknote, tone: "brand" },
  receivable: { icon: CircleDollarSign, tone: "violet" },
  payable: { icon: Receipt, tone: "warning" },
  revenue: { icon: TrendingUp, tone: "success" },
  expenses: { icon: Wallet, tone: "danger" },
  netProfit: { icon: PiggyBank, tone: "success" },
};

/**
 * Where each figure is explained in full.
 *
 * A card is a way into the report that gives the figure its context, not a
 * dead end: the reader who wants to know where the money is goes to the cash
 * book, and the reader who wants to know who owes what goes to the ledger.
 */
const METRIC_TARGET: Readonly<Record<string, string>> = {
  cash: IMS_PATH.cash,
  receivable: IMS_PATH.receivables,
  payable: IMS_PATH.payables,
  revenue: IMS_PATH.financialReports,
  expenses: IMS_PATH.financialReports,
  netProfit: IMS_PATH.financialReports,
};

export function FinanceOverviewPage(): React.JSX.Element {
  const { can } = useApp();
  const navigate = useNavigate();

  const [preset, setPreset] = useState<DateRangePreset>("month");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [granularity, setGranularity] = useState<SeriesGranularity>("month");

  const range = useMemo(
    () => resolveDateRange(preset, customFrom, customTo),
    [preset, customFrom, customTo],
  );

  const { data, isLoading, isError, error } = useQuery({
    queryKey: [
      "finance.overview",
      range.fromDate,
      range.toDate,
      range.previousFromDate,
      range.previousToDate,
      granularity,
    ],
    queryFn: () =>
      call("finance.overview", {
        fromDate: range.fromDate,
        toDate: range.toDate,
        asOfDate: range.asOfDate,
        previousFromDate: range.previousFromDate,
        previousToDate: range.previousToDate,
        granularity,
      }),
  });

  const format = (fils: number): string => formatMoney(fils);

  const receivablePair = useMemo(
    () => [
      {
        label: "Customers owe",
        outstanding: data?.receivableAging.totalOutstandingFils ?? 0,
        overdue: data?.receivableAging.totalOverdueFils ?? 0,
        notDue:
          (data?.receivableAging.totalOutstandingFils ?? 0) -
          (data?.receivableAging.totalOverdueFils ?? 0),
      },
    ],
    [data],
  );

  const payablePair = useMemo(
    () => [
      {
        label: "We owe",
        outstanding: data?.payableAging.totalOutstandingFils ?? 0,
        overdue: data?.payableAging.totalOverdueFils ?? 0,
        notDue:
          (data?.payableAging.totalOutstandingFils ?? 0) -
          (data?.payableAging.totalOverdueFils ?? 0),
      },
    ],
    [data],
  );

  const reconciliation = data?.reconciliation;

  return (
    <FinanceLayout>
      <PageHeader
        title="Finance overview"
        description={`${range.label} · ${range.fromDate} to ${range.toDate}`}
        actions={
          <DateRangePicker
            preset={preset}
            fromDate={customFrom}
            toDate={customTo}
            presets={DATE_RANGE_PRESETS}
            onPresetChange={(value) => {
              setPreset(value as DateRangePreset);
            }}
            onFromChange={setCustomFrom}
            onToChange={setCustomTo}
          />
        }
      />

      {isLoading ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }, (_unused, index) => (
              <div key={index} className="shimmer h-[160px] rounded-xl" />
            ))}
          </div>
          <TableSkeleton columns={4} rows={4} />
        </div>
      ) : isError ? (
        <Card>
          <EmptyState
            icon={<AlertTriangle className="h-5 w-5" />}
            title="The figures could not be loaded"
            description={error instanceof Error ? error.message : "Please try again."}
          />
        </Card>
      ) : data === undefined ? null : (
        <div className="space-y-4">
          {/* The six headline figures, in one balanced grid. */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.metrics.map((metric) => {
              const presentation = METRIC_PRESENTATION[metric.key] ?? {
                icon: Package,
                tone: "brand" as StatTone,
              };
              const Icon = presentation.icon;
              return (
                <StatCard
                  key={metric.key}
                  label={metric.label}
                  hint={metric.hint}
                  value={format(metric.amountFils)}
                  tone={presentation.tone}
                  icon={<Icon className="h-5 w-5" />}
                  delta={metric.delta}
                  deltaLabel={metric.delta === null ? undefined : "vs previous period"}
                  invertDelta={metric.key === "expenses" || metric.key === "payable"}
                  onClick={() => {
                    void navigate(METRIC_TARGET[metric.key] ?? IMS_PATH.financialReports);
                  }}
                />
              );
            })}
          </div>

          {/* The reconciliation, said plainly. */}
          {reconciliation !== undefined &&
            (!reconciliation.receivableMatches || !reconciliation.payableMatches) && (
              <Card>
                <div className="flex items-start gap-3 p-4">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--warning)]" />
                  <div className="min-w-0">
                    <p className="text-[13.5px] font-semibold text-[var(--text)]">
                      The customer and supplier balances do not agree with the ledger
                    </p>
                    <p className="mt-1 text-[12.5px] text-[var(--text-2)]">
                      {!reconciliation.receivableMatches &&
                        `Money customers owe is ${format(reconciliation.receivableControlFils)} in the ledger but ${format(reconciliation.receivableFromPartiesFils)} across the customer accounts. `}
                      {!reconciliation.payableMatches &&
                        `Money owed to suppliers is ${format(reconciliation.payableControlFils)} in the ledger but ${format(reconciliation.payableFromPartiesFils)} across the supplier accounts.`}
                    </p>
                  </div>
                </div>
              </Card>
            )}

          {/* Charts. */}
          <div className="grid gap-4 xl:grid-cols-2">
            <Card flush>
              <CardHeader
                title="Income against expenses"
                description="What came in and what went out over the period."
              />
              <div className="p-4">
                <IncomeExpenseChart
                  data={data.series}
                  format={format}
                  granularity={granularity}
                  onGranularityChange={setGranularity}
                />
              </div>
            </Card>

            <Card flush>
              <CardHeader
                title="Revenue, cost and profit"
                description="Where the money earned goes."
              />
              <div className="p-4">
                <RevenueCostProfitChart data={data.series} format={format} />
              </div>
            </Card>

            <Card flush>
              <CardHeader
                title="Cash flow"
                description="Money received, money paid, and what is left."
              />
              <div className="p-4">
                <CashFlowChart
                  data={data.series}
                  format={format}
                  openingBalanceFils={data.cashFlow.openingCashFils}
                  closingBalanceFils={data.cashFlow.closingCashFils}
                />
              </div>
            </Card>

            <Card flush>
              <CardHeader title="Where the money went" description="Expenses grouped by account." />
              <div className="p-4">
                <ExpenseBreakdownChart data={data.expenseBreakdown} format={format} />
              </div>
            </Card>

            <Card flush>
              <CardHeader
                title="Receivables against payables"
                description="Who owes the business, and who the business owes."
              />
              <div className="p-4">
                <ReceivablesPayablesChart
                  data={[...receivablePair, ...payablePair]}
                  format={format}
                />
              </div>
            </Card>

            <Card flush>
              <CardHeader
                title="Profit trend"
                description="Gross profit and net profit over the period."
              />
              <div className="p-4">
                <ProfitTrendChart data={data.series} format={format} />
              </div>
            </Card>
          </div>

          {/* The two aging summaries, side by side. */}
          <div className="grid gap-4 xl:grid-cols-2">
            <AgingSummaryCard
              title="Customer receivables"
              totalFils={data.receivableAging.totalOutstandingFils}
              overdueFils={data.receivableAging.totalOverdueFils}
              buckets={data.receivableAging.buckets}
              format={format}
            />
            <AgingSummaryCard
              title="Supplier payables"
              totalFils={data.payableAging.totalOutstandingFils}
              overdueFils={data.payableAging.totalOverdueFils}
              buckets={data.payableAging.buckets}
              format={format}
            />
          </div>

          {can("finance", "export") && (
            <Card flush>
              <CardHeader
                title="Export"
                description="Write the figures out as a file you can send to your accountant."
                actions={
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      void call("finance.export", {
                        dataset: "profitAndLoss",
                        fromDate: range.fromDate,
                        toDate: range.toDate,
                      })
                        .then((result) => {
                          window.alert(`Saved to:\n${result.path}`);
                        })
                        .catch(() => {
                          window.alert("The file could not be written.");
                        });
                    }}
                  >
                    Export profit and loss
                  </Button>
                }
              />
            </Card>
          )}
        </div>
      )}
    </FinanceLayout>
  );
}

function AgingSummaryCard({
  title,
  totalFils,
  overdueFils,
  buckets,
  format,
}: {
  readonly title: string;
  readonly totalFils: number;
  readonly overdueFils: number;
  readonly buckets: readonly {
    readonly key: string;
    readonly label: string;
    readonly amountFils: number;
  }[];
  readonly format: (fils: number) => string;
}): React.JSX.Element {
  return (
    <Card flush>
      <CardHeader
        title={title}
        description={`${format(totalFils)} outstanding, ${format(overdueFils)} of it overdue.`}
      />
      <ul className="divide-y divide-[var(--border)]">
        {buckets.map((bucket) => (
          <li key={bucket.key} className="flex items-center justify-between gap-4 px-5 py-2.5">
            <span className="text-[13px] text-[var(--text-2)]">{bucket.label}</span>
            <span className="tabular text-[13.5px] font-medium text-[var(--text)]">
              {format(bucket.amountFils)}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export { Badge };
