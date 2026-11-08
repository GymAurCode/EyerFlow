/**
 * Appearance & Themes.
 *
 * Two independent choices live here: how bright the window is (light, dark, or
 * following the operating system) and which colour pack it uses. Keeping them
 * separate is what makes fifteen packs feel like fifteen designs rather than
 * thirty buttons - every pack is drawn in the mode the user is already in.
 *
 * The cards do not carry duplicated hex values. A card's preview sets
 * `data-theme` and `data-palette` on itself, so the stylesheet resolves that
 * pack's real tokens inside the card even though the page around it is on a
 * different pack. Adding a theme therefore needs no change here at all.
 *
 * Nothing is staged behind a Save button: every choice is applied to <html>
 * the moment it is made, and the live preview below is simply the app's own
 * tokens at a smaller size.
 */

import { useMemo, useState } from "react";
import { Monitor, Moon, RotateCcw, Search, Sun } from "lucide-react";
import {
  DEFAULT_THEME_ID,
  THEME_CATALOG,
  THEME_CATEGORIES,
  themeDefinition,
  type ThemeCategory,
} from "../../../shared/themes";
import type { ThemePreference } from "../../../shared/ipc";
import { useTheme } from "../../lib/app-context";
import { cn } from "../../lib/utils";
import { ThemeCard } from "../../components/theme/ThemeCard";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";

const MODE_OPTIONS: readonly {
  readonly value: ThemePreference;
  readonly label: string;
  readonly hint: string;
  readonly icon: typeof Sun;
}[] = [
  { value: "light", label: "Light", hint: "Bright surfaces", icon: Sun },
  { value: "dark", label: "Dark", hint: "Dim surfaces", icon: Moon },
  { value: "system", label: "System", hint: "Follow this device", icon: Monitor },
];

type CategoryFilter = ThemeCategory | "all";

