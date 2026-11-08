/**
 * The Finance module's charts.
 *
 * Six charts, each answering one question a business owner actually asks:
 *
 *  - Income vs Expenses: "am I taking in more than I am spending?"
 *  - Revenue vs Cost vs Profit: "where does the money I earn go?"
 *  - Cash Flow: "where did the money go, and how much is left?"
 *  - Expense Breakdown: "what am I spending it on?"
 *  - Receivables vs Payables: "who owes me, and who do I owe?"
 *  - Profit Trend: "is the business getting better?"
 *
 * Every series is drawn from real postings, the colours come from the shared
 * chart palette so a category keeps its colour across every screen, and the
 * tooltips say in words what the number means rather than leaving the reader
 * to guess which line they are hovering.
 *
 * A chart with nothing to show says so. An empty grid with a flat line is
 * worse than no chart at all, because it looks like a real result.
 */

import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART_SERIES_VARS, chartSeries } from "./chart-theme";
import { cn } from "../../lib/utils";

export interface FinanceSeriesPoint {
  readonly key: string;
  readonly label: string;
  readonly revenueFils: number;
  readonly expenseFils: number;
  readonly costFils: number;
  readonly grossProfitFils: number;
  readonly netProfitFils: number;
  readonly receivedFils: number;
  readonly paidFils: number;
}

export type CurrencyFormatter = (fils: number) => string;

const AXIS_TICK = { fontSize: 11, fill: "var(--text-3)" } as const;

/** A tooltip body that names every series in words. */
function TooltipCard({
  title,
  rows,
}: {
  readonly title: string;
  readonly rows: readonly { readonly label: string; readonly value: string; readonly color?: string }[];
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 shadow-[var(--shadow-overlay)]">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
        {title}
      </p>
      {rows.map((row) => (
        <p key={row.label} className="flex items-center justify-between gap-4 text-[12px]">
          <span className="flex items-center gap-1.5 text-[var(--text-2)]">
            {row.color !== undefined && (
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: row.color }}
                aria-hidden="true"
              />
            )}
            {row.label}
          </span>
          <span className="tabular font-medium text-[var(--text)]">{row.value}</span>
        </p>
      ))}
    </div>
  );
}

