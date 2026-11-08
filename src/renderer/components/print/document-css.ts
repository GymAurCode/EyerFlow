/**
 * The stylesheet every printed document shares.
 *
 * The documents are rendered as their own HTML page - in an offscreen window
 * for printing, in an iframe for the preview - so the page rules live here
 * rather than in the app's stylesheet, which is themed for a screen.
 *
 * Three things drive the layout:
 *
 *  - `@page` owns the paper. The size is A4 and the orientation is whatever the
 *    document asks for. Chromium honours the CSS page size over the options
 *    Electron is given, so the orientation is decided in one place.
 *  - The bottom margin is deeper than the others. Chromium's own footer - the
 *    one that carries the page number - is drawn inside that band, so it can
 *    never land on top of the report.
 *  - Table headings repeat. A report that runs onto a second page has to be
 *    readable there, and a page of numbers under a blank strip is not.
 */

/** Portrait or landscape, chosen by the document's content. */
export type DocumentOrientation = "portrait" | "landscape";

/** A4 in millimetres, with the room the page footer needs at the bottom. */
const PAGE_MARGIN = "14mm 12mm 18mm";

export function documentCss(orientation: DocumentOrientation = "portrait"): string {
  const size = orientation === "landscape" ? "A4 landscape" : "A4 portrait";

  return `
  @page { size: ${size}; margin: ${PAGE_MARGIN}; }

  * { box-sizing: border-box; }

  html, body { margin: 0; padding: 0; }

  body {
    font-family: "Inter", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
    font-size: 9.5pt;
    line-height: 1.45;
    color: #1e293b;
    background: #ffffff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* ------------------------------------------------------------------ head -- */

  .doc-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 24px;
    padding-bottom: 10px;
  }

  .doc-identity { display: flex; align-items: flex-start; gap: 12px; min-width: 0; }

  /*
   * The logo is boxed rather than dropped straight onto the page: shop logos
   * arrive in arbitrary colours and a pale one disappears on white paper. The
   * box also gives the mark an edge in black and white.
   */
  .doc-logo {
    display: block;
    flex: none;
    max-height: 56px;
    max-width: 190px;
    object-fit: contain;
    padding: 3px;
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 4px;
  }

  .doc-company-name {
    font-size: 13pt;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: #0f172a;
    line-height: 1.25;
  }

  .doc-company-meta {
    font-size: 8.5pt;
    color: #475569;
    margin-top: 2px;
  }

  .doc-company-meta span { display: block; }

  .doc-heading { text-align: right; flex: none; max-width: 46%; }

  .doc-title {
    font-size: 14pt;
    font-weight: 700;
    color: #0f172a;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    line-height: 1.2;
  }

  .doc-subtitle {
    font-size: 9pt;
    color: #475569;
    margin-top: 3px;
  }

  .doc-rule {
    border-top: 2px solid #14243d;
    margin: 0 0 12px;
  }

  .doc-rule-thin {
    border-top: 1px solid #e2e8f0;
    margin: 12px 0;
  }

  /* ------------------------------------------------------------ report info -- */

  .doc-info {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 28px;
    padding-bottom: 12px;
  }

  .doc-info-block { min-width: 0; }

  .doc-label {
    font-size: 7.5pt;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: #64748b;
    font-weight: 700;
  }

  .doc-value {
    font-size: 9.5pt;
    color: #0f172a;
    font-weight: 600;
    margin-top: 1px;
  }

  /* --------------------------------------------------------------- metrics -- */

  .doc-metrics {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 14px;
  }

  .doc-metric {
    flex: 1 1 130px;
    min-width: 130px;
    border: 1px solid #e2e8f0;
    border-left: 3px solid #1668e3;
    border-radius: 4px;
    padding: 7px 10px;
    background: #f8fafc;
  }

  .doc-metric.is-strong { border-left-color: #14243d; background: #f1f5f9; }
  .doc-metric.is-negative { border-left-color: #b91c1c; }
  .doc-metric.is-positive { border-left-color: #15803d; }

  .doc-metric-label {
    font-size: 7.5pt;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #64748b;
    font-weight: 700;
  }

  .doc-metric-value {
    font-size: 11.5pt;
    font-weight: 700;
    color: #0f172a;
    margin-top: 2px;
    font-variant-numeric: tabular-nums;
  }

  /* ---------------------------------------------------------------- tables -- */

  .doc-section { margin-bottom: 16px; }

  .doc-section:last-child { margin-bottom: 0; }

  .doc-section-title {
    font-size: 10pt;
    font-weight: 700;
    color: #0f172a;
    margin: 0 0 6px;
  }

  .doc-section-note {
    font-size: 8.5pt;
    color: #64748b;
    margin: -3px 0 6px;
  }

  table { width: 100%; border-collapse: collapse; }

  /* Repeat the headings on every page the table runs onto. */
  thead { display: table-header-group; }

  /* Keep the totals with the table rather than repeating them per page. */
  tfoot { display: table-row-group; }

  tr { break-inside: avoid; page-break-inside: avoid; }

  th {
    background: #f1f5f9;
    border-bottom: 2px solid #14243d;
    padding: 5px 7px;
    text-align: left;
    font-size: 7.5pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #0f172a;
    white-space: nowrap;
  }

  td {
    padding: 4.5px 7px;
    border-bottom: 1px solid #e2e8f0;
    vertical-align: top;
    color: #1e293b;
  }

  tbody tr:nth-child(even) td { background: #f8fafc; }

  td.num, th.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  td.centre, th.centre { text-align: center; }

  td.strong { font-weight: 600; color: #0f172a; }
  td.muted { color: #64748b; }
  td.negative { color: #b91c1c; }
  td.positive { color: #15803d; }

  tfoot td {
    border-top: 2px solid #14243d;
    border-bottom: none;
    background: #ffffff;
    font-weight: 700;
    color: #0f172a;
  }

  .doc-empty {
    border: 1px dashed #cbd5e1;
    border-radius: 4px;
    padding: 18px;
    text-align: center;
    color: #64748b;
    font-size: 9pt;
    background: #f8fafc;
  }

  /* --------------------------------------------------------------- totals -- */

  .doc-totals {
    margin-top: 12px;
    display: flex;
    justify-content: flex-end;
  }

  .doc-totals-box {
    min-width: 250px;
    border: 1px solid #cbd5e1;
    border-radius: 5px;
    overflow: hidden;
  }

  .doc-totals-row {
    display: flex;
    justify-content: space-between;
    gap: 20px;
    padding: 5px 10px;
    font-size: 9pt;
  }

  .doc-totals-row + .doc-totals-row { border-top: 1px solid #e2e8f0; }
  .doc-totals-row .label { color: #475569; }
  .doc-totals-row .value { font-variant-numeric: tabular-nums; font-weight: 600; color: #0f172a; }

  .doc-totals-row.is-grand {
    background: #14243d;
    color: #ffffff;
  }
  .doc-totals-row.is-grand .label,
  .doc-totals-row.is-grand .value { color: #ffffff; }
  .doc-totals-row.is-grand .value { font-weight: 700; }

  /* -------------------------------------------------------------- two-up -- */

  .doc-columns {
    display: flex;
    flex-wrap: wrap;
    gap: 18px;
  }

  .doc-columns > * { flex: 1 1 260px; min-width: 0; }

  .doc-fields {
    display: grid;
    grid-template-columns: minmax(90px, auto) 1fr;
    gap: 4px 14px;
    font-size: 9pt;
  }

  .doc-fields dt { color: #64748b; }
  .doc-fields dd { margin: 0; color: #0f172a; font-weight: 600; }

  /* -------------------------------------------------------------- notices -- */

  .doc-stamp {
    display: inline-block;
    border: 1.5px solid #14243d;
    color: #14243d;
    padding: 2px 9px;
    border-radius: 3px;
    font-weight: 700;
    text-transform: uppercase;
    font-size: 8.5pt;
    letter-spacing: 0.06em;
  }

  .doc-stamp.is-paid { border-color: #15803d; color: #15803d; }
  .doc-stamp.is-due { border-color: #b45309; color: #b45309; }
  .doc-stamp.is-cancelled { border-color: #b91c1c; color: #b91c1c; }

  .doc-terms {
    margin-top: 14px;
    font-size: 8.5pt;
    color: #475569;
    line-height: 1.5;
  }

  .doc-terms h4 {
    margin: 0 0 2px;
    font-size: 7.5pt;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #64748b;
  }

  .doc-signature {
    margin-top: 26px;
    display: flex;
    justify-content: space-between;
    gap: 36px;
  }

  .doc-signature div {
    flex: 1;
    border-top: 1px solid #94a3b8;
    padding-top: 4px;
    font-size: 8pt;
    color: #64748b;
  }

  /* --------------------------------------------------------------- footer -- */

  /*
   * The document footer, at the end of the document.
   *
   * It is deliberately not a fixed element. Chromium paints a fixed element
   * over the content rather than making room for it, so a repeating footer
   * would sit on top of the last row of every page. The page number and the
   * running title come from Chromium's own page footer instead, which is drawn
   * in the page's bottom margin and cannot overlap anything.
   */
  .doc-footer {
    margin-top: 20px;
    padding-top: 8px;
    border-top: 1px solid #cbd5e1;
    display: flex;
    justify-content: space-between;
    gap: 16px;
    font-size: 8pt;
    color: #64748b;
  }

  .doc-footer-brand { white-space: nowrap; }

  @media print {
    /* A heading must never be the last thing on a page. */
    .doc-section-title { break-after: avoid; page-break-after: avoid; }

    /* A totals block and a signature must never be split in half. */
    .doc-totals,
    .doc-totals-box,
    .doc-signature,
    .doc-terms,
    .doc-footer { break-inside: avoid; page-break-inside: avoid; }
  }

  /* On screen the document is a sheet of paper inside the preview frame. */
  @media screen {
    /*
     * The same margins the page rule gives the printer.
     *
     * A preview that padded the page differently would wrap the columns at a
     * different point from the printed page, and a line that fitted on the
     * paper would not fit in the preview - which is the one thing a preview
     * must not do.
     */
    body { padding: 14mm 12mm 18mm; }
  }
`;
}