export function AppearanceTab(): React.JSX.Element {
  const { theme, resolvedTheme, palette, setTheme, setPalette } = useTheme();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");

  const activeTheme = themeDefinition(palette);
  const modeLabel = theme === "system" ? `System (${resolvedTheme})` : capitalize(theme);

  const visibleThemes = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return THEME_CATALOG.filter((entry) => {
      if (category !== "all" && entry.category !== category) return false;
      if (needle.length === 0) return true;
      return (
        entry.name.toLowerCase().includes(needle) ||
        entry.id.includes(needle) ||
        entry.blurb.toLowerCase().includes(needle) ||
        entry.category.toLowerCase().includes(needle)
      );
    });
  }, [category, query]);

  const reset = (): void => {
    setQuery("");
    setCategory("all");
    void setPalette(DEFAULT_THEME_ID);
    void setTheme("system");
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-[var(--text)]">Appearance &amp; Themes</h2>
          <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-[var(--text-2)]">
            Choose how EyerStock looks. Every theme is a complete design system - surfaces, text,
            borders, tables, inputs and the navigation rail - in both light and dark mode. Changes
            apply instantly and are remembered on this computer.
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-xs"
            aria-label={`Active theme: ${activeTheme.name}, ${modeLabel}`}
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: "var(--brand)" }}
              aria-hidden="true"
            />
            <span className="text-[var(--text-3)]">Active</span>
            <span className="font-medium text-[var(--text)]">{activeTheme.name}</span>
            <span className="text-[var(--text-3)]" aria-hidden="true">
              ·
            </span>
            <span className="text-[var(--text-2)]">{modeLabel}</span>
          </span>
          <Button
            variant="secondary"
            size="sm"
            iconLeft={<RotateCcw className="h-3.5 w-3.5" />}
            onClick={reset}
            title="Ocean Teal, following this device"
          >
            Reset to default
          </Button>
        </div>
      </header>

      {/* mode ------------------------------------------------------------- */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-[13px] font-semibold text-[var(--text)]">Appearance mode</h3>
            <p className="mt-0.5 text-[11.5px] text-[var(--text-3)]">
              System follows the light or dark setting of this computer and changes with it.
            </p>
          </div>

          <div
            className="grid shrink-0 grid-cols-3 gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1"
            role="group"
            aria-label="Appearance mode"
          >
            {MODE_OPTIONS.map((option) => {
              const selected = theme === option.value;
              const Icon = option.icon;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={selected}
                  title={option.hint}
                  onClick={() => {
                    void setTheme(option.value);
                  }}
                  className={cn(
                    "flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors duration-fast",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]",
                    selected
                      ? "bg-[var(--brand)] text-[var(--on-brand)] shadow-[inset_0_1px_0_rgba(255,255,255,0.24)]"
                      : "text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* theme picker ---------------------------------------------------- */}
      <section aria-labelledby="theme-picker-heading">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 id="theme-picker-heading" className="text-[13px] font-semibold text-[var(--text)]">
              Colour theme
            </h3>
            <p className="mt-0.5 text-[11.5px] text-[var(--text-3)]">
              {visibleThemes.length} of {THEME_CATALOG.length} themes shown.
            </p>
          </div>

          <div className="relative w-full sm:w-56">
            <Search
              className="pointer-events-none absolute inset-y-0 start-3 my-auto h-3.5 w-3.5 text-[var(--text-3)]"
              aria-hidden="true"
            />
            <Input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              placeholder="Search themes…"
              aria-label="Search themes"
              className="h-9 ps-9 text-[12.5px]"
            />
          </div>
        </div>

        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Theme categories">
          <CategoryChip
            label="All"
            selected={category === "all"}
            onClick={() => {
              setCategory("all");
            }}
          />
          {THEME_CATEGORIES.map((entry) => (
            <CategoryChip
              key={entry}
              label={entry}
              selected={category === entry}
              onClick={() => {
                setCategory(entry);
              }}
            />
          ))}
        </div>

        <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {visibleThemes.map((entry) => (
            <ThemeCard
              key={entry.id}
              theme={entry}
              mode={resolvedTheme}
              selected={entry.id === palette}
              onSelect={() => {
                void setPalette(entry.id);
              }}
            />
          ))}
        </div>

        {visibleThemes.length === 0 && (
          <div className="mt-3 rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] px-4 py-8 text-center">
            <p className="text-[13px] font-medium text-[var(--text)]">No themes match</p>
            <p className="mt-1 text-xs text-[var(--text-3)]">
              Try a different word, or clear the filter.
            </p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              onClick={() => {
                setQuery("");
                setCategory("all");
              }}
            >
              Clear filters
            </Button>
          </div>
        )}
      </section>

      {/* live preview ---------------------------------------------------- */}
      <section
        aria-labelledby="live-preview-heading"
        className="border-t border-[var(--divider)] pt-5"
      >
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 id="live-preview-heading" className="text-[13px] font-semibold text-[var(--text)]">
              Live preview
            </h3>
            <p className="mt-0.5 text-[11.5px] text-[var(--text-3)]">
              Navigation, header, cards, inputs, tables, buttons and status badges - using the
              active theme and mode.
            </p>
          </div>
          <span className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[11px] font-medium text-[var(--text-2)]">
            {activeTheme.name} · {modeLabel}
          </span>
        </div>

        <div className="mt-3">
          <LivePreview />
        </div>
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* theme category chip                                                        */
/* -------------------------------------------------------------------------- */

function CategoryChip({
  label,
  selected,
  onClick,
}: {
  readonly label: string;
  readonly selected: boolean;
  readonly onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors duration-fast",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]",
        selected
          ? "border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand)]"
          : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-2)] hover:border-[var(--border-strong)] hover:text-[var(--text)]",
      )}
    >
      {label}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* live preview                                                               */
/* -------------------------------------------------------------------------- */

function LivePreview(): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--app-bg)] shadow-[inset_0_1px_0_var(--glass-edge-top)]">
      <div className="flex min-h-[248px]">
        {/* rail */}
        <div
          className="hidden w-36 shrink-0 flex-col gap-1 p-2.5 sm:flex"
          style={{ background: "var(--sidebar-bg)" }}
        >
          <div className="mb-2 flex items-center gap-2 px-1">
            <span
              className="h-5 w-5 rounded-md"
              style={{ background: "var(--sidebar-active-bg)" }}
            />
            <span
              className="h-1.5 w-14 rounded-full"
              style={{ background: "var(--sidebar-text)" }}
            />
          </div>
          <PreviewNavItem label="Dashboard" active />
          <PreviewNavItem label="Products" />
          <PreviewNavItem label="Sales" />
          <PreviewNavItem label="Purchases" />
          <PreviewNavItem label="Finance" />
          <span className="mt-auto flex items-center gap-2 rounded-md px-2 py-1.5">
            <span
              className="h-5 w-5 rounded-full"
              style={{ background: "var(--sidebar-active-bg)" }}
            />
            <span className="space-y-1">
              <span
                className="block h-1 w-12 rounded-full"
                style={{ background: "var(--sidebar-text)" }}
              />
              <span
                className="block h-1 w-8 rounded-full"
                style={{ background: "var(--sidebar-text-muted)" }}
              />
            </span>
          </span>
        </div>

        {/* working area */}
        <div className="min-w-0 flex-1" style={{ background: "var(--main-bg)" }}>
          <div
            className="flex h-12 items-center justify-between gap-3 border-b px-3.5"
            style={{ background: "var(--header-bg)", borderColor: "var(--border)" }}
          >
            <div>
              <p className="text-[11px] font-semibold text-[var(--text)]">Dashboard</p>
              <p className="text-[9px] text-[var(--text-3)]">Monday, 26 October</p>
            </div>
            <div className="flex items-center gap-1.5">
              <span
                className="flex h-6 w-20 items-center rounded-md border px-2 text-[8.5px]"
                style={{
                  background: "var(--input-bg)",
                  borderColor: "var(--input-border)",
                  color: "var(--text-3)",
                }}
              >
                Search…
              </span>
              <span
                className="flex h-6 items-center rounded-md px-2.5 text-[8.5px] font-semibold"
                style={{ background: "var(--brand)", color: "var(--on-brand)" }}
              >
                New sale
              </span>
            </div>
          </div>

          <div className="space-y-2.5 p-3.5">
            <div className="grid grid-cols-3 gap-2">
              <PreviewStat label="Sales today" value="48,250" accent="var(--brand)" />
              <PreviewStat label="Stock value" value="312,400" accent="var(--violet)" />
              <PreviewStat label="Receivable" value="76,900" accent="var(--gold)" />
            </div>

            <div
              className="overflow-hidden rounded-lg border"
              style={{ background: "var(--surface)", borderColor: "var(--border)" }}
            >
              <div
                className="grid grid-cols-[1.6fr_0.6fr_0.8fr_0.8fr] gap-2 border-b px-2.5 py-1.5 text-[8px] font-semibold uppercase tracking-wide"
                style={{
                  background: "var(--table-header-bg)",
                  borderColor: "var(--border)",
                  color: "var(--text-3)",
                }}
              >
                <span>Product</span>
                <span className="text-end">Qty</span>
                <span className="text-end">Rate</span>
                <span className="text-end">Total</span>
              </div>
              <PreviewRow name="Water filter cartridge" qty="2" rate="1,450" total="2,900" />
              <PreviewRow name="RO membrane 100 GPD" qty="1" rate="4,800" total="4,800" hovered />
              <PreviewRow name="Pressure pump" qty="3" rate="2,150" total="6,450" />
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className="flex h-6 items-center rounded-md border px-2.5 text-[8.5px] font-medium"
                style={{
                  background: "var(--surface)",
                  borderColor: "var(--glass-border)",
                  color: "var(--text)",
                }}
              >
                Secondary
              </span>
              <Badge tone="success">Paid</Badge>
              <Badge tone="warning">Part paid</Badge>
              <Badge tone="danger">Overdue</Badge>
              <Badge tone="info">Draft</Badge>
              <span
                className="ms-auto flex h-6 items-center rounded-md border px-2 text-[8.5px]"
                style={{
                  background: "var(--input-bg)",
                  borderColor: "var(--focus-ring)",
                  color: "var(--text-2)",
                  boxShadow: "0 0 0 2px color-mix(in srgb, var(--focus-ring) 22%, transparent)",
                }}
              >
                Focused field
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewNavItem({
  label,
  active = false,
}: {
  readonly label: string;
  readonly active?: boolean;
}): React.JSX.Element {
  return (
    <span
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[8.5px] font-medium"
      style={
        active
          ? {
              background: "var(--sidebar-active-bg)",
              color: "var(--sidebar-active-fg)",
            }
          : { color: "var(--sidebar-text-muted)" }
      }
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{
          background: active ? "var(--sidebar-active-fg)" : "currentColor",
          opacity: active ? 1 : 0.7,
        }}
      />
      {label}
    </span>
  );
}

