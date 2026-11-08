/**
 * The report preview.
 *
 * The sheet is A4 - 210 by 297 millimetres, or the other way round for a
 * landscape report - so the user sees the page the document will be printed
 * on, not a web page that happens to hold the same text. The document inside is
 * the very one the printer receives, so what was checked is what comes out.
 */

import { ArrowLeft, FileOutput, Printer } from "lucide-react";
import { Button } from "../ui/Button";
import { PageHeader } from "../ui/Feedback";
import { DocumentPreview } from "./DocumentPreview";
import type { DocumentOrientation } from "./document-css";

export interface ReportPreviewProps {
  /** The rendered document. This is exactly what will be printed. */
  readonly html: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly orientation?: DocumentOrientation | undefined;
  readonly onPrint: () => void;
  readonly onExportPdf: () => void;
  readonly onBack: () => void;
  readonly busy?: boolean | undefined;
}

export function ReportPreview({
  html,
  title,
  description,
  orientation = "portrait",
  onPrint,
  onExportPdf,
  onBack,
  busy = false,
}: ReportPreviewProps): React.JSX.Element {
  return (
    <div>
      <PageHeader
        title={title}
        description={description}
        breadcrumbs={[{ label: "Reports", onClick: onBack }]}
        actions={
          <>
            <Button
              variant="secondary"
              iconLeft={<ArrowLeft className="h-4 w-4" />}
              onClick={onBack}
              disabled={busy}
            >
              Back to Reports
            </Button>
            <Button
              variant="secondary"
              iconLeft={<FileOutput className="h-4 w-4" />}
              onClick={onExportPdf}
              disabled={busy}
            >
              Export PDF
            </Button>
            <Button
              variant="primary"
              iconLeft={<Printer className="h-4 w-4" />}
              onClick={onPrint}
              loading={busy}
            >
              Print Report
            </Button>
          </>
        }
      />

      <DocumentPreview html={html} orientation={orientation} maxHeight="72vh" />
    </div>
  );
}
