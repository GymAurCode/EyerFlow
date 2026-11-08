/**
 * Sales by Category donut chart for the dashboard.
 *
 * Teal shades + grey, center total, compact legend list below.
 */

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { chartSeries } from "./chart-theme";
import { formatMoney } from "../../lib/format";

export interface CategorySlice {
  readonly name: string;
  readonly value: number;
}

export interface CategoryDonutProps {
  readonly data: readonly CategorySlice[];
  readonly total: number;
  readonly height?: number | undefined;
}

export function CategoryDonut({
  data,
  total,
  height = 180,
}: CategoryDonutProps): React.JSX.Element {
  const chartData = data.map((d) => ({ name: d.name, value: d.value / 100 }));

  return (
    <div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              innerRadius="60%"
              outerRadius="85%"
              paddingAngle={2}
              dataKey="value"
              strokeWidth={0}
            >
              {chartData.map((_entry, index) => (
                <Cell key={`cell-${String(index)}`} fill={chartSeries(index)} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
                boxShadow: "var(--shadow-overlay)",
              }}
              formatter={(value) => [formatMoney(Number(value) * 100), ""]}
            />
          </PieChart>
        </ResponsiveContainer>

        {/* Center label */}
        <div className="pointer-events-none relative -mt-[120px] flex h-[120px] flex-col items-center justify-center">
          <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Total</span>
          <span className="tabular text-sm font-semibold text-[var(--text-primary)]">
            {formatMoney(total)}
          </span>
        </div>
      </div>

      {/* Compact legend list below */}
      {data.length > 0 && (
        <div className="mt-2 space-y-1">
          {data.map((slice, index) => {
            const pct = total > 0 ? Math.round((slice.value / total) * 100) : 0;
            return (
              <div key={slice.name} className="flex items-center justify-between text-[11px]">
                <span className="flex items-center gap-1.5 text-[var(--text-secondary)]">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: chartSeries(index) }}
                  />
                  {slice.name}
                </span>
                <span className="tabular text-[var(--text-muted)]">{pct}%</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