function PreviewStat({
  label,
  value,
  accent,
}: {
  readonly label: string;
  readonly value: string;
  readonly accent: string;
}): React.JSX.Element {
  return (
    <div
      className="rounded-lg border p-2"
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
    >
      <p className="text-[8px] text-[var(--text-3)]">{label}</p>
      <p className="mt-0.5 flex items-center gap-1 text-[11px] font-semibold text-[var(--text)]">
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: accent }}
          aria-hidden="true"
        />
        {value}
      </p>
    </div>
  );
}

function PreviewRow({
  name,
  qty,
  rate,
  total,
  hovered = false,
}: {
  readonly name: string;
  readonly qty: string;
  readonly rate: string;
  readonly total: string;
  readonly hovered?: boolean;
}): React.JSX.Element {
  return (
    <div
      className="grid grid-cols-[1.6fr_0.6fr_0.8fr_0.8fr] gap-2 border-b px-2.5 py-1.5 text-[8.5px] last:border-b-0"
      style={{
        background: hovered ? "var(--table-row-hover)" : "transparent",
        borderColor: "var(--border)",
        color: "var(--text-2)",
      }}
    >
      <span className="truncate text-[var(--text)]">{name}</span>
      <span className="tabular text-end">{qty}</span>
      <span className="tabular text-end">{rate}</span>
      <span className="tabular text-end font-medium text-[var(--text)]">{total}</span>
    </div>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
