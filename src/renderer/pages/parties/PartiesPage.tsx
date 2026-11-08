/**
 * Customers and suppliers.
 *
 * One component for both, because they are the same record seen from two sides:
 * a name, how to reach them, what they owe or are owed, and whether they are
 * still trading. Everything that differs is derived from `kind` here rather than
 * duplicated into a second screen.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, HandCoins, Pencil, Plus, Printer, Receipt, Search, Wallet } from "lucide-react";
import { toast } from "sonner";
import type { PartyDto, PaymentDto } from "../../../shared/types";
import { call, errorField, errorMessage } from "../../lib/api";
import { invalidateLookups } from "../../lib/lookups";
import { useApp } from "../../lib/app-context";
import { formatMoney, parseAmount } from "../../lib/format";
import { todayIso, formatDate } from "../../lib/utils";
import { partyDocumentHtml } from "../../lib/print-records";
import { Avatar } from "../../components/ui/Avatar";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, FormSection } from "../../components/ui/Card";
import { Dialog } from "../../components/ui/Dialog";
import { DeleteConfirmDialog } from "../../components/ui/DeleteConfirmDialog";
import { DetailList, DetailRow } from "../../components/ui/DetailList";
import {
  DocumentPrintDialog,
  type PrintableDocument,
} from "../../components/print/DocumentPrintDialog";
import { type Column, DataTable } from "../../components/ui/DataTable";
import { Pagination, useTableView } from "../../components/ui/Dropdown";
import { HighlightText } from "../../components/ui/HighlightText";
import {
  RecordActions,
  standardRecordActions,
  type RecordAction,
} from "../../components/ui/RecordActions";
import { EmptyState, PageHeader, TableSkeleton } from "../../components/ui/Feedback";
import {
  Field,
  Input,
  MoneyInput,
  Select,
  Switch,
  type SelectOption,
} from "../../components/ui/Input";
import { useSearchHighlight } from "../../lib/search-highlight";

const METHODS = ["cash", "bank", "card"] as const;

type Method = (typeof METHODS)[number];

const partyKey = (row: PartyDto): number => row.id;

/** The same fields `parties.list` searches. */
const PARTY_SEARCH_FIELDS = [
  (row: PartyDto) => row.name,
  (row: PartyDto) => row.code,
  (row: PartyDto) => row.phone,
  (row: PartyDto) => row.trn,
];

const PARTY_RANK_FIELDS = [
  (row: PartyDto) => row.name,
  (row: PartyDto) => row.code,
  (row: PartyDto) => row.phone,
];

const METHOD_LABELS: Record<Method, string> = {
  cash: "Cash",
  bank: "Bank",
  card: "Card",
};

const paymentMethodOptions: SelectOption[] = METHODS.map((value) => ({
  value,
  label: METHOD_LABELS[value],
}));

