/**
 * Purchase dialog.
 *
 * Opens from the purchases list (New / Edit). Items have a product, a quantity
 * and a cost per unit; saving adds the stock and updates each product's
 * "last cost". Totals show subtotal, VAT, total, paid and balance.
 */

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { DocumentDto, DocumentStatus, PartyDto, ProductDto } from "../../../shared/types";
import { call, errorMessage } from "../../lib/api";
import { checkPaidAmount } from "../../../domain/document";
import { useApp } from "../../lib/app-context";
import { formatMoney, parseAmount, parseQuantity } from "../../lib/format";
import { invalidateLookups, useLookup } from "../../lib/lookups";
import { todayIso } from "../../lib/utils";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Field, Input, Select, type SelectOption } from "../ui/Input";
import { LineItemsEditor, newLineItem, type LineItem } from "./LineItemsEditor";

export interface PurchaseDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly document?: DocumentDto | null;
}

export function PurchaseDialog({
  open,
  onOpenChange,
  document,
}: PurchaseDialogProps): React.JSX.Element {
  const { settings } = useApp();
  const client = useQueryClient();
  const isEditing = document != null;

  const [partyId, setPartyId] = useState<number | "">("");
  const [issueDate, setIssueDate] = useState(todayIso());
  const [dueDate, setDueDate] = useState("");
  const [status, setStatus] = useState<DocumentStatus>("issued");
  const [paidText, setPaidText] = useState("");
  const [discountText, setDiscountText] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seeded, setSeeded] = useState<string | null>(null);

  // Prefetched cache, so the dialog draws its pickers on the first frame.
  const parties = useLookup<PartyDto>("supplier");
  const products = useLookup<ProductDto>("product");

  useEffect(() => {
    if (!open) return;
    const seedKey = isEditing ? `edit-${String(document?.id)}` : "new";
    if (seeded === seedKey) return;
    setSeeded(seedKey);

    if (isEditing && document) {
      setPartyId(document.partyId ?? "");
      setIssueDate(document.issueDate);
      setDueDate(document.dueDate ?? "");
      setStatus(document.status === "cancelled" ? "issued" : document.status);
      setPaidText(document.paidFils > 0 ? String(document.paidFils / 100) : "");
      setDiscountText(document.discountFils > 0 ? String(document.discountFils / 100) : "");
      setNotes(document.notes ?? "");
      setLines(
        document.lines.map((line) => ({
          id: line.id,
          productId: line.productId,
          description: line.description,
          quantityText: String(line.quantityMilli / 1000),
          costText: String(line.unitCostFils / 100),
          priceText: String(line.unitPriceFils / 100),
        })),
      );
    } else {
      setPartyId("");
      setIssueDate(todayIso());
      setDueDate("");
      setStatus("issued");
      setPaidText("");
      setDiscountText("");
      setNotes("");
      setLines([newLineItem()]);
    }
    setError(null);
  }, [open, isEditing, document, seeded]);

  // Totals. Quantities are entered in whole units but stored in milli-units,
  // so the totals work in whole units against fils.
  const unitsOf = (text: string): number => (parseQuantity(text) ?? 0) / 1000;

  const subtotal = lines.reduce(
    (sum, l) => sum + unitsOf(l.quantityText) * (parseAmount(l.costText) ?? 0),
    0,
  );
  const discount = parseAmount(discountText) ?? 0;
  const netAfterDiscount = Math.max(0, subtotal - discount);
  const vat = Math.round(netAfterDiscount * (settings.vatRatePercent / 100));
  const total = netAfterDiscount + vat;
  const paid = parseAmount(paidText) ?? 0;
  // Balance is floored at zero and the amount is checked: more than the total
  // is never recorded as a payment.
  const balance = Math.max(0, total - paid);
  const payCheck = checkPaidAmount(total, paid);
  const payError = payCheck.ok ? null : payCheck.message;

  const partyOptions = useMemo<SelectOption[]>(
    () => parties.map((party) => ({ value: String(party.id), label: party.name })),
    [parties],
  );

  /** The states a purchase can be saved in, before any payment is made. */
  const STATUS_OPTIONS: readonly SelectOption[] = [
    { value: "draft", label: "Draft" },
    { value: "issued", label: "Issued" },
    { value: "paid", label: "Paid" },
  ];

  const submit = (): void => {
    if (busy) return;
    if (payError !== null) {
      setError(payError);
      return;
    }
    if (lines.length === 0) {
      setError("Add at least one line item.");
      return;
    }
    setError(null);
    setBusy(true);

    void call("documents.save", {
      ...(isEditing ? { id: document.id } : {}),
      kind: "purchaseInvoice",
      partyId: partyId === "" ? null : partyId,
      issueDate,
      dueDate: dueDate || null,
      status,
      notes: notes.trim().length > 0 ? notes.trim() : null,
      paidAmountFils: paid,
      discountFils: discount,
      lines: lines.map((line) => ({
        productId: line.productId,
        description: line.description,
        quantityMilli: parseQuantity(line.quantityText) ?? 0,
        // On a purchase the cost per unit is the price paid, so it is both the
        // unit price and the unit cost.
        unitPriceFils: parseAmount(line.costText) ?? 0,
        unitCostFils: parseAmount(line.costText) ?? 0,
        vatTreatment: "standard" as const,
      })),
    })
      .then(() => {
        toast.success(isEditing ? "Purchase updated" : "Purchase created");
        // Stock and last cost both moved; refresh the cache the pickers read.
        invalidateLookups("product");
        void client.invalidateQueries({ queryKey: ["documents"] });
        void client.invalidateQueries({ queryKey: ["products"] });
        void client.invalidateQueries({ queryKey: ["dashboard"] });
        onOpenChange(false);
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
      open={open}
      onOpenChange={(next) => {
        if (!next) onOpenChange(false);
      }}
      size="xl"
      title={isEditing ? `Edit ${document?.number ?? "purchase"}` : "New purchase"}
      description={
        isEditing
          ? document?.number
          : "Record a purchase. The cost per unit becomes the product's last cost."
      }
      busy={busy}
      footer={
        <div className="flex w-full flex-col gap-3">
          <div className="flex justify-end">
            <div className="w-64 space-y-1 text-[13px]">
              <TotalRow label="Subtotal" value={formatMoney(subtotal)} />
              <TotalRow label="Discount" value={`−${formatMoney(discount)}`} />
              <TotalRow
                label={`VAT (${String(settings.vatRatePercent)}%)`}
                value={formatMoney(vat)}
              />
              <div className="border-t border-[var(--divider)] pt-1">
                <TotalRow label="Total" value={formatMoney(total)} strong />
              </div>
              <TotalRow label="Paid" value={formatMoney(paid)} />
              <TotalRow
                label="Balance"
                value={formatMoney(balance)}
                tone={balance > 0 ? "warning" : "success"}
              />
            </div>
          </div>

          {error !== null && (
            <p
              className="rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-[13px] text-[var(--danger-fg)]"
              role="alert"
            >
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} disabled={payError !== null} onClick={submit}>
              {isEditing ? "Update purchase" : "Create purchase"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Supplier" required>
            {(id) => (
              <Select
                id={id}
                value={partyId === "" ? "" : String(partyId)}
                options={partyOptions}
                placeholder="Select supplier"
                onChange={(next) => {
                  setPartyId(next === "" ? "" : Number(next));
                }}
              />
            )}
          </Field>

          <Field label="Date" required>
            {(id) => (
              <Input
                id={id}
                type="date"
                value={issueDate}
                onChange={(event) => {
                  setIssueDate(event.target.value);
                }}
              />
            )}
          </Field>

          <Field label="Due date">
            {(id) => (
              <Input
                id={id}
                type="date"
                value={dueDate}
                onChange={(event) => {
                  setDueDate(event.target.value);
                }}
              />
            )}
          </Field>

          <Field label="Status">
            {(id) => (
              <Select
                id={id}
                value={status}
                options={STATUS_OPTIONS}
                onChange={(next) => {
                  setStatus(next as DocumentStatus);
                }}
              />
            )}
          </Field>

          <Field label="Discount">
            {(id) => (
              <Input
                id={id}
                type="number"
                min={0}
                step="0.01"
                value={discountText}
                onChange={(event) => {
                  setDiscountText(event.target.value);
                }}
                placeholder="0.00"
              />
            )}
          </Field>

          <Field
            label="Amount paid"
            hint="Cannot exceed the total. Anything extra is recorded as a credit on the supplier's account from Accounts."
            error={payError}
          >
            {(id) => (
              <>
                <div className="flex items-center gap-2">
                  <Input
                    id={id}
                    type="number"
                    min={0}
                    max={total / 100}
                    step="0.01"
                    value={paidText}
                    invalid={payError !== null}
                    onChange={(event) => {
                      setPaidText(event.target.value);
                    }}
                    placeholder="0.00"
                    className="tabular text-end"
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    className="shrink-0 whitespace-nowrap"
                    disabled={total <= 0}
                    onClick={() => {
                      setPaidText(String(total / 100));
                    }}
                  >
                    Full amount
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 whitespace-nowrap"
                    disabled={paid <= 0}
                    onClick={() => {
                      setPaidText("");
                    }}
                  >
                    Mark unpaid
                  </Button>
                </div>

                <p className="mt-1.5 text-[12px] text-[var(--text-2)]">
                  {payError !== null
                    ? "Fix the amount to see what is still due."
                    : total <= 0
                      ? "Enter the items to see the total."
                      : paid >= total
                        ? "Paid in full — nothing outstanding."
                        : paid > 0
                          ? `Part paid — ${formatMoney(balance)} still due.`
                          : `Unpaid — ${formatMoney(total)} due.`}
                </p>
              </>
            )}
          </Field>
        </div>

        <div>
          <p className="mb-2 text-[13px] font-medium text-[var(--text-primary)]">Items</p>
          <LineItemsEditor
            items={lines}
            products={products}
            isSale={false}
            showProfit={false}
            costLabel="Cost per unit"
            onChange={(items) => {
              setLines([...items]);
            }}
          />
        </div>

        <Field label="Notes">
          {(id) => (
            <Input
              id={id}
              value={notes}
              onChange={(event) => {
                setNotes(event.target.value);
              }}
              placeholder="Optional notes."
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}

function TotalRow({
  label,
  value,
  strong = false,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly strong?: boolean | undefined;
  readonly tone?: "success" | "warning" | undefined;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between">
      <span
        className={
          strong ? "font-semibold text-[var(--text-primary)]" : "text-[var(--text-secondary)]"
        }
      >
        {label}
      </span>
      <span
        className={`tabular ${
          strong ? "font-semibold text-[var(--text-primary)]" : ""
        } ${tone === "success" ? "text-[var(--success-fg)]" : tone === "warning" ? "text-[var(--warning-fg)]" : "text-[var(--text-primary)]"}`}
      >
        {value}
      </span>
    </div>
  );
}
