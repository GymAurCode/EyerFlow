/**
 * Search-result matching for tables.
 *
 * The list RPCs already filter, but a table still needs to know three things
 * the server cannot tell it: which of the rows it received are genuine
 * matches, which one is the best match, and where inside a cell the term sits
 * so it can be marked. All three are derived here from the same
 * case-insensitive substring rule the repository uses (`LIKE %term%`).
 *
 * The functions are pure so the matching rules can be tested without a window,
 * and the hook only keeps the latest accessors in a ref: pages rebuild their
 * inline field lists on every render, and re-walking a thousand rows because
 * of that would be the expensive full-table pass this feature is meant to
 * avoid.
 */

import { useMemo, useRef } from "react";

export type SearchFieldValue = string | number | null | undefined;
export type SearchField<T> = (row: T) => SearchFieldValue;

export interface SearchHighlightOptions<T> {
  readonly rowKey: (row: T) => string | number;
  /** Every field the repository searches. A row outside these is not a match. */
  readonly fields: readonly SearchField<T>[];
  /**
   * The fields that decide which match is best, in order of importance.
   * Defaults to `fields`. A field not listed here can still make a row a
   * match; it just cannot win the "best match" comparison on its own.
   */
  readonly rankFields?: readonly SearchField<T>[] | undefined;
}

export interface SearchHighlight<T> {
  /** The normalised term in force. Empty when the search is cleared. */
  readonly term: string;
  readonly active: boolean;
  readonly keys: ReadonlySet<string | number>;
  readonly primaryKey: string | number | null;
  readonly primaryRow: T | null;
  readonly count: number;
}

export interface HighlightPart {
  readonly text: string;
  readonly match: boolean;
}

/** The normalised term every matcher here uses. */
export function normalizeSearchTerm(term: string): string {
  return term.trim().toLowerCase();
}

function includesTerm(value: SearchFieldValue, term: string): boolean {
  return value !== null && value !== undefined && String(value).toLowerCase().includes(term);
}

/**
 * How good a match is: exact beats prefix beats a match inside the middle,
 * and an earlier rank field beats a later one at the same tier.
 *
 * Returns `null` when no rank field matches, which still leaves a row eligible
 * as a match if one of the wider search fields did.
 */
function rankOf<T>(row: T, term: string, fields: readonly SearchField<T>[]): number | null {
  let best: number | null = null;

  for (const [index, field] of fields.entries()) {
    const value = field(row);
    if (value === null || value === undefined) continue;

    const text = String(value).toLowerCase();
    const tier = text === term ? 0 : text.startsWith(term) ? 1 : text.includes(term) ? 2 : -1;
    if (tier < 0) continue;

    const score = tier * 1000 + index;
    if (best === null || score < best) best = score;
  }

  return best;
}

/** A single empty state, so a cleared search allocates nothing per row. */
function emptyHighlight<T>(term: string): SearchHighlight<T> {
  return {
    term,
    active: false,
    keys: new Set<string | number>(),
    primaryKey: null,
    primaryRow: null,
    count: 0,
  };
}

/**
 * Find the genuine matches in `rows`, and pick the best one.
 *
 * A row is a genuine match when any searchable field contains the term. The
 * best match is the one with the strongest rank (exact, then prefix, then
 * substring), with the first row winning a tie so the choice is stable.
 */
export function computeSearchHighlight<T>(
  rows: readonly T[],
  term: string,
  options: SearchHighlightOptions<T>,
): SearchHighlight<T> {
  const needle = normalizeSearchTerm(term);
  if (needle.length === 0) return emptyHighlight<T>("");

  const rankFields = options.rankFields ?? options.fields;
  const keys = new Set<string | number>();
  let primaryKey: string | number | null = null;
  let primaryRow: T | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const row of rows) {
    if (!options.fields.some((field) => includesTerm(field(row), needle))) continue;

    keys.add(options.rowKey(row));

    // A row can match a wider search field without matching any rank field
    // (a barcode-only hit, say). It is still eligible to be the primary, but
    // only if no ranked row is found; an infinite score puts it last.
    const score = rankOf(row, needle, rankFields) ?? Number.POSITIVE_INFINITY;
    if (primaryRow === null || score < bestScore) {
      bestScore = score;
      primaryKey = options.rowKey(row);
      primaryRow = row;
    }
  }

  return {
    term: needle,
    active: true,
    keys,
    primaryKey,
    primaryRow,
    count: keys.size,
  };
}

/**
 * Memoised highlight state for a page.
 *
 * Recomputes only when the rows or the term change. The accessors are read
 * from a ref so an inline field list does not defeat the memo.
 */
export function useSearchHighlight<T>(
  rows: readonly T[],
  term: string,
  options: SearchHighlightOptions<T>,
): SearchHighlight<T> {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  return useMemo(() => computeSearchHighlight(rows, term, optionsRef.current), [rows, term]);
}

/**
 * Split `text` into plain and matching pieces, case-insensitively.
 *
 * Used by `<HighlightText>`; exported so the split rule can be tested without
 * rendering React. Every occurrence is marked, not just the first.
 */
export function splitHighlight(text: string, term: string): readonly HighlightPart[] {
  const needle = normalizeSearchTerm(term);
  if (needle.length === 0 || text.length === 0) {
    return [{ text, match: false }];
  }

  const lower = text.toLowerCase();
  const parts: HighlightPart[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const found = lower.indexOf(needle, cursor);
    if (found < 0) break;

    if (found > cursor) parts.push({ text: text.slice(cursor, found), match: false });
    parts.push({ text: text.slice(found, found + needle.length), match: true });
    cursor = found + needle.length;
  }

  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return parts.length === 0 ? [{ text, match: false }] : parts;
}
