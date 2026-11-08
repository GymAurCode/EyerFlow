/**
 * StatCard: the KPI tile that heads the dashboard.
 *
 * A neutral piece of glass - same surface, same border, same shadow as every
 * other panel - carrying four things: a small icon chip, a label, the figure,
 * and a change against the previous period. Colour is spent on the chip, the
 * trend indicator and the status; the card itself is never tinted.
 *
 * The tiles are 160px tall so four of them sit in one row without pushing the
 * table below the fold, and wide enough for a money figure and its trend on one
 * line. That 160px is a floor rather than a ceiling: the figure, the label and
 * the sparkline are laid out at their natural size and the tile grows if they
 * need more room, so a large amount is never cut in half.
 *
 * `sparkline` is optional and should only be passed where a real series backs
 * it - the dashboard derives the inventory-value tile's line from the movement
 * ledger, and the tiles with no history simply omit it rather than drawing a
 * decorative one.
 *
 * The card is a link when `onClick` is given, so a KPI is a way into the list
 * it summarises rather than a dead end. Hover lifts it 2px and presses it back
 * down - transform only, so the lift never costs a reflow.
 */

import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "../../lib/utils";
import { GlassChip, type ChipTone } from "./Glass";
import { Sparkline } from "../charts/Sparkline";

export type StatTone = "brand" | "violet" | "success" | "warning" | "danger" | "info" | "neutral";

/** Icon colour plus the light each tile's chip is lit with. One pair per tone. */
const TONES: Record<StatTone, { readonly icon: string; readonly chip: ChipTone }> = {
  brand: { icon: "text-[var(--brand)]", chip: "brand" },
  violet: { icon: "text-[var(--violet)]", chip: "violet" },
  success: { icon: "text-[var(--success)]", chip: "teal" },
  warning: { icon: "text-[var(--warning)]", chip: "amber" },
  danger: { icon: "text-[var(--danger)]", chip: "rose" },
  info: { icon: "text-[var(--cyan)]", chip: "cyan" },
  neutral: { icon: "text-[var(--text-2)]", chip: "neutral" },
};

export interface StatCardProps {
  readonly label: string;
  readonly value: string;
  /** One-line explanation under the label. */
  readonly hint?: string | undefined;
  readonly icon?: ReactNode | undefined;
  readonly tone?: StatTone | undefined;
  /**
   * Change against the previous period, as a fraction (0.12 = +12%).
   * Omit it, or pass null, where there is no previous period to compare with.
   */
  readonly delta?: number | null | undefined;
  /** Text beside the change, e.g. "vs last week". */
  readonly deltaLabel?: string | undefined;
  /** Figures where a fall is good - expenses, outstanding balances. */
  readonly invertDelta?: boolean | undefined;
  /** Real history for this figure. Omit where there is none. */
  readonly sparkline?: readonly number[] | undefined;
  readonly sparklineTone?: "brand" | "amber" | "green" | undefined;
  readonly onClick?: (() => void) | undefined;
  /** Admin-only figures are hidden from staff rather than shown as zero. */
  readonly hiddenForStaff?: boolean | undefined;
}

export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = "brand",
  delta,
  deltaLabel,
  invertDelta = false,
  sparkline,
  sparklineTone = "brand",
  onClick,
  hiddenForStaff = false,
}: StatCardProps): React.JSX.Element | null {
  // A figure the viewer is not allowed to see must not occupy space as a
  // placeholder either: an empty card where "Net profit" should be is a
  // clearer statement of "not yours to see" than a zero.
  if (hiddenForStaff) return null;

  const palette = TONES[tone];

  const content = (
    <>
      <div className="flex items-center gap-3">
        {icon !== undefined && (
          <GlassChip tone={palette.chip} className="h-10 w-10 shrink-0">
            <span className={cn(palette.icon)}>{icon}</span>
          </GlassChip>
        )}
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium text-[var(--text-2)]">{label}</div>
          {hint !== undefined && (
            <div className="truncate text-[11.5px] text-[var(--text-3)]">{hint}</div>
          )}
        </div>
      </div>

      {/* The figure gets the full width of the tile: a money value truncated to
          "Rs 9..." is worse than a small sparkline beside it.

          Three things keep the digits whole, and all three are load-bearing:

          - `leading-tight` (1.25) rather than `leading-none`. Inter's ink box is
            1.21em - ascender plus descender over the em square - so a 26px
            figure needs a line box of at least 31.5px. `leading-none` hands it
            26px, and the glyphs spill out of their own line.
          - `shrink-0`. As a flex child the figure was being squeezed from its
            30px natural box down to 20px to make the height budget balance.
            The tile now grows instead of compressing, and this keeps it honest
            if it is ever constrained again: a figure is a single line that
            either fits or wraps, never one that gets squashed.
          - no `truncate`. `overflow: hidden` is what let flexbox shrink the box
            in the first place (an item that clips has no automatic minimum
            size), and it is also what sliced the clipped-off digits off. A long
            figure wraps onto a second line instead.

          `min-w-0` plus `break-words` is the long-value guard: a nine-figure
          amount wraps at a digit rather than pushing the layout sideways. */}
      <div className="tabular min-w-0 shrink-0 break-words text-[26px] font-semibold leading-tight text-[var(--text)]">
        {value}
      </div>

      <div className="flex items-end justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {delta !== undefined && delta !== null && (
            <DeltaPill delta={delta} invert={invertDelta} />
          )}
          {deltaLabel !== undefined && (
            <span className="truncate text-[11.5px] text-[var(--text-3)]">{deltaLabel}</span>
          )}
        </div>

        {sparkline !== undefined && sparkline.length > 1 && (
          <div className="shrink-0">
            <Sparkline data={sparkline} tone={sparklineTone} width={96} height={34} />
          </div>
        )}
      </div>
    </>
  );

  // `min-h` rather than a fixed `h`. The tile keeps its designed height for the
  // figures that fit it, but a long money value or a taller label grows the card
  // instead of being clipped by it - which is what the fixed height was doing.
  // `overflow-hidden` stays, because `.card` needs it to clip a sparkline to the
  // rounded corners; with a min-height there is nothing left for it to cut.
  const classes = cn(
    "glass card card-interactive flex min-h-[160px] w-full flex-col justify-between gap-3 overflow-hidden p-5 text-start",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
  );

  if (onClick !== undefined) {
    return (
      <button type="button" onClick={onClick} className={classes}>
        {content}
      </button>
    );
  }

  return <div className={classes}>{content}</div>;
}

/**
 * Direction of the change.
 *
 * `invert` is for figures where down is good - expenses, outstanding balances -
 * so a fall reads as an improvement rather than a loss.
 */
export function DeltaPill({
  delta,
  invert = false,
}: {
  readonly delta: number;
  readonly invert?: boolean;
}): React.JSX.Element {
  const percent = Math.round(delta * 100);

  // Exactly zero is shown as flat rather than as a green or red 0%: there is
  // no movement to celebrate or worry about.
  if (percent === 0) {
    return (
      <span className="tabular flex shrink-0 items-center gap-0.5 text-[12px] font-medium text-[var(--text-3)]">
        <Minus className="h-3.5 w-3.5" aria-hidden="true" />
        0%
      </span>
    );
  }

  const up = percent > 0;
  const good = invert ? !up : up;

  return (
    <span
      className={cn(
        "tabular flex shrink-0 items-center gap-0.5 text-[12px] font-medium",
        good ? "text-[var(--success)]" : "text-[var(--danger)]",
      )}
    >
      {up ? (
        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <ArrowDownRight className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      {Math.abs(percent)}%
    </span>
  );
}
