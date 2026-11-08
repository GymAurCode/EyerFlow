/**
 * Sale dialog.
 *
 * Opens from the sales list (New / Edit / row click). Cost and selling price
 * are entered per line at the time of sale - the "Bought at" is pre-filled
 * from the product's last purchase cost, "Sell at" from its last sale price,
 * and both are editable. Profit = (sell - cost) × qty, shown green/red.
 *
 * The footer totals panel shows subtotal, discount, VAT, total and - for
 * admins only - total profit. Staff never see profit.
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
import { cn, todayIso } from "../../lib/utils";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Field, Input, Select, type SelectOption } from "../ui/Input";
import { LineItemsEditor, newLineItem, type LineItem } from "./LineItemsEditor";

export interface SaleDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** When set, the dialog edits this document instead of creating a new one. */
  readonly document?: DocumentDto | null;
}

/** The states a sale can be saved in, before any payment is taken. */
const STATUS_OPTIONS: readonly SelectOption[] = [
  { value: "draft", label: "Draft" },
  { value: "issued", label: "Issued" },
  { value: "paid", label: "Paid" },
];

export function SaleDialog({ open, onOpenChange, document }: SaleDialogProps): React.JSX.Element {
  const { can, settings } = useApp();
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

  // Read from the prefetched cache rather than fetching on open. The dialog can
  // draw its customer and product pickers on the first frame, with no wait on
  // the database.
  const parties = useLookup<PartyDto>("customer");
  const products = useLookup<ProductDto>("product");

  // Seed the form when the dialog opens.
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

  const productMap = useMemo(() => {
    const map = new Map<number, ProductDto>();
    for (const product of products) map.set(product.id, product);
    return map;
  }, [products]);

  // Stock check: block the sale if any line exceeds available stock.
  const stockError = useMemo(() => {
    for (const line of lines) {
      if (line.productId === null) continue;
      const product = productMap.get(line.productId);
      if (!product) continue;
      const qty = parseQuantity(line.quantityText) ?? 0;
      if (qty > 0 && qty > product.quantityMilli && !settings.allowNegativeStock) {
        return `Not enough stock for "${product.name}". On hand: ${product.quantityMilli / 1000}, needed: ${qty / 1000}.`;
      }
    }
    return null;
  }, [lines, productMap, settings.allowNegativeStock]);

  // Totals. Quantities are entered in whole units but stored in milli-units,
  // so the totals work in whole units against fils: a line is
  // `quantity x unit price` and every figure below is in fils.
  const unitsOf = (text: string): number => (parseQuantity(text) ?? 0) / 1000;

  const subtotal = lines.reduce(
    (sum, l) => sum + unitsOf(l.quantityText) * (parseAmount(l.priceText) ?? 0),
    0,
  );
  const discount = parseAmount(discountText) ?? 0;
  const netAfterDiscount = Math.max(0, subtotal - discount);
  const vat = Math.round(netAfterDiscount * (settings.vatRatePercent / 100));
  const total = netAfterDiscount + vat;
  const totalProfit = lines.reduce(
    (sum, l) =>
      sum +
      unitsOf(l.quantityText) * ((parseAmount(l.priceText) ?? 0) - (parseAmount(l.costText) ?? 0)),
    0,
  );
  const paid = parseAmount(paidText) ?? 0;
  const balance = Math.max(0, total - paid);
  // The field's own error: paid may not run past the total, and the message
  // names the ceiling rather than just saying "too much".
  const payCheck = checkPaidAmount(total, paid);
  const payError = payCheck.ok ? null : payCheck.message;

  // Radix reserves the empty string for "nothing chosen", so the placeholder on
  // the control is what reads "Select customer" rather than an option.
  const partyOptions: SelectOption[] = useMemo(
    () => parties.map((party) => ({ value: String(party.id), label: party.name })),
    [parties],
  );

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
    if (stockError !== null) {
      setError(stockError);
      return;
    }
    setError(null);
    setBusy(true);

    void call("documents.save", {
      ...(isEditing ? { id: document.id } : {}),
      kind: "invoice",
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
        unitPriceFils: parseAmount(line.priceText) ?? 0,
        unitCostFils: parseAmount(line.costText) ?? 0,
        vatTreatment: "standard" as const,
      })),
    })
      .then(() => {
        toast.success(isEditing ? "Invoice updated" : "Invoice created");
        // Stock moved, so the cached product list is stale. Refetch in the
        // background: the next dialog to open already has fresh figures.
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

  const showProfit = can("reports", "view");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onOpenChange(false);
      }}
      size="xl"
      title={isEditing ? `Edit ${document?.number ?? "invoice"}` : "New sale"}
      description={
        isEditing ? document?.number : "Record a sale. Cost and price are entered per line."
      }
      busy={busy}
      footer={
        <div className="flex w-full flex-col gap-3">
          {/* Totals panel */}
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
              {showProfit && (
                <TotalRow
                  label="Total profit"
                  value={formatMoney(totalProfit)}
                  tone={totalProfit >= 0 ? "success" : "danger"}
                />
              )}
              <TotalRow label="Paid" value={formatMoney(paid)} />
              <TotalRow
                label="Balance"
                value={formatMoney(balance)}
                tone={balance > 0 ? "warning" : "success"}
              />
              <TotalRow
                label="Status"
                value={
                  payError !== null
                    ? "—"
                    : balance <= 0 && total > 0
                      ? "Paid"
                      : paid > 0
                        ? "Part paid"
                        : "Unpaid"
                }
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
              {isEditing ? "Update invoice" : "Create invoice"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Header fields */}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Customer" required>
            {(id) => (
              <Select
                id={id}
                value={partyId === "" ? "" : String(partyId)}
                options={partyOptions}
                placeholder="Select customer"
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
            hint="Cannot exceed the total. Anything extra is recorded as a credit on the customer's account from Accounts."
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
                    className={cn(
                      "tabular text-end",
                      paid > 0 && "text-[var(--success)]",
                      payError !== null && "text-[var(--danger)]",
                    )}
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

                {/* The payment state, in words as well as in the totals row: "is this
                    settled" is the question the shopkeeper has when the customer
                    is standing at the counter. It stays quiet while the amount
                    is wrong - reporting "paid in full" under an error that says
                    the amount is impossible would be telling them two different
                    things at once. */}
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

        {/* Items */}
        <div>
          <p className="mb-2 text-[13px] font-medium text-[var(--text-primary)]">Items</p>
          <LineItemsEditor
            items={lines}
            products={products}
            isSale
            showProfit={showProfit}
            costLabel="Bought at"
            onChange={(items) => {
              setLines([...items]);
            }}
          />
          {stockError !== null && (
            <p
              className="mt-2 rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-[13px] text-[var(--danger-fg)]"
              role="alert"
            >
              {stockError}
            </p>
          )}
        </div>

        {/* Notes */}
        <Field label="Notes">
          {(id) => (
            <Input
              id={id}
              value={notes}
              onChange={(event) => {
                setNotes(event.target.value);
              }}
              placeholder="Optional notes printed on the invoice."
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
  readonly tone?: "success" | "warning" | "danger" | undefined;
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
        } ${tone === "success" ? "text-[var(--success-fg)]" : tone === "warning" ? "text-[var(--warning-fg)]" : tone === "danger" ? "text-[var(--danger-fg)]" : "text-[var(--text-primary)]"}`}
      >
        {value}
      </span>
    </div>
  );
}
