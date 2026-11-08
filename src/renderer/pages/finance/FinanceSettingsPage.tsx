/**
 * Financial settings.
 *
 * Three things that shape the books rather than the business:
 *
 *  - **Accounting periods.** A closed period cannot be posted to, so a
 *    month's figures cannot be quietly rewritten after they have been
 *    reported on. Closing and reopening a period is deliberately explicit.
 *
 *  - **Opening balances.** What the books started with: the cash in the till,
 *    the money at the bank, the stock on the shelf, what was owed and what was
 *    owing. The entry is checked for balance before it is written.
 *
 *  - **Existing data.** A shop that traded before the Finance module existed
 *    has documents, payments and expenses that carry no journal entry. The
 *    screen says exactly how many, and what cannot be migrated accurately,
 *    rather than quietly inventing figures.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Lock, LockOpen, Plus, RotateCcw, Scale } from "lucide-react";
import { toast } from "sonner";
import type { AccountingPeriodDto, AccountDto } from "../../../shared/finance";
import { call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { formatAmount, formatMoney, parseAmount } from "../../lib/format";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Dialog } from "../../components/ui/Dialog";
import { type Column, DataTable } from "../../components/ui/DataTable";
import { Badge } from "../../components/ui/Badge";
import { EmptyState, PageHeader, TableSkeleton } from "../../components/ui/Feedback";
import { Field, Input, MoneyInput, Textarea } from "../../components/ui/Input";
import { FinanceLayout } from "./FinanceLayout";

export function FinanceSettingsPage(): React.JSX.Element {
  const { can } = useApp();
  const client = useQueryClient();

  const [periodOpen, setPeriodOpen] = useState(false);
  const [openingOpen, setOpeningOpen] = useState(false);

  const { data: periods, isLoading } = useQuery({
    queryKey: ["finance.periods.list"],
    queryFn: () => call("finance.periods.list", {}),
  });

  const { data: audit } = useQuery({
    queryKey: ["finance.migrationAudit"],
    queryFn: () => call("finance.migrationAudit", {}),
  });

  const columns: readonly Column<AccountingPeriodDto>[] = [
    {
      id: "name",
      header: "Period",
      cell: (row) => <span className="font-medium text-[var(--text)]">{row.name}</span>,
      sortValue: (row) => row.name,
    },
    {
      id: "dates",
      header: "Dates",
      cell: (row) => (
        <span className="tabular text-[var(--text-2)]">
          {row.startDate} → {row.endDate}
        </span>
      ),
      sortValue: (row) => row.startDate,
    },
    {
      id: "status",
      header: "Status",
      cell: (row) => (
        <Badge tone={row.status === "closed" ? "neutral" : "success"} dot>
          {row.status === "closed" ? "Closed" : "Open"}
        </Badge>
      ),
      sortValue: (row) => row.status,
    },
  ];

  const setStatus = useMutation({
    mutationFn: (input: { id: number; close: boolean }) =>
      input.close
        ? call("finance.periods.close", { id: input.id })
        : call("finance.periods.reopen", { id: input.id }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["finance.periods.list"] });
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(error));
    },
  });

  const backfill = useMutation({
    mutationFn: () => call("finance.backfill", { confirm: true }),
    onSuccess: (result) => {
      toast.success(`Posted ${String(result.posted)} records, skipped ${String(result.skipped)}.`);
      void client.invalidateQueries({ queryKey: ["finance.migrationAudit"] });
      void client.invalidateQueries({ queryKey: ["finance.overview"] });
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(error));
    },
  });

  return (
    <FinanceLayout>
      <PageHeader
        title="Financial settings"
        description="Periods, opening balances, and the records that predate the Finance module."
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <Card flush>
          <CardHeader
            title="Accounting periods"
            description="A closed period cannot be posted to, so its figures stay as they were reported."
            actions={
              can("finance", "edit") ? (
                <Button
                  variant="secondary"
                  size="sm"
                  iconLeft={<Plus className="h-4 w-4" />}
                  onClick={() => {
                    setPeriodOpen(true);
                  }}
                >
                  New period
                </Button>
              ) : undefined
            }
          />
          {isLoading ? (
            <div className="p-4">
              <TableSkeleton columns={3} rows={3} />
            </div>
          ) : (periods ?? []).length === 0 ? (
            <EmptyState
              compact
              icon={<Scale className="h-5 w-5" />}
              title="No periods defined"
              description="Create a period and close it when its figures have been reported on."
            />
          ) : (
            <DataTable
              frameless
              columns={[
                ...columns,
                {
                  id: "actions",
                  header: "",
                  align: "end",
                  widthClass: "w-32",
                  cell: (row) =>
                    can("finance", "edit") ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        iconLeft={
                          row.status === "closed" ? (
                            <LockOpen className="h-4 w-4" />
                          ) : (
                            <Lock className="h-4 w-4" />
                          )
                        }
                        onClick={() => {
                          setStatus.mutate({ id: row.id, close: row.status !== "closed" });
                        }}
                      >
                        {row.status === "closed" ? "Reopen" : "Close"}
                      </Button>
                    ) : undefined,
                },
              ]}
              rows={periods ?? []}
              rowKey={(row) => row.id}
              caption="Accounting periods"
              compact
            />
          )}
        </Card>

        <Card flush>
          <CardHeader
            title="Opening balances"
            description="What the books started with on the first day of trading."
            actions={
              can("finance", "edit") ? (
                <Button
                  variant="secondary"
                  size="sm"
                  iconLeft={<Scale className="h-4 w-4" />}
                  onClick={() => {
                    setOpeningOpen(true);
                  }}
                >
                  Enter balances
                </Button>
              ) : undefined
            }
          />
          <div className="space-y-3 p-5 text-[13px] text-[var(--text-2)]">
            <p>
              An opening balance is one balanced entry: what the business owned, what it owed, and
              what the owner had put in.
            </p>
            <ul className="list-inside list-disc space-y-1 text-[12.5px] text-[var(--text-3)]">
              <li>Cash in hand and the bank account are the money the business actually had.</li>
              <li>
                Stock is entered at the cost the shop recorded on each purchase, not at today's
                selling price.
              </li>
              <li>
                What customers owed and what the business owed are entered separately, so the
                customer and supplier accounts start where they should.
              </li>
            </ul>
          </div>
        </Card>
      </div>

      <Card flush className="mt-4">
        <CardHeader
          title="Existing records"
          description="Documents, payments and expenses that were recorded before the Finance module existed."
        />
        {audit === undefined ? (
          <div className="p-4">
            <TableSkeleton columns={3} rows={4} />
          </div>
        ) : (
          <div className="space-y-4 p-5">
            {audit.documentsWithoutEntry === 0 &&
            audit.paymentsWithoutEntry === 0 &&
            audit.expensesWithoutEntry === 0 ? (
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[var(--success)]" />
                <div>
                  <p className="text-[13.5px] font-semibold text-[var(--text)]">
                    Every record has a ledger entry
                  </p>
                  <p className="mt-0.5 text-[12.5px] text-[var(--text-2)]">
                    {audit.documentsWithEntry} documents, {audit.paymentsWithEntry} payments and{" "}
                    {audit.expensesWithEntry} expenses are on the books.
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--warning)]" />
                  <div>
                    <p className="text-[13.5px] font-semibold text-[var(--text)]">
                      Some records are not on the books yet
                    </p>
                    <p className="mt-0.5 text-[12.5px] text-[var(--text-2)]">
                      {audit.documentsWithoutEntry} documents, {audit.paymentsWithoutEntry} payments
                      and {audit.expensesWithoutEntry} expenses have no ledger entry. Posting them
                      uses the amounts the records already hold - nothing is invented.
                    </p>
                  </div>
                </div>

                {audit.unmigratable.length > 0 && (
                  <div className="rounded-lg border border-[var(--border)] p-4">
                    <p className="text-[13px] font-semibold text-[var(--text)]">
                      These cannot be posted accurately
                    </p>
                    <p className="mt-0.5 text-[12.5px] text-[var(--text-2)]">
                      They need a decision before they can go on the books. Nothing has been guessed
                      for them.
                    </p>
                    <ul className="mt-2 space-y-1 text-[12.5px] text-[var(--text-2)]">
                      {audit.unmigratable.map((row) => (
                        <li key={`${row.kind}-${row.reference}`}>
                          <span className="tabular text-[var(--text)]">{row.reference}</span> —{" "}
                          {row.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {!audit.inventoryMatches && (
                  <div className="rounded-lg border border-[var(--border)] p-4 text-[12.5px] text-[var(--text-2)]">
                    The stock on the shelf is worth {formatMoney(audit.stockValueFils)} at
                    the costs recorded on the products, while the inventory account holds{" "}
                    {formatMoney(audit.inventoryAccountFils)}. The difference is normal
                    before the history is posted, and is exactly what the back-fill closes.
                  </div>
                )}

                {can("finance", "edit") && (
                  <Button
                    variant="primary"
                    size="sm"
                    iconLeft={<RotateCcw className="h-4 w-4" />}
                    loading={backfill.isPending}
                    onClick={() => {
                      backfill.mutate();
                    }}
                  >
                    Post the missing entries
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </Card>

      <PeriodDialog
        open={periodOpen}
        onClose={() => {
          setPeriodOpen(false);
        }}
        onSaved={() => {
          void client.invalidateQueries({ queryKey: ["finance.periods.list"] });
        }}
      />

      <OpeningBalancesDialog
        open={openingOpen}
        onClose={() => {
          setOpeningOpen(false);
        }}
        onSaved={() => {
          void client.invalidateQueries({ queryKey: ["finance.overview"] });
          void client.invalidateQueries({ queryKey: ["finance.migrationAudit"] });
        }}
      />
    </FinanceLayout>
  );
}

/* -------------------------------------------------------------------------- */

