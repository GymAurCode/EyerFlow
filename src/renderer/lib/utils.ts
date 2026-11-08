/**
 * Small, dependency-free helpers used across the renderer.
 */

/** Join class names, dropping falsy values. */
export function cn(...values: readonly (string | false | null | undefined)[]): string {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0).join(" ");
}

/** Stable, readable unique id for form rows and React keys. */
export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Debounce a function. Used by search boxes so a keystroke is not a query. */
export function debounce<Args extends readonly unknown[]>(
  fn: (...args: Args) => void,
  waitMs: number,
): (...args: Args) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return (...args: Args): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, waitMs);
  };
}

/** Format an ISO date for display. */
export function formatDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

/** Format a date and time for history rows. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Relative day wording used by the due-soon lists. */
export function formatRelativeDays(days: number): string {
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  if (days < 0) return `${String(Math.abs(days))} days overdue`;
  return `in ${String(days)} days`;
}

/** Today's date in the app's format, from the main process clock. */
export function todayIso(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function startOfMonthIso(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export function endOfMonthIso(iso: string): string {
  const year = Number.parseInt(iso.slice(0, 4), 10);
  const month = Number.parseInt(iso.slice(5, 7), 10);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${iso.slice(0, 7)}-${String(last).padStart(2, "0")}`;
}

/** Clamp a number into a range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Sort comparator for a table column.
 *
 * Numbers sort numerically and empty cells always sort last, which is what a
 * shopkeeper expects from a money or quantity column.
 */
export function compareValues<T>(
  a: T,
  b: T,
  accessor: (value: T) => string | number | null,
): number {
  const left = accessor(a);
  const right = accessor(b);

  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;

  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }

  return String(left).localeCompare(String(right));
}

/** Case-insensitive substring match across several fields. */
export function matchesSearch<T>(
  value: T,
  term: string,
  fields: readonly ((value: T) => string | number | null)[],
): boolean {
  const needle = term.trim().toLowerCase();
  if (needle.length === 0) return true;

  return fields.some((field) => {
    const candidate = field(value);
    return candidate !== null && String(candidate).toLowerCase().includes(needle);
  });
}

/** Page numbers for a table, clamped to the available range. */
export function pageCount(total: number, perPage: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, perPage)));
}

/** Slice for the current page, clamped so out-of-range pages stay valid. */
export function pageSlice<T>(items: readonly T[], page: number, perPage: number): T[] {
  const maxPage = pageCount(items.length, perPage);
  const safePage = Math.min(Math.max(1, page), maxPage);
  const start = (safePage - 1) * perPage;
  return items.slice(start, start + perPage);
}