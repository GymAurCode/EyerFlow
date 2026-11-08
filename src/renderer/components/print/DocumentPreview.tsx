/**
 * The document preview, shown as a sheet of A4 paper.
 *
 * The sheet is the real paper size - 210 by 297 millimetres, or the other way
 * round for a landscape report - so what the user sees is the shape of the
 * page the document will be printed on, not a web page that happens to hold
 * the same text.
 *
 * The document inside is laid out in millimetres too, with the same margins
 * the `@page` rule gives the printer, so a line that fits on the preview fits
 * on the paper.
 *
 * The iframe renders the very document the printer receives. `sandbox=""` makes
 * it inert: a preview is a document, not an application.
 */

import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import type { DocumentOrientation } from "./document-css";

/** The paper, in millimetres. */
const PAPER: Record<DocumentOrientation, { readonly width: number; readonly height: number }> = {
  portrait: { width: 210, height: 297 },
  landscape: { width: 297, height: 210 },
};

/** CSS lays one millimetre out at 96/25.4 pixels. */
const PIXELS_PER_MM = 96 / 25.4;

export interface DocumentPreviewProps {
  /** The rendered document. This is exactly what will be printed. */
  readonly html: string;
  readonly orientation?: DocumentOrientation | undefined;
  readonly className?: string | undefined;
  /** How tall the sheet is allowed to get, as a CSS length. */
  readonly maxHeight?: string | undefined;
}

export function DocumentPreview({
  html,
  orientation = "portrait",
  className,
  maxHeight = "70vh",
}: DocumentPreviewProps): React.JSX.Element {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  const paper = PAPER[orientation];
  const paperWidthPx = paper.width * PIXELS_PER_MM;
  const paperHeightPx = paper.height * PIXELS_PER_MM;

  // The sheet is scaled down when the panel is narrower than the paper, so it
  // is always the whole page that is visible rather than a cropped corner.
  useEffect(() => {
    const element = frameRef.current;
    if (element === null) return;

    const measure = (): void => {
      const available = element.clientWidth - 24;
      setScale(Math.min(1, Math.max(0.3, available / paperWidthPx)));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [paperWidthPx]);

  return (
    <div
      ref={frameRef}
      className={cn("overflow-auto rounded-xl bg-[var(--surface-2)] p-3", className)}
      style={{ maxHeight }}
    >
      <div
        className="mx-auto"
        style={{
          width: `${String(paperWidthPx * scale)}px`,
          height: `${String(paperHeightPx * scale)}px`,
        }}
      >
        <div
          className="overflow-hidden bg-white shadow-[0_2px_18px_-8px_rgba(15,23,42,0.45)] ring-1 ring-black/5"
          style={{
            width: `${String(paper.width)}mm`,
            height: `${String(paper.height)}mm`,
            transform: `scale(${String(scale)})`,
            transformOrigin: "top left",
          }}
        >
          <iframe
            title="Document preview"
            srcDoc={html}
            sandbox=""
            className="h-full w-full border-0 bg-white"
          />
        </div>
      </div>
    </div>
  );
}
