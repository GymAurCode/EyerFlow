/**
 * The account editor.
 *
 * Add an account, or change one. The form is deliberately plain - code, name,
 * type, sub-type, parent, description - because those are the things an
 * account *is*. Everything else about it is the ledger's business.
 *
 * The rules the service enforces are explained here rather than left as a
 * refusal:
 *
 *   - a code is an identity, so it cannot be duplicated;
 *   - a system account is one the postings name by code, so it may be renamed
 *     but not retyped;
 *   - an account with ledger lines is never deleted, only deactivated, because
 *     deleting it would leave journal lines pointing at nothing.
 *
 * The parent list excludes the account itself and everything under it, so a
 * loop cannot be chosen in the first place.
 */

import { useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { AccountDto, AccountSubtype, AccountType } from "../../../shared/finance";
import { call, errorField, errorMessage } from "../../lib/api";
import { formatMoney } from "../../lib/format";
import { ACCOUNT_SUBTYPE_LABELS } from "../../lib/finance";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog, Dialog } from "../../components/ui/Dialog";
import { Field, Input, Select, Textarea } from "../../components/ui/Input";

const TYPE_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "asset", label: "Asset" },
  { value: "liability", label: "Liability" },
  { value: "equity", label: "Equity" },
  { value: "income", label: "Income" },
  { value: "expense", label: "Expense" },
];

export interface AccountEditorDialogProps {
  readonly open: boolean;
  readonly account: AccountDto | null;
  readonly accounts: readonly AccountDto[];
  readonly onClose: () => void;
  readonly onSaved: () => void;
  readonly onDeleted: () => void;
}

