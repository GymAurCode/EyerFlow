/**
 * A selectable colour-pack card.
 *
 * The preview is not a hand-picked set of swatches: the card carries the
 * `data-theme` and `data-palette` pair, so the stylesheet resolves that pack's
 * real tokens inside the card even when the surrounding page is on another one.
 * The same component is used by the Appearance screen and the first-login
 * chooser, so a new pack never needs a second preview to be written.
 */

import { Check } from "lucide-react";
import type { ThemeDefinition } from "../../../shared/themes";
import { cn } from "../../lib/utils";

export interface ThemeCardProps {
  readonly theme: ThemeDefinition;
  /** Which of the pack's two modes to draw the preview in. */
  readonly mode: "light" | "dark";
  readonly selected: boolean;
  readonly onSelect: () => void;
  /** Adds a second line of detail; the chooser uses it for its hint. */
  readonly hint?: string | undefined;
}

export function ThemeCard({
  theme,
  mode,
  selected,
  onSelect,
  hint,
}: ThemeCardProps): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`${theme.name}${selected ? " (selected)" : ""}`}
      onClick={onSelect}
      className={cn(
        "group relative flex w-full flex-col rounded-xl border p-2 text-start transition-[border-color,background-color,box-shadow] duration-fast",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]",
        selected
          ? "border-[var(--brand)] bg-[var(--surface)] ring-2 ring-[color-mix(in_srgb,var(--brand)_26%,transparent)]"
          : "border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--border-strong)] hover:bg-[var(--surface)]",
      )}
    >
      {selected && (
        <span
          className="absolute end-3 top-3 z-10 flex h-5 w-5 items-center justify-center rounded-full shadow-sm"
          style={{ background: "var(--brand)", color: "var(--on-brand)" }}
          aria-hidden="true"
        >
          <Check className="h-3 w-3" strokeWidth={3} />
        </span>
      )}

      {/* The real palette, resolved by the stylesheet inside this card. */}
      <span
        className="block overflow-hidden rounded-lg border"
        data-theme={mode}
        data-palette={theme.id}
        data-preview-surface=""
        style={{ borderColor: "var(--border)" }}
        aria-hidden="true"
      >
        <span className="flex h-[78px]" style={{ background: "var(--bg)" }}>
          <span
            className="flex w-9 shrink-0 flex-col gap-1 p-1.5"
            style={{ background: "var(--sidebar-bg)" }}
          >
            <span
              className="h-2 w-2 self-start rounded-[3px]"
              style={{ background: "var(--sidebar-active-fg)" }}
            />
            <span
              className="mt-1.5 block h-1 w-full rounded-full"
              style={{ background: "var(--sidebar-active-bg)" }}
            />
            <span
              className="block h-1 w-4/5 rounded-full"
              style={{ background: "var(--sidebar-text-muted)" }}
            />
            <span
              className="block h-1 w-3/5 rounded-full"
              style={{ background: "var(--sidebar-text-muted)" }}
            />
            <span
              className="block h-1 w-4/5 rounded-full"
              style={{ background: "var(--sidebar-text-muted)" }}
            />
          </span>

          <span className="flex min-w-0 flex-1 flex-col">
            <span
              className="flex h-4 shrink-0 items-center justify-between border-b px-1.5"
              style={{ background: "var(--header-bg)", borderColor: "var(--border)" }}
            >
              <span className="h-1 w-10 rounded-full" style={{ background: "var(--text-3)" }} />
              <span className="flex gap-1">
                <span
                  className="h-1.5 w-3 rounded-full"
                  style={{ background: "var(--surface-3)" }}
                />
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--brand)" }} />
              </span>
            </span>

            <span
              className="flex flex-1 flex-col gap-1 p-1.5"
              style={{ background: "var(--main-bg)" }}
            >
              <span className="flex gap-1">
                <span
                  className="h-4 flex-1 rounded border"
                  style={{ background: "var(--surface)", borderColor: "var(--border)" }}
                />
                <span
                  className="h-4 flex-1 rounded border"
                  style={{ background: "var(--surface)", borderColor: "var(--border)" }}
                />
              </span>
              <span
                className="mt-0.5 block h-1 w-full rounded-full"
                style={{ background: "var(--border)" }}
              />
              <span
                className="block h-1 w-4/5 rounded-full"
                style={{ background: "var(--border)" }}
              />
              <span
                className="block h-1 w-3/5 rounded-full"
                style={{ background: "var(--brand)", opacity: 0.55 }}
              />
            </span>
          </span>
        </span>
      </span>

      <span className="mt-2 flex items-start justify-between gap-2 px-0.5">
        <span className="min-w-0">
          <span className="block truncate text-[12.5px] font-semibold text-[var(--text)]">
            {theme.name}
          </span>
          <span className="mt-0.5 block truncate text-[10.5px] text-[var(--text-3)]">
            {hint ?? theme.blurb}
          </span>
        </span>

        <span
          className="mt-0.5 flex shrink-0 gap-1"
          data-theme={mode}
          data-palette={theme.id}
          data-preview-surface=""
          aria-hidden="true"
        >
          {["--brand", "--sidebar-bg", "--bg", "--violet", "--gold"].map((token) => (
            <span
              key={token}
              className="h-2.5 w-2.5 rounded-full border border-black/10"
              style={{ background: `var(${token})` }}
            />
          ))}
        </span>
      </span>
    </button>
  );
}
