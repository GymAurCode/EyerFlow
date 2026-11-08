/**
 * Document list: sales invoices and purchase invoices.
 *
 * One component serves both: the invoice list and the purchase list are the
 * same table read from a different direction. Everything that makes it "sales"
 * or "purchases" - the title, the button, the routes, the permission module -
 * is derived here from the document kind.
 *
 * Add / Edit / row-click all open dialogs over this list; the page behind them
 * never moves.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Calendar,
  ChevronDown,
  Download,
  Eye,
  FileOutput,
  FilePlus2,
  HandCoins,
  Pencil,
  Printer,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type { DocumentDto, DocumentStatus } from "../../../shared/types";
import { call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { formatMoney } from "../../lib/format";
import { addDaysIso, startOfMonthIso, todayIso } from "../../lib/utils";
import { Button } from "../../components/ui/Button";
import { StatusBadge } from "../../components/ui/Badge";
import { Card } from "../../components/ui/Card";
import { DeleteConfirmDialog } from "../../components/ui/DeleteConfirmDialog";
import { SaleDialog } from "../../components/documents/SaleDialog";
import { PurchaseDialog } from "../../components/documents/PurchaseDialog";
import { DocumentDetailDialog } from "../../components/documents/DocumentDetailDialog";
import { DocumentPaymentDialog } from "../../components/documents/DocumentPaymentDialog";
import { type Column, DataTable } from "../../components/ui/DataTable";
import {
  ColumnVisibility,
  DropdownMenu,
  DropdownItem,
  Pagination,
  useTableView,
} from "../../components/ui/Dropdown";
import { HighlightText } from "../../components/ui/HighlightText";
import { RecordActions, type RecordAction } from "../../components/ui/RecordActions";
import { EmptyState, PageHeader, TableSkeleton } from "../../components/ui/Feedback";
import { Field, Input, Select, type SelectOption } from "../../components/ui/Input";
import { DOCUMENT_STATUS_OPTIONS } from "../../lib/select-options";
import { invoiceDocumentHtml, saveInvoicePdf } from "../../lib/print";
import { useSearchHighlight } from "../../lib/search-highlight";
import {
  DocumentPrintDialog,
  type PrintableDocument,
} from "../../components/print/DocumentPrintDialog";

export type DocumentListKind = "invoice" | "purchaseInvoice";

export interface DocumentListPageProps {
  readonly kind: DocumentListKind;
}

const documentKey = (row: DocumentDto): number => row.id;

/** The same two fields `documents.list` searches. */
const DOCUMENT_SEARCH_FIELDS = [
  (row: DocumentDto) => row.number,
  (row: DocumentDto) => row.partyName,
];

const DOCUMENT_RANK_FIELDS = [
  (row: DocumentDto) => row.number,
  (row: DocumentDto) => row.partyName,
];

const STATUS_LABELS: Record<DocumentStatus, string> = {
  draft: "Draft",
  issued: "Issued",
  partPaid: "Part paid",
  paid: "Paid",
  cancelled: "Cancelled",
};

type DatePreset = "today" | "yesterday" | "week" | "month" | "lastMonth" | "year" | "custom";

function formatDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

