/**
 * Reports.
 *
 * The page is a report builder: pick the report, set the period and any other
 * filter that applies to it, and generate it. Generating reads the live
 * database and builds a document - the same document the preview shows and the
 * printer prints - so a report can never disagree with the screens it was
 * generated from.
 *
 * The previous tabs are still here, as report types. They read the same data
 * they always did and their CSV exports still work; what is new is that each
 * one can be printed and exported as a proper document.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Boxes,
  Download,
  LineChart,
  PackageSearch,
  PieChart,
  Printer,
  Receipt,
  ShoppingCart,
  TrendingUp,
} from "lucide-react";
import { toast } from "sonner";
import type { DocumentStatus } from "../../shared/types";
import { call, errorMessage } from "../lib/api";
import { useApp } from "../lib/app-context";
import { formatDate, todayIso } from "../lib/utils";
import { Button } from "../components/ui/Button";
import { Card, CardBody } from "../components/ui/Card";
import { Field, Input, Select, type SelectOption } from "../components/ui/Input";
import { PageHeader } from "../components/ui/Feedback";
import { ReportPreview } from "../components/print/ReportPreview";
import { renderReportDocument, type ReportDocument } from "../components/print/report-document";
import type { DocumentOrientation } from "../components/print/document-css";
import {
  documentRegisterReport,
  expenseReport,
  inventoryReport,
  partnerSplitReport,
  profitAndLossReport,
  stockReport,
} from "../components/print/report-templates";
import { companyProfile } from "../components/print/company-document";
import { printHtml, saveHtmlAsPdf } from "../lib/print";

type ReportKind =
  "profitAndLoss" | "partnerSplit" | "sales" | "purchases" | "expenses" | "stock" | "inventory";

interface ReportDefinition {
  readonly id: ReportKind;
  readonly label: string;
  readonly description: string;
  readonly icon: React.JSX.Element;
  /** Whether the report covers a period. */
  readonly dated: boolean;
  /** Whether the report can be filtered by document status. */
  readonly byStatus: boolean;
  /** Whether the report can be filtered by expense category. */
  readonly byCategory: boolean;
  /** The CSV export the report has always had, where there is one. */
  readonly csvDataset: "profitAndLoss" | "partnerSplit" | "sales" | "stock" | null;
}

/**
 * The report catalogue.
 *
 * Keyed by id rather than held in a list, so the type of the chosen report is
 * known and the lookup can never come back empty.
 */
const REPORTS: Record<ReportKind, ReportDefinition> = {
  profitAndLoss: {
    id: "profitAndLoss",
    label: "Profit & Loss",
    description: "Revenue, cost of goods and expenses for a period",
    icon: <TrendingUp className="h-4 w-4" />,
    dated: true,
    byStatus: false,
    byCategory: false,
    csvDataset: "profitAndLoss",
  },
  partnerSplit: {
    id: "partnerSplit",
    label: "Partner Split",
    description: "How the net profit is divided between the partners",
    icon: <PieChart className="h-4 w-4" />,
    dated: true,
    byStatus: false,
    byCategory: false,
    csvDataset: "partnerSplit",
  },
  sales: {
    id: "sales",
    label: "Sales Report",
    description: "Every sales invoice, with what is still owed",
    icon: <LineChart className="h-4 w-4" />,
    dated: true,
    byStatus: true,
    byCategory: false,
    csvDataset: "sales",
  },
  purchases: {
    id: "purchases",
    label: "Purchase Report",
    description: "Every purchase invoice, with what is still owed",
    icon: <ShoppingCart className="h-4 w-4" />,
    dated: true,
    byStatus: true,
    byCategory: false,
    csvDataset: null,
  },
  expenses: {
    id: "expenses",
    label: "Expense Report",
    description: "Every expense recorded in the period",
    icon: <Receipt className="h-4 w-4" />,
    dated: true,
    byStatus: false,
    byCategory: true,
    csvDataset: null,
  },
  stock: {
    id: "stock",
    label: "Stock Report",
    description: "What is on the shelf, valued at the last purchase cost",
    icon: <Boxes className="h-4 w-4" />,
    dated: false,
    byStatus: false,
    byCategory: false,
    csvDataset: "stock",
  },
  inventory: {
    id: "inventory",
    label: "Inventory Report",
    description: "The catalogue and its current stock position",
    icon: <PackageSearch className="h-4 w-4" />,
    dated: false,
    byStatus: false,
    byCategory: false,
    csvDataset: null,
  },
};

/** The order the reports are offered in. */
const REPORT_ORDER: readonly ReportKind[] = [
  "profitAndLoss",
  "partnerSplit",
  "sales",
  "purchases",
  "expenses",
  "stock",
  "inventory",
];

