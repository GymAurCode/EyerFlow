/**
 * Expenses.
 *
 * Compact toolbar inside the same card, summary strip above the table.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Pencil, Plus, Printer, Search, Wallet } from "lucide-react";
import { toast } from "sonner";
import type { ExpenseDto } from "../../../shared/types";
import { call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { formatAmount, formatMoney, parseAmount } from "../../lib/format";
import { todayIso, formatDate } from "../../lib/utils";
import { expenseDocumentHtml } from "../../lib/print-records";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Dialog } from "../../components/ui/Dialog";
import { DeleteConfirmDialog } from "../../components/ui/DeleteConfirmDialog";
import { DetailList, DetailRow } from "../../components/ui/DetailList";
import {
  DocumentPrintDialog,
  type PrintableDocument,
} from "../../components/print/DocumentPrintDialog";
import { Pagination, useTableView } from "../../components/ui/Dropdown";
import { HighlightText } from "../../components/ui/HighlightText";
import {
  RecordActions,
  standardRecordActions,
  type RecordAction,
} from "../../components/ui/RecordActions";
import { type Column, DataTable } from "../../components/ui/DataTable";
import { EmptyState, PageHeader, TableSkeleton } from "../../components/ui/Feedback";
import { Badge } from "../../components/ui/Badge";
import { Field, Input, MoneyInput, Select, type SelectOption } from "../../components/ui/Input";
import { useSearchHighlight } from "../../lib/search-highlight";

const expenseKey = (row: ExpenseDto): number => row.id;

/** The only field `expenses.list` searches. */
const EXPENSE_SEARCH_FIELDS = [(row: ExpenseDto) => row.description];

const CATEGORIES = [
  "rent",
  "utilities",
  "transport",
  "salaries",
  "marketing",
  "maintenance",
  "office",
  "internet",
  "general",
] as const;

const OTHER_CATEGORY = "__other";

const METHODS = ["cash", "bank", "card"] as const;

type Method = (typeof METHODS)[number];

const METHOD_LABELS: Record<Method, string> = {
  cash: "Cash",
  bank: "Bank",
  card: "Card",
};

/**
 * The category lists, built once from the constant above.
 *
 * The filter adds an "All Categories" placeholder; the editor adds an
 * "Other…" escape hatch that reveals a free-text field. Radix reserves the
 * empty string for "nothing chosen", so both of those live in the control's
 * placeholder rather than as an option.
 */
const categoryFilterOptions: SelectOption[] = CATEGORIES.map((value) => ({
  value,
  label: value,
}));

const editorCategoryOptions: SelectOption[] = [
  ...categoryFilterOptions,
  { value: OTHER_CATEGORY, label: "Other…" },
];

const paymentMethodOptions: SelectOption[] = METHODS.map((value) => ({
  value,
  label: METHOD_LABELS[value],
}));

