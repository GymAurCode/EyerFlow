import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  daysBetween,
  daysInMonth,
  defaultFiscalYearWindow,
  fiscalMonthOf,
  fiscalYearMonths,
  fiscalYearOf,
  fiscalYearRange,
  lastDayOfMonth,
  monthBounds,
  monthName,
  rollingMonths,
  toIsoDate,
  todayIso,
} from "../src/domain/dates";

describe("ISO dates", () => {
  it("formats a date as YYYY-MM-DD", () => {
    expect(toIsoDate(new Date(2026, 2, 9))).toBe("2026-03-09");
  });

  it("zero-pads single-digit months and days", () => {
    expect(toIsoDate(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("defaults todayIso to now", () => {
    expect(todayIso(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});

describe("addDays and daysBetween", () => {
  it("adds days across a month boundary", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
  });

  it("adds days across a year boundary", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("subtracts days for a negative offset", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("handles a leap day", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2028-02-29", 1)).toBe("2028-03-01");
  });

  it("does not drift across a daylight-saving change", () => {
    // Late March is when several regions shift clocks; the arithmetic is UTC.
    expect(addDays("2026-03-28", 1)).toBe("2026-03-29");
    expect(daysBetween("2026-03-28", "2026-03-29")).toBe(1);
  });

  it("returns whole days between dates", () => {
    expect(daysBetween("2026-01-01", "2026-01-31")).toBe(30);
    expect(daysBetween("2026-01-01", "2026-12-31")).toBe(364);
  });

  it("returns a negative span when the end precedes the start", () => {
    expect(daysBetween("2026-03-10", "2026-03-01")).toBe(-9);
  });

  it("returns zero for the same day", () => {
    expect(daysBetween("2026-03-01", "2026-03-01")).toBe(0);
  });
});

describe("addMonths", () => {
  it("moves forward within the year", () => {
    expect(addMonths("2026-01-15", 2)).toBe("2026-03-15");
  });

  it("rolls into the next year", () => {
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
  });

  it("clamps to the last day of a shorter month", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
  });

  it("moves backward", () => {
    expect(addMonths("2026-03-15", -2)).toBe("2026-01-15");
  });

  it("is the identity for zero months", () => {
    expect(addMonths("2026-06-30", 0)).toBe("2026-06-30");
  });
});

describe("fiscal year with a January start", () => {
  it("puts every month in the calendar year", () => {
    expect(fiscalYearOf("2026-01-01", 1)).toBe(2026);
    expect(fiscalYearOf("2026-12-31", 1)).toBe(2026);
  });

  it("numbers months 1 to 12 in calendar order", () => {
    expect(fiscalMonthOf("2026-01-01", 1)).toBe(1);
    expect(fiscalMonthOf("2026-06-15", 1)).toBe(6);
    expect(fiscalMonthOf("2026-12-31", 1)).toBe(12);
  });

  it("spans January to December", () => {
    expect(fiscalYearRange(2026, 1)).toEqual({ start: "2026-01-01", end: "2026-12-31" });
  });
});

describe("fiscal year with an April start", () => {
  it("puts January in the previous fiscal year", () => {
    expect(fiscalYearOf("2026-03-31", 4)).toBe(2025);
    expect(fiscalYearOf("2026-04-01", 4)).toBe(2026);
  });

  it("numbers April as month 1 and March as month 12", () => {
    expect(fiscalMonthOf("2026-04-01", 4)).toBe(1);
    expect(fiscalMonthOf("2026-07-01", 4)).toBe(4);
    expect(fiscalMonthOf("2026-03-01", 4)).toBe(12);
  });

  it("spans April to the following March", () => {
    expect(fiscalYearRange(2026, 4)).toEqual({ start: "2026-04-01", end: "2027-03-31" });
  });

  it("puts January to March of the next calendar year inside the fiscal year", () => {
    const months = fiscalYearMonths(2026, 4);
    expect(months[0]).toEqual({ month: 4, start: "2026-04-01", end: "2026-04-30" });
    expect(months[11]).toEqual({ month: 3, start: "2027-03-01", end: "2027-03-31" });
  });
});

describe("fiscalYearMonths", () => {
  it("returns twelve consecutive months with correct bounds", () => {
    const months = fiscalYearMonths(2026, 1);
    expect(months).toHaveLength(12);
    expect(months.map((m) => m.month)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    for (const month of months) {
      expect(month.start).toMatch(/^\d{4}-\d{2}-01$/);
      expect(month.end).toBe(lastDayOfMonth(Number(month.start.slice(0, 4)), month.month));
    }
  });

  it("has no gaps or overlaps between consecutive months", () => {
    const months = fiscalYearMonths(2026, 5);
    for (let i = 1; i < months.length; i += 1) {
      expect(addDays(months[i - 1]!.end, 1)).toBe(months[i]!.start);
    }
  });
});

describe("month arithmetic", () => {
  it("knows month lengths including leap years", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 1)).toBe(31);
    expect(daysInMonth(2026, 4)).toBe(30);
  });

  it("gives month bounds", () => {
    expect(monthBounds(2026, 2)).toEqual({ start: "2026-02-01", end: "2026-02-28" });
  });

  it("names months in both languages", () => {
    expect(monthName(1, "en")).toBe("January");
    expect(monthName(12, "en")).toBe("December");
    expect(monthName(1, "ar")).toBe("يناير");
    expect(monthName(12, "ar")).toBe("ديسمبر");
  });

  it("clamps an out-of-range month instead of returning undefined", () => {
    expect(monthName(0, "en")).toBe("January");
    expect(monthName(13, "en")).toBe("December");
  });
});

describe("reporting windows", () => {
  it("defaults to the current fiscal year to date", () => {
    const window = defaultFiscalYearWindow(new Date(2026, 5, 15), 1);
    expect(window).toEqual({ from: "2026-01-01", to: "2026-06-15", fiscalYear: 2026 });
  });

  it("uses the configured start month", () => {
    const window = defaultFiscalYearWindow(new Date(2026, 2, 15), 4);
    expect(window).toEqual({ from: "2025-04-01", to: "2026-03-15", fiscalYear: 2025 });
  });

  it("returns rolling months oldest first", () => {
    const months = rollingMonths(new Date(Date.UTC(2026, 2, 15)), 3);
    expect(months).toEqual([
      { month: "2026-01", fiscalYear: 2026 },
      { month: "2026-02", fiscalYear: 2026 },
      { month: "2026-03", fiscalYear: 2026 },
    ]);
  });

  it("crosses a year boundary when rolling back", () => {
    const months = rollingMonths(new Date(Date.UTC(2026, 1, 15)), 3);
    expect(months[0]).toEqual({ month: "2025-12", fiscalYear: 2025 });
  });

  it("returns a single month when asked for one", () => {
    expect(rollingMonths(new Date(Date.UTC(2026, 5, 1)), 1)).toEqual([
      { month: "2026-06", fiscalYear: 2026 },
    ]);
  });
});