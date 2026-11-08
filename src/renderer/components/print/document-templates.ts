/**
 * Print templates.
 *
 * All rendering happens in the renderer, as strings, and is handed to the main
 * process to print. That keeps the app free of a PDF library and means the
 * printed result is exactly the same markup the user sees in the preview.
 *
 * The document itself is built by the shared layer in this folder: the company
 * header, the report information block, the tables and the attribution footer
 * are the same for every document the app prints, so they live in one place.
 * This file keeps the names the screens already import.
 */

import type { AppSettingsSnapshot } from "../../../shared/ipc";
import type { DocumentDto, PaymentDto } from "../../../shared/types";
import { companyProfile } from "./company-document";
import { renderInvoiceDocument, renderReceiptDocument } from "./record-templates";

export interface TemplateContext {
  readonly settings: AppSettingsSnapshot;
  /** Overrides the logo in the snapshot, for a caller with a fresher image. */
  readonly logoDataUrl?: string | null | undefined;
}

/** A sales invoice or a purchase invoice. The shop's own document either way. */
export function renderInvoice(document: DocumentDto, context: TemplateContext): string {
  return renderInvoiceDocument(document, {
    profile: companyProfile(context.settings, context.logoDataUrl),
    logoDataUrl: context.logoDataUrl,
    generatedAt: new Date(),
  });
}

/** A payment receipt: what the customer handed over, and what it settled. */
export function renderReceipt(payment: PaymentDto, context: TemplateContext): string {
  return renderReceiptDocument(payment, {
    profile: companyProfile(context.settings, context.logoDataUrl),
    logoDataUrl: context.logoDataUrl,
    generatedAt: new Date(),
  });
}

export {
  companyProfile,
  renderDocumentShell,
  renderCompanyHeader,
  renderDocumentFooter,
} from "./company-document";
export type { CompanyProfile } from "./company-document";
export { renderReportDocument } from "./report-document";
export type { ReportDocument, ReportMetric, ReportSection, ReportCell } from "./report-document";
