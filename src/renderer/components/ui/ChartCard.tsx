/**
 * ChartCard: a titled card with a header, a divider and a plot area.
 *
 * Every chart on every page goes in one of these so they line up with each
 * other and with the data table beside them. The header carries an optional
 * range switch on the right, which is where a chart's own time filter belongs
 * rather than in the page-level filter bar.
 *
 * The body reserves its height whether or not there is data, so a chart that
 * fills in does not shove the rest of the page down.
 */

import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export type ChartRange = "7D" | "30D" | "6M" | "12M";

export const CHART_RANGES: readonly ChartRange[] = ["7D", "30D", "6M", "12M"];

export interface ChartCardProps {
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly children: ReactNode;
  /** Rendered at the right of the header: a range switch, a link, a button. */
  readonly action?: ReactNode | undefined;
  /** Plot height in pixels. */
  readonly height?: number | undefined;
  readonly className?: string | undefined;
  /** Shown instead of the plot when there is nothing to draw. */
  readonly empty?: boolean | undefined;
  readonly emptyMessage?: string | undefined;
}

export function ChartCard({
  title,
  subtitle,
  children,
  action,
  height = 240,
  className,
  empty = false,
  emptyMessage = "No data yet",
}: ChartCardProps): React.JSX.Element {
  return (
    <section className={cn("card flex flex-col", className)}>
      <header className="flex items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-[var(--text)]">{title}</h2>
          {subtitle !== undefined && (
            <p className="truncate text-xs text-[var(--text-3)]">{subtitle}</p>
          )}
        </div>
        {action}
      </header>

      <div className="h-px shrink-0 bg-[var(--border)]" />

      <div className="flex-1 p-4">
        {empty ? (
          <div
            className="flex flex-col items-center justify-center gap-2 text-center"
            style={{ height }}
          >
            {/* A dashed flat line rather than an illustration: it reads as
                "the chart is fine, there is just nothing to plot yet". */}
            <svg width="120" height="24" aria-hidden="true" className="text-[var(--border-strong)]">
              <line
                x1="0"
                y1="12"
                x2="120"
                y2="12"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeDasharray="5 5"
              />
            </svg>
            <p className="text-xs text-[var(--text-3)]">{emptyMessage}</p>
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

/**
 * Range switch for a chart header.
 *
 * A segmented control rather than a `<select>`: the options are short, fixed
 * and worth seeing all at once, and it avoids a native popup that would paint
 * outside the theme.
 */
export function RangeToggle({
  value,
  onChange,
  ranges = CHART_RANGES,
}: {
  readonly value: ChartRange;
  readonly onChange: (range: ChartRange) => void;
  readonly ranges?: readonly ChartRange[] | undefined;
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label="Chart range"
      className="flex shrink-0 items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-0.5"
    >
      {ranges.map((range) => (
        <button
          key={range}
          type="button"
          aria-pressed={value === range}
          onClick={() => {
            onChange(range);
          }}
          className={cn(
            "rounded-md px-2 py-1 text-[11px] font-medium transition-colors duration-fast",
            value === range
              ? "bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-sm)]"
              : "text-[var(--text-2)] hover:text-[var(--text)]",
          )}
        >
          {range}
        </button>
      ))}
    </div>
  );
}
