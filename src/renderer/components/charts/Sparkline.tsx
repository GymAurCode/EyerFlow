/**
 * Sparkline: a tiny 110x36 area chart for KPI cards.
 *
 * No axes, no grid, no tooltip. Dark teal line with very light teal area fill.
 * Empty data shows a flat dashed line, not a broken chart.
 */

import { Area, AreaChart, ResponsiveContainer } from "recharts";

export interface SparklineProps {
  readonly data: readonly number[];
  /** Line colour: dark teal (default), amber (expenses), or green (profit). */
  readonly tone?: "brand" | "amber" | "green" | undefined;
  /** Width in pixels. Default 110. */
  readonly width?: number | undefined;
  /** Height in pixels. Default 36. */
  readonly height?: number | undefined;
}

/**
 * Line and area colours per tone, all as variable references so the line
 * repaints with the theme without the chart having to re-render.
 *
 * `currentColor` on the fill lets the area inherit the stroke's colour, which
 * is what keeps a single token in charge of a tone instead of two that can
 * drift apart.
 */
const TONES = {
  brand: { line: "var(--chart-1)", fill: "var(--chart-area)" },
  amber: { line: "var(--chart-4)", fill: "var(--chart-area-warm)" },
  green: { line: "var(--success)", fill: "var(--chart-area-good)" },
} as const;

export function Sparkline({
  data,
  tone = "brand",
  width = 110,
  height = 36,
}: SparklineProps): React.JSX.Element {
  const colors = TONES[tone];
  const chartData = data.map((value, index) => ({ index, value }));
  const isEmpty = data.length === 0 || data.every((v) => v === 0);

  return (
    <div style={{ width, height }} aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
          <Area
            type="monotone"
            dataKey="value"
            stroke={isEmpty ? "var(--text-muted)" : colors.line}
            strokeWidth={1.5}
            fill={isEmpty ? "transparent" : colors.fill}
            dot={false}
            isAnimationActive={false}
            {...(isEmpty ? { strokeDasharray: "4 3" } : {})}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
