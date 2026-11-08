/**
 * Update Payment dialog for a single document.
 *
 * The button that opens it only appears when money is still owed, so the
 * dialog starts from a real balance rather than a blank amount field. The
 * amount may not exceed what is outstanding - not here, and not on the server
 * either, which checks again inside the transaction that writes the payment.
 */

import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { DocumentDto } from "../../../shared/types";
import { call, errorMessage } from "../../lib/api";
import { formatMoney, parseAmount } from "../../lib/format";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Field, Input, MoneyInput, Select, type SelectOption } from "../ui/Input";

const METHOD_OPTIONS: readonly SelectOption[] = [
  { value: "cash", label: "Cash" },
  { value: "bank", label: "Bank transfer" },
  { value: "card", label: "Card" },
];

export interface DocumentPaymentDialogProps {
  readonly document: DocumentDto | null;
  readonly onClose: () => void;
  /** Called after the payment is saved, so the list and the balances refresh. */
  readonly onSaved: () => void;
}

export function DocumentPaymentDialog({
  document,
  onClose,
  onSaved,
}: DocumentPaymentDialogProps): React.JSX.Element | null {
  const [amountText, setAmountText] = useState("");
  const [paymentDate, setPaymentDate] = useState("");
  const [method, setMethod] = useState<"cash" | "bank" | "card">("cash");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPurchase = document?.kind === "purchaseInvoice";
  const outstanding = document?.outstandingFils ?? 0;

  // A new document starts the amount at the full balance: that is the payment
  // the shop is about to make, and it can be typed over.
  useEffect(() => {
    if (document === null) return;
    setAmountText((outstanding / 100).toFixed(2));
    setPaymentDate(new Date().toISOString().slice(0, 10));
    setMethod("cash");
    setReference("");
    setError(null);
  }, [document, outstanding]);

  if (document === null) return null;

  const submit = (): void => {
    if (busy) return;

    const amountFils = parseAmount(amountText);
    if (amountFils === null || amountFils <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }
    if (amountFils > outstanding) {
      setError(`Payment cannot exceed the outstanding balance of ${formatMoney(outstanding)}.`);
      return;
    }

    setError(null);
    setBusy(true);

    void call("payments.save", {
      direction: isPurchase ? "outbound" : "inbound",
      partyId: document.partyId ?? 0,
      paymentDate,
      method,
      amountFils,
      reference: reference.trim().length > 0 ? reference.trim() : null,
      notes: null,
      allocations: [{ documentId: document.id, amountFils }],
    })
      .then(() => {
        toast.success("Payment recorded");
        onSaved();
        onClose();
      })
      .catch((caught: unknown) => {
        setError(errorMessage(caught));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="sm"
      title="Update payment"
      description={`${document.number} · ${document.partyName ?? "—"}`}
      busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            Record payment
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="rounded-lg bg-[var(--surface-2)] px-3 py-2.5 text-[13px] text-[var(--text-2)]">
          Outstanding:{" "}
          <span className="tabular font-medium text-[var(--text)]">{formatMoney(outstanding)}</span>
          {" · "}
          Total {formatMoney(document.grossFils)}, paid {formatMoney(document.paidFils)}
        </p>

        <Field
          label="Amount"
          required
          error={error}
          hint={`The most that can be paid now is ${formatMoney(outstanding)}.`}
        >
          {(id) => (
            <MoneyInput
              id={id}
              value={amountText}
              onChange={(event) => {
                setAmountText(event.target.value);
                setError(null);
              }}
              autoFocus
            />
          )}
        </Field>

        <Field label="Date" required>
          {(id) => (
            <Input
              id={id}
              type="date"
              value={paymentDate}
              onChange={(event) => {
                setPaymentDate(event.target.value);
              }}
            />
          )}
        </Field>

        <Field label="Method" required>
          {(id) => (
            <Select
              id={id}
              value={method}
              options={METHOD_OPTIONS}
              onChange={(next) => {
                setMethod(next as "cash" | "bank" | "card");
              }}
            />
          )}
        </Field>

        <Field label="Reference" hint="Cheque number, transfer ID.">
          {(id) => (
            <Input
              id={id}
              value={reference}
              onChange={(event) => {
                setReference(event.target.value);
              }}
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}
