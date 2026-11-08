/**
 * Payments and receipts.
 *
 * One screen for money in and money out, because a shopkeeper does not think
 * of "receiving" and "paying" as two different activities - they think of
 * "money coming in" and "money going out".
 *
 * The screen answers a question the old app could not: *what is this money
 * for?* A receipt from a customer settles an invoice. A payment to a supplier
 * settles a bill. But money can also be an advance, an operating expense, the
 * owner's own money, or the purchase of a fixed asset - and those are very
 * different things in the books. The "what it settles" control is therefore
 * part of the form, not a hidden rule.
 *
 * A payment method is not an account. "Bank transfer" settles through the
 * bank ledger and "cash" through the till, and the ledger the money lands in
 * can be chosen explicitly.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, Eye, Plus, Printer } from "lucide-react";
import { toast } from "sonner";
import type { PaymentDto } from "../../../shared/types";
import type { AccountDto, PaymentPostingKind } from "../../../shared/finance";
import { call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { formatAmount, formatMoney, parseAmount } from "../../lib/format";
import { formatDate } from "../../lib/utils";
import { receiptDocumentHtml } from "../../lib/print";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Dialog } from "../../components/ui/Dialog";
import { DetailList, DetailRow } from "../../components/ui/DetailList";
import {
  DocumentPrintDialog,
  type PrintableDocument,
} from "../../components/print/DocumentPrintDialog";
import { type Column, DataTable } from "../../components/ui/DataTable";
import { HighlightText } from "../../components/ui/HighlightText";
import { RecordActions, type RecordAction } from "../../components/ui/RecordActions";
import { Badge } from "../../components/ui/Badge";
import { EmptyState, PageHeader, TableSkeleton } from "../../components/ui/Feedback";
import { Field, Input, MoneyInput, Select, Textarea } from "../../components/ui/Input";
import { usePartyOptions } from "../../lib/hooks";
import { useSearchHighlight } from "../../lib/search-highlight";
import { FinanceLayout } from "./FinanceLayout";

const METHOD_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "bank", label: "Bank transfer" },
  { value: "card", label: "Card" },
];

/** What the money settles, and what each choice means in the books. */
const POSTING_KINDS: readonly {
  readonly value: PaymentPostingKind;
  readonly label: string;
  readonly hint: string;
}[] = [
  {
    value: "auto",
    label: "Settle the invoice",
    hint: "Reduces what the customer owes, or what we owe the supplier.",
  },
  {
    value: "customerAdvance",
    label: "Customer advance",
    hint: "Money received before there is an invoice.",
  },
  {
    value: "supplierAdvance",
    label: "Supplier advance",
    hint: "Money paid before there is a bill.",
  },
  { value: "expense", label: "Operating expense", hint: "Rent, salaries, transport and the like." },
  {
    value: "ownerContribution",
    label: "Capital from the owner",
    hint: "Money the owner put into the business.",
  },
  {
    value: "ownerDrawing",
    label: "Owner's drawings",
    hint: "Money the owner took out of the business.",
  },
  { value: "fixedAsset", label: "Fixed asset", hint: "Equipment, tools or a vehicle." },
  { value: "otherIncome", label: "Other income", hint: "Money in that is not trading." },
  {
    value: "otherExpense",
    label: "Other expense",
    hint: "Money out that is not one of the categories above.",
  },
];

const paymentKey = (row: PaymentDto): number => row.id;

/**
 * `payments.list` has no search parameter, so the loaded rows are filtered
 * here. These are every field a reader can see or would reasonably type: the
 * reference, the receipt number, who it was with, what it settled, the notes,
 * and the amount as it is displayed.
 */
const PAYMENT_SEARCH_FIELDS = [
  (row: PaymentDto) => row.reference,
  (row: PaymentDto) => row.receiptNumber,
  (row: PaymentDto) => row.partyName,
  (row: PaymentDto) => row.notes,
  (row: PaymentDto) => formatAmount(row.amountFils),
  (row: PaymentDto) => row.allocations.map((allocation) => allocation.documentNumber).join(" "),
];

const PAYMENT_RANK_FIELDS = [
  (row: PaymentDto) => row.reference,
  (row: PaymentDto) => row.receiptNumber,
  (row: PaymentDto) => row.partyName,
];

