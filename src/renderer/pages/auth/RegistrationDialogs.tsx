/**
 * Registration management on the login screen.
 *
 * Both dialogs are deliberately thin: the main process verifies the licence,
 * the laptop it is bound to and the administrator password, and writes the
 * existing records. Nothing here receives a machine id or a licence key.
 *
 * Editing changes the same `settings` rows and administrator row the setup
 * wizard created. Creating an account adds one user row to the same database;
 * it never issues a licence and never replaces an existing account.
 */

import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import { AlertCircle, CheckCircle2, Info, KeyRound, ShieldCheck, UserPlus } from "lucide-react";
import type { RegistrationAccountRole, RegistrationDetails } from "../../../shared/types";
import { call, errorField, errorMessage } from "../../lib/api";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input, Select, Textarea } from "../../components/ui/Input";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

function formatExpiry(iso: string | null): string {
  if (iso === null || iso.length === 0) return "No expiry date";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function Banner({
  tone,
  icon,
  children,
}: {
  readonly tone: "info" | "warning" | "success";
  readonly icon: React.ReactNode;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const classes =
    tone === "success"
      ? "border-[var(--success)]/40 bg-[var(--success-soft)] text-[var(--success-fg)]"
      : tone === "warning"
        ? "border-[var(--warning)]/40 bg-[var(--warning-soft)] text-[var(--warning)]"
        : "border-[var(--info)]/40 bg-[var(--info-soft)] text-[var(--info-fg)]";

  return (
    <div
      className={`flex items-start gap-2 rounded-lg border p-3 text-[12.5px] leading-relaxed ${classes}`}
    >
      <span className="mt-0.5 shrink-0" aria-hidden="true">
        {icon}
      </span>
      <div>{children}</div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* edit registration details                                                  */
/* -------------------------------------------------------------------------- */

export interface EditRegistrationDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The stable registration owner shown by `registration.status`. */
  readonly username: string;
  readonly onSaved: (message: string) => void | Promise<void>;
}

export function EditRegistrationDialog({
  open,
  onOpenChange,
  username,
  onSaved,
}: EditRegistrationDialogProps): React.JSX.Element {
  const formId = useId();
  const [password, setPassword] = useState("");
  const [details, setDetails] = useState<RegistrationDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPassword("");
    setDetails(null);
    setError(null);
    setFieldErrors({});
    setBusy(false);
  }, [open]);

  const fail = (caught: unknown): void => {
    const field = errorField(caught);
    const message = errorMessage(caught);
    if (field !== undefined) {
      setFieldErrors((current) => ({ ...current, [field]: message }));
    } else {
      setError(message);
    }
  };

  const unlock = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;

    if (password.length === 0) {
      setFieldErrors({ password: "Enter the registration owner's password." });
      return;
    }

    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      setDetails(
        await call("registration.details", {
          username,
          password,
        }),
      );
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  };

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (details === null || busy) return;

    const local: Record<string, string> = {};
    if (details.companyName.trim().length === 0) {
      local.companyName = "Enter the business name.";
    }
    if (details.ownerName.trim().length === 0) {
      local.ownerName = "Enter the registration owner's name.";
    }
    if (details.companyEmail.trim().length > 0 && !isEmail(details.companyEmail)) {
      local.companyEmail = "Enter a valid email address, or leave it blank.";
    }
    if (details.ownerEmail.trim().length > 0 && !isEmail(details.ownerEmail)) {
      local.ownerEmail = "Enter a valid email address, or leave it blank.";
    }
    setFieldErrors(local);
    if (Object.keys(local).length > 0) return;

    setBusy(true);
    setError(null);
    try {
      await call("registration.update", {
        username,
        password,
        companyName: details.companyName,
        companyTrn: details.companyTrn,
        companyAddress: details.companyAddress,
        companyPhone: details.companyPhone,
        companyEmail: details.companyEmail,
        ownerName: details.ownerName,
        ownerEmail: details.ownerEmail,
        ownerPhone: details.ownerPhone,
      });
      onOpenChange(false);
      await onSaved(
        "Registration details updated. Your licence and business data were not changed.",
      );
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  };

  const updateDetail = <K extends keyof RegistrationDetails>(
    key: K,
    value: RegistrationDetails[K],
  ): void => {
    setDetails((current) => (current === null ? current : { ...current, [key]: value }));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={details === null ? "Edit registration details" : "Registration details"}
      description={
        details === null
          ? "Confirm the registration owner's password to see the existing details."
          : "These are the details stored on this computer."
      }
      size="lg"
      busy={busy}
      footer={
        details === null ? (
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
              type="submit"
              form={formId}
              loading={busy}
              iconLeft={<KeyRound className="h-4 w-4" />}
            >
              Show details
            </Button>
          </>
        ) : (
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
              type="submit"
              form={formId}
              loading={busy}
              iconLeft={<ShieldCheck className="h-4 w-4" />}
            >
              Save details
            </Button>
          </>
        )
      }
    >
      {details === null ? (
        <form id={formId} onSubmit={(event) => void unlock(event)} noValidate>
          <div className="space-y-4">
            <Banner tone="info" icon={<KeyRound className="h-4 w-4" />}>
              Registration details belong to this installation. They are only shown after the
              registration owner proves their password.
            </Banner>

            <Field label="Registration owner">
              {(id) => <Input id={id} value={username} readOnly autoComplete="username" />}
            </Field>

            <Field
              label="Owner password"
              required
              error={fieldErrors.password}
              hint="The account created when this copy of EyerStock was set up."
            >
              {(id, describedBy) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="current-password"
                  autoFocus
                  required
                  value={password}
                  aria-describedby={describedBy}
                  invalid={fieldErrors.password !== undefined}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setFieldErrors((current) => {
                      const next = { ...current };
                      delete next.password;
                      return next;
                    });
                  }}
                />
              )}
            </Field>

            {error !== null && (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-lg border-s-2 border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-2 text-[12.5px] leading-relaxed text-[var(--danger-fg)]"
              >
                <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{error}</span>
              </p>
            )}
          </div>
        </form>
      ) : (
        <form id={formId} onSubmit={(event) => void save(event)} noValidate>
          <div className="space-y-5">
            <Banner tone="info" icon={<ShieldCheck className="h-4 w-4" />}>
              Saving updates the existing registration and owner account. It does not change the
              licence, this computer's binding, any other account, or your business records.
            </Banner>

            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
                Licence
              </p>
              <div className="mt-2 grid gap-2 text-[12.5px] sm:grid-cols-2">
                <div>
                  <p className="text-[var(--text-3)]">Licensed to</p>
                  <p className="font-medium text-[var(--text)]">
                    {details.licensedClientName.length > 0
                      ? details.licensedClientName
                      : "Development licence"}
                  </p>
                </div>
                <div>
                  <p className="text-[var(--text-3)]">Edition</p>
                  <p className="font-medium text-[var(--text)]">
                    {details.edition.length > 0 ? details.edition : "Development"}
                  </p>
                </div>
                <div>
                  <p className="text-[var(--text-3)]">Valid until</p>
                  <p className="font-medium text-[var(--text)]">
                    {formatExpiry(details.expiresAt)}
                  </p>
                </div>
              </div>
              <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--text-3)]">
                The licensed customer name is signed inside the key, so it is read-only here.
                Business details below can be corrected without re-activating.
              </p>
            </div>

            <fieldset className="space-y-4">
              <legend className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
                Business details
              </legend>

              <Field label="Business name" required error={fieldErrors.companyName}>
                {(id, describedBy) => (
                  <Input
                    id={id}
                    value={details.companyName}
                    required
                    aria-describedby={describedBy}
                    invalid={fieldErrors.companyName !== undefined}
                    onChange={(event) => {
                      updateDetail("companyName", event.target.value);
                    }}
                  />
                )}
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="TRN (tax number)" error={fieldErrors.companyTrn}>
                  {(id, describedBy) => (
                    <Input
                      id={id}
                      value={details.companyTrn}
                      aria-describedby={describedBy}
                      onChange={(event) => {
                        updateDetail("companyTrn", event.target.value);
                      }}
                    />
                  )}
                </Field>

                <Field label="Business phone" error={fieldErrors.companyPhone}>
                  {(id, describedBy) => (
                    <Input
                      id={id}
                      value={details.companyPhone}
                      aria-describedby={describedBy}
                      onChange={(event) => {
                        updateDetail("companyPhone", event.target.value);
                      }}
                    />
                  )}
                </Field>
              </div>

              <Field
                label="Business email"
                error={fieldErrors.companyEmail}
                hint="Shown on invoices and reports when set."
              >
                {(id, describedBy) => (
                  <Input
                    id={id}
                    type="email"
                    autoComplete="email"
                    value={details.companyEmail}
                    aria-describedby={describedBy}
                    invalid={fieldErrors.companyEmail !== undefined}
                    onChange={(event) => {
                      updateDetail("companyEmail", event.target.value);
                    }}
                  />
                )}
              </Field>

              <Field label="Business address" error={fieldErrors.companyAddress}>
                {(id, describedBy) => (
                  <Textarea
                    id={id}
                    value={details.companyAddress}
                    aria-describedby={describedBy}
                    onChange={(event) => {
                      updateDetail("companyAddress", event.target.value);
                    }}
                  />
                )}
              </Field>
            </fieldset>

            <fieldset className="space-y-4">
              <legend className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
                Registration owner
              </legend>

              <Field label="Owner name" required error={fieldErrors.ownerName}>
                {(id, describedBy) => (
                  <Input
                    id={id}
                    value={details.ownerName}
                    required
                    aria-describedby={describedBy}
                    invalid={fieldErrors.ownerName !== undefined}
                    onChange={(event) => {
                      updateDetail("ownerName", event.target.value);
                    }}
                  />
                )}
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Owner email" error={fieldErrors.ownerEmail}>
                  {(id, describedBy) => (
                    <Input
                      id={id}
                      type="email"
                      autoComplete="email"
                      value={details.ownerEmail}
                      aria-describedby={describedBy}
                      invalid={fieldErrors.ownerEmail !== undefined}
                      onChange={(event) => {
                        updateDetail("ownerEmail", event.target.value);
                      }}
                    />
                  )}
                </Field>

                <Field label="Owner phone" error={fieldErrors.ownerPhone}>
                  {(id, describedBy) => (
                    <Input
                      id={id}
                      value={details.ownerPhone}
                      aria-describedby={describedBy}
                      onChange={(event) => {
                        updateDetail("ownerPhone", event.target.value);
                      }}
                    />
                  )}
                </Field>
              </div>
            </fieldset>

            {error !== null && (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-lg border-s-2 border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-2 text-[12.5px] leading-relaxed text-[var(--danger-fg)]"
              >
                <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{error}</span>
              </p>
            )}
          </div>
        </form>
      )}
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* create a new local account                                                 */
/* -------------------------------------------------------------------------- */

