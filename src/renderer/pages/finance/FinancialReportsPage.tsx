/**
 * The financial reports.
 *
 * Seven reports, one screen, one date range. They are the statements a shop
 * owner has to be able to produce on demand - for themselves, for a bank, or
 * for an accountant - and every one of them is built from the same posted
 * ledger, so they cannot disagree with each other.
 *
 * The trial balance is the proof: if the debits and the credits do not add
 * up, everything below it is suspect, and the screen says so plainly rather
 * than showing a report that looks fine.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Download, FileOutput, Printer } from "lucide-react";
import { toast } from "sonner";
import { call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { formatAmount, formatMoney } from "../../lib/format";
import { DATE_RANGE_PRESETS, resolveDateRange, type DateRangePreset } from "../../lib/finance";
import { reportDocumentHtml, saveHtmlAsPdf } from "../../lib/print";
import type { ReportDocument } from "../../components/print/report-document";
import {
  DocumentPrintDialog,
  type PrintableDocument,
} from "../../components/print/DocumentPrintDialog";
import {
  agingReport,
  balanceSheetReport,
  cashFlowReport,
  financeProfitAndLossReport,
  periodComparisonReport,
  trialBalanceReport,
} from "../../components/print/report-templates";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { type Column, DataTable } from "../../components/ui/DataTable";
import { Badge } from "../../components/ui/Badge";
import { EmptyState, PageHeader, TableSkeleton } from "../../components/ui/Feedback";
import { DateRangePicker, FinanceLayout } from "./FinanceLayout";

/**
 * Print and PDF actions for a financial statement.
 *
 * The statement is rendered from the same data the screen shows, through the
 * shared document layer, so the printed page and the screen cannot disagree.
 *
 * Printing opens the preview first: the document is shown as an A4 sheet, and
 * the printer only receives it once the user says so.
 */
function StatementActions({
  report,
  filename,
}: {
  readonly report: ReportDocument;
  readonly filename: string;
}): React.JSX.Element {
  const { settings } = useApp();
  const [printing, setPrinting] = useState<PrintableDocument | null>(null);

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        iconLeft={<FileOutput className="h-4 w-4" />}
        onClick={() => {
          void saveHtmlAsPdf(
            reportDocumentHtml(report, { settings }),
            `${filename}.pdf`,
            report.title,
          ).then((outcome) => {
            if (!outcome.ok) toast.error(outcome.message);
          });
        }}
      >
        PDF
      </Button>
      <Button
        variant="secondary"
        size="sm"
        iconLeft={<Printer className="h-4 w-4" />}
        onClick={() => {
          setPrinting({
            html: reportDocumentHtml(report, { settings }),
            title: report.title,
            description: report.period,
            filename: `${filename}.pdf`,
            orientation: report.orientation,
          });
        }}
      >
        Print
      </Button>

      <DocumentPrintDialog
        open={printing !== null}
        html={printing?.html ?? ""}
        title={printing?.title ?? ""}
        description={printing?.description}
        filename={printing?.filename ?? "statement.pdf"}
        orientation={printing?.orientation}
        onClose={() => {
          setPrinting(null);
        }}
      />
    </>
  );
}

type ReportTab =
  "trialBalance" | "balanceSheet" | "profitAndLoss" | "cashFlow" | "aging" | "comparison";

const TABS: readonly { readonly value: ReportTab; readonly label: string }[] = [
  { value: "trialBalance", label: "Trial balance" },
  { value: "balanceSheet", label: "Balance sheet" },
  { value: "profitAndLoss", label: "Profit & loss" },
  { value: "cashFlow", label: "Cash flow" },
  { value: "aging", label: "Aging" },
  { value: "comparison", label: "Comparison" },
];

