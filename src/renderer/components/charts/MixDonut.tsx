/**
 * MixDonut: a compact ring chart with its legend beside it.
 *
 * Used where the question is "what is this made of" rather than "how did it
 * move" - the dashboard's stock overview, and any mix of products, categories
 * or parties. A ring rather than a pie because the centre is carrying the
 * total, which is the figure the panel is really about.
 *
 * Slice colours come from the chart tokens through `chartSeries`, so the ring
 * repaints with the theme without the chart re-rendering, and a given category
 * keeps its colour everywhere it appears. Percentages are computed from the
 * total that is passed in, never from the sum of the visible slices, so the
 * "Other" bucket cannot quietly change what each real category reads as.
 */

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { chartSeries } from "./chart-theme";

export interface MixSlice {
  readonly name: string;
  readonly value: number;
}

export interface MixDonutProps {
  readonly data: readonly MixSlice[];
  /** The full total the percentages are taken against. */
  readonly total: number;
  /** Pre-formatted figure shown in the middle of the ring. */
  readonly centerValue: string;
  readonly centerLabel: string;
  /** Formats one slice for the tooltip. */
  readonly tooltipFormat?: ((value: number) => string) | undefined;
  /** Diameter of the ring area in pixels. */
  readonly size?: number | undefined;
  /** Hides the legend for a caller that draws its own. */
  readonly legend?: boolean | undefined;
  readonly emptyMessage?: string | undefined;
}

export function MixDonut({
  data,
  total,
  centerValue,
  centerLabel,
  tooltipFormat,
  size = 156,
  legend = true,
  emptyMessage = "Nothing to show yet.",
}: MixDonutProps): React.JSX.Element {
  if (data.length === 0 || total <= 0) {
    return <p className="py-6 text-center text-[12.5px] text-[var(--text-3)]">{emptyMessage}</p>;
  }

  return (
    <div className="flex items-center gap-4">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={[...data]}
              cx="50%"
              cy="50%"
              innerRadius="66%"
              outerRadius="96%"
              paddingAngle={2}
              dataKey="value"
              strokeWidth={0}
              isAnimationActive={false}
            >
              {data.map((slice, index) => (
                <Cell key={slice.name} fill={chartSeries(index)} />
              ))}
            </Pie>
            <Tooltip
              cursor={false}
              contentStyle={{
                background: "var(--surface-float)",
                border: "1px solid var(--glass-border)",
                borderRadius: 12,
                fontSize: 12,
                color: "var(--text)",
                boxShadow: "var(--shadow-float)",
              }}
              labelStyle={{ color: "var(--text)", fontWeight: 600 }}
              formatter={(value) => [
                tooltipFormat === undefined
                  ? Number(value).toLocaleString("en-US")
                  : tooltipFormat(Number(value)),
                "",
              ]}
            />
          </PieChart>
        </ResponsiveContainer>

        <div
          className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center"
          aria-hidden="true"
        >
          <span className="tabular max-w-full truncate text-[17px] font-semibold leading-tight text-[var(--text)]">
            {centerValue}
          </span>
          <span className="mt-0.5 truncate text-[10.5px] text-[var(--text-3)]">{centerLabel}</span>
        </div>
      </div>

      {legend && (
        <ul className="min-w-0 flex-1 space-y-2">
          {data.map((slice, index) => {
            const percent = Math.round((slice.value / total) * 100);
            return (
              <li key={slice.name} className="flex items-center gap-2 text-[12.5px]">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: chartSeries(index) }}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate text-[var(--text-2)]">{slice.name}</span>
                <span className="tabular shrink-0 font-medium text-[var(--text)]">{percent}%</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}