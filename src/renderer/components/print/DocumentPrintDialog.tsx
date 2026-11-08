/**
 * The print dialog.
 *
 * Printing is never a leap of faith: every print action opens this first, so
 * the user sees the A4 page - the company header, the record's own figures,
 * the totals - before anything reaches the printer. From here the document can
 * be printed or saved as a PDF.
 *
 * The preview and the print job are the same document, so what was checked is
 * what comes out.
 */

import { useState } from "react";
import { FileOutput, Printer } from "lucide-react";
import { toast } from "sonner";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { DocumentPreview } from "./DocumentPreview";
import type { DocumentOrientation } from "./document-css";
import { printHtml, saveHtmlAsPdf } from "../../lib/print";

export interface DocumentPrintDialogProps {
  readonly open: boolean;
  /** The document's name, shown in the title bar and beside the page number. */
  readonly title: string;
  readonly description?: string | undefined;
  /** The rendered document. This is exactly what will be printed. */
  readonly html: string;
  readonly orientation?: DocumentOrientation | undefined;
  /** The file name suggested when the document is saved as a PDF. */
  readonly filename: string;
  readonly onClose: () => void;
}

/** A document waiting to be printed. */
export interface PrintableDocument {
  readonly html: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly filename: string;
  readonly orientation?: DocumentOrientation | undefined;
}

export function DocumentPrintDialog({
  open,
  title,
  description,
  html,
  orientation = "portrait",
  filename,
  onClose,
}: DocumentPrintDialogProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);

  const doPrint = (): void => {
    if (busy) return;
    setBusy(true);
    void printHtml(html, {}, title)
      .then((outcome) => {
        if (!outcome.ok) toast.error(outcome.message);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const doSavePdf = (): void => {
    if (busy) return;
    setBusy(true);
    void saveHtmlAsPdf(html, filename, title)
      .then((outcome) => {
        if (!outcome.ok) toast.error(outcome.message);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="xl"
      busy={busy}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button
            variant="secondary"
            iconLeft={<FileOutput className="h-4 w-4" />}
            onClick={doSavePdf}
            disabled={busy}
          >
            Save PDF
          </Button>
          <Button
            variant="primary"
            iconLeft={<Printer className="h-4 w-4" />}
            onClick={doPrint}
            loading={busy}
          >
            Print
          </Button>
        </>
      }
    >
      <DocumentPreview html={html} orientation={orientation} maxHeight="58vh" />

      <p className="mt-2 text-center text-[12px] text-[var(--text-3)]">
        A4 · {orientation === "landscape" ? "297 × 210 mm" : "210 × 297 mm"} · this is exactly the
        page that will be printed.
      </p>
    </Dialog>
  );
}
