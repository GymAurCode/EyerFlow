/**
 * Fiscal year and date helpers for UAE retail.
 *
 * The fiscal year starts in a configurable month (UAE default January). Every
 * document, expense and stock movement stamps its fiscal year on the way in so
 * period reports stay a simple indexed equality test and remain correct if the
 * fiscal-year start month is changed later.
 */

export type IsoDate = string;

export function toIsoDate(date: Date): IsoDate {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function todayIso(now: Date = new Date()): IsoDate {
  return toIsoDate(now);
}

export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

export function parseIsoDate(value: IsoDate): Date {
  return new Date(`${value}T00:00:00Z`);
}

export function addDays(value: IsoDate, days: number): IsoDate {
  const date = parseIsoDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return toIsoDateUTC(date);
}

function toIsoDateUTC(date: Date): IsoDate {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${String(date.getUTCFullYear())}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Calendar month (1-12) that owns a date, given the fiscal-year start month. */
export function fiscalMonthOf(date: IsoDate, fiscalYearStartMonth: number): number {
  const month = Number.parseInt(date.slice(5, 7), 10);
  const offset = (month - fiscalYearStartMonth + 12) % 12;
  return offset + 1;
}

/**
 * Fiscal year label for a date.
 *
 * A date is in fiscal year N when it falls in months from `startMonth`
 * (inclusive) to December, and in fiscal year N+1 from January to the month
 * before `startMonth`.
 */
export function fiscalYearOf(date: IsoDate, fiscalYearStartMonth: number): number {
  const year = Number.parseInt(date.slice(0, 4), 10);
  const month = Number.parseInt(date.slice(5, 7), 10);
  return month >= fiscalYearStartMonth ? year : year - 1;
}

/** First and last calendar date of a fiscal year. */
export function fiscalYearRange(fiscalYear: number, fiscalYearStartMonth: number): {
  readonly start: IsoDate;
  readonly end: IsoDate;
} {
  const startMonthIndex = fiscalYearStartMonth - 1;
  const start = new Date(Date.UTC(fiscalYear, startMonthIndex, 1));
  const end = new Date(Date.UTC(fiscalYear + 1, startMonthIndex, 0));
  return { start: toIsoDateUTC(start), end: toIsoDateUTC(end) };
}

/** Calendar month bounds (1-12) of a fiscal year, independent of start month. */
export function fiscalYearMonths(
  fiscalYear: number,
  fiscalYearStartMonth: number,
): readonly { readonly month: number; readonly start: IsoDate; readonly end: IsoDate }[] {
  const months: { month: number; start: IsoDate; end: IsoDate }[] = [];

  // Fiscal month k maps to the calendar month `startMonth - 1 + k - 1` months
  // after the fiscal year starts, wrapping into the following calendar year.
  for (let k = 0; k < 12; k += 1) {
    const zeroBased = fiscalYearStartMonth - 1 + k;
    const month = (zeroBased % 12) + 1;
    const year = fiscalYear + Math.floor(zeroBased / 12);
    months.push({
      month,
      start: `${String(year)}-${String(month).padStart(2, "0")}-01`,
      end: lastDayOfMonth(year, month),
    });
  }
  return months;
}

export function lastDayOfMonth(year: number, month: number): IsoDate {
  const date = new Date(Date.UTC(year, month, 0));
  return toIsoDateUTC(date);
}

export function monthBounds(year: number, month: number): {
  readonly start: IsoDate;
  readonly end: IsoDate;
} {
  return { start: `${String(year)}-${String(month).padStart(2, "0")}-01`, end: lastDayOfMonth(year, month) };
}

/** Whole days between two ISO dates; negative when `to` precedes `from`. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((parseIsoDate(to).getTime() - parseIsoDate(from).getTime()) / 86_400_000);
}

export function addMonths(date: IsoDate, months: number): IsoDate {
  const parsed = parseIsoDate(date);
  const targetMonth = parsed.getUTCMonth() + months;
  const year = parsed.getUTCFullYear() + Math.floor(targetMonth / 12);
  const month = ((targetMonth % 12) + 12) % 12;
  const day = Math.min(parsed.getUTCDate(), daysInMonth(year, month + 1));
  return `${String(year)}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export const MONTH_NAMES_EN = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export const MONTH_NAMES_AR = [
  "يناير",
  "فبراير",
  "مارس",
  "أبريل",
  "مايو",
  "يونيو",
  "يوليو",
  "أغسطس",
  "سبتمبر",
  "أكتوبر",
  "نوفمبر",
  "ديسمبر",
] as const;

export function monthName(month: number, language: "en" | "ar"): string {
  const index = Math.min(Math.max(month, 1), 12) - 1;
  return (language === "ar" ? MONTH_NAMES_AR : MONTH_NAMES_EN)[index] ?? "";
}

/**
 * Default reporting window: the current fiscal year to date.
 */
export function defaultFiscalYearWindow(
  now: Date,
  fiscalYearStartMonth: number,
): { readonly from: IsoDate; readonly to: IsoDate; readonly fiscalYear: number } {
  const fiscalYear = fiscalYearOf(toIsoDate(now), fiscalYearStartMonth);
  const { start } = fiscalYearRange(fiscalYear, fiscalYearStartMonth);
  return { from: start, to: toIsoDate(now), fiscalYear };
}

/** Last N months including the current one, oldest first. */
export function rollingMonths(now: Date, count: number): readonly { readonly month: string; readonly fiscalYear: number }[] {
  const result: { month: string; fiscalYear: number }[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    const month = date.getUTCMonth() + 1;
    const year = date.getUTCFullYear();
    result.push({ month: `${String(year)}-${String(month).padStart(2, "0")}`, fiscalYear: year });
  }
  return result;
}