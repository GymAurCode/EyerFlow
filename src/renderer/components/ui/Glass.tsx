/**
 * Glass decoration primitives.
 *
 * The material itself lives in `styles.css` (`.glass`, `.glass-float`,
 * `.glass-chip`); this module is the small amount of React that dresses a
 * surface with it, so that no screen has to hand-write the same layering.
 *
 * Rules this file exists to enforce:
 *
 *  - `GlassChip` is the only decoration in the app. It is a small piece of the
 *    same glass as the panel it sits on, and `tone` only chooses the light it
 *    is lit with; the icon itself keeps its semantic colour, so a green chip
 *    still reads as "healthy".
 *  - Nothing here animates on a timer. The only motion in the design system is
 *    the hover/press lift on a control, and the base layer switches it off
 *    under `prefers-reduced-motion`.
 *  - No surface is tinted end to end: a chip carries the colour, the panel
 *    behind it stays neutral.
 */

import type { CSSProperties, ReactNode } from "react";
import { cn } from "../../lib/utils";

export type ChipTone = "brand" | "violet" | "cyan" | "teal" | "gold" | "amber" | "rose" | "neutral";

/**
 * Tone class names, written out in full.
 *
 * They cannot be composed (` chip-${tone} `) because Tailwind builds the
 * stylesheet from the literals it can find in the source: a name assembled at
 * runtime never appears, so the rule is dropped from the bundle. Each tone here
 * resolves a single `--chip-glow` variable instead, and the colour itself
 * stays in `styles.css`.
 */
const CHIP_TONE_CLASS: Record<ChipTone, string> = {
  brand: "chip-brand",
  violet: "chip-violet",
  cyan: "chip-cyan",
  teal: "chip-teal",
  gold: "chip-gold",
  amber: "chip-amber",
  rose: "chip-rose",
  neutral: "chip-neutral",
};

/**
 * An icon sitting on its own small piece of glass.
 *
 * `tone` only chooses the light the chip is lit with; the icon itself stays
 * the semantic colour, so a green chip still reads as "healthy".
 */
export function GlassChip({
  tone = "brand",
  className,
  children,
  style,
}: {
  readonly tone?: ChipTone | undefined;
  readonly className?: string | undefined;
  readonly children: ReactNode;
  readonly style?: CSSProperties | undefined;
}): React.JSX.Element {
  return (
    <span className={cn("glass-chip", CHIP_TONE_CLASS[tone], className)} style={style}>
      {children}
    </span>
  );
}
