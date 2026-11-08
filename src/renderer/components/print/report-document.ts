/**
 * The report document.
 *
 * A report is described as data first and rendered second. The renderer turns
 * a `ReportDocument` into the same HTML the preview shows and the printer
 * prints, so the two can never drift apart: there is one document, rendered
 * once, and looked at in two places.
 *
 * The model is deliberately dull - a title, some headline figures, and one or
 * more tables - because every report in the app is one of those, and a report
 * with its own bespoke HTML would be a report with its own bespoke bugs.
 */

import type { DocumentOrientation } from "./document-css";
import { renderDocumentShell, renderDocumentInfo, type CompanyProfile } from "./company-document";
import { escapeHtml } from "./html";

/** A headline figure shown above the tables. */
export interface ReportMetric {
  readonly label: string;
  readonly value: string;
  /** Drawn with a heavier rule - used for the figure the report is about. */
  readonly emphasis?: boolean | undefined;
  readonly tone?: "default" | "positive" | "negative" | undefined;
}

/** One cell of a report table. */
export interface ReportCell {
  readonly text: string;
  readonly align?: "start" | "end" | "center" | undefined;
  readonly strong?: boolean | undefined;
  readonly muted?: boolean | undefined;
  readonly tone?: "default" | "positive" | "negative" | undefined;
}

/** A column heading. */
export interface ReportColumn {
  readonly header: string;
  readonly align?: "start" | "end" | "center" | undefined;
}

/** One table of the report. */
export interface ReportSection {
  readonly title?: string | undefined;
  readonly note?: string | undefined;
  readonly columns: readonly ReportColumn[];
  readonly rows: readonly (readonly ReportCell[])[];
  /** The totals row, if the table has one. */
  readonly totals?: readonly ReportCell[] | undefined;
  /** Shown instead of the table when there is nothing to list. */
  readonly emptyMessage: string;
}

/** Everything a report needs to be printed. */
export interface ReportDocument {
  readonly title: string;
  readonly subtitle?: string | undefined;
  /** The period the report covers, already formatted for display. */
  readonly period?: string | undefined;
  /** The moment the report was generated. */
  readonly generatedAt: Date;
  readonly orientation?: DocumentOrientation | undefined;
  readonly metrics?: readonly ReportMetric[] | undefined;
  readonly sections: readonly ReportSection[];
  readonly notes?: readonly string[] | undefined;
}

/** A plain string cell, right-aligned by default when the column says so. */
export function cell(text: string, options: Omit<ReportCell, "text"> = {}): ReportCell {
  return { text, ...options };
}

function cellClass(value: ReportCell): string {
  const classes: string[] = [];
  if (value.align === "end") classes.push("num");
  else if (value.align === "center") classes.push("centre");
  if (value.strong === true) classes.push("strong");
  if (value.muted === true) classes.push("muted");
  if (value.tone === "negative") classes.push("negative");
  else if (value.tone === "positive") classes.push("positive");
  return classes.join(" ");
}

function renderMetrics(metrics: readonly ReportMetric[]): string {
  if (metrics.length === 0) return "";
  return `
    <div class="doc-metrics">
      ${metrics
        .map((metric) => {
          const classes = ["doc-metric"];
          if (metric.emphasis === true) classes.push("is-strong");
          if (metric.tone === "negative") classes.push("is-negative");
          else if (metric.tone === "positive") classes.push("is-positive");
          return `
            <div class="${classes.join(" ")}">
              <div class="doc-metric-label">${escapeHtml(metric.label)}</div>
              <div class="doc-metric-value">${escapeHtml(metric.value)}</div>
            </div>`;
        })
        .join("")}
    </div>`;
}

function renderSection(section: ReportSection): string {
  const head =
    section.title === undefined
      ? ""
      : `<h2 class="doc-section-title">${escapeHtml(section.title)}</h2>`;
  const note =
    section.note === undefined ? "" : `<p class="doc-section-note">${escapeHtml(section.note)}</p>`;

  if (section.rows.length === 0) {
    return `<section class="doc-section">${head}${note}<div class="doc-empty">${escapeHtml(section.emptyMessage)}</div></section>`;
  }

  const headCells = section.columns
    .map((column) => {
      const classes = column.align === "end" ? "num" : column.align === "center" ? "centre" : "";
      return `<th${classes === "" ? "" : ` class="${classes}"`}>${escapeHtml(column.header)}</th>`;
    })
    .join("");

  const bodyCells = section.rows
    .map((row) => {
      const cells = row
        .map((value) => {
          const classes = cellClass(value);
          return `<td${classes === "" ? "" : ` class="${classes}"`}>${escapeHtml(value.text)}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  const totals =
    section.totals === undefined
      ? ""
      : `<tfoot><tr>${section.totals
          .map((value) => {
            const classes = [cellClass(value), "strong"].filter((c) => c !== "").join(" ");
            return `<td${classes === "" ? "" : ` class="${classes}"`}>${escapeHtml(value.text)}</td>`;
          })
          .join("")}</tr></tfoot>`;

  return `
    <section class="doc-section">
      ${head}${note}
      <table>
        <thead><tr>${headCells}</tr></thead>
        <tbody>${bodyCells}</tbody>
        ${totals}
      </table>
    </section>`;
}

export interface RenderReportOptions {
  readonly profile: CompanyProfile;
  /** Overrides the logo in the snapshot. */
  readonly logoDataUrl?: string | null | undefined;
}

/**
 * Render a report into a complete document.
 *
 * The information block under the header carries the period and the moment
 * the report was generated, so a printed report always says when it was
 * produced rather than leaving the reader to guess.
 */
export function renderReportDocument(report: ReportDocument, options: RenderReportOptions): string {
  const info = renderDocumentInfo(
    report.period !== undefined && report.period.length > 0
      ? [{ label: "Period", value: report.period }]
      : [],
    report.generatedAt,
  );

  const notes =
    report.notes === undefined || report.notes.length === 0
      ? ""
      : `<div class="doc-terms">${report.notes
          .map((note) => `<p>${escapeHtml(note)}</p>`)
          .join("")}</div>`;

  const body = `${renderMetrics(report.metrics ?? [])}${report.sections
    .map(renderSection)
    .join("")}${notes}`;

  return renderDocumentShell({
    title: report.title,
    subtitle: report.subtitle,
    profile: options.profile,
    body,
    orientation: report.orientation,
    info,
    footerLabel: report.title,
    footerDetail: report.period,
  });
}