export function FinancialReportsPage(): React.JSX.Element {
  const { can } = useApp();

  const [tab, setTab] = useState<ReportTab>("trialBalance");
  const [preset, setPreset] = useState<DateRangePreset>("month");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [agingSide, setAgingSide] = useState<"receivable" | "payable">("receivable");

  const range = useMemo(
    () => resolveDateRange(preset, customFrom, customTo),
    [preset, customFrom, customTo],
  );

  const exportReport = (dataset: string): void => {
    void call("finance.export", {
      dataset: dataset as never,
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
        title="Financial reports"
        description="Built from the posted ledger, for the selected period."
        actions={
          <div className="flex flex-wrap items-center gap-2">
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
            {can("finance", "export") && (
              <Button
                variant="secondary"
                size="sm"
                iconLeft={<Download className="h-4 w-4" />}
                onClick={() => {
                  exportReport(
                    tab === "aging"
                      ? agingSide === "receivable"
                        ? "receivableAging"
                        : "payableAging"
                      : tab === "comparison"
                        ? "periodComparison"
                        : tab,
                  );
                }}
              >
                Export
              </Button>
            )}
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-1 border-b border-[var(--border)]">
        {TABS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => {
              setTab(option.value);
            }}
            className={`rounded-t-lg border-b-2 px-3 py-2 text-[13px] font-medium transition-colors duration-fast ${
              tab === option.value
                ? "border-[var(--brand)] text-[var(--brand)]"
                : "border-transparent text-[var(--text-2)] hover:border-[var(--border-strong)] hover:text-[var(--text)]"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {tab === "trialBalance" ? (
        <TrialBalanceReport fromDate={range.fromDate} toDate={range.toDate} />
      ) : tab === "balanceSheet" ? (
        <BalanceSheetReport asOfDate={range.asOfDate} />
      ) : tab === "profitAndLoss" ? (
        <ProfitAndLossReport fromDate={range.fromDate} toDate={range.toDate} />
      ) : tab === "cashFlow" ? (
        <CashFlowReport fromDate={range.fromDate} toDate={range.toDate} />
      ) : tab === "aging" ? (
        <AgingReport
          side={agingSide}
          asOfDate={range.asOfDate}
          onSideChange={setAgingSide}
        />
      ) : (
        <ComparisonReport
          fromDate={range.fromDate}
          toDate={range.toDate}
          previousFromDate={range.previousFromDate}
          previousToDate={range.previousToDate}
        />
      )}
    </FinanceLayout>
  );
}

/* -------------------------------------------------------------------------- */
/* trial balance                                                               */
/* -------------------------------------------------------------------------- */

interface TrialRow {
  readonly code: string;
  readonly name: string;
  readonly openingDebitFils: number;
  readonly openingCreditFils: number;
  readonly periodDebitFils: number;
  readonly periodCreditFils: number;
  readonly closingDebitFils: number;
  readonly closingCreditFils: number;
}

function TrialBalanceReport({
  fromDate,
  toDate,
}: {
  readonly fromDate: string;
  readonly toDate: string;
}): React.JSX.Element {
  const { data, isLoading } = useQuery({
    queryKey: ["finance.trialBalance", fromDate, toDate],
    queryFn: () => call("finance.trialBalance", { fromDate, toDate }),
  });

  const columns: readonly Column<TrialRow>[] = [
    {
      id: "code",
      header: "Code",
      widthClass: "w-20",
      cell: (row) => <span className="tabular">{row.code}</span>,
      sortValue: (row) => row.code,
    },
    {
      id: "name",
      header: "Account",
      cell: (row) => <span className="text-[var(--text)]">{row.name}</span>,
      sortValue: (row) => row.name,
    },
    {
      id: "openingDebit",
      header: "Opening debit",
      align: "end",
      cell: (row) =>
        row.openingDebitFils === 0 ? "—" : formatAmount(row.openingDebitFils),
      sortValue: (row) => row.openingDebitFils,
    },
    {
      id: "openingCredit",
      header: "Opening credit",
      align: "end",
      cell: (row) =>
        row.openingCreditFils === 0 ? "—" : formatAmount(row.openingCreditFils),
      sortValue: (row) => row.openingCreditFils,
    },
    {
      id: "periodDebit",
      header: "Period debit",
      align: "end",
      cell: (row) =>
        row.periodDebitFils === 0 ? "—" : formatAmount(row.periodDebitFils),
      sortValue: (row) => row.periodDebitFils,
    },
    {
      id: "periodCredit",
      header: "Period credit",
      align: "end",
      cell: (row) =>
        row.periodCreditFils === 0 ? "—" : formatAmount(row.periodCreditFils),
      sortValue: (row) => row.periodCreditFils,
    },
    {
      id: "closingDebit",
      header: "Closing debit",
      align: "end",
      cell: (row) =>
        row.closingDebitFils === 0 ? "—" : formatAmount(row.closingDebitFils),
      sortValue: (row) => row.closingDebitFils,
    },
    {
      id: "closingCredit",
      header: "Closing credit",
      align: "end",
      cell: (row) =>
        row.closingCreditFils === 0 ? "—" : formatAmount(row.closingCreditFils),
      sortValue: (row) => row.closingCreditFils,
    },
  ];

  return (
    <Card flush>
      <CardHeader
        title="Trial balance"
        description={`${fromDate} to ${toDate} · every account and its balance.`}
        actions={
          data !== undefined ? (
            <div className="flex items-center gap-2">
              {data.isBalanced ? (
                <Badge tone="success" dot>
                  Debits equal credits
                </Badge>
              ) : (
                <Badge tone="danger" dot>
                  Out by {formatAmount(Math.abs(data.differenceFils))}
                </Badge>
              )}
              <StatementActions
                report={trialBalanceReport(data)}
                filename="trial-balance"
              />
            </div>
          ) : undefined
        }
      />
      {isLoading ? (
        <div className="p-4">
          <TableSkeleton columns={8} rows={10} />
        </div>
      ) : data === undefined ? null : (
        <>
          <DataTable
            frameless
            columns={columns}
            rows={data.rows}
            rowKey={(row) => row.code}
            caption="Trial balance"
            compact
            emptyState={
              <EmptyState compact title="No accounts yet" description="Set the chart up first." />
            }
          />
          <div className="flex flex-wrap justify-end gap-x-8 gap-y-1 border-t border-[var(--border)] bg-[var(--surface-2)] px-5 py-3 text-[13px]">
            <Total
              label="Opening"
              debit={data.totalOpeningDebitFils}
              credit={data.totalOpeningCreditFils}
            />
            <Total
              label="Period"
              debit={data.totalPeriodDebitFils}
              credit={data.totalPeriodCreditFils}
            />
            <Total
              label="Closing"
              debit={data.totalClosingDebitFils}
              credit={data.totalClosingCreditFils}
            />
          </div>
        </>
      )}
    </Card>
  );
}

/** A small helper so the totals row above stays readable. */
function Total({
  label,
  debit,
  credit,
}: {
  readonly label: string;
  readonly debit: number;
  readonly credit: number;
}): React.JSX.Element {
  return (
    <span className="flex items-baseline gap-2">
      <span className="text-[var(--text-3)]">{label}</span>
      <span className="tabular font-medium text-[var(--text)]">
        {formatAmount(debit)} / {formatAmount(credit)}
      </span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* balance sheet                                                                */
/* -------------------------------------------------------------------------- */

function BalanceSheetReport({
  asOfDate,
}: {
  readonly asOfDate: string;
}): React.JSX.Element {
  const { data, isLoading } = useQuery({
    queryKey: ["finance.balanceSheet", asOfDate],
    queryFn: () => call("finance.balanceSheet", { asOfDate }),
  });

  if (isLoading || data === undefined) {
    return (
      <Card flush>
        <div className="p-4">
          <TableSkeleton columns={3} rows={10} />
        </div>
      </Card>
    );
  }

  const section = (
    heading: string,
    lines: readonly { code: string; name: string; amountFils: number }[],
    total: number,
  ) => (
    <div>
      <p className="border-b border-[var(--border)] bg-[var(--surface-2)] px-5 py-2 text-[12px] font-semibold uppercase tracking-wide text-[var(--text-2)]">
        {heading}
      </p>
      {lines.length === 0 ? (
        <p className="px-5 py-2 text-[13px] text-[var(--text-3)]">Nothing in this section.</p>
      ) : (
        lines.map((line) => (
          <div
            key={line.code}
            className="flex items-center justify-between gap-4 border-b border-[var(--divider)] px-5 py-2 last:border-0"
          >
            <span className="text-[13px] text-[var(--text)]">
              <span className="tabular pe-2 text-[var(--text-3)]">{line.code}</span>
              {line.name}
            </span>
            <span className="tabular text-[13.5px] font-medium text-[var(--text)]">
              {formatAmount(line.amountFils)}
            </span>
          </div>
        ))
      )}
      <div className="flex items-center justify-between gap-4 bg-[var(--surface-2)] px-5 py-2">
        <span className="text-[13px] font-semibold text-[var(--text)]">
          Total {heading.toLowerCase()}
        </span>
        <span className="tabular text-[13.5px] font-semibold text-[var(--text)]">
          {formatAmount(total)}
        </span>
      </div>
    </div>
  );

  return (
    <Card flush>
      <CardHeader
        title="Balance sheet"
        description={`What the business owns and owes as at ${asOfDate}.`}
        actions={
          <div className="flex items-center gap-2">
            {data.isBalanced ? (
              <Badge tone="success" dot>
                Assets equal liabilities plus equity
              </Badge>
            ) : (
              <Badge tone="danger" dot>
                Out by {formatAmount(Math.abs(data.differenceFils))}
              </Badge>
            )}
            <StatementActions
              report={balanceSheetReport(data)}
              filename="balance-sheet"
            />
          </div>
        }
      />
      <div className="grid gap-4 p-5 lg:grid-cols-2">
        <div className="overflow-hidden rounded-lg border border-[var(--border)]">
          {section(data.assets.heading, data.assets.lines, data.assets.totalFils)}
        </div>
        <div className="space-y-4">
          <div className="overflow-hidden rounded-lg border border-[var(--border)]">
            {section(data.liabilities.heading, data.liabilities.lines, data.liabilities.totalFils)}
          </div>
          <div className="overflow-hidden rounded-lg border border-[var(--border)]">
            {section(data.equity.heading, data.equity.lines, data.equity.totalFils)}
          </div>
          <div className="flex items-center justify-between gap-4 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-5 py-2.5">
            <span className="text-[13px] font-medium text-[var(--text)]">
              Profit for the period
            </span>
            <span className="tabular text-[13.5px] font-medium text-[var(--text)]">
              {formatAmount(data.currentPeriodEarningsFils)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4 rounded-lg border border-[var(--border)] px-5 py-2.5">
            <span className="text-[13px] font-semibold text-[var(--text)]">
              Total liabilities and equity
            </span>
            <span className="tabular text-[13.5px] font-semibold text-[var(--text)]">
              {formatAmount(data.liabilitiesAndEquityFils)}
            </span>
          </div>
        </div>
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* profit and loss                                                             */
/* -------------------------------------------------------------------------- */

function ProfitAndLossReport({
  fromDate,
  toDate,
}: {
  readonly fromDate: string;
  readonly toDate: string;
}): React.JSX.Element {
  const { data, isLoading } = useQuery({
    queryKey: ["finance.profitAndLoss", fromDate, toDate],
    queryFn: () => call("finance.profitAndLoss", { fromDate, toDate }),
  });

  if (isLoading || data === undefined) {
    return (
      <Card flush>
        <div className="p-4">
          <TableSkeleton columns={2} rows={10} />
        </div>
      </Card>
    );
  }

  const row = (label: string, amount: number, bold = false) => (
    <div
      key={label}
      className={`flex items-center justify-between gap-4 border-b border-[var(--divider)] px-5 py-2 ${
        bold ? "bg-[var(--surface-2)]" : ""
      }`}
    >
      <span
        className={`text-[13px] ${bold ? "font-semibold text-[var(--text)]" : "text-[var(--text-2)]"}`}
      >
        {label}
      </span>
      <span
        className={`tabular text-[13.5px] ${bold ? "font-semibold" : "font-medium"} text-[var(--text)]`}
      >
        {formatAmount(amount)}
      </span>
    </div>
  );

  return (
    <Card flush>
      <CardHeader
        title="Profit & loss"
        description={`${fromDate} to ${toDate} · what the business earned and what it cost.`}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={data.netProfitFils >= 0 ? "success" : "danger"} dot>
              {data.netProfitFils >= 0 ? "Profit" : "Loss"}{" "}
              {formatMoney(Math.abs(data.netProfitFils))}
            </Badge>
            <StatementActions
              report={financeProfitAndLossReport(data)}
              filename="profit-and-loss"
            />
          </div>
        }
      />
      <div className="overflow-hidden rounded-lg border border-[var(--border)]">
        {row("Gross sales", data.grossSalesFils)}
        {row("Less: sales returns and allowances", data.salesReturnsFils)}
        {row("Net sales", data.netSalesFils, true)}
        {row("Less: cost of goods sold", data.costOfGoodsSoldFils)}
        {row("Gross profit", data.grossProfitFils, true)}
        {data.expenseLines.map((line) => row(`Less: ${line.name}`, line.amountFils))}
        {row("Total operating expenses", data.operatingExpensesFils, true)}
        {data.otherIncomeLines.map((line) => row(`Plus: ${line.name}`, line.amountFils))}
        {row("Total other income", data.otherIncomeFils, true)}
        {row("Net profit", data.netProfitFils, true)}
      </div>
      <p className="px-5 py-3 text-[12px] text-[var(--text-3)]">
        Gross margin {String(data.grossMarginPercent)}% of net sales.
      </p>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* cash flow                                                                   */
/* -------------------------------------------------------------------------- */

function CashFlowReport({
  fromDate,
  toDate,
}: {
  readonly fromDate: string;
  readonly toDate: string;
}): React.JSX.Element {
  const { data, isLoading } = useQuery({
    queryKey: ["finance.cashFlow", fromDate, toDate],
    queryFn: () => call("finance.cashFlow", { fromDate, toDate }),
  });

  if (isLoading || data === undefined) {
    return (
      <Card flush>
        <div className="p-4">
          <TableSkeleton columns={2} rows={8} />
        </div>
      </Card>
    );
  }

  const section = (
    heading: string,
    lines: readonly { name: string; amountFils: number }[],
    total: number,
  ) => (
    <div className="overflow-hidden rounded-lg border border-[var(--border)]">
      <p className="border-b border-[var(--border)] bg-[var(--surface-2)] px-5 py-2 text-[12px] font-semibold uppercase tracking-wide text-[var(--text-2)]">
        {heading}
      </p>
      {lines.length === 0 ? (
        <p className="px-5 py-2 text-[13px] text-[var(--text-3)]">Nothing in this section.</p>
      ) : (
        lines.map((line) => (
          <div
            key={line.name}
            className="flex items-center justify-between gap-4 border-b border-[var(--divider)] px-5 py-2 last:border-0"
          >
            <span className="text-[13px] text-[var(--text-2)]">{line.name}</span>
            <span className="tabular text-[13.5px] font-medium text-[var(--text)]">
              {formatAmount(line.amountFils)}
            </span>
          </div>
        ))
      )}
      <div className="flex items-center justify-between gap-4 bg-[var(--surface-2)] px-5 py-2">
        <span className="text-[13px] font-semibold text-[var(--text)]">Total</span>
        <span className="tabular text-[13.5px] font-semibold text-[var(--text)]">
          {formatAmount(total)}
        </span>
      </div>
    </div>
  );

  return (
    <Card flush>
      <CardHeader
        title="Cash flow"
        description={`${fromDate} to ${toDate} · where the money came from and where it went.`}
        actions={<StatementActions report={cashFlowReport(data)} filename="cash-flow" />}
      />
      <div className="space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-[var(--border)] px-5 py-3">
            <p className="text-[12px] uppercase tracking-wide text-[var(--text-3)]">
              Opening cash and bank
            </p>
            <p className="tabular mt-0.5 text-[18px] font-semibold text-[var(--text)]">
              {formatAmount(data.openingCashFils)}
            </p>
          </div>
          <div className="rounded-lg border border-[var(--border)] px-5 py-3">
            <p className="text-[12px] uppercase tracking-wide text-[var(--text-3)]">
              Closing cash and bank
            </p>
            <p className="tabular mt-0.5 text-[18px] font-semibold text-[var(--text)]">
              {formatAmount(data.closingCashFils)}
            </p>
          </div>
        </div>

        {section(data.operating.heading, data.operating.lines, data.operating.totalFils)}
        {section(data.investing.heading, data.investing.lines, data.investing.totalFils)}
        {section(data.financing.heading, data.financing.lines, data.financing.totalFils)}

        <div className="flex items-center justify-between gap-4 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-5 py-3">
          <span className="text-[13px] font-semibold text-[var(--text)]">Net movement in cash</span>
          <span className="tabular text-[15px] font-semibold text-[var(--text)]">
            {formatAmount(data.netMovementFils)}
          </span>
        </div>
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* aging                                                                       */
/* -------------------------------------------------------------------------- */

function AgingReport({
  side,
  asOfDate,
  onSideChange,
}: {
  readonly side: "receivable" | "payable";
  readonly asOfDate: string;
  readonly onSideChange: (side: "receivable" | "payable") => void;
}): React.JSX.Element {
  const { data, isLoading } = useQuery({
    queryKey: ["finance.aging", side, asOfDate],
    queryFn: () => call("finance.aging", { asOfDate, side }),
  });

  return (
    <Card flush>
      <CardHeader
        title={side === "receivable" ? "Customer aging" : "Supplier aging"}
        description={`Outstanding invoices as at ${asOfDate}.`}
        actions={
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-0.5">
              {(
                [
                  { value: "receivable", label: "Customers" },
                  { value: "payable", label: "Suppliers" },
                ] as const
              ).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    onSideChange(option.value);
                  }}
                  className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors duration-fast ${
                    side === option.value
                      ? "bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-sm)]"
                      : "text-[var(--text-3)] hover:text-[var(--text)]"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {data !== undefined && (
              <StatementActions
                report={agingReport(data)}
                filename={side === "receivable" ? "receivables-aging" : "payables-aging"}
              />
            )}
          </div>
        }
      />
      {isLoading ? (
        <div className="p-4">
          <TableSkeleton columns={6} rows={8} />
        </div>
      ) : data === undefined ? null : (
        <>
          <div className="grid gap-px border-b border-[var(--border)] bg-[var(--border)] sm:grid-cols-5">
            {data.buckets.map((bucket) => (
              <div key={bucket.key} className="bg-[var(--surface)] px-4 py-3">
                <p className="text-[11.5px] uppercase tracking-wide text-[var(--text-3)]">
                  {bucket.label}
                </p>
                <p className="tabular mt-0.5 text-[15px] font-semibold text-[var(--text)]">
                  {formatAmount(bucket.amountFils)}
                </p>
              </div>
            ))}
          </div>

          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-[var(--border)] text-[11.5px] uppercase tracking-wide text-[var(--text-3)]">
                <th scope="col" className="px-5 py-2 text-start">
                  Invoice
                </th>
                <th scope="col" className="px-5 py-2 text-start">
                  Party
                </th>
                <th scope="col" className="px-5 py-2 text-start">
                  Due
                </th>
                <th scope="col" className="px-5 py-2 text-end">
                  Outstanding
                </th>
                <th scope="col" className="px-5 py-2 text-end">
                  Days late
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-8 text-center text-[var(--text-3)]">
                    Nothing is outstanding.
                  </td>
                </tr>
              ) : (
                data.rows.map((row) => (
                  <tr
                    key={row.documentId}
                    className="border-b border-[var(--divider)] last:border-0"
                  >
                    <td className="tabular px-5 py-2 text-[var(--text-2)]">{row.documentNumber}</td>
                    <td className="px-5 py-2 text-[var(--text)]">{row.partyName}</td>
                    <td className="tabular px-5 py-2 text-[var(--text-2)]">{row.dueDate ?? "—"}</td>
                    <td className="tabular px-5 py-2 text-end font-medium">
                      {formatAmount(row.outstandingFils)}
                    </td>
                    <td className="tabular px-5 py-2 text-end">
                      {row.daysOverdue > 0 ? (
                        <span className="font-medium text-[var(--danger)]">{row.daysOverdue}</span>
                      ) : (
                        <span className="text-[var(--text-3)]">—</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </>
      )}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* period comparison                                                           */
/* -------------------------------------------------------------------------- */

function ComparisonReport({
  fromDate,
  toDate,
  previousFromDate,
  previousToDate,
}: {
  readonly fromDate: string;
  readonly toDate: string;
  readonly previousFromDate: string;
  readonly previousToDate: string;
}): React.JSX.Element {
  const { data, isLoading } = useQuery({
    queryKey: ["finance.periodComparison", fromDate, toDate, previousFromDate, previousToDate],
    queryFn: () =>
      call("finance.periodComparison", { fromDate, toDate, previousFromDate, previousToDate }),
  });

  return (
    <Card flush>
      <CardHeader
        title="Period comparison"
        description={`${fromDate} to ${toDate} against ${previousFromDate} to ${previousToDate}.`}
        actions={
          data !== undefined ? (
            <StatementActions
              report={periodComparisonReport(data)}
              filename="period-comparison"
            />
          ) : undefined
        }
      />
      {isLoading ? (
        <div className="p-4">
          <TableSkeleton columns={4} rows={8} />
        </div>
      ) : data === undefined ? null : (
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-[var(--border)] text-[11.5px] uppercase tracking-wide text-[var(--text-3)]">
              <th scope="col" className="px-5 py-2 text-start">
                Account
              </th>
              <th scope="col" className="px-5 py-2 text-end">
                This period
              </th>
              <th scope="col" className="px-5 py-2 text-end">
                Previous period
              </th>
              <th scope="col" className="px-5 py-2 text-end">
                Change
              </th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.label} className="border-b border-[var(--divider)] last:border-0">
                <td className="px-5 py-2 text-[var(--text)]">{row.label}</td>
                <td className="tabular px-5 py-2 text-end font-medium">
                  {formatAmount(row.currentFils)}
                </td>
                <td className="tabular px-5 py-2 text-end text-[var(--text-2)]">
                  {formatAmount(row.previousFils)}
                </td>
                <td
                  className={`tabular px-5 py-2 text-end ${
                    row.changeFils > 0
                      ? "text-[var(--success)]"
                      : row.changeFils < 0
                        ? "text-[var(--danger)]"
                        : "text-[var(--text-3)]"
                  }`}
                >
                  {row.changeFils > 0 ? "+" : ""}
                  {formatAmount(row.changeFils)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export { AlertTriangle, Printer };