export function PartiesPage({
  kind,
}: {
  readonly kind: "customer" | "supplier";
}): React.JSX.Element {
  const { can, settings } = useApp();
  const client = useQueryClient();

  const isCustomer = kind === "customer";

  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<PartyDto | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [viewing, setViewing] = useState<PartyDto | null>(null);
  const [deleting, setDeleting] = useState<PartyDto | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [printing, setPrinting] = useState<PrintableDocument | null>(null);
  const [paymentFor, setPaymentFor] = useState<PartyDto | null>(null);
  const [paymentsFor, setPaymentsFor] = useState<PartyDto | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["parties", kind, search],
    queryFn: () =>
      call("parties.list", {
        kind,
        ...(search.length > 0 ? { search } : {}),
        limit: 1000,
      }),
  });

  const rows = useMemo(() => data ?? [], [data]);

  const highlight = useSearchHighlight(rows, search, {
    rowKey: partyKey,
    fields: PARTY_SEARCH_FIELDS,
    rankFields: PARTY_RANK_FIELDS,
  });

  const totals = useMemo(
    () => ({
      owed: rows.reduce((sum, row) => sum + Math.max(0, row.balanceFils), 0),
      credit: rows.reduce((sum, row) => sum + Math.min(0, row.balanceFils), 0),
    }),
    [rows],
  );

  const exportCsv = (): void => {
    const header = ["Name", "Phone", "Email", "TRN", "Balance", "Status"];
    const body = rows.map((row) => [
      row.name,
      row.phone ?? "",
      row.email ?? "",
      row.trn ?? "",
      (row.balanceFils / 100).toFixed(2),
      row.isActive ? "Active" : "Inactive",
    ]);
    const csv = [header, ...body]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${isCustomer ? "customers" : "suppliers"}-${todayIso()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${String(rows.length)} ${isCustomer ? "customers" : "suppliers"}`);
  };

  const columns: readonly Column<PartyDto>[] = [
    {
      id: "name",
      header: "Name",
      cell: (row) => (
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar name={row.name} size="sm" square />
          <div className="min-w-0">
            <p className="truncate font-medium text-[var(--text)]">
              <HighlightText text={row.name} term={search} />
            </p>
            <p className="tabular truncate text-xs text-[var(--text-3)]">
              <HighlightText text={row.code} term={search} />
            </p>
          </div>
        </div>
      ),
      sortValue: (row) => row.name,
    },
    {
      id: "contact",
      header: "Contact",
      cell: (row) => (
        <div className="min-w-0">
          <p className="tabular truncate text-[var(--text)]">
            {row.phone === null ? "—" : <HighlightText text={row.phone} term={search} />}
          </p>
          <p className="truncate text-xs text-[var(--text-3)]">{row.email ?? "—"}</p>
        </div>
      ),
      sortValue: (row) => row.phone,
    },
    {
      id: "trn",
      header: "TRN",
      cell: (row) => <span className="tabular text-[var(--text-2)]">{row.trn ?? "—"}</span>,
      sortValue: (row) => row.trn,
    },
    {
      id: "balance",
      header: isCustomer ? "Balance (they owe)" : "Balance (we owe)",
      align: "end",
      cell: (row) => (
        <span
          className={
            row.balanceFils === 0
              ? "text-[var(--text-3)]"
              : row.balanceFils > 0
                ? "font-medium text-[var(--danger)]"
                : "font-medium text-[var(--success)]"
          }
        >
          {formatMoney(row.balanceFils)}
        </span>
      ),
      sortValue: (row) => row.balanceFils,
    },
    {
      id: "status",
      header: "Status",
      cell: (row) => (
        <Badge tone={row.isActive ? "success" : "neutral"}>
          {row.isActive ? "Active" : "Inactive"}
        </Badge>
      ),
      sortValue: (row) => (row.isActive ? 1 : 0),
    },
    {
      id: "actions",
      header: "",
      align: "end",
      widthClass: "w-14",
      cell: (row) => <RecordActions items={actionsFor(row)} />,
    },
  ];

  function actionsFor(row: PartyDto): RecordAction[] {
    const items = standardRecordActions({
      canView: true,
      onView: () => {
        setViewing(row);
      },
      canEdit: can("parties", "edit"),
      onEdit: () => {
        setEditing(row);
        setEditorOpen(true);
      },
      canPrint: true,
      onPrint: () => {
        // The document is shown first: printing is never a leap of faith.
        setPrinting({
          html: partyDocumentHtml(row, { settings }),
          title: `${isCustomer ? "Customer" : "Supplier"} ${row.name}`,
          description: row.code,
          filename: `${row.code}.pdf`,
        });
      },
      canDelete: can("parties", "delete"),
      onDelete: () => {
        setDeleting(row);
      },
    });

    if (can("payments", "create")) {
      items.push({
        id: "payment",
        label: isCustomer ? "Receive payment" : "Pay supplier",
        icon: isCustomer ? <HandCoins className="h-4 w-4" /> : <Wallet className="h-4 w-4" />,
        onSelect: () => {
          setPaymentFor(row);
        },
      });
    }

    if (can("payments", "view")) {
      items.push({
        id: "payments",
        label: "Payments",
        icon: <Receipt className="h-4 w-4" />,
        onSelect: () => {
          setPaymentsFor(row);
        },
      });
    }

    return items;
  }

  const confirmDelete = (): void => {
    if (deleting === null || deleteBusy) return;
    setDeleteBusy(true);

    void call("parties.delete", { id: deleting.id })
      .then(() => {
        toast.success(`"${deleting.name}" deleted`);
        void client.invalidateQueries({ queryKey: ["parties"] });
        void client.invalidateQueries({ queryKey: ["dashboard"] });
        invalidateLookups(isCustomer ? "customer" : "supplier");
        setDeleting(null);
        setViewing(null);
      })
      .catch((error: unknown) => {
        toast.error(errorMessage(error));
      })
      .finally(() => {
        setDeleteBusy(false);
      });
  };

  const view = useTableView(rows, columns, 25, {
    focusKey: highlight.primaryKey,
    rowKey: partyKey,
  });

  const openEditor = (): void => {
    setEditing(null);
    setEditorOpen(true);
  };

  // Reached from the dashboard's quick actions, which dispatch the same kind of
  // event the shell already uses for sales and purchases.
  useEffect(() => {
    const eventName = isCustomer ? "eyerstock:new-customer" : "eyerstock:new-supplier";
    const onNew = (): void => {
      if (!can("parties", "create")) return;
      setEditing(null);
      setEditorOpen(true);
    };
    window.addEventListener(eventName, onNew);
    return () => {
      window.removeEventListener(eventName, onNew);
    };
  }, [can, isCustomer]);

  // "Receive payment" with no account chosen opens the list of accounts to
  // choose from, rather than a dialog for an account that does not exist yet.
  useEffect(() => {
    if (!isCustomer) return;
    const onPayment = (): void => {
      if (!can("payments", "create")) return;
      const first = rows[0];
      if (first !== undefined) setPaymentFor(first);
    };
    window.addEventListener("eyerstock:new-payment", onPayment);
    return () => {
      window.removeEventListener("eyerstock:new-payment", onPayment);
    };
  }, [can, isCustomer, rows]);

  return (
    <div>
      <PageHeader
        title={isCustomer ? "Customers" : "Suppliers"}
        description={
          isCustomer
            ? "Who owes the shop, and who has paid in advance."
            : "Who the shop owes, and who has been paid in advance."
        }
        actions={
          can("parties", "create") ? (
            <Button variant="primary" iconLeft={<Plus className="h-4 w-4" />} onClick={openEditor}>
              {isCustomer ? "New customer" : "New supplier"}
            </Button>
          ) : undefined
        }
      />

      <Card flush>
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
                    placeholder="Name, phone or code"
                    className="ps-9"
                  />
                </div>
              )}
            </Field>
          </div>

          {rows.length > 0 && (
            <div className="ms-auto flex items-center gap-4 text-[13px] text-[var(--text-2)]">
              <SummaryStat
                label={isCustomer ? "Owed to us" : "We owe"}
                value={formatMoney(totals.owed)}
              />
              <SummaryStat label="In credit" value={formatMoney(totals.credit)} />
              <SummaryStat
                label={isCustomer ? "Customers" : "Suppliers"}
                value={String(rows.length)}
              />
            </div>
          )}

          <Button
            variant="secondary"
            size="icon"
            iconOnlyLabel="Export CSV"
            className={rows.length > 0 ? "" : "ms-auto"}
            onClick={exportCsv}
          >
            <Download className="h-4 w-4" />
          </Button>
        </div>

        {isLoading ? (
          <div className="p-4">
            <TableSkeleton columns={5} rows={8} />
          </div>
        ) : (
          <>
            <DataTable
              frameless
              columns={columns}
              rows={view.rowsOnPage}
              rowKey={(row) => row.id}
              onRowClick={(row) => {
                setViewing(row);
              }}
              sortId={view.sortId}
              sortDirection={view.sortDirection}
              onSortChange={view.setSort}
              hiddenColumnIds={view.hiddenColumnIds}
              highlightedRowKeys={highlight.keys}
              primaryRowKey={highlight.primaryKey}
              scrollToRowKey={highlight.primaryKey}
              caption={isCustomer ? "Customers" : "Suppliers"}
              compact
              emptyState={
                <EmptyState
                  compact
                  title={isCustomer ? "No customers yet" : "No suppliers yet"}
                  description={
                    isCustomer
                      ? "Add the shops and people you sell to so invoices can carry their name."
                      : "Add who you buy from so purchases can carry their name."
                  }
                  actionLabel={
                    can("parties", "create")
                      ? isCustomer
                        ? "New customer"
                        : "New supplier"
                      : undefined
                  }
                  onAction={can("parties", "create") ? openEditor : undefined}
                />
              }
            />
            <Pagination
              total={view.totalRows}
              page={view.page}
              onPageChange={view.setPage}
              perPage={view.perPage}
              onPerPageChange={view.setPerPage}
              itemLabel={isCustomer ? "customers" : "suppliers"}
            />
          </>
        )}
      </Card>

      <PartyDetailDialog
        party={viewing}
        isCustomer={isCustomer}
        canEdit={can("parties", "edit")}
        canDelete={can("parties", "delete")}
        onClose={() => {
          setViewing(null);
        }}
        onEdit={(party) => {
          setViewing(null);
          setEditing(party);
          setEditorOpen(true);
        }}
        onDelete={(party) => {
          setDeleting(party);
        }}
        onPrint={(party) => {
          setPrinting({
            html: partyDocumentHtml(party, { settings }),
            title: `${isCustomer ? "Customer" : "Supplier"} ${party.name}`,
            description: party.code,
            filename: `${party.code}.pdf`,
          });
        }}
        onPayments={(party) => {
          setViewing(null);
          setPaymentsFor(party);
        }}
      />

      <DeleteConfirmDialog
        open={deleting !== null}
        subject={deleting === null ? "" : `"${deleting.name}"`}
        message={
          deleting === null
            ? ""
            : `"${deleting.name}" will be removed from the list. This cannot be undone. ` +
              "A customer or supplier with invoices or payments against it cannot be deleted - mark them inactive instead."
        }
        busy={deleteBusy}
        onCancel={() => {
          setDeleting(null);
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

      <PartyEditor
        open={editorOpen}
        kind={kind}
        party={editing}
        onClose={() => {
          setEditorOpen(false);
          setEditing(null);
        }}
      />

      <PaymentDialog
        open={paymentFor !== null}
        kind={kind}
        party={paymentFor}
        onClose={() => {
          setPaymentFor(null);
        }}
      />

      <PartyPaymentsDialog
        party={paymentsFor}
        onClose={() => {
          setPaymentsFor(null);
        }}
      />
    </div>
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

function PartyDetailDialog({
  party,
  isCustomer,
  canEdit,
  canDelete,
  onClose,
  onEdit,
  onDelete,
  onPrint,
  onPayments,
}: {
  readonly party: PartyDto | null;
  readonly isCustomer: boolean;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
  readonly onClose: () => void;
  readonly onEdit: (party: PartyDto) => void;
  readonly onDelete: (party: PartyDto) => void;
  readonly onPrint: (party: PartyDto) => void;
  readonly onPayments: (party: PartyDto) => void;
}): React.JSX.Element {

  return (
    <Dialog
      open={party !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="md"
      title={party?.name ?? ""}
      description={party === null ? undefined : party.code}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          {canDelete && party !== null && (
            <Button
              variant="danger"
              onClick={() => {
                onDelete(party);
              }}
            >
              Delete
            </Button>
          )}
          {party !== null && (
            <Button
              variant="secondary"
              iconLeft={<Receipt className="h-4 w-4" />}
              onClick={() => {
                onPayments(party);
              }}
            >
              Payments
            </Button>
          )}
          {party !== null && (
            <Button
              variant="secondary"
              iconLeft={<Printer className="h-4 w-4" />}
              onClick={() => {
                onPrint(party);
              }}
            >
              Print
            </Button>
          )}
          {canEdit && party !== null && (
            <Button
              variant="primary"
              iconLeft={<Pencil className="h-4 w-4" />}
              onClick={() => {
                onEdit(party);
              }}
            >
              Edit
            </Button>
          )}
        </>
      }
    >
      {party === null ? null : (
        <DetailList>
          <DetailRow label="Code" value={party.code} />
          <DetailRow
            label="Type"
            value={party.kind === "both" ? "Customer and supplier" : party.kind}
          />
          <DetailRow label="Phone" value={party.phone ?? "—"} />
          <DetailRow label="Email" value={party.email ?? "—"} />
          <DetailRow label="TRN" value={party.trn ?? "—"} />
          <DetailRow label="Address" value={party.addressLine ?? "—"} />
          <DetailRow label="Status" value={party.isActive ? "Active" : "Inactive"} />
          <DetailRow
            label={isCustomer ? "Balance they owe" : "Balance we owe"}
            value={formatMoney(party.balanceFils)}
          />
        </DetailList>
      )}
    </Dialog>
  );
}

function PartyEditor({
  open,
  kind,
  party,
  onClose,
}: {
  readonly open: boolean;
  readonly kind: "customer" | "supplier";
  readonly party: PartyDto | null;
  readonly onClose: () => void;
}): React.JSX.Element {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [trn, setTrn] = useState("");
  const [addressLine, setAddressLine] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorAt, setErrorAt] = useState<string | undefined>(undefined);
  const [seeded, setSeeded] = useState<number | null>(null);

  // Seeded in an effect, not during render: a render-phase setState makes
  // React discard and repeat the whole render pass.
  useEffect(() => {
    if (!open) return;
    const seedKey = party?.id ?? null;
    if (seeded === seedKey) return;
    setSeeded(seedKey);
    setName(party?.name ?? "");
    setPhone(party?.phone ?? "");
    setEmail(party?.email ?? "");
    setTrn(party?.trn ?? "");
    setAddressLine(party?.addressLine ?? "");
    setIsActive(party?.isActive ?? true);
    setError(null);
    setErrorAt(undefined);
  }, [open, party, seeded]);

  const submit = (): void => {
    if (busy) return;
    setError(null);
    setErrorAt(undefined);
    setBusy(true);

    void call("parties.save", {
      ...(party === null ? {} : { id: party.id }),
      name: name.trim(),
      kind,
      phone: phone.trim().length > 0 ? phone.trim() : null,
      email: email.trim().length > 0 ? email.trim() : null,
      trn: trn.trim().length > 0 ? trn.trim() : null,
      addressLine: addressLine.trim().length > 0 ? addressLine.trim() : null,
      isActive,
    })
      .then(() => {
        toast.success(
          party === null ? `${kind === "customer" ? "Customer" : "Supplier"} added` : "Saved",
        );
        invalidateLookups(kind === "customer" ? "customer" : "supplier");
        void client.invalidateQueries({ queryKey: ["parties"] });
        void client.invalidateQueries({ queryKey: ["dashboard"] });
        onClose();
      })
      .catch((caught: unknown) => {
        setError(errorMessage(caught));
        setErrorAt(errorField(caught));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const noun = kind === "customer" ? "customer" : "supplier";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={party === null ? `New ${noun}` : `Edit ${noun}`}
      description={party === null ? `Add a ${noun} to the list.` : party.name}
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
      <div className="grid gap-4 sm:grid-cols-2">
        <FormSection title="Contact details" className="sm:col-span-2">
          <div className="space-y-3">
            <Field label="Name" required error={errorAt === "name" ? error : null}>
              {(id) => (
                <Input
                  id={id}
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                  autoFocus
                />
              )}
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Phone">
                {(id) => (
                  <Input
                    id={id}
                    value={phone}
                    onChange={(event) => {
                      setPhone(event.target.value);
                    }}
                    dir="ltr"
                  />
                )}
              </Field>

              <Field label="Email" error={errorAt === "email" ? error : null}>
                {(id) => (
                  <Input
                    id={id}
                    type="email"
                    value={email}
                    onChange={(event) => {
                      setEmail(event.target.value);
                    }}
                    dir="ltr"
                  />
                )}
              </Field>
            </div>

            <Field label="Address">
              {(id) => (
                <Input
                  id={id}
                  value={addressLine}
                  onChange={(event) => {
                    setAddressLine(event.target.value);
                  }}
                />
              )}
            </Field>
          </div>
        </FormSection>

        <FormSection title="Tax & status" className="sm:col-span-2">
          <div className="space-y-3">
            <Field label="TRN" hint="Tax registration number, printed on invoices.">
              {(id) => (
                <Input
                  id={id}
                  value={trn}
                  onChange={(event) => {
                    setTrn(event.target.value);
                  }}
                  dir="ltr"
                />
              )}
            </Field>

            <Switch
              checked={isActive}
              onChange={setIsActive}
              label={isActive ? "Active" : "Inactive"}
              description="Inactive accounts stay on old documents but are not offered on new ones."
            />
          </div>
        </FormSection>

        {error !== null && errorAt === undefined && (
          <p
            className="rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-[13px] text-[var(--danger)] sm:col-span-2"
            role="alert"
          >
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function PaymentDialog({
  open,
  kind,
  party,
  onClose,
}: {
  readonly open: boolean;
  readonly kind: "customer" | "supplier";
  readonly party: PartyDto | null;
  readonly onClose: () => void;
}): React.JSX.Element {
  const client = useQueryClient();
  const isCustomer = kind === "customer";

  const [amountText, setAmountText] = useState("");
  const [paymentDate, setPaymentDate] = useState(todayIso());
  const [method, setMethod] = useState<Method>("cash");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seeded, setSeeded] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const seedKey = party?.id ?? null;
    if (seeded === seedKey) return;
    setSeeded(seedKey);
    setAmountText("");
    setPaymentDate(todayIso());
    setMethod("cash");
    setReference("");
    setNotes("");
    setError(null);
  }, [open, party, seeded]);

  // What the party still owes: the ceiling for this payment. A party holding
  // a credit owes nothing, so nothing may be taken for their invoice.
  const outstanding = Math.max(0, party?.balanceFils ?? 0);

  const submit = (): void => {
    if (party === null || busy) return;
    const amountFils = parseAmount(amountText);
    if (amountFils === null || amountFils <= 0) {
      setError("Enter the amount received or paid.");
      return;
    }
    // The balance is the ceiling: money cannot be taken for more than is
    // owed. The server checks the same thing again when it writes the
    // payment, so this is a courtesy rather than the rule.
    if (amountFils > outstanding) {
      setError(`Payment cannot exceed the outstanding balance of ${formatMoney(outstanding)}.`);
      return;
    }
    setError(null);
    setBusy(true);

    void call("payments.save", {
      direction: isCustomer ? "inbound" : "outbound",
      partyId: party.id,
      paymentDate,
      method,
      amountFils,
      reference: reference.trim().length > 0 ? reference.trim() : null,
      notes: notes.trim().length > 0 ? notes.trim() : null,
    })
      .then(() => {
        toast.success(isCustomer ? "Payment received" : "Supplier paid");
        void client.invalidateQueries({ queryKey: ["parties"] });
        void client.invalidateQueries({ queryKey: ["dashboard"] });
        void client.invalidateQueries({ queryKey: ["finance"] });
        void client.invalidateQueries({ queryKey: ["payments"] });
        onClose();
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
      open={open && party !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="sm"
      title={isCustomer ? "Receive payment" : "Pay supplier"}
      description={party?.name}
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
      <div className="space-y-3">
        {party !== null && (
          <p className="rounded-lg bg-[var(--surface-2)] px-3 py-2.5 text-[13px] text-[var(--text-2)]">
            Outstanding:{" "}
            <span className="tabular font-medium text-[var(--text)]">
              {formatMoney(outstanding)}
            </span>
            {" · "}Applied to oldest unpaid {isCustomer ? "invoices" : "purchases"} first.
          </p>
        )}

        <Field
          label="Amount"
          required
          error={error}
          hint={`The most that can be paid now is ${formatMoney(outstanding)}.`}
        >
          {(id) => (
            <MoneyInput
              id={id}
              value={amountText}
              onChange={(event) => {
                setAmountText(event.target.value);
                setError(null);
              }}
              autoFocus
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

        <Field label="Method" required>
          {(id) => (
            <Select
              id={id}
              value={method}
              options={paymentMethodOptions}
              onChange={(next) => {
                setMethod(next as Method);
              }}
            />
          )}
        </Field>

        <Field label="Reference" hint="Cheque number, transfer ID.">
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

        <Field label="Note">
          {(id) => (
            <Input
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

function PartyPaymentsDialog({
  party,
  onClose,
}: {
  readonly party: PartyDto | null;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { data, isLoading } = useQuery({
    queryKey: ["payments", party?.id ?? 0],
    queryFn: () => call("payments.list", { partyId: party?.id ?? 0, limit: 200 }),
    enabled: party !== null,
  });

  const rows = useMemo(() => data ?? [], [data]);

  const columns: readonly Column<PaymentDto>[] = [
    {
      id: "date",
      header: "Date",
      cell: (row) => (
        <span className="tabular text-[var(--text-2)]">{formatDate(row.paymentDate)}</span>
      ),
      sortValue: (row) => row.paymentDate,
    },
    {
      id: "direction",
      header: "Direction",
      cell: (row) => (
        <Badge tone={row.direction === "inbound" ? "success" : "warning"}>
          {row.direction === "inbound" ? "Received" : "Paid"}
        </Badge>
      ),
      sortValue: (row) => row.direction,
    },
    {
      id: "method",
      header: "Method",
      cell: (row) => METHOD_LABELS[row.method] ?? row.method,
      sortValue: (row) => row.method,
    },
    {
      id: "amount",
      header: "Amount",
      align: "end",
      cell: (row) => <span className="font-medium">{formatMoney(row.amountFils)}</span>,
      sortValue: (row) => row.amountFils,
    },
    {
      id: "reference",
      header: "Reference",
      cell: (row) => row.reference ?? "—",
      sortValue: (row) => row.reference,
    },
    {
      id: "notes",
      header: "Note",
      cell: (row) => row.notes ?? "—",
      sortValue: (row) => row.notes,
    },
  ];

  return (
    <Dialog
      open={party !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="lg"
      title="Payments"
      description={party?.name}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      {isLoading ? (
        <TableSkeleton columns={5} rows={6} />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          caption="Payments"
          maxBodyHeight="24rem"
          compact
          emptyState={
            <EmptyState
              compact
              title="No payments yet"
              description="Payments recorded against this account appear here."
            />
          }
        />
      )}
    </Dialog>
  );
}