function EmptyPlot({ message, height }: { readonly message: string; readonly height: number }): React.JSX.Element {
  return (
    <div
      className="flex items-center justify-center rounded-lg border border-dashed border-[var(--border)] text-center text-[13px] text-[var(--text-3)]"
      style={{ height }}
    >
      {message}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* A. income versus expenses                                                    */
/* -------------------------------------------------------------------------- */

export type SeriesGranularity = "month" | "week" | "year";

/**
 * Income against expenses, over the selected period.
 *
 * The two are drawn as bars rather than a filled area, because the point of
 * the chart is the gap between them, and a gap is easier to read between two
 * bars than between two areas that overlap.
 */
export function IncomeExpenseChart({
  data,
  format,
  granularity = "month",
  onGranularityChange,
  height = 260,
}: {
  readonly data: readonly FinanceSeriesPoint[];
  readonly format: CurrencyFormatter;
  readonly granularity?: SeriesGranularity | undefined;
  readonly onGranularityChange?: ((value: SeriesGranularity) => void) | undefined;
  readonly height?: number | undefined;
}): React.JSX.Element {
  const rows = useMemo(
    () =>
      data.map((point) => ({
        label: point.label,
        income: point.revenueFils,
        expenses: point.expenseFils,
      })),
    [data],
  );

  const hasData = rows.some((row) => row.income !== 0 || row.expenses !== 0);

  return (
    <div>
      {onGranularityChange !== undefined && (
        <div className="mb-2 flex justify-end">
          <div className="flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-0.5">
            {(["month", "week", "year"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  onGranularityChange(value);
                }}
                className={cn(
                  "rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors duration-fast",
                  granularity === value
                    ? "bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-sm)]"
                    : "text-[var(--text-3)] hover:text-[var(--text)]",
                )}
              >
                {value === "month" ? "Monthly" : value === "week" ? "Weekly" : "Yearly"}
              </button>
            ))}
          </div>
        </div>
      )}

      {rows.length === 0 || !hasData ? (
        <EmptyPlot message="No income or expenses in this period." height={height} />
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <BarChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: -4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
            <XAxis dataKey="label" tick={AXIS_TICK} axisLine={{ stroke: "var(--border)" }} tickLine={false} />
            <YAxis
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={64}
              tickFormatter={(value: number) => format(value)}
            />
            <Tooltip
              cursor={{ fill: "var(--table-row-hover)" }}
              content={({ active, payload, label }) => {
                if (!active || payload === undefined || payload.length === 0) return null;
                const point = payload[0]?.payload as { income: number; expenses: number } | undefined;
                if (point === undefined) return null;
                return (
                  <TooltipCard
                    title={String(label)}
                    rows={[
                      { label: "Income", value: format(point.income), color: "var(--chart-1)" },
                      { label: "Expenses", value: format(point.expenses), color: "var(--chart-3)" },
                      {
                        label: "Difference",
                        value: format(point.income - point.expenses),
                      },
                    ]}
                  />
                );
              }}
            />
            <Legend
              verticalAlign="top"
              height={28}
              iconType="circle"
              iconSize={8}
              wrapperStyle={{ fontSize: 11, color: "var(--text-2)" }}
            />
            <Bar dataKey="income" name="Income" fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={28} />
            <Bar dataKey="expenses" name="Expenses" fill="var(--chart-3)" radius={[4, 4, 0, 0]} maxBarSize={28} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* B. revenue, cost and profit                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Revenue, the cost of the goods sold, gross profit and net profit.
 *
 * Four series on one axis, because the question is how one becomes the next:
 * revenue less cost is gross profit, and gross profit less the running costs
 * is net profit.
 */
export function RevenueCostProfitChart({
  data,
  format,
  height = 260,
}: {
  readonly data: readonly FinanceSeriesPoint[];
  readonly format: CurrencyFormatter;
  readonly height?: number | undefined;
}): React.JSX.Element {
  const rows = useMemo(
    () =>
      data.map((point) => ({
        label: point.label,
        revenue: point.revenueFils,
        cost: point.costFils,
        grossProfit: point.grossProfitFils,
        netProfit: point.netProfitFils,
      })),
    [data],
  );

  const hasData = rows.some((row) => row.revenue !== 0 || row.cost !== 0);

  return (
    <div>
      {rows.length === 0 || !hasData ? (
        <EmptyPlot message="No sales in this period." height={height} />
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <ComposedChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: -4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
            <XAxis dataKey="label" tick={AXIS_TICK} axisLine={{ stroke: "var(--border)" }} tickLine={false} />
            <YAxis
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={64}
              tickFormatter={(value: number) => format(value)}
            />
            <Tooltip
              cursor={{ fill: "var(--table-row-hover)" }}
              content={({ active, payload, label }) => {
                if (!active || payload === undefined || payload.length === 0) return null;
                const point = payload[0]?.payload as
                  | { revenue: number; cost: number; grossProfit: number; netProfit: number }
                  | undefined;
                if (point === undefined) return null;
                return (
                  <TooltipCard
                    title={String(label)}
                    rows={[
                      { label: "Sales revenue", value: format(point.revenue), color: "var(--chart-1)" },
                      { label: "Cost of goods sold", value: format(point.cost), color: "var(--chart-4)" },
                      { label: "Gross profit", value: format(point.grossProfit), color: "var(--chart-5)" },
                      { label: "Net profit", value: format(point.netProfit), color: "var(--chart-2)" },
                    ]}
                  />
                );
              }}
            />
            <Legend
              verticalAlign="top"
              height={28}
              iconType="circle"
              iconSize={8}
              wrapperStyle={{ fontSize: 11, color: "var(--text-2)" }}
            />
            <Bar dataKey="revenue" name="Sales revenue" fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={26} />
            <Bar dataKey="cost" name="Cost of goods sold" fill="var(--chart-4)" radius={[4, 4, 0, 0]} maxBarSize={26} />
            <Line
              type="monotone"
              dataKey="grossProfit"
              name="Gross profit"
              stroke="var(--chart-5)"
              strokeWidth={2}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="netProfit"
              name="Net profit"
              stroke="var(--chart-2)"
              strokeWidth={2}
              dot={false}
              strokeDasharray="4 3"
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* C. cash flow                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Money received, money paid, and what was left at the end.
 *
 * The opening and closing balances are drawn as a pair of reference lines
 * rather than as series, because they are the two ends of the same story: the
 * money that was there, and the money that is there now.
 */
export function CashFlowChart({
  data,
  format,
  openingBalanceFils,
  closingBalanceFils,
  height = 260,
}: {
  readonly data: readonly FinanceSeriesPoint[];
  readonly format: CurrencyFormatter;
  readonly openingBalanceFils: number;
  readonly closingBalanceFils: number;
  readonly height?: number | undefined;
}): React.JSX.Element {
  const rows = useMemo(
    () =>
      data.map((point) => ({
        label: point.label,
        received: point.receivedFils,
        paid: point.paidFils,
        net: point.receivedFils - point.paidFils,
      })),
    [data],
  );

  const hasData = rows.some((row) => row.received !== 0 || row.paid !== 0);

  return (
    <div>
      {rows.length === 0 || !hasData ? (
        <EmptyPlot message="No money moved in this period." height={height} />
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <ComposedChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: -4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
            <XAxis dataKey="label" tick={AXIS_TICK} axisLine={{ stroke: "var(--border)" }} tickLine={false} />
            <YAxis
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={64}
              tickFormatter={(value: number) => format(value)}
            />
            <Tooltip
              cursor={{ fill: "var(--table-row-hover)" }}
              content={({ active, payload, label }) => {
                if (!active || payload === undefined || payload.length === 0) return null;
                const point = payload[0]?.payload as
                  | { received: number; paid: number; net: number }
                  | undefined;
                if (point === undefined) return null;
                return (
                  <TooltipCard
                    title={String(label)}
                    rows={[
                      { label: "Money received", value: format(point.received), color: "var(--chart-1)" },
                      { label: "Money paid", value: format(point.paid), color: "var(--chart-3)" },
                      { label: "Net movement", value: format(point.net) },
                    ]}
                  />
                );
              }}
            />
            <Legend
              verticalAlign="top"
              height={28}
              iconType="circle"
              iconSize={8}
              wrapperStyle={{ fontSize: 11, color: "var(--text-2)" }}
            />
            <Bar dataKey="received" name="Money received" fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={26} />
            <Bar dataKey="paid" name="Money paid" fill="var(--chart-3)" radius={[4, 4, 0, 0]} maxBarSize={26} />
            <Line
              type="monotone"
              dataKey="net"
              name="Net movement"
              stroke="var(--chart-2)"
              strokeWidth={2}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-[12px]">
        <span className="flex items-baseline gap-1.5">
          <span className="text-[var(--text-3)]">Opening cash and bank</span>
          <span className="tabular font-medium text-[var(--text)]">{format(openingBalanceFils)}</span>
        </span>
        <span className="flex items-baseline gap-1.5">
          <span className="text-[var(--text-3)]">Closing cash and bank</span>
          <span className="tabular font-medium text-[var(--text)]">{format(closingBalanceFils)}</span>
        </span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* D. expense breakdown                                                        */
/* -------------------------------------------------------------------------- */

export interface ExpenseSlice {
  readonly code: string;
  readonly name: string;
  readonly amountFils: number;
}

/**
 * Expenses grouped by account.
 *
 * The legend is interactive: clicking a row hides that slice, so a chart with
 * eight small slices can be read without the smallest ones disappearing into
 * the middle.
 */
export function ExpenseBreakdownChart({
  data,
  format,
  height = 260,
}: {
  readonly data: readonly ExpenseSlice[];
  readonly format: CurrencyFormatter;
  readonly height?: number | undefined;
}): React.JSX.Element {
  const [hidden, setHidden] = useState<readonly string[]>([]);

  const rows = useMemo(
    () =>
      data
        .filter((slice) => !hidden.includes(slice.code))
        .map((slice) => ({ ...slice, value: slice.amountFils })),
    [data, hidden],
  );

  const total = data.reduce((sum, slice) => sum + slice.amountFils, 0);

  if (data.length === 0 || total === 0) {
    return <EmptyPlot message="No expenses recorded in this period." height={height} />;
  }

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-center">
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie
            data={rows}
            dataKey="value"
            nameKey="name"
            innerRadius="58%"
            outerRadius="86%"
            paddingAngle={1.5}
            stroke="var(--surface)"
            strokeWidth={1}
          >
            {rows.map((slice, index) => (
              <Cell key={slice.code} fill={chartSeries(index)} />
            ))}
          </Pie>
          <Tooltip
            content={({ active, payload }) => {
              if (!active || payload === undefined || payload.length === 0) return null;
              const point = payload[0]?.payload as { name: string; value: number } | undefined;
              if (point === undefined) return null;
              const share = total === 0 ? 0 : Math.round((point.value / total) * 100);
              return (
                <TooltipCard
                  title={point.name}
                  rows={[
                    { label: "Amount", value: format(point.value) },
                    { label: "Share", value: `${String(share)}%` },
                  ]}
                />
              );
            }}
          />
        </PieChart>
      </ResponsiveContainer>

      <ul className="space-y-1">
        {data.map((slice, index) => {
          const isHidden = hidden.includes(slice.code);
          const share = total === 0 ? 0 : Math.round((slice.amountFils / total) * 100);
          return (
            <li key={slice.code}>
              <button
                type="button"
                onClick={() => {
                  setHidden((current) =>
                    current.includes(slice.code)
                      ? current.filter((code) => code !== slice.code)
                      : [...current, slice.code],
                  );
                }}
                aria-pressed={isHidden}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2 py-1 text-start transition-colors duration-fast",
                  "hover:bg-[var(--surface-2)]",
                  isHidden && "opacity-40",
                )}
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: chartSeries(index) }}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--text-2)]">
                  {slice.name}
                </span>
                <span className="tabular text-[12.5px] font-medium text-[var(--text)]">
                  {format(slice.amountFils)}
                </span>
                <span className="tabular w-10 text-end text-[11.5px] text-[var(--text-3)]">
                  {String(share)}%
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* E. receivables against payables                                              */
/* -------------------------------------------------------------------------- */

export interface BalancePair {
  readonly label: string;
  readonly outstanding: number;
  readonly overdue: number;
  readonly notDue: number;
}

/**
 * What customers owe against what the business owes.
 *
 * Each bar is split into the part that is late and the part that is not yet
 * due, so a reader can see at a glance how much of the money is actually
 * overdue rather than having to read the total and worry.
 */
export function ReceivablesPayablesChart({
  data,
  format,
  height = 260,
}: {
  readonly data: readonly BalancePair[];
  readonly format: CurrencyFormatter;
  readonly height?: number | undefined;
}): React.JSX.Element {
  const hasData = data.some((row) => row.outstanding !== 0);

  return (
    <div>
      {data.length === 0 || !hasData ? (
        <EmptyPlot message="Nothing is outstanding." height={height} />
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
            <XAxis dataKey="label" tick={AXIS_TICK} axisLine={{ stroke: "var(--border)" }} tickLine={false} />
            <YAxis
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={64}
              tickFormatter={(value: number) => format(value)}
            />
            <Tooltip
              cursor={{ fill: "var(--table-row-hover)" }}
              content={({ active, payload, label }) => {
                if (!active || payload === undefined || payload.length === 0) return null;
                const point = payload[0]?.payload as
                  | { overdue: number; notDue: number; outstanding: number }
                  | undefined;
                if (point === undefined) return null;
                return (
                  <TooltipCard
                    title={String(label)}
                    rows={[
                      { label: "Not yet due", value: format(point.notDue), color: "var(--chart-1)" },
                      { label: "Overdue", value: format(point.overdue), color: "var(--chart-4)" },
                      { label: "Total outstanding", value: format(point.outstanding) },
                    ]}
                  />
                );
              }}
            />
            <Legend
              verticalAlign="top"
              height={28}
              iconType="circle"
              iconSize={8}
              wrapperStyle={{ fontSize: 11, color: "var(--text-2)" }}
            />
            <Bar
              dataKey="notDue"
              name="Not yet due"
              stackId="outstanding"
              fill="var(--chart-1)"
              radius={[0, 0, 0, 0]}
              maxBarSize={48}
            />
            <Bar
              dataKey="overdue"
              name="Overdue"
              stackId="outstanding"
              fill="var(--chart-4)"
              radius={[4, 4, 0, 0]}
              maxBarSize={48}
            />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* F. profit trend                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Gross profit and net profit over time.
 *
 * The gap between the two lines is the running costs of the business, drawn
 * to scale: a widening gap is a business whose overheads are eating its
 * margin.
 */
export function ProfitTrendChart({
  data,
  format,
  height = 260,
}: {
  readonly data: readonly FinanceSeriesPoint[];
  readonly format: CurrencyFormatter;
  readonly height?: number | undefined;
}): React.JSX.Element {
  const rows = useMemo(
    () =>
      data.map((point) => ({
        label: point.label,
        grossProfit: point.grossProfitFils,
        netProfit: point.netProfitFils,
      })),
    [data],
  );

  const hasData = rows.some((row) => row.grossProfit !== 0 || row.netProfit !== 0);

  return (
    <div>
      {rows.length === 0 || !hasData ? (
        <EmptyPlot message="No profit recorded in this period." height={height} />
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <LineChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: -4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
            <XAxis dataKey="label" tick={AXIS_TICK} axisLine={{ stroke: "var(--border)" }} tickLine={false} />
            <YAxis
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={64}
              tickFormatter={(value: number) => format(value)}
            />
            <Tooltip
              cursor={{ stroke: "var(--chart-grid)" }}
              content={({ active, payload, label }) => {
                if (!active || payload === undefined || payload.length === 0) return null;
                const point = payload[0]?.payload as
                  | { grossProfit: number; netProfit: number }
                  | undefined;
                if (point === undefined) return null;
                return (
                  <TooltipCard
                    title={String(label)}
                    rows={[
                      { label: "Gross profit", value: format(point.grossProfit), color: "var(--chart-5)" },
                      { label: "Net profit", value: format(point.netProfit), color: "var(--chart-2)" },
                      {
                        label: "Running costs",
                        value: format(point.grossProfit - point.netProfit),
                      },
                    ]}
                  />
                );
              }}
            />
            <Legend
              verticalAlign="top"
              height={28}
              iconType="circle"
              iconSize={8}
              wrapperStyle={{ fontSize: 11, color: "var(--text-2)" }}
            />
            <Line
              type="monotone"
              dataKey="grossProfit"
              name="Gross profit"
              stroke="var(--chart-5)"
              strokeWidth={2}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="netProfit"
              name="Net profit"
              stroke="var(--chart-2)"
              strokeWidth={2}
              dot={false}
              strokeDasharray="4 3"
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

export { CHART_SERIES_VARS };