const STATUS_OPTIONS: readonly SelectOption[] = [
  { value: "", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "issued", label: "Issued" },
  { value: "partPaid", label: "Part paid" },
  { value: "paid", label: "Paid" },
  { value: "cancelled", label: "Cancelled" },
];

function startOfYear(): string {
  return `${todayIso().slice(0, 4)}-01-01`;
}

function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function ReportsPage(): React.JSX.Element {
  const { settings } = useApp();

  const [kind, setKind] = useState<ReportKind>("profitAndLoss");
  const [fromDate, setFromDate] = useState(startOfYear);
  const [toDate, setToDate] = useState(todayIso);
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [generated, setGenerated] = useState<{
    /** The rendered document. This is exactly what is previewed and printed. */
    readonly html: string;
    readonly title: string;
    readonly orientation: DocumentOrientation;
  } | null>(null);

  const definition = REPORTS[kind];

  // The expense categories the shop has actually used, so the filter offers
  // real choices rather than a free-text box.
  const { data: expenseCategories } = useQuery({
    queryKey: ["reports", "expense-categories"],
    queryFn: () => call("expenses.list", { limit: 500 }),
    enabled: definition.byCategory,
    staleTime: 60_000,
  });

  const categoryOptions = useMemo<SelectOption[]>(() => {
    const categories = new Set<string>();
    for (const expense of expenseCategories ?? []) {
      categories.add(expense.category);
    }
    return [
      { value: "", label: "All categories" },
      ...[...categories].sort().map((value) => ({ value, label: value })),
    ];
  }, [expenseCategories]);

  const generate = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);

    try {
      const report = await buildReport(definition, {
        fromDate,
        toDate,
        status: status.length > 0 ? (status as DocumentStatus) : undefined,
        category,
      });

      const html = renderReportDocument(report, {
        profile: companyProfile(settings),
      });

      setGenerated({
        html,
        title: report.title,
        orientation: report.orientation ?? "portrait",
      });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const doPrint = (): void => {
    if (generated === null) return;
    setBusy(true);
    // The very document that was previewed, so what was checked is what
    // prints.
    void printHtml(generated.html, {}, generated.title)
      .then((outcome) => {
        if (!outcome.ok) toast.error(outcome.message);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const doExportPdf = (): void => {
    if (generated === null) return;
    setBusy(true);
    void saveHtmlAsPdf(generated.html, `${slug(generated.title)}.pdf`, generated.title)
      .then((outcome) => {
        if (!outcome.ok) toast.error(outcome.message);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const exportCsv = (): void => {
    if (definition.csvDataset === null) return;
    void call("reports.export", {
      dataset: definition.csvDataset,
      fromDate,
      toDate,
    })
      .then((result) => {
        toast.success(`Saved to ${result.path}`);
      })
      .catch((error: unknown) => {
        toast.error(errorMessage(error));
      });
  };

  if (generated !== null) {
    return (
      <ReportPreview
        html={generated.html}
        title={generated.title}
        description="Generated from the live database."
        orientation={generated.orientation}
        busy={busy}
        onPrint={doPrint}
        onExportPdf={doExportPdf}
        onBack={() => {
          setGenerated(null);
        }}
      />
    );
  }

  return (
    <div>
      <PageHeader
        title="Reports"
        description="Pick a report, set the period, and generate it from your live data."
        actions={
          definition.csvDataset !== null ? (
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<Download className="h-3.5 w-3.5" />}
              onClick={exportCsv}
            >
              Export CSV
            </Button>
          ) : undefined
        }
      />

      {/* Report type */}
      <div className="mb-4">
        <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
          Report type
        </h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {REPORT_ORDER.map((id) => {
            const report = REPORTS[id];
            const active = report.id === kind;
            return (
              <button
                key={report.id}
                type="button"
                onClick={() => {
                  setKind(report.id);
                }}
                aria-pressed={active}
                className={[
                  "flex items-start gap-3 rounded-xl border p-3 text-start transition-colors duration-fast",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
                  active
                    ? "border-[var(--brand)] bg-[var(--brand-soft)]"
                    : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--brand)] hover:bg-[var(--surface-2)]",
                ].join(" ")}
              >
                <span
                  className={[
                    "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
                    active
                      ? "bg-[var(--brand)] text-[var(--on-brand)]"
                      : "bg-[var(--surface-2)] text-[var(--text-3)]",
                  ].join(" ")}
                >
                  {report.icon}
                </span>
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-semibold text-[var(--text)]">
                    {report.label}
                  </span>
                  <span className="mt-0.5 block text-[12px] leading-snug text-[var(--text-3)]">
                    {report.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Filters */}
      <Card className="mb-4">
        <CardBody>
          <div className="flex flex-wrap items-end gap-3">
            {definition.dated && (
              <>
                <div className="w-[168px]">
                  <Field label="From">
                    {(id) => (
                      <Input
                        id={id}
                        type="date"
                        value={fromDate}
                        onChange={(event) => {
                          setFromDate(event.target.value);
                        }}
                      />
                    )}
                  </Field>
                </div>
                <div className="w-[168px]">
                  <Field label="To">
                    {(id) => (
                      <Input
                        id={id}
                        type="date"
                        value={toDate}
                        onChange={(event) => {
                          setToDate(event.target.value);
                        }}
                      />
                    )}
                  </Field>
                </div>
                <div className="flex items-center gap-1 pb-0.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setFromDate(startOfYear());
                      setToDate(todayIso());
                    }}
                  >
                    This year
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setFromDate(daysAgo(30));
                      setToDate(todayIso());
                    }}
                  >
                    Last 30 days
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setFromDate(daysAgo(90));
                      setToDate(todayIso());
                    }}
                  >
                    Last 90 days
                  </Button>
                </div>
              </>
            )}

            {definition.byStatus && (
              <div className="w-[180px]">
                <Field label="Status">
                  {(id) => (
                    <Select
                      id={id}
                      value={status}
                      options={STATUS_OPTIONS}
                      onChange={(next) => {
                        setStatus(next);
                      }}
                    />
                  )}
                </Field>
              </div>
            )}

            {definition.byCategory && (
              <div className="w-[200px]">
                <Field label="Category">
                  {(id) => (
                    <Select
                      id={id}
                      value={category}
                      options={categoryOptions}
                      onChange={(next) => {
                        setCategory(next);
                      }}
                    />
                  )}
                </Field>
              </div>
            )}

            <div className="ms-auto flex items-center gap-2">
              <Button
                variant="primary"
                iconLeft={<Printer className="h-4 w-4" />}
                onClick={() => {
                  void generate();
                }}
                loading={busy}
              >
                Generate Report
              </Button>
            </div>
          </div>

          {definition.dated && (
            <p className="mt-3 text-xs text-[var(--text-muted)]">
              The report will cover {formatDate(fromDate)} to {formatDate(toDate)}.
            </p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* building the report                                                         */
/* -------------------------------------------------------------------------- */

interface BuildOptions {
  readonly fromDate: string;
  readonly toDate: string;
  readonly status: DocumentStatus | undefined;
  readonly category: string;
}

/** Read the data for the chosen report and turn it into a document model. */
async function buildReport(
  definition: ReportDefinition,
  options: BuildOptions,
): Promise<ReportDocument> {
  switch (definition.id) {
    case "profitAndLoss": {
      const data = await call("reports.profitAndLoss", {
        fromDate: options.fromDate,
        toDate: options.toDate,
      });
      return profitAndLossReport(data);
    }

    case "partnerSplit": {
      const data = await call("reports.partnerSplit", {
        fromDate: options.fromDate,
        toDate: options.toDate,
      });
      return partnerSplitReport(data);
    }

    case "sales": {
      const rows = await call("reports.documentRegister", {
        kind: "invoice",
        fromDate: options.fromDate,
        toDate: options.toDate,
        ...(options.status !== undefined ? { status: options.status } : {}),
      });
      return documentRegisterReport(
        {
          title: "Sales Report",
          subtitle: "Every sales invoice and what is still owed",
          partyHeader: "Customer",
          numberHeader: "Invoice No.",
          rows,
          fromDate: options.fromDate,
          toDate: options.toDate,
        },
      );
    }

    case "purchases": {
      const rows = await call("reports.documentRegister", {
        kind: "purchaseInvoice",
        fromDate: options.fromDate,
        toDate: options.toDate,
        ...(options.status !== undefined ? { status: options.status } : {}),
      });
      return documentRegisterReport(
        {
          title: "Purchase Report",
          subtitle: "Every purchase invoice and what is still owed",
          partyHeader: "Supplier",
          numberHeader: "Purchase No.",
          rows,
          fromDate: options.fromDate,
          toDate: options.toDate,
        },
      );
    }

    case "expenses": {
      const expenses = await call("expenses.list", {
        fromDate: options.fromDate,
        toDate: options.toDate,
        ...(options.category.length > 0 ? { category: options.category } : {}),
        limit: 5000,
      });
      return expenseReport(expenses, options.fromDate, options.toDate);
    }

    case "stock": {
      const data = await call("reports.stockValuation", {});
      return stockReport(data.rows, todayIso());
    }

    case "inventory": {
      const products = await call("products.list", { limit: 5000 });
      return inventoryReport(products);
    }
  }
}

/** A file name that is safe on every filesystem. */
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
