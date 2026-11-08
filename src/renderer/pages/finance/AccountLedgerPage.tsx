/**
 * The account ledger.
 *
 * One account, every movement on it, in date order, with the balance carried
 * along line by line. It is the screen that answers "where did this money
 * go?" for a single account - cash, the bank, a customer, an expense.
 *
 * The opening balance is shown above the table rather than as a first row,
 * because it is a starting point rather than a movement, and a reader who
 * treats it as a movement will add it up twice.
 *
 * The account and the period can be handed over in the address: the Chart of
 * Accounts sends the reader here with both already chosen, and the button at
 * the top brings them back to where they were.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Download, Printer } from "lucide-react";
import { toast } from "sonner";
import type { AccountDto } from "../../../shared/finance";
import { call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { formatAmount, formatMoney } from "../../lib/format";
import { DATE_RANGE_PRESETS, resolveDateRange, type DateRangePreset } from "../../lib/finance";
import { IMS_PATH } from "../../lib/ims-nav";
import { ledgerDocumentHtml } from "../../lib/print-records";
import {
  DocumentPrintDialog,
  type PrintableDocument,
} from "../../components/print/DocumentPrintDialog";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { type Column, DataTable } from "../../components/ui/DataTable";
import { EmptyState, PageHeader, TableSkeleton } from "../../components/ui/Feedback";
import { Field, Input, Select } from "../../components/ui/Input";
import { DateRangePicker, FinanceLayout } from "./FinanceLayout";

export function AccountLedgerPage(): React.JSX.Element {
  const { can, settings } = useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [printing, setPrinting] = useState<PrintableDocument | null>(null);

  // The account and the period the reader arrived with, if any.
  const codeParam = searchParams.get("code");
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");
  const cameFromChart = codeParam !== null;

  const [code, setCode] = useState(codeParam ?? "1000");
  const [preset, setPreset] = useState<DateRangePreset>(
    fromParam !== null && toParam !== null ? "custom" : "month",
  );
  const [customFrom, setCustomFrom] = useState(fromParam ?? "");
  const [customTo, setCustomTo] = useState(toParam ?? "");

  // A handover that arrives while the page is already open - the reader
  // changed the account in another tab, or came back through the address
  // bar - still lands.
  useEffect(() => {
    if (codeParam !== null) setCode(codeParam);
    if (fromParam !== null && toParam !== null) {
      setPreset("custom");
      setCustomFrom(fromParam);
      setCustomTo(toParam);
    }
  }, [codeParam, fromParam, toParam]);

  const range = useMemo(
    () => resolveDateRange(preset, customFrom, customTo),
    [preset, customFrom, customTo],
  );

  const { data: accounts } = useQuery({
    queryKey: ["finance.chart"],
    queryFn: () => call("finance.chart", {}),
  });

  const { data, isLoading } = useQuery({
    queryKey: ["finance.generalLedger", code, range.fromDate, range.toDate],
    queryFn: () =>
      call("finance.generalLedger", {
        code,
        fromDate: range.fromDate,
        toDate: range.toDate,
      }),
    enabled: code.length > 0,
  });

  const accountOptions = useMemo(
    () =>
      (accounts ?? []).map((account: AccountDto) => ({
        value: account.code,
        label: `${account.code} — ${account.name}`,
      })),
    [accounts],
  );

  const columns: readonly Column<NonNullable<typeof data>["rows"][number]>[] = [
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
      cell: (row) => (
        <div className="min-w-0">
          <div className="truncate text-[var(--text)]">
            {row.description ?? row.documentNumber ?? "—"}
          </div>
          {row.partyName !== null && (
            <div className="truncate text-[11.5px] text-[var(--text-3)]">{row.partyName}</div>
          )}
        </div>
      ),
      sortValue: (row) => row.description ?? "",
    },
    {
      id: "debit",
      header: "Debit",
      align: "end",
      cell: (row) =>
        row.debitFils === 0 ? (
          <span className="text-[var(--text-3)]">—</span>
        ) : (
          <span className="tabular">{formatAmount(row.debitFils)}</span>
        ),
      sortValue: (row) => row.debitFils,
    },
    {
      id: "credit",
      header: "Credit",
      align: "end",
      cell: (row) =>
        row.creditFils === 0 ? (
          <span className="text-[var(--text-3)]">—</span>
        ) : (
          <span className="tabular">{formatAmount(row.creditFils)}</span>
        ),
      sortValue: (row) => row.creditFils,
    },
    {
      id: "balance",
      header: "Balance",
      align: "end",
      cell: (row) => (
        <span className="tabular font-medium">{formatAmount(row.runningBalanceFils)}</span>
      ),
      sortValue: (row) => row.runningBalanceFils,
    },
  ];

  const exportLedger = (): void => {
    void call("finance.export", {
      dataset: "generalLedger",
      accountCode: code,
      fromDate: range.fromDate,
      toDate: range.toDate,
    })
      .then((result) => {
        toast.success(`Saved to ${result.path}`);
      })
      .catch((error: unknown) => {
        toast.error(errorMessage(error));
      });
  };

  return (
    <FinanceLayout>
      <PageHeader
        title="Account ledger"
        description="Every movement on one account, with the balance carried along."
        {...(cameFromChart
          ? {
              breadcrumbs: [
                {
                  label: "Chart of Accounts",
                  onClick: () => {
                    void navigate(
                      `${IMS_PATH.accounts}?account=${encodeURIComponent(codeParam ?? "")}`,
                    );
                  },
                },
                { label: `Account ${code}` },
              ],
            }
          : {})}
        actions={
          <div className="flex items-center gap-2">
            {cameFromChart && (
              <Button
                variant="secondary"
                size="sm"
                iconLeft={<ArrowLeft className="h-4 w-4" />}
                onClick={() => {
                  void navigate(
                    `${IMS_PATH.accounts}?account=${encodeURIComponent(codeParam ?? "")}`,
                  );
                }}
              >
                Back to Chart of Accounts
              </Button>
            )}
            {can("finance", "export") && (
              <Button
                variant="secondary"
                size="sm"
                iconLeft={<Download className="h-4 w-4" />}
                onClick={exportLedger}
              >
                Export
              </Button>
            )}
            {data !== undefined && (
              <Button
                variant="primary"
                size="sm"
                iconLeft={<Printer className="h-4 w-4" />}
                onClick={() => {
                  // The document is shown first: printing is never a leap of faith.
                  setPrinting({
                    html: ledgerDocumentHtml(data, { settings }),
                    title: `General Ledger ${data.code}`,
                    description: `${data.fromDate} to ${data.toDate}`,
                    filename: `ledger-${data.code}.pdf`,
                  });
                }}
              >
                Print
              </Button>
            )}
          </div>
        }
      />

      <Card flush>
        <div className="flex flex-wrap items-end gap-3 border-b border-[var(--divider)] p-4">
          <div className="w-[300px]">
            <Field label="Account">
              {(id) => (
                <Select
                  id={id}
                  value={code}
                  options={accountOptions}
                  placeholder="Choose an account"
                  onChange={(value) => {
                    setCode(value);
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

        {isLoading ? (
          <div className="p-4">
            <TableSkeleton columns={6} rows={8} />
          </div>
        ) : data === undefined ? null : (
          <>
            <div className="grid gap-px border-b border-[var(--border)] bg-[var(--border)] sm:grid-cols-4">
              <SummaryCell
                label="Opening balance"
                value={formatMoney(data.openingBalanceFils)}
                hint="Everything posted before this period"
              />
              <SummaryCell
                label="Total debits"
                value={formatMoney(data.totalDebitFils)}
                hint="Money and costs coming in"
              />
              <SummaryCell
                label="Total credits"
                value={formatMoney(data.totalCreditFils)}
                hint="Money and income going out"
              />
              <SummaryCell
                label="Closing balance"
                value={formatMoney(data.closingBalanceFils)}
                hint="What the account holds now"
              />
            </div>

            <DataTable
              frameless
              columns={columns}
              rows={data.rows}
              rowKey={(row) => row.lineId}
              caption={`Ledger for ${data.name}`}
              compact
              emptyState={
                <EmptyState
                  compact
                  icon={<Printer className="h-5 w-5" />}
                  title="No movements in this period"
                  description="Widen the date range, or choose a different account."
                />
              }
            />
          </>
        )}
      </Card>

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

function SummaryCell({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint: string;
}): React.JSX.Element {
  return (
    <div className="bg-[var(--surface)] px-4 py-3">
      <p className="text-[11.5px] uppercase tracking-wide text-[var(--text-3)]">{label}</p>
      <p className="tabular mt-0.5 text-[16px] font-semibold text-[var(--text)]">{value}</p>
      <p className="mt-0.5 text-[11.5px] text-[var(--text-3)]">{hint}</p>
    </div>
  );
}

export { Input };
