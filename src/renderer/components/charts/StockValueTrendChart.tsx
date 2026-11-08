/**
 * Stock value trend.
 *
 * One blue line with a soft area under it and a dot on each day, plotted over
 * the window the card's range switch selects.
 *
 * The series itself is derived on the dashboard from the stock ledger rather
 * than stored: today's valuation is the products' own stock value, and each
 * earlier day is that figure with everything the ledger moved since then taken
 * back out. It is the same arithmetic the Stock report uses, walked backwards,
 * so the last point of the line always equals the "Total Stock Value" tile.
 */

import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatMoney } from "../../lib/format";

export interface StockValuePoint {
  readonly date: string;
  readonly valueFils: number;
}

export interface StockValueTrendChartProps {
  readonly data: readonly StockValuePoint[];
  readonly height?: number | undefined;
  /** Wording for the empty case, so it can name the window. */
  readonly emptyMessage?: string | undefined;
}

/** `2026-10-04` -> `Oct 4`, without pulling the whole locale machinery in. */
function shortDate(iso: string): string {
  const month = Number.parseInt(iso.slice(5, 7), 10);
  const day = Number.parseInt(iso.slice(8, 10), 10);
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const name = names[Math.min(Math.max(month - 1, 0), 11)];
  return `${name ?? ""} ${String(day)}`.trim();
}

/**
 * Axis ticks: whole units, shortened to thousands so the labels do not collide.
 *
 * The values are in currency units (fils/100), so the axis is a currency axis
 * and is told to say so rather than printing a bare number beside a money
 * chart.
 */
function axisMoney(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1000) return `${value < 0 ? "-" : ""}${String(Math.round(value / 1000))}k`;
  return String(Math.round(value));
}

export function StockValueTrendChart({
  data,
  height = 280,
  emptyMessage = "No stock movements in this period yet.",
}: StockValueTrendChartProps): React.JSX.Element {
  const points = data.map((point) => ({ ...point, label: shortDate(point.date) }));

  // Animate the first paint only. Recharts' default tween re-runs on every data
  // change, which made the chart visibly twitch on each quiet refetch.
  const [animated, setAnimated] = useState(true);
  useEffect(() => {
    setAnimated(false);
  }, []);

  if (points.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-sm text-[var(--text-3)]"
        style={{ height }}
      >
        {emptyMessage}
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
        <defs>
          <linearGradient id="stockValueFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.22} />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
          </linearGradient>
        </defs>

        <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />

        <XAxis
          dataKey="label"
          tick={{ fontSize: 11, fill: "var(--text-3)" }}
          axisLine={{ stroke: "var(--border)" }}
          tickLine={false}
          tickMargin={10}
          minTickGap={16}
        />
        <YAxis
          tick={{ fontSize: 11, fill: "var(--text-3)" }}
          axisLine={false}
          tickLine={false}
          width={56}
          tickFormatter={axisMoney}
        />

        <Tooltip
          cursor={{ stroke: "var(--border-strong)", strokeWidth: 1 }}
          contentStyle={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            fontSize: 12,
            boxShadow: "var(--shadow-md)",
          }}
          labelStyle={{ color: "var(--text-2)", marginBottom: 4 }}
          formatter={(value) => [formatMoney(Number(value ?? 0) * 100), "Stock value"]}
        />

        <Area
          type="monotone"
          dataKey="value"
          name="Stock value"
          stroke="var(--chart-1)"
          strokeWidth={2}
          fill="url(#stockValueFill)"
          dot={{ r: 3, fill: "var(--chart-1)", strokeWidth: 0 }}
          activeDot={{ r: 5, fill: "var(--chart-1)", stroke: "var(--surface)", strokeWidth: 2 }}
          isAnimationActive={animated}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}