export function FinancePaymentsPage(): React.JSX.Element {
  const { can, settings } = useApp();
  const client = useQueryClient();

  const [direction, setDirection] = useState<"inbound" | "outbound">("inbound");
  const [search, setSearch] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [viewing, setViewing] = useState<PaymentDto | null>(null);
  const [printing, setPrinting] = useState<PrintableDocument | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["payments", { direction, fromDate, toDate }],
    queryFn: () =>
      call("payments.list", {
        direction,
        ...(fromDate.length > 0 ? { fromDate } : {}),
        ...(toDate.length > 0 ? { toDate } : {}),
        limit: 500,
      }),
  });

  const rows = useMemo(() => data ?? [], [data]);

  const highlight = useSearchHighlight(rows, search, {
    rowKey: paymentKey,
    fields: PAYMENT_SEARCH_FIELDS,
    rankFields: PAYMENT_RANK_FIELDS,
  });

  // The matched keys are already computed, so filtering reuses that pass
  // instead of walking every field a second time.
  const visible = useMemo(
    () => (highlight.active ? rows.filter((row) => highlight.keys.has(paymentKey(row))) : rows),
    [rows, highlight],
  );

  const total = useMemo(
    () => visible.reduce((sum, row) => sum + row.amountFils, 0),
    [visible],
  );

  const isSearching = search.trim().length > 0;

  const columns: readonly Column<PaymentDto>[] = [
    {
      id: "date",
      header: "Date",
      widthClass: "w-28",
      cell: (row) => <span className="tabular text-[var(--text-2)]">{row.paymentDate}</span>,
      sortValue: (row) => row.paymentDate,
    },
    {
      id: "reference",
      header: "Reference",
      widthClass: "w-36",
      cell: (row) => (
        <span className="tabular text-[var(--text-2)]">
          <HighlightText text={row.reference ?? row.receiptNumber ?? "—"} term={search} />
        </span>
      ),
      sortValue: (row) => row.reference ?? "",
    },
    {
      id: "party",
      header: direction === "inbound" ? "From" : "To",
      cell: (row) => (
        <span className="text-[var(--text)]">
          <HighlightText text={row.partyName} term={search} />
        </span>
      ),
      sortValue: (row) => row.partyName,
    },
    {
      id: "method",
      header: "Method",
      cell: (row) => (
        <span className="text-[var(--text-2)]">
          {METHOD_OPTIONS.find((option) => option.value === row.method)?.label ?? row.method}
        </span>
      ),
      sortValue: (row) => row.method,
    },
    {
      id: "allocations",
      header: "Applied to",
      cell: (row) =>
        row.allocations.length === 0 ? (
          <span className="text-[var(--text-3)]">On account</span>
        ) : (
          <span className="text-[var(--text-2)]">
            {row.allocations.map((allocation, index) => (
              <span key={allocation.documentId}>
                {index > 0 && ", "}
                <HighlightText text={allocation.documentNumber} term={search} />
              </span>
            ))}
          </span>
        ),
    },
    {
      id: "amount",
      header: "Amount",
      align: "end",
      cell: (row) => (
        <span className="tabular font-medium">
          <HighlightText text={formatAmount(row.amountFils)} term={search} />
        </span>
      ),
      sortValue: (row) => row.amountFils,
    },
    {
      id: "actions",
      header: "",
      align: "end",
      widthClass: "w-12",
      cell: (row) => <RecordActions items={actionsFor(row)} />,
    },
  ];

  function actionsFor(row: PaymentDto): RecordAction[] {
    return [
      {
        id: "view",
        label: "View",
        icon: <Eye className="h-4 w-4" />,
        onSelect: () => {
          setViewing(row);
        },
      },
      {
        id: "print",
        label: "Print",
        icon: <Printer className="h-4 w-4" />,
        onSelect: () => {
          // The document is shown first: printing is never a leap of faith.
          setPrinting({
            html: receiptDocumentHtml(row, { settings }),
            title: row.direction === "inbound" ? "Receipt" : "Payment",
            description: row.partyName,
            filename: `receipt-${row.receiptNumber ?? String(row.id)}.pdf`,
          });
        },
      },
    ];
  }

  return (
    <FinanceLayout>
      <PageHeader
        title="Payments & receipts"
        description="Every rupee that moved, and what it settled."
        actions={
          can("payments", "create") ? (
            <Button
              variant="primary"
              size="sm"
              iconLeft={<Plus className="h-4 w-4" />}
              onClick={() => {
                setEditorOpen(true);
              }}
            >
              Record {direction === "inbound" ? "a receipt" : "a payment"}
            </Button>
          ) : undefined
        }
      />

      <Card flush>
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--divider)] p-4">
          <div className="flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-0.5">
            {(
              [
                { value: "inbound", label: "Money in", icon: ArrowDownLeft },
                { value: "outbound", label: "Money out", icon: ArrowUpRight },
              ] as const
            ).map((option) => {
              const Icon = option.icon;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    setDirection(option.value);
                  }}
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors duration-fast ${
                    direction === option.value
                      ? "bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-sm)]"
                      : "text-[var(--text-3)] hover:text-[var(--text)]"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {option.label}
                </button>
              );
            })}
          </div>

          <div className="w-[220px]">
            <Field label="Search" srLabelOnly>
              {(id) => (
                <Input
                  id={id}
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                  }}
                  placeholder="Reference or amount"
                />
              )}
            </Field>
          </div>
          <div className="w-[160px]">
            <Input
              type="date"
              value={fromDate}
              onChange={(event) => {
                setFromDate(event.target.value);
              }}
              aria-label="From date"
            />
          </div>
          <div className="w-[160px]">
            <Input
              type="date"
              value={toDate}
              onChange={(event) => {
                setToDate(event.target.value);
              }}
              aria-label="To date"
            />
          </div>

          {rows.length > 0 && (
            <span className="ms-auto text-[12.5px] text-[var(--text-3)]">
              {isSearching ? `${visible.length} of ${rows.length}` : rows.length} payments ·{" "}
              {formatMoney(total)}
            </span>
          )}
        </div>

        {isLoading ? (
          <div className="p-4">
            <TableSkeleton columns={6} rows={8} />
          </div>
        ) : (
          <DataTable
            frameless
            columns={columns}
            rows={visible}
            rowKey={paymentKey}
            highlightedRowKeys={highlight.keys}
            primaryRowKey={highlight.primaryKey}
            scrollToRowKey={highlight.primaryKey}
            caption="Payments and receipts"
            compact
            emptyState={
              isSearching ? (
                <EmptyState
                  compact
                  icon={
                    direction === "inbound" ? (
                      <ArrowDownLeft className="h-5 w-5" />
                    ) : (
                      <ArrowUpRight className="h-5 w-5" />
                    )
                  }
                  title="No payments match"
                  description={`Nothing in this list contains “${search.trim()}”. Clear the search to see every payment.`}
                />
              ) : (
                <EmptyState
                  compact
                  icon={
                    direction === "inbound" ? (
                      <ArrowDownLeft className="h-5 w-5" />
                    ) : (
                      <ArrowUpRight className="h-5 w-5" />
                    )
                  }
                  title={
                    direction === "inbound" ? "No money received yet" : "No money paid out yet"
                  }
                  description={
                    direction === "inbound"
                      ? "Receipts from customers appear here as soon as they are recorded."
                      : "Payments to suppliers and expenses appear here as soon as they are recorded."
                  }
                />
              )
            }
          />
        )}
      </Card>

      <PaymentDetailDialog
        payment={viewing}
        onClose={() => {
          setViewing(null);
        }}
        onPrint={(payment) => {
          setPrinting({
            html: receiptDocumentHtml(payment, { settings }),
            title: payment.direction === "inbound" ? "Receipt" : "Payment",
            description: payment.partyName,
            filename: `receipt-${payment.receiptNumber ?? String(payment.id)}.pdf`,
          });
        }}
      />

      <PaymentEditor
        open={editorOpen}
        direction={direction}
        onClose={() => {
          setEditorOpen(false);
        }}
        onSaved={() => {
          void client.invalidateQueries({ queryKey: ["payments"] });
          void client.invalidateQueries({ queryKey: ["finance.overview"] });
        }}
      />

      <DocumentPrintDialog
        open={printing !== null}
        html={printing?.html ?? ""}
        title={printing?.title ?? ""}
        description={printing?.description}
        filename={printing?.filename ?? "document.pdf"}
        orientation={printing?.orientation}
        onClose={() => {
          setPrinting(null);
        }}
      />
    </FinanceLayout>
  );
}

