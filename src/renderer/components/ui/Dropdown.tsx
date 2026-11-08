/**
 * Row actions menu, tabs, and pagination.
 *
 * Compact: 36px pagination, smaller menu items.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { Check, ChevronLeft, ChevronRight, MoreHorizontal, Settings2 } from "lucide-react";
import { cn, pageCount, pageSlice } from "../../lib/utils";
import { Button } from "./Button";
import { Select } from "./Input";

/* ------------------------------------------------------------------------ */
/* row actions                                                                */
/* ------------------------------------------------------------------------ */

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly onSelect: () => void;
  readonly icon?: ReactNode | undefined;
  readonly destructive?: boolean | undefined;
  readonly disabled?: boolean | undefined;
}

/**
 * The "..." menu on a table row.
 */
export function RowActions({ items }: { readonly items: readonly MenuItem[] }): React.JSX.Element {
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <Button variant="ghost" size="icon" iconOnlyLabel="Row actions" className="h-8 w-8">
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </Button>
      </DropdownMenuPrimitive.Trigger>

      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          sideOffset={4}
          className="glass-float z-50 min-w-[160px] overflow-hidden rounded-xl py-1 animate-scale-in"
        >
          {items.map((item) => (
            <DropdownMenuPrimitive.Item
              key={item.id}
              disabled={item.disabled === true}
              onSelect={() => {
                item.onSelect();
              }}
              className={cn(
                "flex cursor-pointer items-center gap-2.5 px-4 py-2 text-[13.5px] outline-none select-none",
                "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
                item.destructive === true
                  ? "text-[var(--danger)] data-[highlighted]:bg-[var(--danger-soft)]"
                  : "text-[var(--text)] data-[highlighted]:bg-[var(--surface-2)]",
              )}
            >
              {item.icon}
              {item.label}
            </DropdownMenuPrimitive.Item>
          ))}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

export function DropdownMenu({
  trigger,
  children,
  align = "end",
}: {
  readonly trigger: ReactNode;
  readonly children: ReactNode;
  readonly align?: "start" | "center" | "end" | undefined;
}): React.JSX.Element {
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>{trigger}</DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align={align}
          sideOffset={4}
          className="glass-float z-50 min-w-[180px] overflow-hidden rounded-xl py-1 animate-scale-in"
        >
          {children}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

export function DropdownItem({
  children,
  onSelect,
  destructive = false,
  disabled = false,
  checked,
}: {
  readonly children: ReactNode;
  readonly onSelect?: (() => void) | undefined;
  readonly destructive?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly checked?: boolean | undefined;
}): React.JSX.Element {
  return (
    <DropdownMenuPrimitive.Item
      disabled={disabled}
      {...(onSelect === undefined
        ? {}
        : {
            onSelect: () => {
              onSelect();
            },
          })}
      className={cn(
        "flex cursor-pointer items-center gap-2.5 px-4 py-2 text-[13.5px] outline-none select-none",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        destructive === true
          ? "text-[var(--danger)] data-[highlighted]:bg-[var(--danger-soft)]"
          : "text-[var(--text)] data-[highlighted]:bg-[var(--surface-2)]",
      )}
    >
      {checked === true && <Check className="h-3.5 w-3.5 text-[var(--brand)]" aria-hidden="true" />}
      {children}
    </DropdownMenuPrimitive.Item>
  );
}

export function DropdownSeparator(): React.JSX.Element {
  return <DropdownMenuPrimitive.Separator className="my-1 h-px bg-[var(--border)]" />;
}

export function DropdownLabel({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return (
    <DropdownMenuPrimitive.Label className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
      {children}
    </DropdownMenuPrimitive.Label>
  );
}

/** Column-visibility menu for wide tables. */
export function ColumnVisibility({
  columns,
  hiddenIds,
  onToggle,
}: {
  readonly columns: readonly { readonly id: string; readonly header: string }[];
  readonly hiddenIds: readonly string[];
  readonly onToggle: (id: string) => void;
}): React.JSX.Element {
  const hidden = new Set(hiddenIds);

  return (
    <DropdownMenu
      trigger={
        <Button variant="secondary" size="sm" iconLeft={<Settings2 className="h-3.5 w-3.5" />}>
          Columns
        </Button>
      }
    >
      <DropdownLabel>Visible columns</DropdownLabel>
      {columns.map((column) => (
        <DropdownItem
          key={column.id}
          checked={!hidden.has(column.id)}
          onSelect={() => {
            onToggle(column.id);
          }}
        >
          {column.header}
        </DropdownItem>
      ))}
    </DropdownMenu>
  );
}

/* ------------------------------------------------------------------------ */
/* tabs                                                                       */
/* ------------------------------------------------------------------------ */

export interface TabDefinition {
  readonly id: string;
  readonly label: ReactNode;
  readonly badge?: ReactNode | undefined;
}

/**
 * Pill tabs.
 *
 * A segmented control rather than an underlined strip: report tabs sit inside a
 * card next to a date filter, and a row of self-contained pills reads as a
 * switch between views rather than as a document outline.
 */
export function Tabs({
  tabs,
  value,
  onChange,
  className,
}: {
  readonly tabs: readonly TabDefinition[];
  readonly value: string;
  readonly onChange: (id: string) => void;
  readonly className?: string | undefined;
}): React.JSX.Element {
  return (
    <TabsPrimitive.Root
      value={value}
      onValueChange={(next) => {
        onChange(next);
      }}
    >
      <TabsPrimitive.List
        className={cn("flex flex-wrap items-center gap-2", className)}
        role="tablist"
      >
        {tabs.map((tab) => (
          <TabsPrimitive.Trigger
            key={tab.id}
            value={tab.id}
            className={cn(
              "flex items-center gap-2 rounded-lg border px-3.5 py-2 text-[13px] font-medium",
              "transition-colors duration-fast",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
              "data-[state=active]:border-[var(--brand)] data-[state=active]:bg-[var(--brand-soft)] data-[state=active]:text-[var(--brand)]",
              "data-[state=inactive]:border-[var(--border)] data-[state=inactive]:bg-[var(--surface)] data-[state=inactive]:text-[var(--text-2)] hover:border-[var(--border-strong)] hover:text-[var(--text)]",
            )}
          >
            {tab.label}
            {tab.badge !== undefined && <BadgeCount>{tab.badge}</BadgeCount>}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  );
}

export function TabPanel({
  value,
  children,
}: {
  readonly value: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <TabsPrimitive.Content value={value} className="mt-4 focus-visible:outline-none">
      {children}
    </TabsPrimitive.Content>
  );
}

function BadgeCount({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return (
    <span className="tabular rounded-full bg-[var(--surface-2)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--text-2)]">
      {children}
    </span>
  );
}

/** Controllable tab wrapper: one `active` value instead of Radix context. */
export function TabView({
  tabs,
  active,
  onChange,
  children,
}: {
  readonly tabs: readonly TabDefinition[];
  readonly active: string;
  readonly onChange: (id: string) => void;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="space-y-4">
      <Tabs tabs={tabs} value={active} onChange={onChange} />
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* pagination                                                                 */
/* ------------------------------------------------------------------------ */

export interface PaginationProps {
  readonly total: number;
  readonly page: number;
  readonly onPageChange: (page: number) => void;
  readonly perPage: number;
  readonly onPerPageChange?: (perPage: number) => void | undefined;
  readonly perPageOptions?: readonly number[] | undefined;
  readonly itemLabel?: string | undefined;
}

/**
 * Page controls.
 *
 * "Showing 1-25 of 248 products" on the left, the stepper on the right. The
 * counts are stated rather than implied, because the number of records a list
 * holds is the first thing someone checks when a total looks wrong.
 */
export function Pagination({
  total,
  page,
  onPageChange,
  perPage,
  onPerPageChange,
  perPageOptions = [25, 50, 100],
  itemLabel = "rows",
}: PaginationProps): React.JSX.Element | null {
  const pages = pageCount(total, perPage);
  if (total === 0) return null;

  const start = (Math.min(page, pages) - 1) * perPage + 1;
  const end = Math.min(page * perPage, total);

  // A short, centred run of page numbers with ellipses, so a long list does
  // not turn the footer into a wall of buttons.
  const numbers = pageWindow(page, pages);

  return (
    <div className="flex min-h-[52px] flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] px-4 py-2.5 text-[13px]">
      <div className="flex items-center gap-3 text-[var(--text-2)]">
        <span className="tabular">
          Showing {start}–{end} of {total} {itemLabel}
        </span>

        {onPerPageChange !== undefined && (
          <Select
            value={String(perPage)}
            options={perPageOptions.map((option) => ({
              value: String(option),
              label: `${String(option)} / page`,
            }))}
            aria-label={`${itemLabel} per page`}
            className="h-8 w-[104px] text-xs"
            onChange={(next) => {
              onPerPageChange(Number(next));
            }}
          />
        )}
      </div>

      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          iconOnlyLabel="Previous page"
          disabled={page <= 1}
          className="h-8 w-8"
          onClick={() => {
            onPageChange(Math.max(1, page - 1));
          }}
        >
          <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
        </Button>

        {numbers.map((entry, index) =>
          entry === null ? (
            <span key={`gap-${String(index)}`} className="px-1 text-xs text-[var(--text-3)]">
              …
            </span>
          ) : (
            <button
              key={entry}
              type="button"
              aria-current={entry === page ? "page" : undefined}
              aria-label={`Page ${String(entry)}`}
              onClick={() => {
                onPageChange(entry);
              }}
              className={cn(
                "tabular h-8 min-w-8 rounded-lg border px-2 text-[13px] font-medium transition-colors duration-fast",
                entry === page
                  ? "border-[var(--brand)] bg-[var(--brand)] text-[var(--on-brand)]"
                  : "border-transparent text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]",
              )}
            >
              {entry}
            </button>
          ),
        )}

        <Button
          variant="ghost"
          size="icon"
          iconOnlyLabel="Next page"
          disabled={page >= pages}
          className="h-8 w-8"
          onClick={() => {
            onPageChange(Math.min(pages, page + 1));
          }}
        >
          <ChevronRight className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

/**
 * The page numbers worth showing around the current one.
 *
 * Always the first and last page, plus a run either side of the current one;
 * `null` marks where a page has been left out.
 */
function pageWindow(page: number, pages: number): readonly (number | null)[] {
  if (pages <= 7) return Array.from({ length: pages }, (_unused, index) => index + 1);

  const entries: (number | null)[] = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(pages - 1, page + 1);

  if (start > 2) entries.push(null);
  for (let index = start; index <= end; index += 1) entries.push(index);
  if (end < pages - 1) entries.push(null);

  entries.push(pages);
  return entries;
}

/**
 * Sorting, paging and column-visibility state for a table.
 *
 * `focusKey` is the best search match. When it changes, the table moves to the
 * page that contains it; a manual page change afterwards is left alone. The
 * page is also clamped when a filter shrinks the list, so the reader is never
 * left on page 7 of a two-page result.
 */
export interface TableViewOptions<T> {
  readonly focusKey?: string | number | null | undefined;
  readonly rowKey?: ((row: T) => string | number) | undefined;
}

export function useTableView<T extends object>(
  rows: readonly T[],
  columns: readonly {
    readonly id: string;
    readonly sortValue?: (row: T) => string | number | null | undefined;
  }[],
  initialPerPage = 25,
  options: TableViewOptions<T> = {},
): {
  readonly rowsOnPage: T[];
  readonly totalRows: number;
  readonly page: number;
  readonly setPage: (page: number) => void;
  readonly perPage: number;
  readonly setPerPage: (perPage: number) => void;
  readonly sortId: string | null;
  readonly sortDirection: "asc" | "desc";
  readonly setSort: (id: string) => void;
  readonly hiddenColumnIds: readonly string[];
  readonly toggleColumn: (id: string) => void;
  readonly reset: () => void;
} {
  const [page, setPage] = useState(1);
  const [perPage, setPerPageState] = useState(initialPerPage);
  const [sortId, setSortId] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [hiddenColumnIds, setHiddenColumnIds] = useState<readonly string[]>([]);

  const focusKey = options.focusKey ?? null;
  const focusRowKey = options.rowKey;

  // Pages rebuild their column definitions on every render, so `columns` has a
  // new identity each time even when every sortValue is the same function in
  // spirit. Keeping the latest definitions in a ref means a page that changes
  // an unrelated piece of state does not re-sort a thousand rows.
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  const setPerPage = (next: number): void => {
    setPerPageState(next);
    setPage(1);
  };

  const setSort = (id: string): void => {
    if (id === sortId) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortId(id);
    setSortDirection("asc");
    setPage(1);
  };

  const toggleColumn = (id: string): void => {
    setHiddenColumnIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  };

  const reset = (): void => {
    setPage(1);
    setSortId(null);
    setSortDirection("asc");
    setHiddenColumnIds([]);
  };

  const sorted = useMemo(() => {
    if (sortId === null) return rows;
    const column = columnsRef.current.find((candidate) => candidate.id === sortId);
    if (column?.sortValue === undefined) return rows;

    const direction = sortDirection === "asc" ? 1 : -1;

    return [...rows].sort((a, b) => {
      const left = column.sortValue?.(a) ?? null;
      const right = column.sortValue?.(b) ?? null;

      if (left === null && right === null) return 0;
      if (left === null) return 1;
      if (right === null) return -1;

      if (typeof left === "number" && typeof right === "number") {
        return (left - right) * direction;
      }

      return String(left).localeCompare(String(right)) * direction;
    });
  }, [rows, sortDirection, sortId]);

  const rowsOnPage = useMemo(() => pageSlice(sorted, page, perPage), [page, perPage, sorted]);

  // The page can be left behind by a filter that made the list shorter. The
  // slice already clamps what it displays; clamping the state too keeps the
  // pagination controls and the table agreeing with each other.
  const pages = pageCount(sorted.length, perPage);
  useEffect(() => {
    setPage((current) => Math.min(Math.max(1, current), pages));
  }, [pages]);

  // Jump to the best match's page once per focus key. The data may arrive a
  // render after the key, in which case the effect simply runs again. Paging
  // after that is the reader's: the key has been handled and is not re-applied.
  const handledFocusRef = useRef<string | number | null>(null);
  useEffect(() => {
    if (focusKey === null) {
      handledFocusRef.current = null;
      return;
    }
    if (focusRowKey === undefined || handledFocusRef.current === focusKey) return;

    const index = sorted.findIndex((row) => focusRowKey(row) === focusKey);
    if (index < 0) return;

    handledFocusRef.current = focusKey;
    setPage(Math.floor(index / perPage) + 1);
  }, [focusKey, focusRowKey, sorted, perPage]);

  return {
    rowsOnPage,
    totalRows: sorted.length,
    page,
    setPage,
    perPage,
    setPerPage,
    sortId,
    sortDirection,
    setSort,
    hiddenColumnIds,
    toggleColumn,
    reset,
  };
}
