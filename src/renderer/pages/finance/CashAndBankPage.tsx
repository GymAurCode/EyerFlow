/**
 * Bank and cash accounts.
 *
 * The money itself: what is in the till, what is at the bank, and what each
 * of them has been through. It is the one screen that answers "how much
 * money have I actually got?" without any accounting language in the way.
 *
 * A transfer between the till and the bank is here too, because moving money
 * between the two is the most common thing a shopkeeper does with the cash
 * in their hands - and it must not be recorded as income or an expense.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, Download, Landmark, Printer, Wallet } from "lucide-react";
import { toast } from "sonner";
import { call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { formatAmount, formatMoney, parseAmount } from "../../lib/format";
import { DATE_RANGE_PRESETS, resolveDateRange, type DateRangePreset } from "../../lib/finance";
import { cashBookDocumentHtml } from "../../lib/print-records";
import {
  DocumentPrintDialog,
  type PrintableDocument,
} from "../../components/print/DocumentPrintDialog";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Dialog } from "../../components/ui/Dialog";
import { type Column, DataTable } from "../../components/ui/DataTable";
import { EmptyState, PageHeader, TableSkeleton } from "../../components/ui/Feedback";
import { Field, Input, MoneyInput, Select } from "../../components/ui/Input";
import { DateRangePicker, FinanceLayout } from "./FinanceLayout";

const CASH_CODE = "1000";
const BANK_CODE = "1010";

export function CashAndBankPage(): React.JSX.Element {
  const { can, settings } = useApp();
  const client = useQueryClient();

  const [accountCode, setAccountCode] = useState(CASH_CODE);
  const [preset, setPreset] = useState<DateRangePreset>("month");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [transferOpen, setTransferOpen] = useState(false);
  const [printing, setPrinting] = useState<PrintableDocument | null>(null);

  const range = useMemo(
    () => resolveDateRange(preset, customFrom, customTo),
    [preset, customFrom, customTo],
  );

  const { data: cash, isLoading: cashLoading } = useQuery({
    queryKey: ["finance.cashBook", CASH_CODE, range.fromDate, range.toDate],
    queryFn: () =>
      call("finance.cashBook", {
        accountCode: CASH_CODE,
        fromDate: range.fromDate,
        toDate: range.toDate,
      }),
  });

  const { data: bank, isLoading: bankLoading } = useQuery({
    queryKey: ["finance.cashBook", BANK_CODE, range.fromDate, range.toDate],
    queryFn: () =>
      call("finance.cashBook", {
        accountCode: BANK_CODE,
        fromDate: range.fromDate,
        toDate: range.toDate,
      }),
  });

  const { data: book, isLoading } = useQuery({
    queryKey: ["finance.cashBook", accountCode, range.fromDate, range.toDate],
    queryFn: () =>
      call("finance.cashBook", {
        accountCode,
        fromDate: range.fromDate,
        toDate: range.toDate,
      }),
  });

  const rows = useMemo(() => book?.rows ?? [], [book]);

  const columns: readonly Column<NonNullable<typeof book>["rows"][number]>[] = [
    {
      id: "date",
      header: "Date",
      widthClass: "w-28",
      cell: (row) => <span className="tabular text-[var(--text-2)]">{row.entryDate}</span>,
      sortValue: (row) => row.entryDate,
    },
    {
      id: "entry",
      header: "Entry",
      widthClass: "w-40",
      cell: (row) => <span className="tabular text-[var(--text-2)]">{row.entryNo}</span>,
      sortValue: (row) => row.entryNo,
    },
    {
      id: "description",
      header: "Description",
      cell: (row) => <span className="text-[var(--text)]">{row.description}</span>,
      sortValue: (row) => row.description,
    },
    {
      id: "receipts",
      header: "Receipts",
      align: "end",
      cell: (row) =>
        row.receiptFils === 0 ? (
          <span className="text-[var(--text-3)]">—</span>
        ) : (
          <span className="tabular text-[var(--success)]">
            {formatAmount(row.receiptFils)}
          </span>
        ),
      sortValue: (row) => row.receiptFils,
    },
    {
      id: "payments",
      header: "Payments",
      align: "end",
      cell: (row) =>
        row.paymentFils === 0 ? (
          <span className="text-[var(--text-3)]">—</span>
        ) : (
          <span className="tabular text-[var(--danger)]">
            {formatAmount(row.paymentFils)}
          </span>
        ),
      sortValue: (row) => row.paymentFils,
    },
    {
      id: "balance",
      header: "Balance",
      align: "end",
      cell: (row) => (
        <span className="tabular font-medium">{formatAmount(row.balanceFils)}</span>
      ),
      sortValue: (row) => row.balanceFils,
    },
  ];

  const isLoadingAny = cashLoading || bankLoading || isLoading;

  return (
    <FinanceLayout>
      <PageHeader
        title="Bank & cash"
        description="The money itself: what is in the till, what is at the bank."
        actions={
          <div className="flex items-center gap-2">
            {can("finance", "create") && (
              <Button
                variant="secondary"
                size="sm"
                iconLeft={<ArrowLeftRight className="h-4 w-4" />}
                onClick={() => {
                  setTransferOpen(true);
                }}
              >
                Transfer
              </Button>
            )}
            {can("finance", "export") && (
              <Button
                variant="secondary"
                size="sm"
                iconLeft={<Download className="h-4 w-4" />}
                onClick={() => {
                  void call("finance.export", {
                    dataset: "cashBook",
                    accountCode,
                    fromDate: range.fromDate,
                    toDate: range.toDate,
                  })
                    .then((result) => {
                      toast.success(`Saved to ${result.path}`);
                    })
                    .catch((error: unknown) => {
                      toast.error(errorMessage(error));
                    });
                }}
              >
                Export
              </Button>
            )}
            {book !== undefined && (
              <Button
                variant="primary"
                size="sm"
                iconLeft={<Printer className="h-4 w-4" />}
                onClick={() => {
                  // The document is shown first: printing is never a leap of faith.
                  setPrinting({
                    html: cashBookDocumentHtml(book, { settings }),
                    title: `Cash Book ${book.accountCode}`,
                    description: `${book.fromDate} to ${book.toDate}`,
                    filename: `cash-book-${book.accountCode}.pdf`,
                  });
                }}
              >
                Print
              </Button>
            )}
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <BalanceCard
          title="Cash in hand"
          icon={<Wallet className="h-5 w-5" />}
          value={cash?.closingBalanceFils ?? 0}
          opening={cash?.openingBalanceFils ?? 0}
        />
        <BalanceCard
          title="Bank balance"
          icon={<Landmark className="h-5 w-5" />}
          value={bank?.closingBalanceFils ?? 0}
          opening={bank?.openingBalanceFils ?? 0}
        />
        <BalanceCard
          title="Cash and bank together"
          icon={<Landmark className="h-5 w-5" />}
          value={(cash?.closingBalanceFils ?? 0) + (bank?.closingBalanceFils ?? 0)}
          opening={(cash?.openingBalanceFils ?? 0) + (bank?.openingBalanceFils ?? 0)}
        />
      </div>

      <Card flush className="mt-4">
        <div className="flex flex-wrap items-end gap-3 border-b border-[var(--divider)] p-4">
          <div className="w-[220px]">
            <Field label="Account">
              {(id) => (
                <Select
                  id={id}
                  value={accountCode}
                  options={[
                    { value: CASH_CODE, label: "Cash in Hand" },
                    { value: BANK_CODE, label: "Bank Account" },
                  ]}
                  onChange={(value) => {
                    setAccountCode(value);
                  }}
                />
              )}
            </Field>
          </div>

          <DateRangePicker
            preset={preset}
            fromDate={customFrom}
            toDate={customTo}
            presets={DATE_RANGE_PRESETS}
            onPresetChange={(value) => {
              setPreset(value as DateRangePreset);
            }}
            onFromChange={setCustomFrom}
            onToChange={setCustomTo}
          />
        </div>

        {isLoadingAny ? (
          <div className="p-4">
            <TableSkeleton columns={6} rows={8} />
          </div>
        ) : (
          <>
            {book !== undefined && (
              <div className="grid gap-px border-b border-[var(--border)] bg-[var(--border)] sm:grid-cols-4">
                <SummaryCell
                  label="Opening balance"
                  value={formatMoney(book.openingBalanceFils)}
                />
                <SummaryCell
                  label="Receipts"
                  value={formatMoney(book.totalReceiptsFils)}
                />
                <SummaryCell
                  label="Payments"
                  value={formatMoney(book.totalPaymentsFils)}
                />
                <SummaryCell
                  label="Closing balance"
                  value={formatMoney(book.closingBalanceFils)}
                />
              </div>
            )}

            <DataTable
              frameless
              columns={columns}
              rows={rows}
              rowKey={(row) => row.entryId}
              caption="Cash book"
              compact
              emptyState={
                <EmptyState
                  compact
                  icon={<Wallet className="h-5 w-5" />}
                  title="No money moved in this period"
                  description="Choose a wider date range to see earlier movements."
                />
              }
            />
          </>
        )}
      </Card>

      <TransferDialog
        open={transferOpen}
        onClose={() => {
          setTransferOpen(false);
        }}
        onSaved={() => {
          void client.invalidateQueries({ queryKey: ["finance.cashBook"] });
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

function BalanceCard({
  title,
  icon,
  value,
  opening,
}: {
  readonly title: string;
  readonly icon: React.ReactNode;
  readonly value: number;
  readonly opening: number;
}): React.JSX.Element {
  const change = value - opening;
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[12.5px] font-medium text-[var(--text-2)]">{title}</p>
          <p className="tabular mt-1 text-[24px] font-semibold leading-tight text-[var(--text)]">
            {formatMoney(value)}
          </p>
          <p className="mt-1 text-[11.5px] text-[var(--text-3)]">
            Opened at {formatMoney(opening)}
            {change !== 0 && (
              <span className={change > 0 ? " text-[var(--success)]" : " text-[var(--danger)]"}>
                {" · "}
                {change > 0 ? "+" : ""}
                {formatMoney(change)}
              </span>
            )}
          </p>
        </div>
        <span className="glass-chip flex h-10 w-10 shrink-0 items-center justify-center rounded-[16px] text-[var(--brand)]">
          {icon}
        </span>
      </div>
    </Card>
  );
}

function SummaryCell({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): React.JSX.Element {
  return (
    <div className="bg-[var(--surface)] px-4 py-3">
      <p className="text-[11.5px] uppercase tracking-wide text-[var(--text-3)]">{label}</p>
      <p className="tabular mt-0.5 text-[16px] font-semibold text-[var(--text)]">{value}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function TransferDialog({
  open,
  onClose,
  onSaved,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): React.JSX.Element {

  const [fromAccount, setFromAccount] = useState(CASH_CODE);
  const [toAccount, setToAccount] = useState(BANK_CODE);
  const [amountText, setAmountText] = useState("");
  const [transferDate, setTransferDate] = useState("");
  const [reference, setReference] = useState("");
  const [busy] = useState(false);

  const transfer = useMutation({
    mutationFn: (input: {
      transferDate: string;
      fromAccountCode: string;
      toAccountCode: string;
      amountFils: number;
      reference: string | null;
    }) => call("finance.transfer", input),
    onSuccess: () => {
      toast.success("Transfer recorded");
      setAmountText("");
      onSaved();
      onClose();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(error));
    },
  });

  const options = [
    { value: CASH_CODE, label: "Cash in Hand" },
    { value: BANK_CODE, label: "Bank Account" },
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Transfer between cash and bank"
      description="Moving money between your own accounts is not income or an expense."
      busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => {
              const amountFils = parseAmount(amountText);
              if (amountFils === null || amountFils <= 0) {
                toast.error("Enter the amount to move.");
                return;
              }
              transfer.mutate({
                transferDate:
                  transferDate.length > 0 ? transferDate : new Date().toISOString().slice(0, 10),
                fromAccountCode: fromAccount,
                toAccountCode: toAccount,
                amountFils,
                reference: reference.trim().length > 0 ? reference.trim() : null,
              });
            }}
          >
            Record transfer
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="From" required>
          {(id) => (
            <Select
              id={id}
              value={fromAccount}
              options={options}
              onChange={(value) => {
                setFromAccount(value);
              }}
            />
          )}
        </Field>
        <Field label="To" required>
          {(id) => (
            <Select
              id={id}
              value={toAccount}
              options={options}
              onChange={(value) => {
                setToAccount(value);
              }}
            />
          )}
        </Field>
        <Field label="Date" required>
          {(id) => (
            <Input
              id={id}
              type="date"
              value={transferDate}
              onChange={(event) => {
                setTransferDate(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Amount" required>
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
        <Field label="Reference" className="sm:col-span-2">
          {(id) => (
            <Input
              id={id}
              value={reference}
              onChange={(event) => {
                setReference(event.target.value);
              }}
              placeholder="Deposit slip number"
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}