function PaymentDetailDialog({
  payment,
  onClose,
  onPrint,
}: {
  readonly payment: PaymentDto | null;
  readonly onClose: () => void;
  readonly onPrint: (payment: PaymentDto) => void;
}): React.JSX.Element {

  return (
    <Dialog
      open={payment !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="md"
      title={payment?.direction === "inbound" ? "Receipt" : "Payment"}
      description={payment?.partyName}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          {payment !== null && (
            <Button
              variant="primary"
              iconLeft={<Printer className="h-4 w-4" />}
              onClick={() => {
                onPrint(payment);
              }}
            >
              Print
            </Button>
          )}
        </>
      }
    >
      {payment === null ? null : (
        <div className="space-y-4">
          <DetailList>
            <DetailRow label="Date" value={formatDate(payment.paymentDate)} />
            <DetailRow
              label="Receipt no."
              value={payment.receiptNumber ?? `#${String(payment.id)}`}
            />
            <DetailRow
              label={payment.direction === "inbound" ? "Received from" : "Paid to"}
              value={payment.partyName}
            />
            <DetailRow label="Method" value={payment.method.toUpperCase()} />
            <DetailRow label="Amount" value={formatMoney(payment.amountFils)} />
            <DetailRow label="Reference" value={payment.reference ?? "—"} />
            <DetailRow label="Notes" value={payment.notes ?? "—"} />
          </DetailList>

          <div>
            <p className="mb-1.5 text-[13px] font-medium text-[var(--text)]">Applied to</p>
            {payment.allocations.length === 0 ? (
              <p className="text-[13.5px] text-[var(--text-3)]">On account</p>
            ) : (
              <ul className="space-y-1 text-[13.5px] text-[var(--text-2)]">
                {payment.allocations.map((allocation) => (
                  <li key={allocation.documentId} className="flex justify-between gap-3">
                    <span>{allocation.documentNumber}</span>
                    <span className="tabular">
                      {formatMoney(allocation.amountFils)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */

function PaymentEditor({
  open,
  direction,
  onClose,
  onSaved,
}: {
  readonly open: boolean;
  readonly direction: "inbound" | "outbound";
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): React.JSX.Element {

  const [partyId, setPartyId] = useState<number | null>(null);
  const [paymentDate, setPaymentDate] = useState("");
  const [method, setMethod] = useState("cash");
  const [amountText, setAmountText] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [postingKind, setPostingKind] = useState<PaymentPostingKind>("auto");
  const [cashAccountCode, setCashAccountCode] = useState("1000");
  const [expenseAccountCode, setExpenseAccountCode] = useState("");
  const [busy, setBusy] = useState(false);

  const partyOptions = usePartyOptions(direction === "inbound" ? "customer" : "supplier");

  // The balance of the chosen party: the ceiling for a payment that settles
  // what they owe. The other kinds - an advance, an expense - are not settling
  // an invoice and are not limited by it.
  const { data: selectedParty } = useQuery({
    queryKey: ["parties", direction === "inbound" ? "customer" : "supplier"],
    queryFn: () =>
      call("parties.list", {
        kind: direction === "inbound" ? "customer" : "supplier",
        limit: 1000,
      }),
    enabled: open && partyId !== null,
  });

  const outstanding = useMemo(() => {
    if (partyId === null || selectedParty === undefined) return 0;
    const party = selectedParty.find((row) => row.id === partyId);
    return Math.max(0, party?.balanceFils ?? 0);
  }, [partyId, selectedParty]);

  const { data: accounts } = useQuery({
    queryKey: ["finance.chart"],
    queryFn: () => call("finance.chart", {}),
    enabled: open,
  });

  const cashOptions = useMemo(
    () =>
      (accounts ?? [])
        .filter(
          (account: AccountDto) =>
            account.code === "1000" || account.code === "1010" || account.type === "asset",
        )
        .map((account: AccountDto) => ({
          value: account.code,
          label: `${account.code} — ${account.name}`,
        })),
    [accounts],
  );

  const expenseOptions = useMemo(
    () =>
      (accounts ?? [])
        .filter((account: AccountDto) => account.type === "expense" || account.type === "income")
        .map((account: AccountDto) => ({
          value: account.code,
          label: `${account.code} — ${account.name}`,
        })),
    [accounts],
  );

  const kindHint = POSTING_KINDS.find((kind) => kind.value === postingKind)?.hint ?? "";

  const submit = (): void => {
    const amountFils = parseAmount(amountText);
    if (amountFils === null || amountFils <= 0) {
      toast.error("Enter the amount.");
      return;
    }
    if (partyId === null) {
      toast.error("Choose the customer or supplier.");
      return;
    }
    // Money that settles an invoice cannot exceed what is owed. The server
    // checks the same thing again when it writes the payment.
    if (postingKind === "auto" && amountFils > outstanding) {
      toast.error(`Payment cannot exceed the outstanding balance of ${formatMoney(outstanding)}.`);
      return;
    }

    setBusy(true);
    void call("finance.recordPayment", {
      direction,
      partyId,
      paymentDate: paymentDate.length > 0 ? paymentDate : new Date().toISOString().slice(0, 10),
      method: method as "cash" | "bank" | "card",
      amountFils,
      reference: reference.trim().length > 0 ? reference.trim() : null,
      notes: notes.trim().length > 0 ? notes.trim() : null,
      postingKind,
      cashAccountCode,
      ...(postingKind === "expense" && expenseAccountCode.length > 0 ? { expenseAccountCode } : {}),
    })
      .then(() => {
        toast.success(direction === "inbound" ? "Receipt recorded" : "Payment recorded");
        setPartyId(null);
        setAmountText("");
        setReference("");
        setNotes("");
        onSaved();
        onClose();
      })
      .catch((error: unknown) => {
        toast.error(errorMessage(error));
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
      title={direction === "inbound" ? "Record a receipt" : "Record a payment"}
      description={
        direction === "inbound"
          ? "Money received from a customer."
          : "Money paid to a supplier, or for anything else."
      }
      busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label={direction === "inbound" ? "From customer" : "To supplier"}
          required
          className="sm:col-span-2"
        >
          {(id) => (
            <Select
              id={id}
              value={partyId === null ? "" : String(partyId)}
              options={partyOptions.map((option) => ({
                value: String(option.id),
                label: option.label,
              }))}
              placeholder="Choose a name"
              onChange={(value) => {
                setPartyId(value === "" ? null : Number(value));
              }}
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

        <Field
          label="Amount"
          required
          hint={
            postingKind === "auto" && partyId !== null
              ? `The most that can be paid now is ${formatMoney(outstanding)}.`
              : undefined
          }
        >
          {(id) => (
            <MoneyInput
              id={id}
              value={amountText}
              onChange={(event) => {
                setAmountText(event.target.value);
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
              onChange={(value) => {
                setMethod(value);
                setCashAccountCode(value === "cash" ? "1000" : "1010");
              }}
            />
          )}
        </Field>

        <Field label="Cash or bank account" required hint="The ledger the money lands in.">
          {(id) => (
            <Select
              id={id}
              value={cashAccountCode}
              options={cashOptions}
              onChange={(value) => {
                setCashAccountCode(value);
              }}
            />
          )}
        </Field>

        <Field label="What it settles" required hint={kindHint} className="sm:col-span-2">
          {(id) => (
            <Select
              id={id}
              value={postingKind}
              options={POSTING_KINDS.map((kind) => ({ value: kind.value, label: kind.label }))}
              onChange={(value) => {
                setPostingKind(value as PaymentPostingKind);
              }}
            />
          )}
        </Field>

        {postingKind === "expense" && (
          <Field label="Expense account" required className="sm:col-span-2">
            {(id) => (
              <Select
                id={id}
                value={expenseAccountCode}
                options={expenseOptions}
                placeholder="Choose an account"
                onChange={(value) => {
                  setExpenseAccountCode(value);
                }}
              />
            )}
          </Field>
        )}

        <Field label="Reference">
          {(id) => (
            <Input
              id={id}
              value={reference}
              onChange={(event) => {
                setReference(event.target.value);
              }}
              placeholder="Receipt or cheque number"
            />
          )}
        </Field>

        <Field label="Notes" className="sm:col-span-2">
          {(id) => (
            <Textarea
              id={id}
              value={notes}
              onChange={(event) => {
                setNotes(event.target.value);
              }}
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}

export { Badge, useMutation };