export function AccountEditorDialog({
  open,
  account,
  accounts,
  onClose,
  onSaved,
  onDeleted,
}: AccountEditorDialogProps): React.JSX.Element {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("asset");
  const [subtype, setSubtype] = useState<AccountSubtype | "">("");
  const [parentId, setParentId] = useState("");
  const [description, setDescription] = useState("");
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [seeded, setSeeded] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const key = account?.id ?? null;
    if (seeded === key) return;
    setSeeded(key);
    setCode(account?.code ?? "");
    setName(account?.name ?? "");
    setType(account?.type ?? "asset");
    setSubtype(account?.subtype ?? "");
    setParentId(account?.parentId === null || account === null ? "" : String(account.parentId));
    setDescription(account?.description ?? "");
    setErrors({});
  }, [open, account, seeded]);

  const subtypeOptions = useMemo(() => {
    const allowed: Record<string, readonly AccountSubtype[]> = {
      asset: ["currentAsset", "fixedAsset", "contraAsset"],
      liability: ["currentLiability", "longTermLiability"],
      equity: ["equity"],
      income: ["operatingIncome", "otherIncome"],
      expense: ["cogs", "operatingExpense", "otherExpense"],
    };
    return (allowed[type] ?? []).map((value) => ({
      value,
      label: ACCOUNT_SUBTYPE_LABELS[value] ?? value,
    }));
  }, [type]);

  /**
   * The accounts that may be this account's parent.
   *
   * Its own descendants are excluded as well as itself: a parent that is below
   * the account would make the chart a loop, which the service refuses and the
   * reader should not be offered.
   */
  const parentOptions = useMemo(() => {
    if (account === null) {
      return accounts
        .filter((candidate) => candidate.type === type)
        .map((candidate) => ({
          value: String(candidate.id),
          label: `${candidate.code} — ${candidate.name}`,
        }));
    }

    const forbidden = new Set<number>([account.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const candidate of accounts) {
        if (candidate.parentId === null || candidate.parentId === undefined) continue;
        if (forbidden.has(candidate.parentId) && !forbidden.has(candidate.id)) {
          forbidden.add(candidate.id);
          grew = true;
        }
      }
    }

    return accounts
      .filter((candidate) => !forbidden.has(candidate.id) && candidate.type === type)
      .map((candidate) => ({
        value: String(candidate.id),
        label: `${candidate.code} — ${candidate.name}`,
      }));
  }, [accounts, account, type]);

  const childCount = useMemo(
    () =>
      account === null
        ? 0
        : accounts.filter((candidate) => candidate.parentId === account.id).length,
    [accounts, account],
  );

  /** An account with history is never destroyed: it is deactivated instead. */
  const canDelete = account !== null && account.usageCount === 0 && childCount === 0;

  const submit = (): void => {
    const nextErrors: Record<string, string> = {};
    if (code.trim().length === 0) nextErrors["code"] = "An account needs a code.";
    if (name.trim().length === 0) nextErrors["name"] = "An account needs a name.";

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setBusy(true);
    void call("finance.chart.save", {
      ...(account === null ? {} : { id: account.id }),
      code: code.trim(),
      name: name.trim(),
      type,
      ...(subtype === "" ? {} : { subtype }),
      parentId: parentId === "" ? null : Number(parentId),
      description: description.trim().length > 0 ? description.trim() : null,
    })
      .then(() => {
        toast.success(account === null ? "Account created" : "Account updated");
        onSaved();
        onClose();
      })
      .catch((error: unknown) => {
        // The service names the field it is refusing when it can, so the
        // message goes under the input it belongs to rather than only in a
        // toast the reader has to remember.
        const field = errorField(error);
        const message = errorMessage(error);
        setErrors(field === undefined ? {} : { [field]: message });
        toast.error(message);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const toggleActive = (): void => {
    if (account === null) return;
    setBusy(true);
    void call("finance.chart.setActive", { id: account.id, isActive: !account.isActive })
      .then(() => {
        toast.success(account.isActive ? "Account deactivated" : "Account activated");
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

  const remove = (): void => {
    if (account === null) return;
    setBusy(true);
    void call("finance.chart.delete", { id: account.id })
      .then(() => {
        toast.success("Account deleted");
        setDeleting(false);
        onDeleted();
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
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
        title={account === null ? "New account" : `Edit ${account.code}`}
        description={
          account?.isSystem === true
            ? "This is a system account. It can be renamed, but its type cannot be changed."
            : undefined
        }
        busy={busy}
        footer={
          <>
            {account !== null && (
              <>
                <Button
                  variant="secondary"
                  onClick={toggleActive}
                  disabled={busy}
                  className="me-auto"
                >
                  {account.isActive ? "Deactivate" : "Activate"}
                </Button>
                {canDelete && (
                  <Button
                    variant="danger"
                    onClick={() => {
                      setDeleting(true);
                    }}
                    disabled={busy}
                    iconLeft={<Trash2 className="h-4 w-4" />}
                  >
                    Delete
                  </Button>
                )}
              </>
            )}
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
          {account !== null && (
            <div className="sm:col-span-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-[12.5px] text-[var(--text-2)]">
              <span>
                Balance{" "}
                <span className="tabular font-medium text-[var(--text)]">
                  {formatMoney(account.balanceFils)}
                </span>
              </span>
              <span>
                {String(account.usageCount)} ledger line{account.usageCount === 1 ? "" : "s"}
              </span>
              {account.usageCount > 0 && (
                <span className="text-[var(--text-3)]">
                  This account has history, so it can be deactivated but not deleted.
                </span>
              )}
            </div>
          )}

          <Field label="Code" required hint="Unique across the chart." error={errors["code"]}>
            {(id) => (
              <Input
                id={id}
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                }}
                placeholder="1100"
                invalid={errors["code"] !== undefined}
                autoFocus
              />
            )}
          </Field>

          <Field label="Name" required error={errors["name"]}>
            {(id) => (
              <Input
                id={id}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
                placeholder="Equipment & Fixed Assets"
                invalid={errors["name"] !== undefined}
              />
            )}
          </Field>

          <Field label="Type" required error={errors["type"]}>
            {(id) => (
              <Select
                id={id}
                value={type}
                options={TYPE_OPTIONS}
                onChange={(value) => {
                  setType(value as AccountType);
                  setSubtype("");
                }}
                disabled={account?.isSystem === true}
              />
            )}
          </Field>

          <Field label="Sub-type" hint="Groups the account in the reports.">
            {(id) => (
              <Select
                id={id}
                value={subtype}
                options={subtypeOptions}
                placeholder="None"
                onChange={(value) => {
                  setSubtype(value as AccountSubtype);
                }}
              />
            )}
          </Field>

          <Field
            label="Parent account"
            hint="For sub-accounts."
            error={errors["parentId"]}
            className="sm:col-span-2"
          >
            {(id) => (
              <Select
                id={id}
                value={parentId}
                options={parentOptions}
                placeholder="No parent"
                onChange={(value) => {
                  setParentId(value);
                }}
              />
            )}
          </Field>

          <Field label="Description" className="sm:col-span-2">
            {(id) => (
              <Textarea
                id={id}
                value={description}
                onChange={(event) => {
                  setDescription(event.target.value);
                }}
                placeholder="What this account is for."
              />
            )}
          </Field>

          {account !== null && account.usageCount === 0 && childCount > 0 && (
            <p className="sm:col-span-2 text-[12px] text-[var(--text-3)]">
              This account has {String(childCount)} sub-account{childCount === 1 ? "" : "s"} under
              it, so it cannot be deleted until they are moved.
            </p>
          )}
        </div>
      </Dialog>

      <ConfirmDialog
        open={deleting}
        onOpenChange={(next) => {
          if (!next) setDeleting(false);
        }}
        title="Delete account"
        message={
          <p>
            {account === null
              ? ""
              : `Delete ${account.code} — ${account.name}? An account that has been used cannot be deleted; deactivate it instead.`}
          </p>
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={() => {
          remove();
        }}
      />
    </>
  );
}