export interface CreateRegistrationAccountDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Prefilled with the registration owner, but another administrator may sign. */
  readonly administratorUsername: string;
  readonly onCreated: (message: string, username: string) => void | Promise<void>;
}

interface CreateForm {
  authorizedUsername: string;
  authorizedPassword: string;
  username: string;
  displayName: string;
  email: string;
  phone: string;
  password: string;
  confirmPassword: string;
  role: RegistrationAccountRole;
}

export function CreateRegistrationAccountDialog({
  open,
  onOpenChange,
  administratorUsername,
  onCreated,
}: CreateRegistrationAccountDialogProps): React.JSX.Element {
  const formId = useId();
  const [form, setForm] = useState<CreateForm>({
    authorizedUsername: administratorUsername,
    authorizedPassword: "",
    username: "",
    displayName: "",
    email: "",
    phone: "",
    password: "",
    confirmPassword: "",
    role: "Staff",
  });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setForm({
      authorizedUsername: administratorUsername,
      authorizedPassword: "",
      username: "",
      displayName: "",
      email: "",
      phone: "",
      password: "",
      confirmPassword: "",
      role: "Staff",
    });
    setError(null);
    setFieldErrors({});
    setBusy(false);
  }, [administratorUsername, open]);

  const update = <K extends keyof CreateForm>(key: K, value: CreateForm[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const fail = (caught: unknown): void => {
    const field = errorField(caught);
    const message = errorMessage(caught);
    if (field !== undefined) {
      setFieldErrors((current) => ({ ...current, [field]: message }));
    } else {
      setError(message);
    }
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;

    const local: Record<string, string> = {};
    if (form.authorizedUsername.trim().length === 0) {
      local.authorizedUsername = "Enter an administrator username.";
    }
    if (form.authorizedPassword.length === 0) {
      local.authorizedPassword = "Enter that administrator's password.";
    }
    if (form.username.trim().length < 3) {
      local.username = "Use at least 3 characters.";
    }
    if (form.displayName.trim().length === 0) {
      local.displayName = "Enter the person's name.";
    }
    if (form.email.trim().length > 0 && !isEmail(form.email)) {
      local.email = "Enter a valid email address, or leave it blank.";
    }
    if (form.password.length < 8) {
      local.password = "Use at least 8 characters.";
    } else if (!/[A-Z]/.test(form.password)) {
      local.password = "Include at least one capital letter.";
    } else if (!/[a-z]/.test(form.password)) {
      local.password = "Include at least one small letter.";
    } else if (!/[0-9]/.test(form.password)) {
      local.password = "Include at least one number.";
    }
    if (form.password !== form.confirmPassword) {
      local.confirmPassword = "The two passwords do not match.";
    }

    setFieldErrors(local);
    if (Object.keys(local).length > 0) return;

    setBusy(true);
    setError(null);
    try {
      const created = await call("registration.createAccount", {
        authorizedUsername: form.authorizedUsername,
        authorizedPassword: form.authorizedPassword,
        username: form.username,
        displayName: form.displayName,
        email: form.email,
        phone: form.phone,
        password: form.password,
        role: form.role,
      });
      onOpenChange(false);
      await onCreated(
        `Account "${created.username}" was created. It shares this computer's licence and business data.`,
        created.username,
      );
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create new account"
      description="Add a local account to this same installation."
      size="lg"
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
            type="submit"
            form={formId}
            loading={busy}
            iconLeft={<UserPlus className="h-4 w-4" />}
          >
            Create account
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(event) => void submit(event)} noValidate>
        <div className="space-y-5">
          <Banner tone="warning" icon={<Info className="h-4 w-4" />}>
            <p className="font-medium">This does not create or extend a licence.</p>
            <p className="mt-1">
              The new account runs under this computer's existing licence and uses the same business
              database. It can see the same products, sales, purchases and reports that its role
              allows. Existing accounts and business data are not replaced, copied or deleted.
            </p>
          </Banner>

          <fieldset className="space-y-4">
            <legend className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
              Authorise this change
            </legend>

            <Banner tone="info" icon={<KeyRound className="h-4 w-4" />}>
              An existing administrator must approve the new account. Their password is checked
              against the same lockout policy as sign-in.
            </Banner>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Administrator username" required error={fieldErrors.authorizedUsername}>
                {(id, describedBy) => (
                  <Input
                    id={id}
                    value={form.authorizedUsername}
                    autoComplete="username"
                    required
                    aria-describedby={describedBy}
                    invalid={fieldErrors.authorizedUsername !== undefined}
                    onChange={(event) => {
                      update("authorizedUsername", event.target.value);
                    }}
                  />
                )}
              </Field>

              <Field label="Administrator password" required error={fieldErrors.authorizedPassword}>
                {(id, describedBy) => (
                  <Input
                    id={id}
                    type="password"
                    autoComplete="current-password"
                    required
                    value={form.authorizedPassword}
                    aria-describedby={describedBy}
                    invalid={fieldErrors.authorizedPassword !== undefined}
                    onChange={(event) => {
                      update("authorizedPassword", event.target.value);
                    }}
                  />
                )}
              </Field>
            </div>
          </fieldset>

          <fieldset className="space-y-4">
            <legend className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
              New account
            </legend>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Username" required error={fieldErrors.username}>
                {(id, describedBy) => (
                  <Input
                    id={id}
                    value={form.username}
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    required
                    aria-describedby={describedBy}
                    invalid={fieldErrors.username !== undefined}
                    onChange={(event) => {
                      update("username", event.target.value);
                    }}
                  />
                )}
              </Field>

              <Field label="Person's name" required error={fieldErrors.displayName}>
                {(id, describedBy) => (
                  <Input
                    id={id}
                    value={form.displayName}
                    autoComplete="name"
                    required
                    aria-describedby={describedBy}
                    invalid={fieldErrors.displayName !== undefined}
                    onChange={(event) => {
                      update("displayName", event.target.value);
                    }}
                  />
                )}
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Email" error={fieldErrors.email}>
                {(id, describedBy) => (
                  <Input
                    id={id}
                    type="email"
                    autoComplete="email"
                    value={form.email}
                    aria-describedby={describedBy}
                    invalid={fieldErrors.email !== undefined}
                    onChange={(event) => {
                      update("email", event.target.value);
                    }}
                  />
                )}
              </Field>

              <Field label="Phone" error={fieldErrors.phone}>
                {(id, describedBy) => (
                  <Input
                    id={id}
                    value={form.phone}
                    autoComplete="tel"
                    aria-describedby={describedBy}
                    invalid={fieldErrors.phone !== undefined}
                    onChange={(event) => {
                      update("phone", event.target.value);
                    }}
                  />
                )}
              </Field>
            </div>

            <Field label="Account type" hint="Administrator sees settings and user management.">
              {(id) => (
                <Select
                  id={id}
                  value={form.role}
                  options={[
                    { value: "Staff", label: "Staff" },
                    { value: "Administrator", label: "Administrator" },
                  ]}
                  onChange={(next) => {
                    update("role", next === "Administrator" ? "Administrator" : "Staff");
                  }}
                />
              )}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="New account password"
                required
                error={fieldErrors.password}
                hint="At least 8 characters, with a capital letter, a small letter and a number."
              >
                {(id, describedBy) => (
                  <Input
                    id={id}
                    type="password"
                    autoComplete="new-password"
                    required
                    value={form.password}
                    aria-describedby={describedBy}
                    invalid={fieldErrors.password !== undefined}
                    onChange={(event) => {
                      update("password", event.target.value);
                    }}
                  />
                )}
              </Field>

              <Field label="Confirm password" required error={fieldErrors.confirmPassword}>
                {(id, describedBy) => (
                  <Input
                    id={id}
                    type="password"
                    autoComplete="new-password"
                    required
                    value={form.confirmPassword}
                    aria-describedby={describedBy}
                    invalid={fieldErrors.confirmPassword !== undefined}
                    onChange={(event) => {
                      update("confirmPassword", event.target.value);
                    }}
                  />
                )}
              </Field>
            </div>
          </fieldset>

          {error !== null && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg border-s-2 border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-2 text-[12.5px] leading-relaxed text-[var(--danger-fg)]"
            >
              <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </p>
          )}
        </div>
      </form>
    </Dialog>
  );
}

/** Shared success banner used by the login screen after either flow. */
export function RegistrationSuccess({ message }: { readonly message: string }): React.JSX.Element {
  return (
    <div className="mt-4 flex items-start gap-2 rounded-lg bg-[var(--success-soft)] px-3 py-2.5 text-[13px] leading-relaxed text-[var(--success-fg)]">
      <CheckCircle2 className="mt-px h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}
