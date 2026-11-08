/**
 * Chart theming.
 *
 * Every series colour is a CSS variable reference rather than a literal, so a
 * theme switch repaints the charts through the same mechanism as the rest of
 * the UI. `var(--chart-1)` in an SVG `fill` attribute is resolved by the
 * renderer on every paint, which means a chart does not need to re-render, and
 * cannot get out of step, when the palette changes.
 *
 * The palette is exposed as a function rather than a constant because a donut
 * needs several distinct series; the order is fixed so a given category keeps
 * the same colour across every chart and every page.
 */

/** The categorical series palette, in assignment order. */
export const CHART_SERIES_VARS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

/** Colour for the nth series, wrapping if there are more slices than colours. */
export function chartSeries(index: number): string {
  return CHART_SERIES_VARS[index % CHART_SERIES_VARS.length] as string;
}

/**
 * A stable colour for a named series.
 *
 * Keyed by name rather than position so "Hardware" keeps its colour even when
 * a filter hides another category and everything shifts up a row.
 */
export function chartColorForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return chartSeries(Math.abs(hash));
}

/**
 * Track an appearance change so a chart can recompute anything it derived in
 * JavaScript.
 *
 * Most colour work needs nothing (the variables resolve themselves), but a
 * chart that reads a resolved value through `getComputedStyle` - to pick a
 * readable label colour, say - needs to know the appearance moved. Both the
 * mode class and the pack attribute are watched: a pack change repaints every
 * variable without touching `class`.
 */
import { useEffect, useState } from "react";

export function useThemeVersion(): number {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;

    const observer = new MutationObserver(() => {
      setVersion((current) => current + 1);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "data-palette"],
    });
    return () => {
      observer.disconnect();
    };
  }, []);

  return version;
}

/** Read a CSS custom property as a concrete colour, for canvas-like usage. */
export function readCssColor(name: string): string {
  if (typeof window === "undefined") return "";
  return window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