function PeriodDialog({
  open,
  onClose,
  onSaved,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): React.JSX.Element {
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = (): void => {
    if (name.trim().length === 0 || startDate.length === 0 || endDate.length === 0) {
      toast.error("Fill in the name and both dates.");
      return;
    }
    setBusy(true);
    void call("finance.periods.save", { name: name.trim(), startDate, endDate })
      .then(() => {
        toast.success("Period saved");
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
      title="New accounting period"
      description="A period that has been closed cannot be posted to."
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
        <Field label="Name" required className="sm:col-span-2">
          {(id) => (
            <Input
              id={id}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
              placeholder="March 2026"
              autoFocus
            />
          )}
        </Field>
        <Field label="Starts" required>
          {(id) => (
            <Input
              id={id}
              type="date"
              value={startDate}
              onChange={(event) => {
                setStartDate(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Ends" required>
          {(id) => (
            <Input
              id={id}
              type="date"
              value={endDate}
              onChange={(event) => {
                setEndDate(event.target.value);
              }}
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */

const OPENING_CODES = ["1000", "1010", "1020", "1030", "2000", "3000"] as const;

function OpeningBalancesDialog({
  open,
  onClose,
  onSaved,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): React.JSX.Element {
  const [entryDate, setEntryDate] = useState("");
  const [busy, setBusy] = useState(false);

  const { data: accounts } = useQuery({
    queryKey: ["finance.chart"],
    queryFn: () => call("finance.chart", {}),
    enabled: open,
  });

  const [values, setValues] = useState<Readonly<Record<string, string>>>({});

  const relevant = useMemo(
    () =>
      (accounts ?? []).filter((account: AccountDto) =>
        OPENING_CODES.includes(account.code as never),
      ),
    [accounts],
  );

  const totals = useMemo(() => {
    let debits = 0;
    let credits = 0;
    for (const [code, text] of Object.entries(values)) {
      const amount = parseAmount(text) ?? 0;
      if (amount === 0) continue;
      const account = relevant.find((candidate: AccountDto) => candidate.code === code);
      const isDebit = account !== undefined && (account.normalBalance === "debit" ? true : false);
      if (isDebit) debits += amount;
      else credits += amount;
    }
    return { debits, credits, difference: debits - credits };
  }, [values, relevant]);

  const submit = (): void => {
    const balances = Object.entries(values)
      .map(([code, text]) => ({ code, amount: parseAmount(text) ?? 0 }))
      .filter((entry) => entry.amount !== 0)
      .map((entry) => {
        const account = relevant.find((candidate: AccountDto) => candidate.code === entry.code);
        const debit = account !== undefined && account.normalBalance === "debit";
        return {
          accountCode: entry.code,
          debitFils: debit ? entry.amount : 0,
          creditFils: debit ? 0 : entry.amount,
        };
      });

    if (balances.length === 0) {
      toast.error("Enter at least one balance.");
      return;
    }

    setBusy(true);
    void call("finance.openingBalances", {
      entryDate: entryDate.length > 0 ? entryDate : new Date().toISOString().slice(0, 10),
      balances,
    })
      .then(() => {
        toast.success("Opening balances posted");
        setValues({});
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
      title="Opening balances"
      description="What the books started with. The entry must balance before it is posted."
      size="lg"
      busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={totals.difference !== 0}
            onClick={submit}
          >
            Post opening balances
          </Button>
        </>
      }
    >
      <Field label="Date" required className="mb-4">
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

      <div className="space-y-2">
        {relevant.map((account: AccountDto) => (
          <div
            key={account.code}
            className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
          >
            <Field label={`${account.code} — ${account.name}`} srLabelOnly>
              {(id) => (
                <Input
                  id={id}
                  value={account.name}
                  readOnly
                  className="bg-[var(--surface-2)] text-[var(--text-2)]"
                />
              )}
            </Field>
            <Field srLabelOnly label={`Balance for ${account.name}`}>
              {(id) => (
                <MoneyInput
                  id={id}
                  value={values[account.code] ?? ""}
                  onChange={(event) => {
                    const next = { ...values };
                    if (event.target.value.trim().length === 0) delete next[account.code];
                    else next[account.code] = event.target.value;
                    setValues(next);
                  }}
                />
              )}
            </Field>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-end gap-4 text-[13px]">
        <span className="text-[var(--text-2)]">
          Debits{" "}
          <span className="tabular font-medium text-[var(--text)]">
            {formatAmount(totals.debits)}
          </span>
        </span>
        <span className="text-[var(--text-2)]">
          Credits{" "}
          <span className="tabular font-medium text-[var(--text)]">
            {formatAmount(totals.credits)}
          </span>
        </span>
        {totals.difference === 0 ? (
          <span className="font-medium text-[var(--success)]">Balanced</span>
        ) : (
          <span className="font-medium text-[var(--danger)]">
            Out by {formatAmount(Math.abs(totals.difference))}
          </span>
        )}
      </div>
    </Dialog>
  );
}

export { Textarea };
