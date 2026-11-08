/**
 * Journal entries.
 *
 * The raw record of every posting: what was booked, when, and why. A sale, a
 * purchase and a payment all arrive here as entries, so this is the one
 * screen where the whole ledger can be read as a single list.
 *
 * Two rules are visible in the interface rather than hidden in the engine:
 *
 *  - A **draft** can be edited and posted. A **posted** entry cannot be
 *    edited at all - it is corrected by posting a reversal beside it, so the
 *    correction is on the record rather than the old number quietly changing.
 *  - A manual entry has to balance before it can be posted. The editor shows
 *    the difference as it is typed, so the error is visible before the save
 *    rather than after it.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Eye, Plus, Printer, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type {
  JournalEntryDetailDto,
  JournalEntryRowDto,
  JournalSource,
  JournalStatus,
} from "../../../shared/finance";
import { call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { formatAmount, formatMoney, parseAmount } from "../../lib/format";
import { JOURNAL_SOURCE_LABELS } from "../../lib/finance";
import { journalEntryDocumentHtml } from "../../lib/print-records";
import {
  DocumentPrintDialog,
  type PrintableDocument,
} from "../../components/print/DocumentPrintDialog";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { ConfirmDialog, Dialog } from "../../components/ui/Dialog";
import { type Column, DataTable } from "../../components/ui/DataTable";
import { HighlightText } from "../../components/ui/HighlightText";
import { Badge, type BadgeTone } from "../../components/ui/Badge";
import { EmptyState, PageHeader, TableSkeleton } from "../../components/ui/Feedback";
import { Field, Input, MoneyInput, Select, Textarea } from "../../components/ui/Input";
import { useSearchHighlight } from "../../lib/search-highlight";
import { FinanceLayout } from "./FinanceLayout";

const SOURCE_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "sale", label: "Sale" },
  { value: "purchase", label: "Purchase" },
  { value: "payment", label: "Payment" },
  { value: "expense", label: "Expense" },
  { value: "manual", label: "Manual" },
  { value: "transfer", label: "Transfer" },
  { value: "opening", label: "Opening" },
  { value: "reversal", label: "Reversal" },
  { value: "adjustment", label: "Adjustment" },
];

const STATUS_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "draft", label: "Draft" },
  { value: "posted", label: "Posted" },
  { value: "reversed", label: "Reversed" },
];

const STATUS_TONES: Readonly<Record<string, BadgeTone>> = {
  draft: "warning",
  posted: "success",
  reversed: "neutral",
};

const journalKey = (row: JournalEntryRowDto): number => row.id;

/** The same three fields `finance.journal.list` searches. */
const JOURNAL_SEARCH_FIELDS = [
  (row: JournalEntryRowDto) => row.entryNo,
  (row: JournalEntryRowDto) => row.description,
  (row: JournalEntryRowDto) => row.reference,
];

const JOURNAL_RANK_FIELDS = [
  (row: JournalEntryRowDto) => row.entryNo,
  (row: JournalEntryRowDto) => row.description,
];

