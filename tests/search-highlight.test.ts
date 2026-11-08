import { describe, expect, it } from "vitest";
import {
  computeSearchHighlight,
  normalizeSearchTerm,
  splitHighlight,
} from "../src/renderer/lib/search-highlight";

/**
 * Search-result highlighting, without a window.
 *
 * The table uses these rules to decide three things: which rows genuinely
 * match, which one is the best match, and which parts of a cell to mark. The
 * server's `LIKE %term%` is case-insensitive and matches anywhere, so the
 * renderer has to make the same decision or a row can be shown as a result
 * without being highlighted.
 */

interface Row {
  readonly id: number;
  readonly name: string;
  readonly sku: string;
  readonly barcode: string | null;
  readonly amount: number;
}

const fields = [
  (row: Row) => row.name,
  (row: Row) => row.sku,
  (row: Row) => row.barcode,
];

const rankFields = [(row: Row) => row.name, (row: Row) => row.sku];

function row(over: Partial<Row> & { readonly id: number }): Row {
  return {
    id: over.id,
    name: over.name ?? `Product ${String(over.id)}`,
    sku: over.sku ?? `SKU-${String(over.id)}`,
    barcode: over.barcode ?? null,
    amount: over.amount ?? 0,
  };
}

function search(rows: readonly Row[], term: string) {
  return computeSearchHighlight(rows, term, {
    rowKey: (entry) => entry.id,
    fields,
    rankFields,
  });
}

describe("normalising the search term", () => {
  it("trims and lower-cases, so the same rules apply to every field", () => {
    expect(normalizeSearchTerm("  Water Filter  ")).toBe("water filter");
    expect(normalizeSearchTerm("SKU-12")).toBe("sku-12");
  });

  it("treats a blank term as no search at all", () => {
    const result = search([row({ id: 1 })], "   ");

    expect(result.active).toBe(false);
    expect(result.term).toBe("");
    expect(result.count).toBe(0);
    expect(result.keys.size).toBe(0);
    expect(result.primaryKey).toBeNull();
    expect(result.primaryRow).toBeNull();
  });
});

describe("finding genuine matches", () => {
  const rows = [
    row({ id: 1, name: "Ceramic Filter", sku: "CF-10" }),
    row({ id: 2, name: "Carbon Filter", sku: "CF-20" }),
    row({ id: 3, name: "Water Pump", sku: "WP-01", barcode: "6291234567890" }),
  ];

  it("matches all searchable fields, case-insensitively and partially", () => {
    expect([...search(rows, "filter").keys]).toEqual([1, 2]);
    expect([...search(rows, "cf-2").keys]).toEqual([2]);
    expect([...search(rows, "629123").keys]).toEqual([3]);
  });

  it("returns the matched rows with the term normalised", () => {
    const result = search(rows, "  FILTER ");

    expect(result.active).toBe(true);
    expect(result.term).toBe("filter");
    expect(result.count).toBe(2);
    expect(result.primaryRow?.id).toBe(1);
  });
});

describe("choosing the best match", () => {
  it("prefers an exact field match over a prefix over a substring", () => {
    const rows = [
      row({ id: 1, name: "Big Water Filter" }),
      row({ id: 2, name: "Water" }),
      row({ id: 3, name: "Water Filter" }),
    ];

    expect(search(rows, "water").primaryKey).toBe(2);
  });

  it("prefers an earlier rank field when the tier is the same", () => {
    const rows = [
      row({ id: 1, name: "Zeta", sku: "ALPHA-01" }),
      row({ id: 2, name: "Alpha", sku: "ZETA-01" }),
    ];

    expect(search(rows, "alpha").primaryKey).toBe(2);
  });

  it("keeps the first match on a tie", () => {
    const rows = [
      row({ id: 7, name: "Filter Cartridge" }),
      row({ id: 8, name: "Filter Housing" }),
    ];

    expect(search(rows, "filter").primaryKey).toBe(7);
  });

  it("can match a wider field without letting it win over a ranked row", () => {
    const rows = [
      row({ id: 1, name: "Pump", sku: "WP-01", barcode: "4711" }),
      row({ id: 2, name: "4711 Filter", sku: "F-4711" }),
    ];

    expect(search(rows, "4711").primaryKey).toBe(2);
  });

  it("still picks a primary when every match is rank-less", () => {
    const rows = [
      row({ id: 1, name: "Pump", sku: "WP-01", barcode: "4711" }),
      row({ id: 2, name: "Tank", sku: "TK-01", barcode: "4711" }),
    ];

    const result = search(rows, "4711");

    expect(result.count).toBe(2);
    expect(result.primaryKey).toBe(1);
    expect(result.primaryRow?.id).toBe(1);
  });

  it("matches numeric fields by their printed form", () => {
    const result = computeSearchHighlight([row({ id: 1, amount: 125050 })], "1250", {
      rowKey: (entry) => entry.id,
      fields: [(entry) => String(entry.amount)],
    });

    expect(result.count).toBe(1);
  });
});

describe("marking the matched substring", () => {
  it("marks every occurrence and keeps the original casing", () => {
    expect(splitHighlight("Water water WATER", "water")).toEqual([
      { text: "Water", match: true },
      { text: " ", match: false },
      { text: "water", match: true },
      { text: " ", match: false },
      { text: "WATER", match: true },
    ]);
  });

  it("returns the plain text when nothing matches or the term is blank", () => {
    expect(splitHighlight("Ceramic filter", "pump")).toEqual([
      { text: "Ceramic filter", match: false },
    ]);
    expect(splitHighlight("Ceramic filter", "  ")).toEqual([
      { text: "Ceramic filter", match: false },
    ]);
  });

  it("handles a match at the start, the end and in the middle", () => {
    expect(splitHighlight("Filter housing filter", "filter")).toEqual([
      { text: "Filter", match: true },
      { text: " housing ", match: false },
      { text: "filter", match: true },
    ]);
    expect(splitHighlight("invoices", "ices")).toEqual([
      { text: "invo", match: false },
      { text: "ices", match: true },
    ]);
  });

  it("does not loop when the same region could match twice", () => {
    expect(splitHighlight("aaaa", "aa")).toEqual([
      { text: "aa", match: true },
      { text: "aa", match: true },
    ]);
  });
});
