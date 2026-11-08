/**
 * Settings, in five tabs.
 *
 * Company details, the tax and partner split, users, backup and restore, and
 * About. One screen rather than five menu entries: a shopkeeper changes these
 * once, and a five-item menu for pages visited once each would be noise in the
 * sidebar.
 *
 * Layout: a left vertical tab list, a bordered content card with grouped
 * fields, and a sticky Save bar pinned to the bottom of the card.
 *
 * Only an Administrator can open this screen at all - the route guard checks
 * the `settings` permission, so Staff never sees the tab strip.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { FolderOpen, RotateCcw, Save } from "lucide-react";
import type { AppSettingsSnapshot, BackupFileInfo, UpdateState } from "../../../shared/ipc";
import { DEFAULT_PARTNER_SHARE_PERCENT } from "../../../shared/finance";
import type { PartnerDto, PartnerTransactionDto, UserDto } from "../../../shared/types";
import { bridge, call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { useUpdates } from "../../lib/updates";
import { formatFileSize, formatMoney } from "../../lib/format";
import { formatDate } from "../../lib/utils";
import { MONTH_OPTIONS, ROLE_OPTIONS } from "../../lib/select-options";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { ConfirmDialog, Dialog } from "../../components/ui/Dialog";
import { Field, Input, Select, Switch, Textarea } from "../../components/ui/Input";
import { RowActions, type TabDefinition } from "../../components/ui/Dropdown";
import { PageHeader } from "../../components/ui/Feedback";
import { AppearanceTab } from "./AppearancePanel";
import { toast } from "sonner";

const TABS: readonly TabDefinition[] = [
  { id: "company", label: "Company" },
  { id: "tax", label: "Tax & Partners" },
  { id: "users", label: "Users" },
  { id: "backup", label: "Backup & Restore" },
  { id: "appearance", label: "Appearance" },
  { id: "about", label: "About" },
];

export function SettingsPage(): React.JSX.Element {
  const { can } = useApp();
  const [searchParams, setSearchParams] = useSearchParams();

  // Users are an Administrator concern: Staff cannot manage accounts, and a
  // tab they cannot use is a dead end.
  const tabs = TABS.filter((entry) => entry.id !== "users" || can("users", "view"));

  // The open section lives in the URL (`#/settings?tab=appearance`) so other
  // screens can link straight to it - the topbar's theme menu does. An unknown
  // or unavailable id falls back to Company instead of rendering a blank pane.
  const requested = searchParams.get("tab");
  const tab =
    requested !== null && tabs.some((entry) => entry.id === requested) ? requested : "company";

  const selectTab = (id: string): void => {
    setSearchParams({ tab: id }, { replace: true });
  };

  // The active tab registers its save function here so the sticky Save bar can
  // trigger it without the parent knowing what each tab does.
  const saveRef = useRef<(() => void) | null>(null);
  const registerSave = useCallback((fn: () => void): void => {
    saveRef.current = fn;
  }, []);

  const save = (): void => {
    saveRef.current?.();
  };

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Company details, tax and partner split, users, and backups."
      />

      <div className="flex items-start gap-4">
        {/* Left vertical tab list */}
        <nav className="w-48 shrink-0 space-y-0.5" aria-label="Settings sections">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => {
                selectTab(entry.id);
              }}
              className={`flex h-9 w-full items-center rounded-lg px-3 text-start text-[13px] font-medium transition-colors duration-fast ${
                tab === entry.id
                  ? "bg-[var(--brand)] text-[var(--on-brand)]"
                  : "text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
              }`}
              aria-current={tab === entry.id ? "page" : undefined}
            >
              {entry.label}
            </button>
          ))}
        </nav>

        {/* Bordered content card with sticky save bar */}
        <Card className="min-w-0 flex-1">
          <div className="p-4">
            {tab === "company" && <CompanyTab registerSave={registerSave} />}
            {tab === "tax" && <TaxPartnersTab registerSave={registerSave} />}
            {tab === "users" && can("users", "view") && <UsersTab registerSave={registerSave} />}
            {tab === "backup" && <BackupTab registerSave={registerSave} />}
            {tab === "appearance" && <AppearanceTab />}
            {tab === "about" && <AboutTab />}
          </div>

          {/*
            Sticky save bar. Hidden on the tabs that have nothing to save:
            appearance applies the moment it is chosen, and About is read-only.
            Offering a Save button that does nothing is worse than no button.
          */}
          {tab !== "appearance" && tab !== "about" && (
            <div className="sticky bottom-0 flex items-center justify-between gap-3 rounded-b-lg border-t border-[var(--border)] bg-[var(--surface-2)]/60 px-4 py-3">
              <span className="text-xs text-[var(--text-3)]">
                {tab === "company" && "Company details are printed on every invoice."}
                {tab === "tax" && "The split applies to net profit after the donation."}
                {tab === "users" && "Two fixed roles: Administrator and Staff."}
                {tab === "backup" && "A backup is written every time the app closes."}
              </span>
              <Button variant="primary" iconLeft={<Save className="h-4 w-4" />} onClick={save}>
                Save changes
              </Button>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* company                                                                    */
/* -------------------------------------------------------------------------- */

function CompanyTab({
  registerSave,
}: {
  readonly registerSave: (fn: () => void) => void;
}): React.JSX.Element {
  const { updateSettings, settings } = useApp();
  const [form, setForm] = useState(() =>
    pick(settings, [
      "companyName",
      "companyTrn",
      "companyAddress",
      "companyPhone",
      "companyEmail",
      "invoiceFooter",
      "invoiceTerms",
      "vendorName",
      "fiscalYearStartMonth",
      "vatRatePercent",
      "allowNegativeStock",
    ] as const),
  );
  const [logoBusy, setLogoBusy] = useState(false);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const save = useCallback(async (): Promise<void> => {
    try {
      await updateSettings(form);
      toast.success("Company details saved");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }, [form, updateSettings]);

  useEffect(() => {
    registerSave(() => {
      void save();
    });
  }, [registerSave, save]);

  const chooseLogo = async (): Promise<void> => {
    setLogoBusy(true);
    try {
      const result = await bridge().pickImage("companyLogo");
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      if (result.data === null) return;

      await updateSettings({ companyLogoPath: result.data });
      toast.success("Logo updated");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setLogoBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <Field label="Company name" required>
            {(id) => (
              <Input
                id={id}
                value={form.companyName}
                onChange={(event) => {
                  set("companyName", event.target.value);
                }}
              />
            )}
          </Field>

          <Field
            label="Tax / business registration number"
            hint="Printed under the company name on every document."
          >
            {(id) => (
              <Input
                id={id}
                value={form.companyTrn}
                onChange={(event) => {
                  set("companyTrn", event.target.value);
                }}
              />
            )}
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Phone">
              {(id) => (
                <Input
                  id={id}
                  value={form.companyPhone}
                  onChange={(event) => {
                    set("companyPhone", event.target.value);
                  }}
                />
              )}
            </Field>
            <Field label="Email">
              {(id) => (
                <Input
                  id={id}
                  type="email"
                  value={form.companyEmail}
                  onChange={(event) => {
                    set("companyEmail", event.target.value);
                  }}
                />
              )}
            </Field>
          </div>

          <Field
            label="Business address"
            hint="Printed at the top of every invoice and report. One line per row."
          >
            {(id) => (
              <Textarea
                id={id}
                rows={3}
                value={form.companyAddress}
                onChange={(event) => {
                  set("companyAddress", event.target.value);
                }}
                placeholder={"Shop 12, Al Nakheel Street\nDubai, United Arab Emirates"}
              />
            )}
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Financial year starts in">
              {(id) => (
                <Select
                  id={id}
                  value={String(form.fiscalYearStartMonth)}
                  options={MONTH_OPTIONS}
                  onChange={(next) => {
                    set("fiscalYearStartMonth", Number(next));
                  }}
                />
              )}
            </Field>

            <Field
              label="Currency"
              hint="EyerStock trades in Pakistani Rupees. Amounts are shown as Rs."
            >
              {(id) => <Input id={id} value="PKR" readOnly disabled />}
            </Field>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <p className="mb-2 text-sm font-medium text-[var(--text-primary)]">Logo</p>
            {settings.companyLogoDataUrl === null ? (
              <p className="text-sm text-[var(--text-3)]">No logo chosen yet.</p>
            ) : (
              <img
                src={settings.companyLogoDataUrl}
                alt="Company logo"
                className="h-16 rounded-lg border border-[var(--border)] bg-[var(--surface)] object-contain p-1"
              />
            )}
            <Button
              variant="secondary"
              iconLeft={<FolderOpen className="h-4 w-4" />}
              loading={logoBusy}
              onClick={() => {
                void chooseLogo();
              }}
              className="mt-2"
            >
              Choose logo
            </Button>
          </div>

          <div className="space-y-3">
            <Field label="Footer line">
              {(id) => (
                <Input
                  id={id}
                  value={form.invoiceFooter}
                  onChange={(event) => {
                    set("invoiceFooter", event.target.value);
                  }}
                />
              )}
            </Field>
            <Field label="Terms" hint="Printed under every invoice.">
              {(id) => (
                <Input
                  id={id}
                  value={form.invoiceTerms}
                  onChange={(event) => {
                    set("invoiceTerms", event.target.value);
                  }}
                />
              )}
            </Field>
            <Field label="Developed by">
              {(id) => (
                <Input
                  id={id}
                  value={form.vendorName}
                  onChange={(event) => {
                    set("vendorName", event.target.value);
                  }}
                />
              )}
            </Field>
          </div>
        </div>
      </div>

      {/* Tax & stock settings */}
      <div className="border-t border-[var(--divider)] pt-4">
        <p className="mb-3 text-sm font-medium text-[var(--text-primary)]">Tax & stock</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="VAT rate (%)" hint="Applied to standard-rated lines.">
            {(id) => (
              <Input
                id={id}
                type="number"
                min={0}
                max={100}
                step="0.01"
                value={String(form.vatRatePercent)}
                onChange={(event) => {
                  set("vatRatePercent", Number(event.target.value));
                }}
              />
            )}
          </Field>
          <div className="flex items-end pb-1">
            <Switch
              label="Allow negative stock"
              description="When on, a sale may take stock below zero."
              checked={form.allowNegativeStock}
              onChange={(value) => {
                set("allowNegativeStock", value);
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* tax and partners                                                           */
/* -------------------------------------------------------------------------- */

function TaxPartnersTab({
  registerSave,
}: {
  readonly registerSave: (fn: () => void) => void;
}): React.JSX.Element {
  const { updateSettings, settings } = useApp();
  const [donationRatePercent, setDonationRatePercent] = useState(settings.donationRatePercent);

  const [partners, setPartners] = useState<readonly PartnerDto[]>([]);
  const [transactions, setTransactions] = useState<readonly PartnerTransactionDto[]>([]);
  const [editing, setEditing] = useState<PartnerDto | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const loadPartners = useCallback(async (): Promise<void> => {
    try {
      setPartners(await call("partners.list", {}));
      setTransactions(await call("partners.transactions", { limit: 50 }));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void loadPartners();
  }, [loadPartners]);

  useEffect(() => {
    setDonationRatePercent(settings.donationRatePercent);
  }, [settings.donationRatePercent]);

  // The donation and the partners' shares are percentages of the same net
  // profit, so they have to come to 100% between them. A 2% donation with two
  // partners at 49% each is the arrangement this business agreed.
  const activePartners = partners.filter((partner) => partner.isActive);
  const partnerTotal = activePartners.reduce((sum, partner) => sum + partner.sharePercent, 0);
  const total = donationRatePercent + partnerTotal;
  const totalsAreRight = Math.abs(total - 100) < 0.0001;

  const save = useCallback(async (): Promise<void> => {
    if (!totalsAreRight) {
      toast.error(
        `The donation (${String(donationRatePercent)}%) and the partner shares (${String(Math.round(partnerTotal * 100) / 100)}%) must add up to 100%.`,
      );
      return;
    }

    try {
      await updateSettings({ donationRatePercent });
      toast.success("Split saved");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }, [donationRatePercent, partnerTotal, totalsAreRight, updateSettings]);

  useEffect(() => {
    registerSave(() => {
      void save();
    });
  }, [registerSave, save]);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-3">
        <p className="text-sm font-medium text-[var(--text-primary)]">Profit split</p>
        <p className="text-xs text-[var(--text-muted)]">
          Net profit, then the donation, then the rest between the partners. The donation and the
          partners&apos; shares are percentages of the same net profit, so together they come to
          100%.
        </p>
        <Field label="Donation" hint="Percentage of net profit set aside before the split.">
          {(id) => (
            <Input
              id={id}
              type="number"
              min={0}
              max={50}
              value={String(donationRatePercent)}
              onChange={(event) => {
                setDonationRatePercent(Number(event.target.value));
              }}
            />
          )}
        </Field>

        <div className="rounded-lg border border-[var(--border)] px-3 py-2 text-[13px]">
          <p className="text-[var(--text-2)]">
            Donation {donationRatePercent}%
            {activePartners
              .map((partner) => ` · ${partner.name} ${partner.sharePercent}%`)
              .join("")}
          </p>
          <p
            className={totalsAreRight ? "mt-1 text-[var(--success)]" : "mt-1 text-[var(--danger)]"}
          >
            {totalsAreRight
              ? "The split comes to 100%."
              : `The split comes to ${String(Math.round(total * 100) / 100)}%. It must come to 100%.`}
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-[var(--text-primary)]">Partners</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            Add partner
          </Button>
        </div>
        <p className="text-xs text-[var(--text-muted)]">
          Each partner&apos;s percentage is of the net profit, after the donation has been taken
          off.
        </p>
        {partners.length === 0 ? (
          <p className="text-sm text-[var(--text-3)]">No partners yet.</p>
        ) : (
          partners.map((partner) => (
            <div
              key={partner.id}
              className="flex items-center justify-between rounded-lg border border-[var(--border)] px-3 py-2"
            >
              <div>
                <p className="text-sm font-medium text-[var(--text)]">{partner.name}</p>
                <p className="text-xs text-[var(--text-3)]">
                  {partner.sharePercent}% of net profit
                  {partner.isActive ? "" : " · not taking a share"}
                </p>
              </div>
              <RowActions
                items={[
                  {
                    id: "edit",
                    label: "Edit",
                    onSelect: () => {
                      setEditing(partner);
                      setDialogOpen(true);
                    },
                  },
                ]}
              />
            </div>
          ))
        )}
      </div>

      <PartnerDialog
        open={dialogOpen}
        partner={editing}
        onOpenChange={setDialogOpen}
        onSaved={() => {
          void loadPartners();
        }}
      />

      {/* What has actually been allocated: the partnership's own ledger. */}
      <div className="lg:col-span-2">
        <p className="text-sm font-medium text-[var(--text-primary)]">Recorded splits</p>
        <p className="text-xs text-[var(--text-muted)]">
          When an accounting period is closed, the profit for that period is split and written down
          here: each partner&apos;s share, and the donation that goes with it.
        </p>
        {transactions.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--text-3)]">
            Nothing has been recorded yet. Close an accounting period in Finance to record the
            split.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
            {transactions.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-4 px-3 py-2">
                <div>
                  <p className="text-[13px] font-medium text-[var(--text)]">
                    {entry.partnerName} ·{" "}
                    {entry.kind === "profit"
                      ? "profit share"
                      : entry.kind === "donation"
                        ? "donation"
                        : entry.kind}
                  </p>
                  <p className="text-xs text-[var(--text-3)]">
                    {entry.txnDate}
                    {entry.periodRef !== null ? ` · ${entry.periodRef.replace("..", " to ")}` : ""}
                  </p>
                </div>
                <span className="tabular text-[13.5px] font-medium text-[var(--text)]">
                  {formatMoney(entry.amountFils)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PartnerDialog({
  open,
  partner,
  onOpenChange,
  onSaved,
}: {
  readonly open: boolean;
  readonly partner: PartnerDto | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved: () => void;
}): React.JSX.Element {
  const [name, setName] = useState("");
  const [sharePercent, setSharePercent] = useState("0");
  const [isActive, setIsActive] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(partner?.name ?? "");
    setSharePercent(String(partner?.sharePercent ?? DEFAULT_PARTNER_SHARE_PERCENT));
    setIsActive(partner?.isActive ?? true);
  }, [open, partner]);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await call("partners.save", {
        ...(partner !== null ? { id: partner.id } : {}),
        name,
        sharePercent: Number(sharePercent),
        isActive,
      });
      toast.success(partner === null ? "Partner added" : "Partner updated");
      onOpenChange(false);
      onSaved();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={partner === null ? "Add partner" : "Edit partner"}
      busy={busy}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
            }}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => {
              void save();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name" required>
          {(id) => (
            <Input
              id={id}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Share of net profit (%)">
          {(id) => (
            <Input
              id={id}
              type="number"
              min={0}
              max={100}
              value={sharePercent}
              onChange={(event) => {
                setSharePercent(event.target.value);
              }}
            />
          )}
        </Field>
        <Switch
          label="Active"
          checked={isActive}
          onChange={(value) => {
            setIsActive(value);
          }}
        />
      </div>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* users                                                                      */
/* -------------------------------------------------------------------------- */

function UsersTab({
  registerSave,
}: {
  readonly registerSave: (fn: () => void) => void;
}): React.JSX.Element {
  const [users, setUsers] = useState<readonly UserDto[]>([]);
  const [editing, setEditing] = useState<UserDto | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setUsers(await call("users.list", {}));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const adminRoleId = users.find((user) => user.roleName === "Administrator")?.roleId ?? null;
  const staffRoleId = users.find((user) => user.roleName === "Staff")?.roleId ?? null;

  // Users are managed through a dialog; the sticky save bar is not needed here
  // but we register a no-op so the bar never fires a stale action.
  useEffect(() => {
    registerSave(() => {
      /* user saves happen in the user dialog */
    });
  }, [registerSave]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-[var(--text-primary)]">Users</p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          Add user
        </Button>
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        Two fixed roles: Administrator sees everything, Staff does not see profit reports, the
        partner split, or these settings.
      </p>
      {users.length === 0 ? (
        <p className="text-sm text-[var(--text-3)]">No users.</p>
      ) : (
        users.map((user) => (
          <div
            key={user.id}
            className="flex items-center justify-between rounded-lg border border-[var(--border)] px-3 py-2"
          >
            <div>
              <p className="text-sm font-medium text-[var(--text)]">{user.displayName}</p>
              <p className="text-xs text-[var(--text-3)]">
                {user.username} · {user.roleName ?? "No role"}
                {user.mustChangePassword ? " · must change password" : ""}
                {user.isActive ? "" : " · deactivated"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {user.isActive ? (
                <Badge tone="success">Active</Badge>
              ) : (
                <Badge tone="neutral">Inactive</Badge>
              )}
              <RowActions
                items={[
                  {
                    id: "edit",
                    label: "Edit",
                    onSelect: () => {
                      setEditing(user);
                      setDialogOpen(true);
                    },
                  },
                ]}
              />
            </div>
          </div>
        ))
      )}

      <UserDialog
        open={dialogOpen}
        user={editing}
        adminRoleId={adminRoleId}
        staffRoleId={staffRoleId}
        onOpenChange={setDialogOpen}
        onSaved={() => {
          void load();
        }}
      />
    </div>
  );
}

function UserDialog({
  open,
  user,
  adminRoleId,
  staffRoleId,
  onOpenChange,
  onSaved,
}: {
  readonly open: boolean;
  readonly user: UserDto | null;
  readonly adminRoleId: number | null;
  readonly staffRoleId: number | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved: () => void;
}): React.JSX.Element {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState("Administrator");
  const [isActive, setIsActive] = useState(true);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setUsername(user?.username ?? "");
    setDisplayName(user?.displayName ?? "");
    setRole(user?.roleName ?? "Administrator");
    setIsActive(user?.isActive ?? true);
    setPassword("");
  }, [open, user]);

  const save = async (): Promise<void> => {
    const roleId = role === "Administrator" ? adminRoleId : staffRoleId;

    if (roleId === null) {
      toast.error(
        `The ${role} role is not on this system yet. Ask an administrator to create a user with it first.`,
      );
      return;
    }

    setBusy(true);
    try {
      await call("users.save", {
        ...(user !== null ? { id: user.id } : {}),
        username,
        displayName,
        roleId,
        isActive,
        ...(password.length > 0 ? { password } : {}),
      });
      toast.success(user === null ? "User added" : "User updated");
      onOpenChange(false);
      onSaved();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={user === null ? "Add user" : "Edit user"}
      busy={busy}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
            }}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => {
              void save();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Display name" required>
          {(id) => (
            <Input
              id={id}
              value={displayName}
              onChange={(event) => {
                setDisplayName(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Username" required>
          {(id) => (
            <Input
              id={id}
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Role">
          {(id) => (
            <Select
              id={id}
              value={role}
              options={ROLE_OPTIONS}
              onChange={(next) => {
                setRole(next);
              }}
            />
          )}
        </Field>
        <Field
          label={user === null ? "Password" : "New password"}
          required={user === null}
          hint={user === null ? undefined : "Leave blank to keep the current password."}
        >
          {(id) => (
            <Input
              id={id}
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
          )}
        </Field>
        <Switch
          label="Active"
          checked={isActive}
          onChange={(value) => {
            setIsActive(value);
          }}
        />
      </div>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* backup and restore                                                         */
/* -------------------------------------------------------------------------- */

function BackupTab({
  registerSave,
}: {
  readonly registerSave: (fn: () => void) => void;
}): React.JSX.Element {
  const { updateSettings, settings } = useApp();
  const [backups, setBackups] = useState<readonly BackupFileInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<BackupFileInfo | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setBackups(
        await bridge()
          .listBackups()
          .then((result) => (result.ok ? result.data : [])),
      );
    } catch {
      setBackups([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Backup settings are saved as they change (each control calls updateSettings
  // directly), so the sticky bar is registered as a no-op for this tab.
  useEffect(() => {
    registerSave(() => {
      /* backup settings save as they change */
    });
  }, [registerSave]);

  const backupNow = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await bridge().runBackupNow();
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      toast.success("Backup written");
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const chooseFolder = async (): Promise<void> => {
    try {
      const result = await bridge().chooseBackupFolder();
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Destination folder">
            {() => (
              <p className="text-sm text-[var(--text-2)]">
                {settings.backupDirectory.length > 0
                  ? settings.backupDirectory
                  : "Default app data folder"}
              </p>
            )}
          </Field>
          <Button
            variant="secondary"
            iconLeft={<FolderOpen className="h-4 w-4" />}
            onClick={() => {
              void chooseFolder();
            }}
          >
            Change folder
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Backups to keep">
            {(id) => (
              <Input
                id={id}
                type="number"
                min={1}
                max={3650}
                value={String(settings.backupKeepCount)}
                onChange={(event) => {
                  void updateSettings({ backupKeepCount: Number(event.target.value) }).catch(
                    (error: unknown) => {
                      toast.error(errorMessage(error));
                    },
                  );
                }}
              />
            )}
          </Field>
          <div className="flex items-end pb-1">
            <Switch
              label="Back up automatically on close"
              checked={settings.dailyBackupEnabled}
              onChange={(value) => {
                void updateSettings({ dailyBackupEnabled: value }).catch((error: unknown) => {
                  toast.error(errorMessage(error));
                });
              }}
            />
          </div>
        </div>

        <Button
          variant="primary"
          iconLeft={<Save className="h-4 w-4" />}
          loading={busy}
          onClick={() => {
            void backupNow();
          }}
        >
          Back up now
        </Button>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-[var(--text-primary)]">Restore</p>
        <p className="text-xs text-[var(--text-muted)]">
          Replacing the current data with an earlier backup.
        </p>
        {backups.length === 0 ? (
          <p className="text-sm text-[var(--text-3)]">No backups found.</p>
        ) : (
          backups.map((file) => (
            <div
              key={file.path}
              className="flex items-center justify-between rounded-lg border border-[var(--border)] px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-[var(--text)]">{file.name}</p>
                <p className="text-xs text-[var(--text-3)]">
                  {formatDate(file.modifiedAtIso.slice(0, 10))} · {formatFileSize(file.sizeBytes)}
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                iconLeft={<RotateCcw className="h-4 w-4" />}
                onClick={() => {
                  setRestoreTarget(file);
                }}
              >
                Restore
              </Button>
            </div>
          ))
        )}
      </div>

      {restoreTarget !== null && (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setRestoreTarget(null);
          }}
          title="Restore this backup?"
          message={
            <>
              <p>
                Everything entered since <strong>{restoreTarget.name}</strong> was written will be
                replaced. The app restarts to finish.
              </p>
              <p className="mt-2">Type RESTORE to confirm.</p>
            </>
          }
          confirmLabel="Restore"
          cancelLabel="Cancel"
          destructive
          confirmationWord="RESTORE"
          onConfirm={() => {
            const target = restoreTarget;
            setRestoreTarget(null);
            void (async () => {
              try {
                const result = await bridge().restoreBackup(target.path, "RESTORE");
                if (!result.ok) {
                  toast.error(result.error.message);
                  return;
                }
                toast.success("Backup restored. The app will restart.");
                window.setTimeout(() => {
                  window.location.reload();
                }, 1500);
              } catch (error) {
                toast.error(errorMessage(error));
              }
            })();
          }}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* about                                                                      */
/* -------------------------------------------------------------------------- */

function AboutTab(): React.JSX.Element {
  const { licenseStatus, machineId, settings } = useApp();
  const { status, busy, error, check, download, install } = useUpdates();
  const [info, setInfo] = useState<{ version: string; schemaVersion: number } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const result = await bridge().getAppInfo();
        if (result.ok) {
          setInfo({ version: result.data.version, schemaVersion: result.data.schemaVersion });
        }
      } catch {
        // The About tab is informational; a missing version is not an error.
      }
    })();
  }, []);

  return (
    <div className="space-y-1 text-sm text-[var(--text-2)]">
      <p>
        <span className="text-[var(--text-3)]">Version </span>
        {info?.version ?? "—"}
      </p>
      <p>
        <span className="text-[var(--text-3)]">Data schema </span>
        {info?.schemaVersion ?? "—"}
      </p>
      <p>
        <span className="text-[var(--text-3)]">Developed by </span>
        {settings.vendorName}
      </p>
      <p className="pt-2">
        Stock, sales, purchases, expenses and accounts, all on this computer and working without
        internet.
      </p>

      <div className="pt-4 border-t border-[var(--border)]">
        <p className="text-sm font-medium text-[var(--text)]">Updates</p>

        {status.supported ? (
          <>
            <div className="mt-2 space-y-1">
              <p>
                <span className="text-[var(--text-3)]">Installed version </span>
                {info?.version ?? status.currentVersion ?? "—"}
              </p>
              <p>
                <span className="text-[var(--text-3)]">Latest version </span>
                {status.latestVersion ?? "—"}
              </p>
              <p className="text-[var(--text-3)]">{updateStateText(status.state, error)}</p>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  void check();
                }}
              >
                Check for updates
              </Button>
              {status.state === "available" && (
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => {
                    void download();
                  }}
                >
                  Download the update
                </Button>
              )}
              {status.state === "downloaded" && (
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => {
                    void install();
                  }}
                >
                  Restart and install
                </Button>
              )}
            </div>
          </>
        ) : (
          <p className="mt-1 text-sm text-[var(--text-3)]">
            Updates are checked by the installed application.
          </p>
        )}
      </div>

      <div className="pt-4 border-t border-[var(--border)]">
        <p className="text-sm font-medium text-[var(--text)]">License</p>
        {licenseStatus ? (
          <div className="mt-2 space-y-1">
            <p>
              <span className="text-[var(--text-3)]">Licensed to: </span>
              {licenseStatus.clientName}
            </p>
            <p>
              <span className="text-[var(--text-3)]">Machine ID: </span>
              <code className="text-xs bg-[var(--surface-2)] px-1 rounded">
                {machineId.slice(0, 16)}…
              </code>
            </p>
            {licenseStatus.expiresAt ? (
              <>
                <p>
                  <span className="text-[var(--text-3)]">Expires: </span>
                  {new Date(licenseStatus.expiresAt).toLocaleDateString()}
                </p>
                {licenseStatus.isExpiringSoon && (
                  <p className="text-[var(--warning)]">
                    <span className="text-[var(--text-3)]">⚠ </span>License expires in{" "}
                    {licenseStatus.daysUntilExpiry} day(s)
                  </p>
                )}
              </>
            ) : (
              <p>
                <span className="text-[var(--text-3)]">Expires: </span>Never (perpetual)
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-[var(--text-3)]">No license information available</p>
        )}
      </div>
    </div>
  );
}

/**
 * What the update state means, in one line.
 *
 * The state names are for the code; this sentence is for the person reading
 * it, and it says what happens next rather than what the machine is doing.
 */
function updateStateText(state: UpdateState, error: string | null): string {
  switch (state) {
    case "idle":
      return "Not checked yet.";
    case "checking":
      return "Checking for a newer version…";
    case "available":
      return "A newer version is available.";
    case "upToDate":
      return "This is the newest version.";
    case "downloading":
      return "Downloading the new version…";
    case "downloaded":
      return "Ready to install. The application will close and start again when it is installed.";
    case "error":
      return error ?? "The update could not be completed.";
    default:
      return "";
  }
}

/** Pick a subset of the settings snapshot into a form state object. */
function pick<K extends keyof AppSettingsSnapshot>(
  settings: AppSettingsSnapshot,
  keys: readonly K[],
): Pick<AppSettingsSnapshot, K> {
  const out = {} as Pick<AppSettingsSnapshot, K>;
  for (const key of keys) {
    out[key] = settings[key];
  }
  return out;
}
