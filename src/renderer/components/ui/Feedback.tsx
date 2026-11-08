/**
 * Small presentational pieces used across many screens: skeletons, empty
 * states, section headings, tooltips and the loading indicator.
 */

import type { ReactNode } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Info, PackageOpen } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "./Button";

/** Shimmering placeholder. Width and height mirror the real content. */
export function Skeleton({
  className,
  count = 1,
}: {
  readonly className?: string | undefined;
  readonly count?: number | undefined;
}): React.JSX.Element {
  return (
    <>
      {Array.from({ length: count }, (_unused, index) => (
        <div
          key={index}
          className={cn(
            "shimmer rounded-lg border border-[var(--glass-border)] bg-[var(--surface-2)]",
            className,
          )}
          aria-hidden="true"
        />
      ))}
    </>
  );
}

/** Table-shaped skeleton: header row plus `rows` body rows. */
export function TableSkeleton({
  columns = 5,
  rows = 6,
}: {
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
}): React.JSX.Element {
  return (
    <div className="glass card overflow-hidden" aria-busy="true">
      <div className="flex gap-3 border-b border-[var(--border)] bg-[var(--table-header-bg)] px-4 py-3">
        {Array.from({ length: columns }, (_unused, index) => (
          <Skeleton key={index} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_unused, rowIndex) => (
        <div
          key={rowIndex}
          className="flex gap-3 border-b border-[var(--divider)] px-4 py-3 last:border-0"
        >
          {Array.from({ length: columns }, (_column, columnIndex) => (
            <Skeleton key={columnIndex} className="h-3 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function Spinner({
  className,
}: {
  readonly className?: string | undefined;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        "inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent",
        className,
      )}
      role="status"
      aria-label="Loading"
    />
  );
}

export interface EmptyStateProps {
  readonly title: ReactNode;
  readonly description?: ReactNode | undefined;
  readonly actionLabel?: string | undefined;
  readonly onAction?: (() => void) | undefined;
  readonly icon?: ReactNode | undefined;
  readonly compact?: boolean | undefined;
}

/**
 * Empty state: small icon + one line + action button. No giant illustrations.
 */
export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
  icon,
  compact = false,
}: EmptyStateProps): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "px-4 py-8" : "px-6 py-12",
      )}
    >
      <div className="glass-chip mb-3.5 h-11 w-11 rounded-[16px] text-[var(--brand)]">
        {icon ?? <PackageOpen className="h-5 w-5" aria-hidden="true" />}
      </div>

      <p className="text-[15px] font-semibold text-[var(--text)]">{title}</p>

      {description !== undefined && (
        <p className="mt-1 max-w-sm text-[13px] text-[var(--text-2)]">{description}</p>
      )}

      {actionLabel !== undefined && onAction !== undefined && (
        <Button variant="primary" size="sm" className="mt-4" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}

/**
 * Page title: 20px semibold navy, one line of description, actions on the right.
 *
 * The heading is the largest type in the app but still smaller than a marketing
 * page's: this is a tool, and the data should be the loudest thing on screen.
 */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode | undefined;
  readonly actions?: ReactNode | undefined;
  readonly breadcrumbs?: readonly { readonly label: string; readonly onClick?: () => void }[];
}): React.JSX.Element {
  return (
    <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {breadcrumbs !== undefined && breadcrumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="mb-1">
            <ol className="flex flex-wrap items-center gap-1 text-xs text-[var(--text-3)]">
              {breadcrumbs.map((crumb, index) => (
                <li key={`${crumb.label}-${String(index)}`} className="flex items-center gap-1">
                  {index > 0 && <span aria-hidden="true">/</span>}
                  {crumb.onClick === undefined ? (
                    <span>{crumb.label}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={crumb.onClick}
                      className="rounded transition-colors duration-fast hover:text-[var(--brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                    >
                      {crumb.label}
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}

        <h1 className="text-[20px] font-semibold leading-7 text-[var(--text)]">{title}</h1>

        {description !== undefined && (
          <p className="mt-1 text-[13.5px] text-[var(--text-2)]">{description}</p>
        )}
      </div>

      {actions !== undefined && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/**
 * Section heading with an optional inline help tooltip.
 */
export function SectionTitle({
  children,
  hint,
  className,
}: {
  readonly children: ReactNode;
  readonly hint?: string | undefined;
  readonly className?: string | undefined;
}): React.JSX.Element {
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <h2 className="text-[15px] font-semibold text-[var(--text)]">{children}</h2>
      {hint !== undefined && (
        <Tooltip content={hint}>
          <button
            type="button"
            aria-label="More information"
            className="rounded text-[var(--text-3)] transition-colors duration-fast hover:text-[var(--brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
          >
            <Info className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

export function TooltipProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return <TooltipPrimitive.Provider delayDuration={250}>{children}</TooltipPrimitive.Provider>;
}

export function Tooltip({
  content,
  children,
}: {
  readonly content: ReactNode;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          sideOffset={6}
          className="glass-float-strong z-50 max-w-xs rounded-xl px-3 py-2 text-xs text-[var(--text)] animate-fade-in"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/** Bar used in the aging report and budget breakdowns. */
export function MeterBar({
  value,
  total,
  tone = "brand",
  label,
}: {
  readonly value: number;
  readonly total: number;
  readonly tone?: "brand" | "success" | "warning" | "danger" | "info" | "slate" | undefined;
  readonly label?: string | undefined;
}): React.JSX.Element {
  const ratio = total === 0 ? 0 : Math.min(100, Math.max(0, (value / total) * 100));

  const colours: Record<string, string> = {
    brand: "bg-[var(--brand)]",
    success: "bg-[var(--success)]",
    warning: "bg-[var(--warning)]",
    danger: "bg-[var(--danger)]",
    info: "bg-[var(--info)]",
    slate: "bg-[var(--text-3)]",
  };

  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-2)] shadow-[inset_0_1px_2px_rgba(0,0,0,0.18)]"
      role="meter"
      aria-valuenow={Math.round(ratio)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className={cn(
          "h-full rounded-full shadow-[inset_0_1px_0_rgba(255,255,255,0.35)] transition-[width] duration-normal",
          colours[tone],
        )}
        style={{ width: `${String(ratio)}%` }}
      />
    </div>
  );
}

/** Definition list row used on About, settings summaries and statement headers. */
export function DefinitionRow({
  label,
  children,
}: {
  readonly label: ReactNode;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-[13.5px] text-[var(--text-2)]">{label}</dt>
      <dd className="tabular text-[13.5px] font-medium text-[var(--text)]">{children}</dd>
    </div>
  );
}
