/**
 * Sales vs Expenses chart for the dashboard.
 *
 * Area/bar combo, dark teal for sales, grey for expenses.
 * Light dashed grid, small legend top-right, 6M/12M range toggle in header.
 */

import { useEffect, useState } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatMoney } from "../../lib/format";

export interface SalesExpensePoint {
  readonly month: string;
  readonly salesFils: number;
  readonly expenseFils: number;
}

export interface SalesExpenseChartProps {
  readonly data: readonly SalesExpensePoint[];
  readonly height?: number | undefined;
}

function monthLabel(month: string): string {
  const index = Number(month.slice(5, 7)) - 1;
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return names[Math.min(Math.max(index, 0), 11)] ?? month;
}

export function SalesExpenseChart({ data, height = 260 }: SalesExpenseChartProps): React.JSX.Element {
  const [range, setRange] = useState<"6M" | "12M">("6M");
  const months = range === "6M" ? 6 : 12;
  const chartData = data.slice(-months).map((point) => ({
    month: monthLabel(point.month),
    sales: point.salesFils / 100,
    expenses: point.expenseFils / 100,
  }));

  // Animate the first paint only. Recharts' default tween re-runs on every
  // data change, which meant a background refetch made the chart visibly
  // twitch every time the page quietly refreshed.
  const [animated, setAnimated] = useState(true);
  useEffect(() => {
    setAnimated(false);
  }, []);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] p-0.5">
          {(["6M", "12M"] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => { setRange(r); }}
              className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors duration-fast ${
                range === r
                  ? "bg-[var(--surface)] text-[var(--text-primary)] shadow-[var(--shadow-card)]"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 text-[11px] text-[var(--text-secondary)]">
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-[var(--chart-1)]" />
            Sales
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-[var(--chart-3)]" />
            Expenses
          </span>
        </div>
      </div>

      {chartData.length === 0 ? (
        <div className="flex items-center justify-center text-sm text-[var(--text-muted)]" style={{ height: height - 32 }}>
          No activity recorded yet.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={height - 32}>
          <ComposedChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
            <XAxis
              dataKey="month"
              tick={{ fontSize: 11, fill: "var(--text-muted)" }}
              axisLine={{ stroke: "var(--border)" }}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "var(--text-muted)" }}
              axisLine={false}
              tickLine={false}
              width={56}
              tickFormatter={(value: number) => String(Math.round(value))}
            />
            <Tooltip
              cursor={{ fill: "var(--table-row-hover)" }}
              contentStyle={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
                boxShadow: "var(--shadow-overlay)",
              }}
              formatter={(value, name) => [
                formatMoney(Number(value) * 100),
                name === "sales" ? "Sales" : "Expenses",
              ]}
            />
            <Area
              type="monotone"
              dataKey="sales"
              name="Sales"
              stroke="var(--chart-1)"
              strokeWidth={1.5}
              fill="var(--chart-area)"
              dot={false}
              isAnimationActive={animated}
            />
            <Bar
              dataKey="expenses"
              name="Expenses"
              fill="var(--chart-3)"
              radius={[4, 4, 0, 0]}
              maxBarSize={24}
              isAnimationActive={animated}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