export function ExpensesPage(): React.JSX.Element {
  const { can, settings } = useApp();
  const client = useQueryClient();

  const [search, setSearch] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [category, setCategory] = useState("");
  const [editing, setEditing] = useState<ExpenseDto | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [viewing, setViewing] = useState<ExpenseDto | null>(null);
  const [deleting, setDeleting] = useState<ExpenseDto | null>(null);
  const [printing, setPrinting] = useState<PrintableDocument | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["expenses", { search, fromDate, toDate, category }],
    queryFn: () =>
      call("expenses.list", {
        ...(search.length > 0 ? { search } : {}),
        ...(fromDate.length > 0 ? { fromDate } : {}),
        ...(toDate.length > 0 ? { toDate } : {}),
        ...(category.length > 0 ? { category } : {}),
        limit: 1000,
      }),
  });

  const isFiltered = search.length > 0 || fromDate !== "" || toDate !== "" || category !== "";

  const exportCsv = (): void => {
    const header = ["Date", "Category", "Description", "Method", "VAT", "Amount"];
    const body = rows.map((row) => [
      row.expenseDate,
      row.category,
      row.description,
      METHOD_LABELS[row.paymentMethod],
      (row.vatFils / 100).toFixed(2),
      (row.amountFils / 100).toFixed(2),
    ]);
    const csv = [header, ...body]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `expenses-${todayIso()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${String(rows.length)} expenses`);
  };

  const rows = useMemo(() => data ?? [], [data]);
  const highlight = useSearchHighlight(rows, search, {
    rowKey: expenseKey,
    fields: EXPENSE_SEARCH_FIELDS,
  });
  const total = useMemo(() => rows.reduce((sum, row) => sum + row.amountFils, 0), [rows]);

  const columns: readonly Column<ExpenseDto>[] = [
    {
      id: "date",
      header: "Date",
      cell: (row) => (
        <span className="tabular text-[var(--text-2)]">{formatDate(row.expenseDate)}</span>
      ),
      sortValue: (row) => row.expenseDate,
    },
    {
      id: "category",
      header: "Category",
      cell: (row) => <span className="capitalize">{row.category}</span>,
      sortValue: (row) => row.category,
    },
    {
      id: "description",
      header: "Description",
      cell: (row) => (
        <span className="text-[var(--text)]">
          <HighlightText text={row.description} term={search} />
        </span>
      ),
      sortValue: (row) => row.description,
    },
    {
      id: "method",
      header: "Method",
      cell: (row) => METHOD_LABELS[row.paymentMethod],
      sortValue: (row) => row.paymentMethod,
    },
    {
      id: "vat",
      header: "VAT",
      align: "end",
      cell: (row) => (row.vatFils === 0 ? "—" : formatAmount(row.vatFils)),
      sortValue: (row) => row.vatFils,
      defaultHidden: true,
    },
    {
      id: "amount",
      header: "Amount",
      align: "end",
      cell: (row) => <span className="font-medium">{formatMoney(row.amountFils)}</span>,
      sortValue: (row) => row.amountFils,
    },
    {
      id: "status",
      header: "Status",
      cell: (row) => {
        const paid = row.paidFils ?? row.amountFils;
        if (paid >= row.amountFils) return <Badge tone="success">Paid</Badge>;
        if (paid > 0) return <Badge tone="warning">Part paid</Badge>;
        return <Badge tone="danger">Unpaid</Badge>;
      },
      sortValue: (row) => (row.paidFils ?? row.amountFils) / Math.max(1, row.amountFils),
    },
    {
      id: "actions",
      header: "",
      align: "end",
      widthClass: "w-12",
      cell: (row) => <RecordActions items={actionsFor(row)} />,
    },
  ];

  function actionsFor(row: ExpenseDto): RecordAction[] {
    return standardRecordActions({
      canView: true,
      onView: () => {
        setViewing(row);
      },
      canEdit: can("finance", "edit"),
      onEdit: () => {
        setEditing(row);
        setEditorOpen(true);
      },
      canPrint: true,
      onPrint: () => {
        // The document is shown first: printing is never a leap of faith.
        setPrinting({
          html: expenseDocumentHtml(row, { settings }),
          title: "Expense Voucher",
          description: row.description,
          filename: `expense-${row.expenseDate}.pdf`,
        });
      },
      canDelete: can("finance", "delete"),
      onDelete: () => {
        setDeleting(row);
      },
    });
  }

  const view = useTableView(rows, columns, 25, {
    focusKey: highlight.primaryKey,
    rowKey: expenseKey,
  });

  const openEditor = (): void => {
    setEditing(null);
    setEditorOpen(true);
  };

  // The dashboard's quick actions reach this screen from elsewhere.
  useEffect(() => {
    const onNewExpense = (): void => {
      if (!can("finance", "create")) return;
      setEditing(null);
      setEditorOpen(true);
    };
    window.addEventListener("eyerstock:new-expense", onNewExpense);
    return () => {
      window.removeEventListener("eyerstock:new-expense", onNewExpense);
    };
  }, [can]);

  return (
    <div>
      <PageHeader
        title="Expenses"
        description="Rent, salaries, transport — everything that is not stock."
        actions={
          can("finance", "create") ? (
            <Button variant="primary" iconLeft={<Plus className="h-4 w-4" />} onClick={openEditor}>
              New expense
            </Button>
          ) : undefined
        }
      />

      <Card flush>
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--divider)] p-4">
          <div className="w-[280px]">
            <Field label="Search" srLabelOnly>
              {(id) => (
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-[var(--text-3)]"
                    aria-hidden="true"
                  />
                  <Input
                    id={id}
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                    }}
                    placeholder="Description"
                    className="ps-9"
                  />
                </div>
              )}
            </Field>
          </div>

          <div className="w-[170px]">
            <Input
              type="date"
              value={fromDate}
              onChange={(event) => {
                setFromDate(event.target.value);
              }}
              aria-label="From date"
            />
          </div>
          <div className="w-[170px]">
            <Input
              type="date"
              value={toDate}
              onChange={(event) => {
                setToDate(event.target.value);
              }}
              aria-label="To date"
            />
          </div>
          <div className="w-[170px]">
            <Select
              value={category}
              options={categoryFilterOptions}
              placeholder="All Categories"
              onChange={(next) => {
                setCategory(next);
              }}
              aria-label="Category filter"
            />
          </div>

          {rows.length > 0 && (
            <span className="ms-1 me-1 hidden sm:inline-flex">
              <SummaryStat label="Total" value={formatMoney(total)} />
            </span>
          )}

          <Button
            variant="secondary"
            size="icon"
            iconOnlyLabel="Export CSV"
            className="ms-auto"
            onClick={exportCsv}
          >
            <Download className="h-4 w-4" />
          </Button>
        </div>

        {/* Filter chips */}
        {isFiltered && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--divider)] bg-[var(--surface-2)]/60 px-4 py-2.5">
            {search.length > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--brand-soft)] px-2.5 py-0.5 text-[12px] font-medium text-[var(--brand)]">
                Search: {search}
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="rounded-full transition-colors hover:text-[var(--brand-hover)]"
                  aria-label="Clear search filter"
                >
                  ×
                </button>
              </span>
            )}
            {category !== "" && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--brand-soft)] px-2.5 py-0.5 text-[12px] font-medium text-[var(--brand)]">
                Category: {category}
                <button
                  type="button"
                  onClick={() => setCategory("")}
                  className="rounded-full transition-colors hover:text-[var(--brand-hover)]"
                  aria-label="Clear category filter"
                >
                  ×
                </button>
              </span>
            )}
            {(fromDate !== "" || toDate !== "") && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--brand-soft)] px-2.5 py-0.5 text-[12px] font-medium text-[var(--brand)]">
                Date: {fromDate || "…"} → {toDate || "…"}
                <button
                  type="button"
                  onClick={() => {
                    setFromDate("");
                    setToDate("");
                  }}
                  className="rounded-full transition-colors hover:text-[var(--brand-hover)]"
                  aria-label="Clear date filter"
                >
                  ×
                </button>
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                setSearch("");
                setFromDate("");
                setToDate("");
                setCategory("");
              }}
              className="text-[12.5px] font-medium text-[var(--brand)] hover:underline"
            >
              Clear all
            </button>
          </div>
        )}

        {/* Table */}
        {isLoading ? (
          <div className="p-4">
            <TableSkeleton columns={5} rows={6} />
          </div>
        ) : (
          <>
            <DataTable
              frameless
              columns={columns}
              rows={view.rowsOnPage}
              rowKey={(row) => row.id}
              sortId={view.sortId}
              sortDirection={view.sortDirection}
              onSortChange={view.setSort}
              hiddenColumnIds={view.hiddenColumnIds}
              highlightedRowKeys={highlight.keys}
              primaryRowKey={highlight.primaryKey}
              scrollToRowKey={highlight.primaryKey}
              caption="Expenses"
              compact
              emptyState={
                <EmptyState
                  compact
                  icon={<Wallet className="h-5 w-5" />}
                  title="No expenses yet"
                  description="Record rent, salaries and transport here so the profit figures are true."
                  actionLabel={can("finance", "create") ? "New expense" : undefined}
                  onAction={can("finance", "create") ? openEditor : undefined}
                />
              }
            />
            <Pagination
              total={view.totalRows}
              page={view.page}
              onPageChange={view.setPage}
              perPage={view.perPage}
              onPerPageChange={view.setPerPage}
              itemLabel="expenses"
            />
          </>
        )}
      </Card>

      <ExpenseEditor
        open={editorOpen}
        expense={editing}
        onClose={() => {
          setEditorOpen(false);
          setEditing(null);
        }}
        onSaved={() => {
          void client.invalidateQueries({ queryKey: ["expenses"] });
        }}
      />

      <ExpenseDetailDialog
        expense={viewing}
        canEdit={can("finance", "edit")}
        canDelete={can("finance", "delete")}
        onClose={() => {
          setViewing(null);
        }}
        onEdit={(expense) => {
          setViewing(null);
          setEditing(expense);
          setEditorOpen(true);
        }}
        onDelete={(expense) => {
          setDeleting(expense);
        }}
        onPrint={(expense) => {
          setPrinting({
            html: expenseDocumentHtml(expense, { settings }),
            title: "Expense Voucher",
            description: expense.description,
            filename: `expense-${expense.expenseDate}.pdf`,
          });
        }}
      />

      <DeleteConfirmDialog
        open={deleting !== null}
        subject="expense"
        message={
          deleting === null
            ? ""
            : `"${deleting.description}" · ${formatMoney(deleting.amountFils)} · ` +
              `${formatDate(deleting.expenseDate)}. This cannot be undone.`
        }
        busy={busy}
        onCancel={() => {
          setDeleting(null);
        }}
        onConfirm={() => {
          if (deleting === null) return;
          setBusy(true);
          void call("expenses.delete", { id: deleting.id })
            .then(() => {
              toast.success("Expense deleted");
              setDeleting(null);
              void client.invalidateQueries({ queryKey: ["expenses"] });
            })
            .catch((error: unknown) => {
              toast.error(errorMessage(error));
            })
            .finally(() => {
              setBusy(false);
            });
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
    </div>
  );
}