export function JournalEntriesPage(): React.JSX.Element {
  const { can, settings } = useApp();
  const client = useQueryClient();

  const [search, setSearch] = useState("");
  const [source, setSource] = useState("");
  const [status, setStatus] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const [editorOpen, setEditorOpen] = useState(false);
  const [viewing, setViewing] = useState<JournalEntryDetailDto | null>(null);
  const [reversing, setReversing] = useState<JournalEntryRowDto | null>(null);
  const [printing, setPrinting] = useState<PrintableDocument | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["finance.journal.list", { search, source, status, fromDate, toDate }],
    queryFn: () =>
      call("finance.journal.list", {
        ...(search.length > 0 ? { search } : {}),
        ...(source.length > 0 ? { source: source as JournalSource } : {}),
        ...(status.length > 0 ? { status: status as JournalStatus } : {}),
        ...(fromDate.length > 0 ? { fromDate } : {}),
        ...(toDate.length > 0 ? { toDate } : {}),
        limit: 500,
      }),
  });

  const rows = useMemo(() => data ?? [], [data]);

  const highlight = useSearchHighlight(rows, search, {
    rowKey: journalKey,
    fields: JOURNAL_SEARCH_FIELDS,
    rankFields: JOURNAL_RANK_FIELDS,
  });

  const totals = useMemo(
    () => ({
      count: rows.length,
      debits: rows.reduce((sum, row) => sum + row.totalDebitFils, 0),
      credits: rows.reduce((sum, row) => sum + row.totalCreditFils, 0),
    }),
    [rows],
  );

  const columns: readonly Column<JournalEntryRowDto>[] = [
    {
      id: "entryNo",
      header: "Entry",
      widthClass: "w-44",
      cell: (row) => (
        <span className="tabular font-medium">
          <HighlightText text={row.entryNo} term={search} />
        </span>
      ),
      sortValue: (row) => row.entryNo,
    },
    {
      id: "date",
      header: "Date",
      widthClass: "w-28",
      cell: (row) => <span className="tabular text-[var(--text-2)]">{row.entryDate}</span>,
      sortValue: (row) => row.entryDate,
    },
    {
      id: "description",
      header: "Description",
      cell: (row) => (
        <div className="min-w-0">
          <div className="truncate text-[var(--text)]">
            <HighlightText text={row.description} term={search} />
          </div>
          {row.reference !== null && (
            <div className="truncate text-[11.5px] text-[var(--text-3)]">
              <HighlightText text={row.reference} term={search} />
            </div>
          )}
        </div>
      ),
      sortValue: (row) => row.description,
    },
    {
      id: "source",
      header: "Source",
      cell: (row) => (
        <span className="text-[var(--text-2)]">
          {JOURNAL_SOURCE_LABELS[row.source] ?? row.source}
        </span>
      ),
      sortValue: (row) => row.source,
    },
    {
      id: "status",
      header: "Status",
      cell: (row) => (
        <Badge tone={STATUS_TONES[row.status] ?? "neutral"}>
          {row.status === "posted" ? "Posted" : row.status === "draft" ? "Draft" : "Reversed"}
        </Badge>
      ),
      sortValue: (row) => row.status,
    },
    {
      id: "debit",
      header: "Debit",
      align: "end",
      cell: (row) => <span className="tabular">{formatAmount(row.totalDebitFils)}</span>,
      sortValue: (row) => row.totalDebitFils,
    },
    {
      id: "credit",
      header: "Credit",
      align: "end",
      cell: (row) => <span className="tabular">{formatAmount(row.totalCreditFils)}</span>,
      sortValue: (row) => row.totalCreditFils,
    },
    {
      id: "actions",
      header: "",
      align: "end",
      widthClass: "w-28",
      cell: (row) => (
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            aria-label="View entry"
            onClick={(event) => {
              event.stopPropagation();
              void call("finance.journal.get", { id: row.id }).then(setViewing);
            }}
            className="rounded-lg p-1.5 text-[var(--text-3)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
          >
            <Eye className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="Print entry"
            onClick={(event) => {
              event.stopPropagation();
              void call("finance.journal.get", { id: row.id })
                .then((entry) => {
                  // The document is shown first: printing is never a leap of faith.
                  setPrinting({
                    html: journalEntryDocumentHtml(entry, { settings }),
                    title: `Journal Entry ${entry.entryNo}`,
                    description: entry.description,
                    filename: `journal-${entry.entryNo}.pdf`,
                  });
                })
                .catch((error: unknown) => {
                  toast.error(errorMessage(error));
                });
            }}
            className="rounded-lg p-1.5 text-[var(--text-3)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
          >
            <Printer className="h-4 w-4" />
          </button>
          {row.status === "posted" && can("finance", "cancel") && (
            <button
              type="button"
              aria-label="Reverse entry"
              onClick={(event) => {
                event.stopPropagation();
                setReversing(row);
              }}
              className="rounded-lg p-1.5 text-[var(--text-3)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--warning)]"
            >
              <RotateCcw className="h-4 w-4" />
            </button>
          )}
        </div>
      ),
    },
  ];

  const reverse = useMutation({
    mutationFn: (input: { id: number; reason: string }) => call("finance.journal.reverse", input),
    onSuccess: () => {
      toast.success("Entry reversed");
      setReversing(null);
      void client.invalidateQueries({ queryKey: ["finance.journal.list"] });
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(error));
    },
  });

  return (
    <FinanceLayout>
      <PageHeader
        title="Journal entries"
        description="Every posting the books have made, in one list."
        actions={
          <div className="flex items-center gap-2">
            {can("finance", "export") && (
              <Button
                variant="secondary"
                size="sm"
                iconLeft={<Download className="h-4 w-4" />}
                onClick={() => {
                  void call("finance.export", { dataset: "journalRegister", fromDate, toDate })
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
            {can("finance", "create") && (
              <Button
                variant="primary"
                size="sm"
                iconLeft={<Plus className="h-4 w-4" />}
                onClick={() => {
                  setEditorOpen(true);
                }}
              >
                New entry
              </Button>
            )}
          </div>
        }
      />

      <Card flush>
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--divider)] p-4">
          <div className="w-[260px]">
            <Field label="Search" srLabelOnly>
              {(id) => (
                <Input
                  id={id}
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                  }}
                  placeholder="Number, description or reference"
                />
              )}
            </Field>
          </div>
          <div className="w-[160px]">
            <Select
              value={source}
              options={SOURCE_OPTIONS}
              placeholder="All sources"
              onChange={setSource}
              aria-label="Filter by source"
            />
          </div>
          <div className="w-[150px]">
            <Select
              value={status}
              options={STATUS_OPTIONS}
              placeholder="All statuses"
              onChange={setStatus}
              aria-label="Filter by status"
            />
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
              {totals.count} entries · debits {formatMoney(totals.debits)} · credits{" "}
              {formatMoney(totals.credits)}
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
            rows={rows}
            rowKey={journalKey}
            onRowClick={(row) => {
              void call("finance.journal.get", { id: row.id }).then(setViewing);
            }}
            highlightedRowKeys={highlight.keys}
            primaryRowKey={highlight.primaryKey}
            scrollToRowKey={highlight.primaryKey}
            caption="Journal entries"
            compact
            emptyState={
              <EmptyState
                compact
                icon={<Plus className="h-5 w-5" />}
                title="No entries match"
                description="Clear the filters, or record a manual entry."
              />
            }
          />
        )}
      </Card>

      <JournalEditor
        open={editorOpen}
        onClose={() => {
          setEditorOpen(false);
        }}
        onSaved={() => {
          void client.invalidateQueries({ queryKey: ["finance.journal.list"] });
        }}
      />

      <EntryDetailDialog
        entry={viewing}
        onClose={() => {
          setViewing(null);
        }}
        onPrint={(entry) => {
          setViewing(null);
          setPrinting({
            html: journalEntryDocumentHtml(entry, { settings }),
            title: `Journal Entry ${entry.entryNo}`,
            description: entry.description,
            filename: `journal-${entry.entryNo}.pdf`,
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

      <ConfirmDialog
        open={reversing !== null}
        onOpenChange={(next) => {
          if (!next) setReversing(null);
        }}
        title="Reverse entry"
        message={
          <p>
            {reversing === null
              ? ""
              : `Post a reversing entry for ${reversing.entryNo}? The original entry stays on the record, marked as reversed, so the correction is visible rather than silent.`}
          </p>
        }
        confirmLabel="Reverse"
        cancelLabel="Cancel"
        destructive={false}
        onConfirm={() => {
          if (reversing === null) return;
          reverse.mutate({ id: reversing.id, reason: "Reversed from the journal screen" });
        }}
      />
    </FinanceLayout>
  );
}

/* -------------------------------------------------------------------------- */

function EntryDetailDialog({
  entry,
  onClose,
  onPrint,
}: {
  readonly entry: JournalEntryDetailDto | null;
  readonly onClose: () => void;
  readonly onPrint: (entry: JournalEntryDetailDto) => void;
}): React.JSX.Element {

  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={entry === null ? "Entry" : `Entry ${entry.entryNo}`}
      description={entry === null ? undefined : `${entry.entryDate} · ${entry.description}`}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          {entry !== null && (
            <Button
              variant="primary"
              iconLeft={<Printer className="h-4 w-4" />}
              onClick={() => {
                onPrint(entry);
              }}
            >
              Print
            </Button>
          )}
        </>
      }
    >
      {entry === null ? null : (
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-[var(--border)] text-[11.5px] uppercase tracking-wide text-[var(--text-3)]">
              <th scope="col" className="py-2 text-start">
                Account
              </th>
              <th scope="col" className="py-2 text-start">
                Description
              </th>
              <th scope="col" className="py-2 text-end">
                Debit
              </th>
              <th scope="col" className="py-2 text-end">
                Credit
              </th>
            </tr>
          </thead>
          <tbody>
            {entry.lines.map((line) => (
              <tr key={line.lineNo} className="border-b border-[var(--divider)] last:border-0">
                <td className="py-2 pe-3">
                  <span className="tabular text-[var(--text-2)]">{line.accountCode}</span>{" "}
                  <span className="text-[var(--text)]">{line.accountName}</span>
                </td>
                <td className="py-2 pe-3 text-[var(--text-2)]">
                  {line.partyName ?? line.description ?? "—"}
                </td>
                <td className="tabular py-2 text-end">
                  {line.debitFils === 0 ? "—" : formatAmount(line.debitFils)}
                </td>
                <td className="tabular py-2 text-end">
                  {line.creditFils === 0 ? "—" : formatAmount(line.creditFils)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-[var(--border)] text-[13px] font-medium">
              <td className="py-2" colSpan={2}>
                Total
              </td>
              <td className="tabular py-2 text-end">
                {formatAmount(entry.totalDebitFils)}
              </td>
              <td className="tabular py-2 text-end">
                {formatAmount(entry.totalCreditFils)}
              </td>
            </tr>
          </tfoot>
        </table>
      )}
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */

interface DraftLine {
  readonly accountCode: string;
  readonly debit: string;
  readonly credit: string;
  readonly description: string;
}

function JournalEditor({
  open,
  onClose,
  onSaved,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): React.JSX.Element {

  const [entryDate, setEntryDate] = useState("");
  const [description, setDescription] = useState("");
  const [reference, setReference] = useState("");
  const [lines, setLines] = useState<readonly DraftLine[]>([
    { accountCode: "", debit: "", credit: "", description: "" },
    { accountCode: "", debit: "", credit: "", description: "" },
  ]);
  const [busy, setBusy] = useState(false);

  const { data: accounts } = useQuery({
    queryKey: ["finance.chart"],
    queryFn: () => call("finance.chart", {}),
    enabled: open,
  });

  useEffect(() => {
    if (!open) return;
    setEntryDate(new Date().toISOString().slice(0, 10));
    setDescription("");
    setReference("");
    setLines([
      { accountCode: "", debit: "", credit: "", description: "" },
      { accountCode: "", debit: "", credit: "", description: "" },
    ]);
  }, [open]);

  const accountOptions = useMemo(
    () =>
      (accounts ?? []).map((account) => ({
        value: account.code,
        label: `${account.code} — ${account.name}`,
      })),
    [accounts],
  );

  const totals = useMemo(() => {
    let debits = 0;
    let credits = 0;
    for (const line of lines) {
      debits += parseAmount(line.debit) ?? 0;
      credits += parseAmount(line.credit) ?? 0;
    }
    return { debits, credits, difference: debits - credits };
  }, [lines]);

  const updateLine = (index: number, patch: Partial<DraftLine>): void => {
    setLines((current) =>
      current.map((line, position) => (position === index ? { ...line, ...patch } : line)),
    );
  };

  const submit = (postNow: boolean): void => {
    if (lines.length < 2) {
      toast.error("A journal entry needs at least two lines.");
      return;
    }
    const payload = lines.map((line) => ({
      accountCode: line.accountCode,
      debitFils: parseAmount(line.debit) ?? 0,
      creditFils: parseAmount(line.credit) ?? 0,
      description: line.description.trim().length > 0 ? line.description.trim() : null,
    }));

    setBusy(true);
    void call("finance.journal.save", {
      entryDate,
      description: description.trim(),
      reference: reference.trim().length > 0 ? reference.trim() : null,
      lines: payload,
      postNow,
    })
      .then(() => {
        toast.success(postNow ? "Entry posted" : "Draft saved");
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
      title="New journal entry"
      description="A manual entry must balance before it can be posted."
      size="lg"
      busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            loading={busy}
            onClick={() => {
              submit(false);
            }}
          >
            Save as draft
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={totals.difference !== 0}
            onClick={() => {
              submit(true);
            }}
          >
            Post
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Date" required>
          {(id) => (
            <Input
              id={id}
              type="date"
              value={entryDate}
              onChange={(event) => {
                setEntryDate(event.target.value);
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
              placeholder="Supporting document number"
            />
          )}
        </Field>
        <Field label="Explanation" required className="sm:col-span-3">
          {(id) => (
            <Textarea
              id={id}
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
              placeholder="Why this entry is being made."
            />
          )}
        </Field>
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[13px] font-semibold text-[var(--text)]">Lines</p>
          <Button
            variant="ghost"
            size="sm"
            iconLeft={<Plus className="h-4 w-4" />}
            onClick={() => {
              setLines((current) => [
                ...current,
                { accountCode: "", debit: "", credit: "", description: "" },
              ]);
            }}
          >
            Add line
          </Button>
        </div>

        <div className="space-y-2">
          {lines.map((line, index) => (
            <div
              key={index}
              className="grid items-end gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_32px]"
            >
              <Field label={index === 0 ? "Account" : ""} srLabelOnly={index !== 0}>
                {(id) => (
                  <Select
                    id={id}
                    value={line.accountCode}
                    options={accountOptions}
                    placeholder="Choose an account"
                    onChange={(value) => {
                      updateLine(index, { accountCode: value });
                    }}
                  />
                )}
              </Field>
              <Field label={index === 0 ? "Debit" : ""} srLabelOnly={index !== 0}>
                {(id) => (
                  <MoneyInput
                    id={id}
                    value={line.debit}
                    onChange={(event) => {
                      updateLine(index, { debit: event.target.value, credit: "" });
                    }}
                  />
                )}
              </Field>
              <Field label={index === 0 ? "Credit" : ""} srLabelOnly={index !== 0}>
                {(id) => (
                  <MoneyInput
                    id={id}
                    value={line.credit}
                    onChange={(event) => {
                      updateLine(index, { credit: event.target.value, debit: "" });
                    }}
                  />
                )}
              </Field>
              <Button
                variant="ghost"
                size="icon"
                iconOnlyLabel="Remove line"
                disabled={lines.length <= 2}
                onClick={() => {
                  setLines((current) => current.filter((_unused, position) => position !== index));
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-end gap-4 text-[13px]">
          <span className="text-[var(--text-2)]">
            Debits{" "}
            <span className="tabular font-medium text-[var(--text)]">
              {formatMoney(totals.debits)}
            </span>
          </span>
          <span className="text-[var(--text-2)]">
            Credits{" "}
            <span className="tabular font-medium text-[var(--text)]">
              {formatMoney(totals.credits)}
            </span>
          </span>
          {totals.difference === 0 ? (
            <span className="font-medium text-[var(--success)]">Balanced</span>
          ) : (
            <span className="font-medium text-[var(--danger)]">
              Out by {formatMoney(Math.abs(totals.difference))}
            </span>
          )}
        </div>
      </div>
    </Dialog>
  );
}
