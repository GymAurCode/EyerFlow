/**
 * Read-only document detail dialog.
 *
 * Opened by clicking a row in a document list. Shows the party, lines, totals
 * and payment position, with Print / Save PDF / Edit actions. Replaces the old
 * full-page detail screen: the list stays put behind the dialog.
 */

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Ban, FileOutput, HandCoins, Pencil, Printer, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { DocumentDto, DocumentStatus, PaymentDto } from "../../../shared/types";
import { call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { formatMoney, formatQuantity } from "../../lib/format";
import { saveInvoicePdf } from "../../lib/print";
import { Button } from "../ui/Button";
import { StatusBadge } from "../ui/Badge";
import { Dialog } from "../ui/Dialog";
import { DeleteConfirmDialog } from "../ui/DeleteConfirmDialog";
import { Field, Textarea } from "../ui/Input";
import { DocumentPaymentDialog } from "./DocumentPaymentDialog";

const STATUS_LABELS: Record<DocumentStatus, string> = {
  draft: "Draft",
  issued: "Issued",
  partPaid: "Part paid",
  paid: "Paid",
  cancelled: "Cancelled",
};

function formatDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

export interface DocumentDetailDialogProps {
  readonly document: DocumentDto | null;
  readonly onClose: () => void;
  readonly onEdit: (document: DocumentDto) => void;
  /** Opens the print preview for the document. */
  readonly onPrint: (document: DocumentDto) => void;
  /** Called after a draft has been deleted, so the list can refresh. */
  readonly onDeleted?: (() => void) | undefined;
  /** Called after a payment has been recorded, so the list can refresh. */
  readonly onPaid?: (() => void) | undefined;
}

export function DocumentDetailDialog({
  document,
  onClose,
  onEdit,
  onPrint,
  onDeleted,
  onPaid,
}: DocumentDetailDialogProps): React.JSX.Element | null {
  const { can, settings } = useApp();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  // What has been paid against this document. The list is read from the
  // payments themselves, so a payment that was deleted is not on it.
  const { data: payments } = useQuery({
    queryKey: ["payments", "document", document?.id ?? 0],
    queryFn: () =>
      call("payments.list", { documentId: document?.id ?? 0, limit: 200 }),
    enabled: document !== null,
  });

  const paymentHistory: readonly PaymentDto[] = payments ?? [];

  if (document === null) {
    return null;
  }

  const isPurchase = document.kind === "purchaseInvoice";
  const permissionModule = isPurchase ? "purchases" : "sales";
  const isHistory = document.status === "cancelled";
  const canEdit = can(permissionModule, "edit") && !isHistory;
  const canDelete = can(permissionModule, "delete") && document.status === "draft";
  // Money still owed is the only reason to offer to take money. A document
  // that is paid, cancelled or not yet issued has nothing outstanding, so the
  // button is not offered at all.
  const canPay =
    can("payments", "create") &&
    document.status !== "cancelled" &&
    document.status !== "draft" &&
    document.outstandingFils > 0;

  const confirmCancel = (): void => {
    setBusy(true);
    void call("documents.cancel", { id: document.id, reason: reason.trim() })
      .then(() => {
        setCancelOpen(false);
        setReason("");
        toast.success(isPurchase ? "Purchase cancelled" : "Invoice cancelled");
        onClose();
      })
      .catch((caught: unknown) => {
        toast.error(errorMessage(caught));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const confirmDelete = (): void => {
    setBusy(true);
    void call("documents.delete", { id: document.id })
      .then(() => {
        toast.success(`${document.number} deleted`);
        setDeleteOpen(false);
        onClose();
        onDeleted?.();
      })
      .catch((caught: unknown) => {
        toast.error(errorMessage(caught));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <>
      <Dialog
        open={document !== null}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
        size="lg"
        title={`${isPurchase ? "Purchase" : "Invoice"} ${document.number}`}
        description={`${document.partyName ?? "—"} · ${formatDate(document.issueDate)}`}
        footer={
          <>
            <Button
              variant="secondary"
              loading={busy}
              iconLeft={<Printer className="h-4 w-4" />}
              onClick={() => {
                onPrint(document);
              }}
            >
              Print
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              iconLeft={<FileOutput className="h-4 w-4" />}
              onClick={() => {
                void saveInvoicePdf(document, { settings }).then((outcome) => {
                  if (!outcome.ok) toast.error(outcome.message);
                });
              }}
            >
              Save PDF
            </Button>
            {canEdit && (
              <Button
                variant="primary"
                iconLeft={<Pencil className="h-4 w-4" />}
                onClick={() => {
                  onEdit(document);
                }}
              >
                Edit
              </Button>
            )}
            {canPay && (
              <Button
                variant="primary"
                iconLeft={<HandCoins className="h-4 w-4" />}
                onClick={() => {
                  setPaymentOpen(true);
                }}
              >
                Update payment
              </Button>
            )}
            {can(permissionModule, "cancel") &&
              document.status !== "cancelled" &&
              document.status !== "draft" && (
                <Button
                  variant="destructive"
                  iconLeft={<Ban className="h-4 w-4" />}
                  onClick={() => {
                    setCancelOpen(true);
                  }}
                >
                  Cancel
                </Button>
              )}
            {canDelete && (
              <Button
                variant="danger"
                iconLeft={<Trash2 className="h-4 w-4" />}
                onClick={() => {
                  setDeleteOpen(true);
                }}
              >
                Delete
              </Button>
            )}
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                {isPurchase ? "Supplier" : "Customer"}
              </p>
              <p className="text-sm font-medium text-ink">{document.partyName ?? "—"}</p>
            </div>
            <div className="text-end">
              <StatusBadge status={document.status} label={STATUS_LABELS[document.status]} />
              <p className="mt-1 text-[13px] text-ink-secondary">
                Issued: {formatDate(document.issueDate)}
              </p>
              {document.dueDate !== null && (
                <p className="text-[13px] text-ink-secondary">
                  Due: {formatDate(document.dueDate)}
                </p>
              )}
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-[13px]">
              <thead className="bg-[var(--table-header-bg)]">
                <tr>
                  <th className="px-3 py-2 text-start text-xs font-semibold uppercase tracking-wide text-ink-secondary">
                    Item
                  </th>
                  <th className="px-3 py-2 text-end text-xs font-semibold uppercase tracking-wide text-ink-secondary">
                    Qty
                  </th>
                  <th className="px-3 py-2 text-end text-xs font-semibold uppercase tracking-wide text-ink-secondary">
                    Price
                  </th>
                  <th className="px-3 py-2 text-end text-xs font-semibold uppercase tracking-wide text-ink-secondary">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {document.lines.map((line) => (
                  <tr key={line.id} className="border-t border-line-soft">
                    <td className="px-3 py-2 text-ink">{line.description}</td>
                    <td className="tabular px-3 py-2 text-end">
                      {formatQuantity(line.quantityMilli)}
                    </td>
                    <td className="tabular px-3 py-2 text-end">
                      {formatMoney(line.unitPriceFils)}
                    </td>
                    <td className="tabular px-3 py-2 text-end font-medium">
                      {formatMoney(line.netFils + line.vatFils)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex justify-end">
            <div className="w-64 space-y-1 text-[13px]">
              <div className="flex justify-between">
                <span className="text-ink-secondary">Subtotal</span>
                <span className="tabular">
                  {formatMoney(document.netFils + document.discountFils)}
                </span>
              </div>
              {document.discountFils > 0 && (
                <div className="flex justify-between">
                  <span className="text-ink-secondary">Discount</span>
                  <span className="tabular">
                    -{formatMoney(document.discountFils)}
                  </span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-ink-secondary">Net</span>
                <span className="tabular">{formatMoney(document.netFils)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-secondary">VAT</span>
                <span className="tabular">{formatMoney(document.vatFils)}</span>
              </div>
              <div className="flex justify-between border-t border-[var(--divider)] pt-1 font-semibold">
                <span>Total</span>
                <span className="tabular">
                  {formatMoney(document.grossFils)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-secondary">Paid</span>
                <span className="tabular text-success-fg">
                  {formatMoney(document.paidFils)}
                </span>
              </div>
              <div className="flex justify-between font-medium">
                <span
                  className={
                    document.outstandingFils > 0 ? "text-warning-fg" : "text-ink-secondary"
                  }
                >
                  Outstanding
                </span>
                <span className="tabular text-ink">
                  {formatMoney(document.outstandingFils)}
                </span>
              </div>
            </div>
          </div>

          {document.notes !== null && document.notes.length > 0 && (
            <p className="border-t border-line-soft pt-3 text-sm text-ink-secondary">
              <span className="font-medium text-ink">Notes: </span>
              {document.notes}
            </p>
          )}

          {/* What has been paid, and when. */}
          <div className="border-t border-line-soft pt-3">
            <p className="text-[13px] font-medium text-ink">Payment history</p>
            {paymentHistory.length === 0 ? (
              <p className="mt-1 text-[13px] text-ink-secondary">
                Nothing has been paid against this document yet.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-[var(--border)]">
                {paymentHistory.map((payment) => (
                  <li
                    key={payment.id}
                    className="flex items-center justify-between gap-4 py-1.5 text-[13px]"
                  >
                    <span className="text-ink-secondary">
                      {formatDate(payment.paymentDate)} ·{" "}
                      {payment.receiptNumber ?? "Receipt"} · {payment.method.toUpperCase()}
                    </span>
                    <span className="tabular font-medium text-ink">
                      {formatMoney(payment.amountFils)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Dialog>

      {/* Delete confirm */}
      <DeleteConfirmDialog
        open={deleteOpen}
        subject={`draft ${document.number}`}
        message={
          `The draft ${document.number} will be removed. This cannot be undone. ` +
          "Only a draft can be deleted - an issued invoice is cancelled instead."
        }
        busy={busy}
        onCancel={() => {
          setDeleteOpen(false);
        }}
        onConfirm={confirmDelete}
      />

      {/* Cancel confirm */}
      <Dialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        size="sm"
        title={isPurchase ? "Cancel purchase" : "Cancel invoice"}
        busy={busy}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCancelOpen(false)} disabled={busy}>
              Keep it
            </Button>
            <Button variant="destructive" loading={busy} onClick={confirmCancel}>
              Cancel
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-ink-secondary">
            {document.number} · {formatMoney(document.grossFils)}
          </p>
          <p className="text-sm text-ink-secondary">
            Cancelling reverses the stock movements and the VAT position of this document. The
            document is kept for the record and can no longer be edited.
          </p>
          <Field label="Reason" required>
            {(id) => (
              <Textarea
                id={id}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
                placeholder="Why is this being cancelled?"
                autoFocus
              />
            )}
          </Field>
        </div>
      </Dialog>

      {/* Payment against this document */}
      {paymentOpen && (
        <DocumentPaymentDialog
          document={document}
          onClose={() => {
            setPaymentOpen(false);
          }}
          onSaved={() => {
            onPaid?.();
          }}
        />
      )}
    </>
  );
}