function ExpenseDetailDialog({
  expense,
  canEdit,
  canDelete,
  onClose,
  onEdit,
  onDelete,
  onPrint,
}: {
  readonly expense: ExpenseDto | null;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
  readonly onClose: () => void;
  readonly onEdit: (expense: ExpenseDto) => void;
  readonly onDelete: (expense: ExpenseDto) => void;
  readonly onPrint: (expense: ExpenseDto) => void;
}): React.JSX.Element {

  return (
    <Dialog
      open={expense !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="md"
      title="Expense"
      description={expense?.description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          {canDelete && expense !== null && (
            <Button
              variant="danger"
              onClick={() => {
                onDelete(expense);
              }}
            >
              Delete
            </Button>
          )}
          {expense !== null && (
            <Button
              variant="secondary"
              iconLeft={<Printer className="h-4 w-4" />}
              onClick={() => {
                onPrint(expense);
              }}
            >
              Print
            </Button>
          )}
          {canEdit && expense !== null && (
            <Button
              variant="primary"
              iconLeft={<Pencil className="h-4 w-4" />}
              onClick={() => {
                onEdit(expense);
              }}
            >
              Edit
            </Button>
          )}
        </>
      }
    >
      {expense === null ? null : (
        <DetailList>
          <DetailRow label="Date" value={formatDate(expense.expenseDate)} />
          <DetailRow label="Category" value={expense.category} />
          <DetailRow label="Amount" value={formatMoney(expense.amountFils)} />
          <DetailRow label="VAT" value={formatMoney(expense.vatFils)} />
          <DetailRow label="Paid" value={formatMoney(expense.paidFils)} />
          <DetailRow
            label="Outstanding"
            value={formatMoney(expense.amountFils + expense.vatFils - expense.paidFils)}
          />
          <DetailRow label="Method" value={expense.paymentMethod.toUpperCase()} />
          <DetailRow label="Reference" value={expense.reference ?? "—"} />
          <DetailRow label="Account" value={expense.accountCode ?? "—"} />
          <DetailRow label="Notes" value={expense.notes ?? "—"} />
        </DetailList>
      )}
    </Dialog>
  );
}

function SummaryStat({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): React.JSX.Element {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-[var(--text-3)]">{label}:</span>
      <span className="tabular font-medium text-[var(--text)]">{value}</span>
    </span>
  );
}

function ExpenseEditor({
  open,
  expense,
  onClose,
  onSaved,
}: {
  readonly open: boolean;
  readonly expense: ExpenseDto | null;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): React.JSX.Element {
  const [expenseDate, setExpenseDate] = useState(todayIso());
  const [category, setCategory] = useState<string>("general");
  const [customCategory, setCustomCategory] = useState("");
  const [description, setDescription] = useState("");
  const [amountText, setAmountText] = useState("");
  const [vatText, setVatText] = useState("0");
  const [paidText, setPaidText] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<Method>("cash");
  const [accountCode, setAccountCode] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [seeded, setSeeded] = useState<number | null>(null);

  // The Chart of Accounts, so the expense can be charged to a real account
  // rather than to a category name.
  const { data: accounts } = useQuery({
    queryKey: ["finance.chart"],
    queryFn: () => call("finance.chart", {}),
    enabled: open,
  });

  const accountOptions = useMemo(
    () =>
      (accounts ?? [])
        .filter((account) => account.type === "expense")
        .map((account) => ({
          value: account.code,
          label: `${account.code} — ${account.name}`,
        })),
    [accounts],
  );

  // Seeded in an effect rather than during render, which would make React
  // discard and repeat the whole pass.
  useEffect(() => {
    if (!open) return;
    const seedKey = expense?.id ?? null;
    if (seeded === seedKey) return;
    setSeeded(seedKey);
    setExpenseDate(expense?.expenseDate ?? todayIso());
    const known = expense !== null && (CATEGORIES as readonly string[]).includes(expense.category);
    setCategory(known ? (expense?.category ?? "general") : OTHER_CATEGORY);
    setCustomCategory(known || expense === null ? "" : expense.category);
    setDescription(expense?.description ?? "");
    setAmountText(expense === null ? "" : String(expense.amountFils / 100));
    setVatText(expense === null ? "0" : String(expense.vatFils / 100));
    setPaidText(expense === null ? "" : String((expense.paidFils ?? expense.amountFils) / 100));
    setPaymentMethod(expense?.paymentMethod ?? "cash");
    setAccountCode(expense?.accountCode ?? "");
    setReference(expense?.reference ?? "");
  }, [open, expense, seeded]);

  const effectiveCategory = category === OTHER_CATEGORY ? customCategory.trim() : category;

  const amountFils = parseAmount(amountText) ?? 0;
  // An expense that is not paid yet leaves a liability behind, and the ledger
  // has to show it.
  const paidFils = paidText.trim().length === 0 ? amountFils : (parseAmount(paidText) ?? 0);
  const unpaidFils = Math.max(0, amountFils - paidFils);

  const submit = (): void => {
    const amount = parseAmount(amountText);
    if (amount === null || amount <= 0) {
      toast.error("Enter the amount spent.");
      return;
    }
    if (effectiveCategory.length === 0) {
      toast.error("Choose or type a category.");
      return;
    }
    const paid = paidText.trim().length === 0 ? amount : (parseAmount(paidText) ?? 0);
    if (paid < 0 || paid > amount) {
      toast.error("The amount paid must be between nothing and the whole amount.");
      return;
    }

    setBusy(true);

    void call("expenses.save", {
      ...(expense === null ? {} : { id: expense.id }),
      expenseDate,
      category: effectiveCategory,
      description: description.trim(),
      amountFils: amount,
      vatFils: parseAmount(vatText) ?? 0,
      paidFils: paid,
      paymentMethod,
      accountCode: accountCode.length > 0 ? accountCode : null,
      reference: reference.trim().length > 0 ? reference.trim() : null,
    })
      .then(() => {
        toast.success("Expense saved");
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
      title={expense === null ? "New expense" : "Edit expense"}
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
        <Field label="Date" required>
          {(id) => (
            <Input
              id={id}
              type="date"
              value={expenseDate}
              onChange={(event) => {
                setExpenseDate(event.target.value);
              }}
            />
          )}
        </Field>

        <Field label="Category" required>
          {(id) => (
            <Select
              id={id}
              value={category}
              options={editorCategoryOptions}
              onChange={(next) => {
                setCategory(next);
              }}
            />
          )}
        </Field>

        {category === OTHER_CATEGORY && (
          <Field label="Category name" required className="sm:col-span-2">
            {(id) => (
              <Input
                id={id}
                value={customCategory}
                onChange={(event) => {
                  setCustomCategory(event.target.value);
                }}
                placeholder="Insurance, licence, delivery"
                autoFocus
              />
            )}
          </Field>
        )}

        <Field label="Description" required className="sm:col-span-2">
          {(id) => (
            <Input
              id={id}
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
              placeholder="Shop rent — March"
              autoFocus={category !== OTHER_CATEGORY}
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

        <Field label="VAT" hint="Recoverable VAT, if any.">
          {(id) => (
            <MoneyInput
              id={id}
              value={vatText}
              onChange={(event) => {
                setVatText(event.target.value);
              }}
            />
          )}
        </Field>

        <Field label="Payment method" required>
          {(id) => (
            <Select
              id={id}
              value={paymentMethod}
              options={paymentMethodOptions}
              onChange={(next) => {
                setPaymentMethod(next as Method);
              }}
            />
          )}
        </Field>

        <Field
          label="Amount paid"
          hint="Leave blank if it was paid in full. Anything unpaid is carried as a liability."
        >
          {(id) => (
            <MoneyInput
              id={id}
              value={paidText}
              onChange={(event) => {
                setPaidText(event.target.value);
              }}
              placeholder={amountText}
            />
          )}
        </Field>

        <Field
          label="Account"
          hint="The ledger account this is charged to."
          className="sm:col-span-2"
        >
          {(id) => (
            <Select
              id={id}
              value={accountCode}
              options={accountOptions}
              placeholder="Use the category default"
              onChange={(next) => {
                setAccountCode(next);
              }}
            />
          )}
        </Field>

        {unpaidFils > 0 && (
          <p className="text-xs text-[var(--warning)] sm:col-span-2">
            {formatMoney(unpaidFils)} of this expense is not paid yet, and will be carried as a
            liability until it is settled.
          </p>
        )}

        <Field label="Reference" hint="Receipt or invoice number.">
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
