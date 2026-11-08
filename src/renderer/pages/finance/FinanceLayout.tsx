/**
 * The Finance module's shell.
 *
 * The rail lists each finance screen under "Payments & Expenses", but the ten
 * screens are also a single workflow - a posting runs from the chart to the
 * journal to the ledger to the reports - so they keep a row of tabs to walk
 * along it without going back to the rail every time.
 *
 * The tabs are secondary navigation: they sit under the page heading, in the
 * page's own width, and they do not move as the page scrolls - so the reader
 * always knows which of the ten screens they are looking at.
 */

import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { cn } from "../../lib/utils";
import { FINANCE_TABS } from "../../lib/finance";

export function FinanceLayout({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return (
    <div>
      <nav
        aria-label="Finance sections"
        className="mb-4 -mx-1 flex gap-1 overflow-x-auto border-b border-[var(--border)] px-1 pb-px"
      >
        {FINANCE_TABS.map((tab) => (
          <NavLink
            key={tab.path}
            to={tab.path}
            title={tab.hint}
            className={({ isActive }) =>
              cn(
                "whitespace-nowrap rounded-t-lg border-b-2 px-3 py-2 text-[13px] font-medium transition-colors duration-fast",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
                isActive
                  ? "border-[var(--brand)] text-[var(--brand)]"
                  : "border-transparent text-[var(--text-2)] hover:border-[var(--border-strong)] hover:text-[var(--text)]",
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      {children}
    </div>
  );
}

/**
 * The date-range picker every Finance screen shares.
 *
 * The presets and the two custom dates are in one row, so the range in force
 * is always visible on every screen and never has to be remembered.
 */
export function DateRangePicker({
  preset,
  fromDate,
  toDate,
  onPresetChange,
  onFromChange,
  onToChange,
  presets,
}: {
  readonly preset: string;
  readonly fromDate: string;
  readonly toDate: string;
  readonly onPresetChange: (value: string) => void;
  readonly onFromChange: (value: string) => void;
  readonly onToChange: (value: string) => void;
  readonly presets: readonly { readonly value: string; readonly label: string }[];
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-0.5">
        {presets.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => {
              onPresetChange(option.value);
            }}
            className={cn(
              "rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors duration-fast",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
              preset === option.value
                ? "bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-sm)]"
                : "text-[var(--text-3)] hover:text-[var(--text)]",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {preset === "custom" && (
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={fromDate}
            onChange={(event) => {
              onFromChange(event.target.value);
            }}
            aria-label="From date"
            className="glass-input h-8 rounded-lg px-2 text-[12.5px] text-[var(--text)]"
          />
          <span className="text-[12px] text-[var(--text-3)]">to</span>
          <input
            type="date"
            value={toDate}
            onChange={(event) => {
              onToChange(event.target.value);
            }}
            aria-label="To date"
            className="glass-input h-8 rounded-lg px-2 text-[12.5px] text-[var(--text)]"
          />
        </div>
      )}
    </div>
  );
}
