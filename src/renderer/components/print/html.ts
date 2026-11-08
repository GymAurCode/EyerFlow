/**
 * Small HTML helpers for the printed documents.
 *
 * Every value that reaches a document is user-entered at some point: a
 * customer's name, a line description, a note on an expense. Those strings are
 * inserted into markup, so they are escaped once, here, rather than at each
 * call site.
 */

/** Escape text for use in element content or in a quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape a value for an attribute, or return null when there is nothing to say. */
export function escapeAttribute(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return escapeHtml(trimmed);
}

/**
 * Split a free-text field into printable lines.
 *
 * A company address typed as several lines has to stay several lines on the
 * document; a single-line field must not gain stray empty rows.
 */
export function toLines(value: string | null | undefined): readonly string[] {
  if (value === null || value === undefined) return [];
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Join non-empty fragments with a separator, skipping the empty ones. */
export function joinParts(
  parts: readonly (string | null | undefined)[],
  separator = " · ",
): string {
  return parts
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim())
    .join(separator);
}