export function DocumentListPage({ kind }: DocumentListPageProps): React.JSX.Element {
  const { can, settings } = useApp();

  const isPurchase = kind === "purchaseInvoice";
  const permissionModule = isPurchase ? "purchases" : "sales";
  const title = isPurchase ? "Purchases" : "Sales";
  const singular = isPurchase ? "purchase" : "invoice";
  const plural = `${singular}s`;
  const newLabel = isPurchase ? "New purchase" : "New invoice";
  const partyLabel = isPurchase ? "Supplier" : "Customer";

  const canCreate = can(permissionModule, "create");
  const canEdit = can(permissionModule, "edit");
  const canDelete = can(permissionModule, "delete");
  const client = useQueryClient();

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<DocumentStatus | "">("");
  const [partyId, setPartyId] = useState<number | "">("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [datePreset, setDatePreset] = useState<DatePreset | "">("");
  const [saleOpen, setSaleOpen] = useState(false);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [editingDoc, setEditingDoc] = useState<DocumentDto | null>(null);
  const [detailDoc, setDetailDoc] = useState<DocumentDto | null>(null);
  const [paymentDoc, setPaymentDoc] = useState<DocumentDto | null>(null);
  const [deletingDoc, setDeletingDoc] = useState<DocumentDto | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [printing, setPrinting] = useState<PrintableDocument | null>(null);

  // Keyboard shortcuts (Ctrl+N / Ctrl+P) dispatch custom events that the list
  // pages listen for, since the dialogs are owned by the pages themselves.
  useEffect(() => {
    const onNewSale = (): void => {
      if (kind === "invoice" && can("sales", "create")) {
        setEditingDoc(null);
        setSaleOpen(true);
      }
    };
    const onNewPurchase = (): void => {
      if (kind === "purchaseInvoice" && can("purchases", "create")) {
        setEditingDoc(null);
        setPurchaseOpen(true);
      }
    };
    window.addEventListener("eyerstock:new-sale", onNewSale);
    window.addEventListener("eyerstock:new-purchase", onNewPurchase);
    return () => {
      window.removeEventListener("eyerstock:new-sale", onNewSale);
      window.removeEventListener("eyerstock:new-purchase", onNewPurchase);
    };
  }, [kind, can]);

  const { data, isLoading } = useQuery({
    queryKey: ["documents", kind, { search, status, partyId, fromDate, toDate }],
    queryFn: () =>
      call("documents.list", {
        kind,
        limit: 1000,
        ...(search.length > 0 ? { search } : {}),
        ...(status !== "" ? { status } : {}),
        ...(partyId !== "" ? { partyId } : {}),
        ...(fromDate ? { fromDate } : {}),
        ...(toDate ? { toDate } : {}),
      }),
  });

  const rows = useMemo(() => data ?? [], [data]);
  const highlight = useSearchHighlight(rows, search, {
    rowKey: documentKey,
    fields: DOCUMENT_SEARCH_FIELDS,
    rankFields: DOCUMENT_RANK_FIELDS,
  });
  // The detail dialog shows the document as it is now, not as it was when it
  // was opened, so a payment recorded from it is reflected the moment the
  // list refreshes - and the Update payment button disappears on its own once
  // the balance is gone.
  const liveDetailDoc = useMemo(() => {
    if (detailDoc === null) return null;
    return rows.find((row) => row.id === detailDoc.id) ?? detailDoc;
  }, [detailDoc, rows]);
  const isFiltered =
    search.length > 0 || status !== "" || partyId !== "" || fromDate !== "" || toDate !== "";

  const { data: parties } = useQuery({
    queryKey: ["parties", isPurchase ? "supplier" : "customer"],
    queryFn: () =>
      call("parties.list", { kind: isPurchase ? "supplier" : "customer", limit: 1000 }),
  });

  // The party filter's options. "All suppliers"/"All customers" is the control's
  // placeholder rather than an option, because the empty string is what
  // "nothing chosen" means to a select.
  const partyFilterOptions = useMemo<SelectOption[]>(
    () => (parties ?? []).map((p) => ({ value: String(p.id), label: p.name })),
    [parties],
  );

  const applyPreset = (preset: DatePreset): void => {
    const today = todayIso();
    setDatePreset(preset);
    switch (preset) {
      case "today":
        setFromDate(today);
        setToDate(today);
        break;
      case "yesterday":
        setFromDate(addDaysIso(today, -1));
        setToDate(addDaysIso(today, -1));
        break;
      case "week": {
        const day = new Date().getDay();
        const diff = day === 0 ? 6 : day - 1;
        setFromDate(addDaysIso(today, -diff));
        setToDate(today);
        break;
      }
      case "month":
        setFromDate(startOfMonthIso(today));
        setToDate(today);
        break;
      case "lastMonth": {
        const first = startOfMonthIso(today);
        const lastMonthEnd = addDaysIso(first, -1);
        const lastMonthStart = startOfMonthIso(lastMonthEnd);
        setFromDate(lastMonthStart);
        setToDate(lastMonthEnd);
        break;
      }
      case "year":
        setFromDate(`${today.slice(0, 4)}-01-01`);
        setToDate(today);
        break;
      case "custom":
        break;
    }
  };

  const clearFilters = (): void => {
    setSearch("");
    setStatus("");
    setPartyId("");
    setFromDate("");
    setToDate("");
    setDatePreset("");
  };

  const exportCsv = (): void => {
    const header = ["Number", "Date", partyLabel, "Total", "Paid", "Outstanding", "Status"];
    const body = rows.map((row) => [
      row.number,
      row.issueDate,
      row.partyName ?? "",
      (row.grossFils / 100).toFixed(2),
      (row.paidFils / 100).toFixed(2),
      (row.outstandingFils / 100).toFixed(2),
      STATUS_LABELS[row.status],
    ]);
    const csv = [header, ...body]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${plural}-${todayIso()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${String(rows.length)} ${plural}`);
  };

  const actionsFor = (row: DocumentDto): RecordAction[] => {
    const items: RecordAction[] = [
      {
        id: "view",
        label: "View",
        icon: <Eye className="h-4 w-4" />,
        onSelect: () => {
          setDetailDoc(row);
        },
      },
      {
        id: "print",
        label: "Print",
        icon: <Printer className="h-4 w-4" />,
        onSelect: () => {
          // The document is shown first: printing is never a leap of faith.
          setPrinting({
            html: invoiceDocumentHtml(row, { settings }),
            title: `${isPurchase ? "Purchase invoice" : "Invoice"} ${row.number}`,
            description: row.partyName ?? formatDate(row.issueDate),
            filename: `${row.number}.pdf`,
          });
        },
      },
      {
        id: "pdf",
        label: "Save PDF",
        icon: <FileOutput className="h-4 w-4" />,
        onSelect: () => {
          void saveInvoicePdf(row, { settings }).then((outcome) => {
            if (!outcome.ok) toast.error(outcome.message);
          });
        },
      },
    ];

    if (canEdit && row.status !== "cancelled" && row.status !== "paid") {
      items.push({
        id: "edit",
        label: "Edit",
        icon: <Pencil className="h-4 w-4" />,
        onSelect: () => {
          setEditingDoc(row);
          if (isPurchase) {
            setPurchaseOpen(true);
          } else {
            setSaleOpen(true);
          }
        },
      });
    }

    // Money still owed is the only reason to offer to take money. A document
    // that is paid, cancelled or not yet issued has nothing outstanding.
    if (
      can("payments", "create") &&
      row.status !== "cancelled" &&
      row.status !== "draft" &&
      row.outstandingFils > 0
    ) {
      items.push({
        id: "payment",
        label: "Update payment",
        icon: <HandCoins className="h-4 w-4" />,
        onSelect: () => {
          setPaymentDoc(row);
        },
      });
    }

    // Only a draft can be removed. An issued document has stock moved and
    // money posted against it, so it is cancelled instead - which is the
    // record of the fact that it was issued and later withdrawn.
    if (canDelete && row.status === "draft") {
      items.push({
        id: "delete",
        label: "Delete",
        icon: <Trash2 className="h-4 w-4" />,
        destructive: true,
        onSelect: () => {
          setDeletingDoc(row);
        },
      });
    }

    return items;
  };

  const confirmDelete = (): void => {
    if (deletingDoc === null || deleteBusy) return;
    setDeleteBusy(true);

    void call("documents.delete", { id: deletingDoc.id })
      .then(() => {
        toast.success(`${deletingDoc.number} deleted`);
        void client.invalidateQueries({ queryKey: ["documents"] });
        void client.invalidateQueries({ queryKey: ["dashboard"] });
        setDeletingDoc(null);
        setDetailDoc(null);
      })
      .catch((error: unknown) => {
        toast.error(errorMessage(error));
      })
      .finally(() => {
        setDeleteBusy(false);
      });
  };

  const columns: readonly Column<DocumentDto>[] = [
    {
      id: "date",
      header: "Date",
      cell: (row) => (
        <span className="tabular text-[var(--text-2)]">{formatDate(row.issueDate)}</span>
      ),
      sortValue: (row) => row.issueDate,
    },
    {
      id: "number",
      header: isPurchase ? "Purchase No." : "Invoice No.",
      cell: (row) => (
        <span className="tabular font-medium text-[var(--text)]">
          <HighlightText text={row.number} term={search} />
        </span>
      ),
      sortValue: (row) => row.number,
    },
    {
      id: "party",
      header: partyLabel,
      cell: (row) => (
        <span className="text-[var(--text)]">
          {row.partyName === null ? "—" : <HighlightText text={row.partyName} term={search} />}
        </span>
      ),
      sortValue: (row) => row.partyName,
    },
    {
      id: "items",
      header: "Items",
      align: "end",
      cell: (row) => (
        <span className="tabular text-[var(--text-2)]">{String(row.lines.length)}</span>
      ),
      sortValue: (row) => row.lines.length,
    },
    {
      id: "total",
      header: "Total Amount",
      align: "end",
      cell: (row) => (
        <span className="tabular font-medium">{formatMoney(row.grossFils)}</span>
      ),
      sortValue: (row) => row.grossFils,
    },
    {
      id: "paid",
      header: "Paid",
      align: "end",
      cell: (row) => (row.paidFils > 0 ? formatMoney(row.paidFils) : "—"),
      sortValue: (row) => row.paidFils,
    },
    {
      id: "outstanding",
      header: "Outstanding",
      align: "end",
      cell: (row) =>
        row.outstandingFils > 0 ? (
          <span className="tabular font-medium text-[var(--warning)]">
            {formatMoney(row.outstandingFils)}
          </span>
        ) : (
          <span className="text-[var(--text-3)]">—</span>
        ),
      sortValue: (row) => row.outstandingFils,
    },
    {
      id: "status",
      header: "Status",
      cell: (row) => <StatusBadge status={row.status} label={STATUS_LABELS[row.status]} />,
      sortValue: (row) => row.status,
    },
    {
      id: "actions",
      header: "",
      align: "end",
      widthClass: "w-14",
      cell: (row) => <RecordActions items={actionsFor(row)} />,
    },
  ];

  const view = useTableView(rows, columns, 25, {
    focusKey: highlight.primaryKey,
    rowKey: documentKey,
  });

  const totalGross = rows.reduce((sum, row) => sum + row.grossFils, 0);
  const totalPaid = rows.reduce((sum, row) => sum + row.paidFils, 0);
  const totalOutstanding = rows.reduce((sum, row) => sum + row.outstandingFils, 0);

  return (
    <div>
      <PageHeader
        title={title}
        description={
          isPurchase
            ? "Everything bought in, and what is still owed."
            : "Everything sold, and what is still to be collected."
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* Date range first: it decides what the totals below refer to. */}
            <DropdownMenu
              trigger={
                <Button
                  variant="secondary"
                  iconLeft={<Calendar className="h-4 w-4" />}
                  iconRight={<ChevronDown className="h-4 w-4" />}
                >
                  {datePreset !== "" ? datePresetLabel(datePreset) : "Date range"}
                </Button>
              }
            >
              <DropdownItem
                checked={datePreset === "today"}
                onSelect={() => {
                  applyPreset("today");
                }}
              >
                Today
              </DropdownItem>
              <DropdownItem
                checked={datePreset === "yesterday"}
                onSelect={() => {
                  applyPreset("yesterday");
                }}
              >
                Yesterday
              </DropdownItem>
              <DropdownItem
                checked={datePreset === "week"}
                onSelect={() => {
                  applyPreset("week");
                }}
              >
                This week
              </DropdownItem>
              <DropdownItem
                checked={datePreset === "month"}
                onSelect={() => {
                  applyPreset("month");
                }}
              >
                This month
              </DropdownItem>
              <DropdownItem
                checked={datePreset === "lastMonth"}
                onSelect={() => {
                  applyPreset("lastMonth");
                }}
              >
                Last month
              </DropdownItem>
              <DropdownItem
                checked={datePreset === "year"}
                onSelect={() => {
                  applyPreset("year");
                }}
              >
                This year
              </DropdownItem>
              <DropdownItem
                checked={datePreset === "custom"}
                onSelect={() => {
                  setDatePreset("custom");
                }}
              >
                Custom…
              </DropdownItem>
              {datePreset === "custom" && (
                <div className="space-y-2 px-4 py-2">
                  <Input
                    type="date"
                    value={fromDate}
                    onChange={(event) => {
                      setFromDate(event.target.value);
                    }}
                    aria-label="From date"
                    className="h-9 text-xs"
                  />
                  <Input
                    type="date"
                    value={toDate}
                    onChange={(event) => {
                      setToDate(event.target.value);
                    }}
                    aria-label="To date"
                    className="h-9 text-xs"
                  />
                </div>
              )}
            </DropdownMenu>

            <Button variant="secondary" size="icon" iconOnlyLabel="Export CSV" onClick={exportCsv}>
              <Download className="h-4 w-4" />
            </Button>

            {canCreate && (
              <Button
                variant="primary"
                iconLeft={<FilePlus2 className="h-4 w-4" />}
                onClick={() => {
                  if (isPurchase) {
                    setPurchaseOpen(true);
                  } else {
                    setSaleOpen(true);
                  }
                }}
              >
                {newLabel}
              </Button>
            )}
          </div>
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
                    placeholder="Number or party name"
                    className="ps-9"
                  />
                </div>
              )}
            </Field>
          </div>

          <div className="w-[150px]">
            <Select
              value={status}
              options={DOCUMENT_STATUS_OPTIONS}
              placeholder="All Status"
              onChange={(next) => {
                setStatus(next as DocumentStatus | "");
              }}
              aria-label="Status filter"
            />
          </div>

          <div className="w-[200px]">
            <Select
              value={partyId === "" ? "" : String(partyId)}
              options={partyFilterOptions}
              placeholder={`All ${partyLabel}s`}
              onChange={(next) => {
                setPartyId(next === "" ? "" : Number(next));
              }}
              aria-label={`${partyLabel} filter`}
            />
          </div>

          <div className="ms-auto">
            <ColumnVisibility
              columns={columns
                .filter((column) => !column.defaultHidden && column.id !== "actions")
                .map((column) => ({
                  id: column.id,
                  header: typeof column.header === "string" ? column.header : column.id,
                }))}
              hiddenIds={view.hiddenColumnIds}
              onToggle={view.toggleColumn}
            />
          </div>
        </div>

        {/* Filter chips */}
        {isFiltered && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--divider)] bg-[var(--surface-2)]/60 px-4 py-2.5">
            {search.length > 0 && (
              <FilterChip label={`Search: ${search}`} onClear={() => setSearch("")} />
            )}
            {status !== "" && (
              <FilterChip
                label={`Status: ${STATUS_LABELS[status]}`}
                onClear={() => setStatus("")}
              />
            )}
            {partyId !== "" && (
              <FilterChip
                label={`${partyLabel}: ${(parties ?? []).find((p) => p.id === partyId)?.name ?? ""}`}
                onClear={() => setPartyId("")}
              />
            )}
            {(fromDate !== "" || toDate !== "") && (
              <FilterChip
                label={`Date: ${fromDate || "…"} → ${toDate || "…"}`}
                onClear={() => {
                  setFromDate("");
                  setToDate("");
                  setDatePreset("");
                }}
              />
            )}
            <button
              type="button"
              onClick={clearFilters}
              className="text-[12.5px] font-medium text-[var(--brand)] hover:underline"
            >
              Clear all
            </button>
          </div>
        )}

        {/* Summary strip */}
        {rows.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-[var(--divider)] px-4 py-2.5 text-[13px]">
            <SummaryStat label="Total" value={formatMoney(totalGross)} />
            <SummaryStat label="Paid" value={formatMoney(totalPaid)} />
            <SummaryStat label="Due" value={formatMoney(totalOutstanding)} />
            <SummaryStat
              label={rows.length === 1 ? singular : plural}
              value={String(rows.length)}
            />
          </div>
        )}

        {/* Table */}
        {isLoading ? (
          <div className="p-4">
            <TableSkeleton columns={8} rows={8} />
          </div>
        ) : (
          <>
            <DataTable
              frameless
              columns={columns}
              rows={view.rowsOnPage}
              rowKey={(row) => row.id}
              onRowClick={(row) => {
                setDetailDoc(row);
              }}
              sortId={view.sortId}
              sortDirection={view.sortDirection}
              onSortChange={view.setSort}
              hiddenColumnIds={view.hiddenColumnIds}
              highlightedRowKeys={highlight.keys}
              primaryRowKey={highlight.primaryKey}
              scrollToRowKey={highlight.primaryKey}
              caption={title}
              compact
              emptyState={
                <EmptyState
                  compact
                  icon={<FilePlus2 className="h-5 w-5" aria-hidden="true" />}
                  title={isFiltered ? "Nothing matched your search" : `No ${plural} yet`}
                  description={
                    isFiltered
                      ? "Try a different number, or clear the filters."
                      : `${newLabel} and it will show up here.`
                  }
                  actionLabel={canCreate ? newLabel : undefined}
                  onAction={
                    canCreate
                      ? () => {
                          if (isPurchase) {
                            setPurchaseOpen(true);
                          } else {
                            setSaleOpen(true);
                          }
                        }
                      : undefined
                  }
                />
              }
            />
            <Pagination
              total={view.totalRows}
              page={view.page}
              onPageChange={view.setPage}
              perPage={view.perPage}
              onPerPageChange={view.setPerPage}
              itemLabel={plural}
            />
          </>
        )}
      </Card>

      {/* Dialogs */}
      <SaleDialog
        open={saleOpen || (editingDoc !== null && !isPurchase)}
        onOpenChange={(next) => {
          if (!next) {
            setSaleOpen(false);
            setEditingDoc(null);
          }
        }}
        document={!isPurchase ? editingDoc : null}
      />
      <PurchaseDialog
        open={purchaseOpen || (editingDoc !== null && isPurchase)}
        onOpenChange={(next) => {
          if (!next) {
            setPurchaseOpen(false);
            setEditingDoc(null);
          }
        }}
        document={isPurchase ? editingDoc : null}
      />
      <DocumentDetailDialog
        document={liveDetailDoc}
        onClose={() => setDetailDoc(null)}
        onPrint={(doc) => {
          setDetailDoc(null);
          setPrinting({
            html: invoiceDocumentHtml(doc, { settings }),
            title: `${isPurchase ? "Purchase invoice" : "Invoice"} ${doc.number}`,
            description: doc.partyName ?? formatDate(doc.issueDate),
            filename: `${doc.number}.pdf`,
          });
        }}
        onEdit={(doc) => {
          setDetailDoc(null);
          setEditingDoc(doc);
          if (doc.kind === "purchaseInvoice") {
            setPurchaseOpen(true);
          } else {
            setSaleOpen(true);
          }
        }}
        onDeleted={() => {
          void client.invalidateQueries({ queryKey: ["documents"] });
          void client.invalidateQueries({ queryKey: ["dashboard"] });
        }}
        onPaid={() => {
          void client.invalidateQueries({ queryKey: ["documents"] });
          void client.invalidateQueries({ queryKey: ["dashboard"] });
          void client.invalidateQueries({ queryKey: ["finance"] });
          void client.invalidateQueries({ queryKey: ["parties"] });
          void client.invalidateQueries({ queryKey: ["payments"] });
        }}
      />

      {paymentDoc !== null && (
        <DocumentPaymentDialog
          document={paymentDoc}
          onClose={() => {
            setPaymentDoc(null);
          }}
          onSaved={() => {
            void client.invalidateQueries({ queryKey: ["documents"] });
            void client.invalidateQueries({ queryKey: ["dashboard"] });
            void client.invalidateQueries({ queryKey: ["finance"] });
            void client.invalidateQueries({ queryKey: ["parties"] });
            void client.invalidateQueries({ queryKey: ["payments"] });
          }}
        />
      )}

      <DeleteConfirmDialog
        open={deletingDoc !== null}
        subject={deletingDoc === null ? "document" : `draft ${deletingDoc.number}`}
        message={
          deletingDoc === null
            ? ""
            : `The draft ${deletingDoc.number} will be removed. This cannot be undone. ` +
              "Only a draft can be deleted - an issued invoice is cancelled instead."
        }
        busy={deleteBusy}
        onCancel={() => {
          setDeletingDoc(null);
        }}
        onConfirm={confirmDelete}
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

function datePresetLabel(preset: DatePreset): string {
  switch (preset) {
    case "today":
      return "Today";
    case "yesterday":
      return "Yesterday";
    case "week":
      return "This week";
    case "month":
      return "This month";
    case "lastMonth":
      return "Last month";
    case "year":
      return "This year";
    case "custom":
      return "Custom";
  }
}

function FilterChip({
  label,
  onClear,
}: {
  readonly label: string;
  readonly onClear: () => void;
}): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--brand-soft)] px-2.5 py-0.5 text-[12px] font-medium text-[var(--brand)]">
      {label}
      <button
        type="button"
        onClick={onClear}
        className="rounded-full transition-colors hover:text-[var(--brand-hover)]"
        aria-label={`Clear ${label} filter`}
      >
        ×
      </button>
    </span>
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
