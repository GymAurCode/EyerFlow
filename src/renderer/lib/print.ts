/**
 * Printing bridge for the renderer.
 *
 * Wraps the print and save-as-PDF paths so screens call one function and the
 * main process never sees a document shape it does not understand.
 *
 * The paper is A4 and the document decides whether it is portrait or landscape:
 * every document carries its own `@page` rule, and Chromium prefers that rule
 * over the options here. That way the preview, the printed page and the
 * exported PDF are all the same document.
 */

import type { PrintOptions } from "../../shared/ipc";
import type { DocumentDto, PaymentDto } from "../../shared/types";
import { bridge, errorMessage } from "./api";
import { renderInvoice, renderReceipt } from "../components/print/document-templates";
import { companyProfile } from "../components/print/company-document";
import { renderReportDocument, type ReportDocument } from "../components/print/report-document";
import type { AppSettingsSnapshot } from "../../shared/ipc";

export interface PrintContext {
  readonly settings: AppSettingsSnapshot;
  /** Overrides the logo embedded in the settings snapshot. */
  readonly logoDataUrl?: string | null | undefined;
}

export type PrintOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

const A4: PrintOptions = {
  silent: false,
  paperSize: "A4",
  landscape: false,
  copies: 1,
};

async function sendPrint(
  html: string,
  options: PrintOptions,
  footerLabel = "",
): Promise<PrintOutcome> {
  const result = await bridge().printHtml(html, { ...options, footerLabel });
  if (result.ok) return { ok: true };
  // A cancelled print dialog is the user's choice, not an error worth a toast.
  if (result.error.code === "CANCELLED") return { ok: true };
  return { ok: false, message: result.error.message };
}

/**
 * Print a document that has already been rendered.
 *
 * This is the single entry point every print action goes through, so a report,
 * an invoice and a printed record all leave the app the same way.
 */
export async function printHtml(
  html: string,
  options: Partial<PrintOptions> = {},
  footerLabel = "",
): Promise<PrintOutcome> {
  return sendPrint(html, { ...A4, ...options }, footerLabel);
}

/** Save a document that has already been rendered as a PDF. */
export async function saveHtmlAsPdf(
  html: string,
  suggestedName: string,
  footerLabel = "",
): Promise<PrintOutcome> {
  const result = await bridge().saveHtmlAsPdf(html, suggestedName, { footerLabel });

  if (result.ok) return { ok: true };
  if (result.error.code === "CANCELLED") return { ok: true };
  return { ok: false, message: result.error.message };
}

/* -------------------------------------------------------------------------- */
/* documents with their own shape                                              */
/* -------------------------------------------------------------------------- */

/**
 * The invoice document, as it will be printed.
 *
 * The preview and the print job are the same string, so what the user checks
 * is what comes out of the printer.
 */
export function invoiceDocumentHtml(document: DocumentDto, context: PrintContext): string {
  return renderInvoice(document, context);
}

/** The receipt document, as it will be printed. */
export function receiptDocumentHtml(payment: PaymentDto, context: PrintContext): string {
  return renderReceipt(payment, context);
}

/** Save an invoice or purchase invoice as a PDF. */
export async function saveInvoicePdf(
  document: DocumentDto,
  context: PrintContext,
): Promise<PrintOutcome> {
  const result = await bridge().saveHtmlAsPdf(
    renderInvoice(document, context),
    `${document.number}.pdf`,
    { footerLabel: `Invoice ${document.number}` },
  );

  if (result.ok) return { ok: true };
  if (result.error.code === "CANCELLED") return { ok: true };
  return { ok: false, message: result.error.message };
}

/* -------------------------------------------------------------------------- */
/* reports                                                                     */
/* -------------------------------------------------------------------------- */

/** Render a report into the document that will be previewed and printed. */
export function reportDocumentHtml(report: ReportDocument, context: PrintContext): string {
  return renderReportDocument(report, {
    profile: companyProfile(context.settings, context.logoDataUrl),
    logoDataUrl: context.logoDataUrl,
  });
}

/** Message from any error, used by callers that surface print failures. */
export function printErrorMessage(error: unknown): string {
  return errorMessage(error);
}
