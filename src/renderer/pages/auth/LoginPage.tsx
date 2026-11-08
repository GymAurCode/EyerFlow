/**
 * Login and first-run setup.
 *
 * The login screen is a split: Eyercall's brand on one side, the sign-in form
 * on the other. The form is short by design - two fields, one button - so
 * everything around it is there to make those two fields feel calm: a panel
 * that says what the software is, a heading that says where you are, and
 * nothing else competing for attention.
 *
 * The authentication itself is untouched. `signIn` is the same call the form
 * always made, with the same service behind it, the same session afterwards
 * and the same failure messages; only the way the form looks and behaves has
 * changed. The password is verified by the main process against the stored
 * scrypt hash, the lockout policy is the one the accounts already run under,
 * and nothing about that is re-implemented here.
 */

import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  Info,
  Lock,
  LogIn,
  Pencil,
  ShieldCheck,
  User,
  UserPlus,
} from "lucide-react";
import type { SetupInput } from "../../lib/app-context";
import type { RegistrationStatus } from "../../../shared/types";
import { useApp } from "../../lib/app-context";
import { call, errorMessage } from "../../lib/api";
import { MONTH_OPTIONS } from "../../lib/select-options";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Field, Input, Select } from "../../components/ui/Input";
import { BrandMark } from "../../components/layout/Sidebar";
import { BrandPanel } from "./BrandPanel";
import {
  CreateRegistrationAccountDialog,
  EditRegistrationDialog,
  RegistrationSuccess,
} from "./RegistrationDialogs";
import { ForgotPasswordDialog } from "./ForgotPasswordDialog";

export function LoginPage(): React.JSX.Element {
  const { signIn, refreshSettings } = useApp();

  const [username, setUsername] = useState(() => {
    // Prefill username from URL hash (set by setup completion)
    const hash = window.location.hash;
    const match = hash.match(/[?&]username=([^&]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  });
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage] = useState(() => {
    const hash = window.location.hash;
    return hash.includes("setup=complete") ? "Setup complete. Please log in to continue." : null;
  });
  const [registrationNotice, setRegistrationNotice] = useState<string | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [registrationStatus, setRegistrationStatus] = useState<RegistrationStatus | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // The login screen is anonymous, so the status call returns only enough to
  // decide whether these options make sense. A failure hides them rather than
  // turning a missing convenience into an error on the sign-in screen.
  useEffect(() => {
    let cancelled = false;
    void call("registration.status", {})
      .then((status) => {
        if (!cancelled) setRegistrationStatus(status);
      })
      .catch(() => {
        if (!cancelled) setRegistrationStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const canManageRegistration =
    registrationStatus?.setupComplete === true && registrationStatus.administratorUsername !== null;

  /**
   * A second click while the first request is still in flight.
   *
   * `busy` cannot do this on its own: the handler closes over the value it
   * had when it was created, so a click landing before the re-render would
   * still see `false` and start a second sign-in on top of the first. The
   * flag is set synchronously, before the first await, and cleared in the
   * same `finally` that clears `busy`.
   */
  const inFlight = useRef(false);

  const usernameRef = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const errorId = useId();

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (inFlight.current) return;

    const name = username.trim();

    // Empty fields are caught here rather than in the main process, so the
    // form can say which field is missing. Everything else - a wrong
    // password, a deactivated account, a locked account - is decided by the
    // service, and its message is shown as it stands.
    if (name.length === 0) {
      setError("Enter the username you sign in with.");
      usernameRef.current?.focus();
      return;
    }
    if (password.length === 0) {
      setError("Enter your password.");
      passwordRef.current?.focus();
      return;
    }

    inFlight.current = true;
    setBusy(true);
    setError(null);

    void signIn(name, password)
      .catch((caught: unknown) => {
        setError(errorMessage(caught));
        // The password is the field a wrong attempt is usually about, so it
        // takes the focus back rather than leaving the caret in a field the
        // user has already corrected.
        passwordRef.current?.focus();
      })
      .finally(() => {
        inFlight.current = false;
        setBusy(false);
      });
  };

  return (
    <div className="flex min-h-full flex-col lg:flex-row">
      <BrandPanel />

      <main className="flex flex-1 items-center justify-center px-5 py-10 sm:px-8 lg:py-12">
        <div className="w-full max-w-[420px] animate-auth-form-in">
          <Card flush>
            <div className="p-6 sm:p-8">
              <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.015em] text-[var(--text)]">
                Welcome back
              </h1>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-[var(--text-2)]">
                Sign in to continue to your EyerStock workspace.
              </p>

              {successMessage !== null && (
                <div className="mt-5 flex items-start gap-2 rounded-lg bg-[var(--success-soft)] px-3 py-2.5 text-[13px] leading-relaxed text-[var(--success-fg)]">
                  <CheckCircle2 className="mt-px h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{successMessage}</span>
                </div>
              )}

              {registrationNotice !== null && <RegistrationSuccess message={registrationNotice} />}

              {recoveryNotice !== null && <RegistrationSuccess message={recoveryNotice} />}

              <form onSubmit={submit} className="mt-6" noValidate>
                <Field label="Username" required>
                  {(id, describedBy) => (
                    <div className="relative">
                      <User
                        className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-[var(--text-3)]"
                        aria-hidden="true"
                      />
                      <Input
                        id={id}
                        ref={usernameRef}
                        aria-describedby={describedBy}
                        value={username}
                        onChange={(event) => {
                          setUsername(event.target.value);
                        }}
                        autoComplete="username"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        className="ps-9"
                        required
                        autoFocus
                      />
                    </div>
                  )}
                </Field>

                <div className="mt-4">
                  <Field label="Password" required>
                    {(id, describedBy) => (
                      <div className="relative">
                        <Lock
                          className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-[var(--text-3)]"
                          aria-hidden="true"
                        />
                        <Input
                          id={id}
                          ref={passwordRef}
                          type={passwordVisible ? "text" : "password"}
                          aria-describedby={
                            error === null
                              ? describedBy
                              : [describedBy, errorId].filter(Boolean).join(" ")
                          }
                          aria-invalid={error !== null}
                          value={password}
                          onChange={(event) => {
                            setPassword(event.target.value);
                          }}
                          autoComplete="current-password"
                          className="ps-9 pe-11"
                          required
                        />
                        {/*
                          The toggle is a real button, so it is reachable by
                          keyboard and announces its own state.

                          Its name comes from the text inside it rather than
                          from `aria-label`, so the control is still "Show
                          password" to a screen reader while a query for the
                          password *field* - by its label - finds the field and
                          only the field.
                        */}
                        <button
                          type="button"
                          onClick={() => {
                            setPasswordVisible((current) => !current);
                          }}
                          aria-pressed={passwordVisible}
                          title={passwordVisible ? "Hide password" : "Show password"}
                          className="absolute inset-y-0 end-0 flex w-11 items-center justify-center rounded-e-lg text-[var(--text-3)] transition-colors duration-fast hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand)]"
                        >
                          <span className="sr-only">
                            {passwordVisible ? "Hide password" : "Show password"}
                          </span>
                          <span className="relative block h-4 w-4" aria-hidden="true">
                            <Eye
                              className={
                                passwordVisible
                                  ? "absolute inset-0 h-4 w-4 scale-100 opacity-100 transition-all duration-fast"
                                  : "absolute inset-0 h-4 w-4 scale-90 opacity-0 transition-all duration-fast"
                              }
                              aria-hidden="true"
                            />
                            <EyeOff
                              className={
                                passwordVisible
                                  ? "absolute inset-0 h-4 w-4 scale-90 opacity-0 transition-all duration-fast"
                                  : "absolute inset-0 h-4 w-4 scale-100 opacity-100 transition-all duration-fast"
                              }
                              aria-hidden="true"
                            />
                          </span>
                        </button>
                      </div>
                    )}
                  </Field>
                </div>

                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      setForgotOpen(true);
                    }}
                    className="rounded text-[12.5px] font-medium text-[var(--brand)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2"
                  >
                    Forgot password?
                  </button>
                </div>

                {/*
                  The message has a home of its own, and that home is the same
                  size whether the message is there or not. An error that
                  arrives by pushing the button down is a layout shift, and a
                  form that moves under the pointer while it is being used is
                  a form people mis-click.

                  The reserved height is two lines of the message plus its
                  padding, so even the longest message the service can return
                  - a locked account, a deactivated one - lands without
                  moving anything.
                */}
                <div className="mt-1 min-h-[40px]">
                  {error !== null && (
                    <p
                      id={errorId}
                      role="alert"
                      className="flex items-start gap-2 rounded-lg border-s-2 border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-1 text-[12.5px] leading-4 text-[var(--danger-fg)]"
                    >
                      <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span>{error}</span>
                    </p>
                  )}
                </div>

                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  className="mt-3 w-full"
                  loading={busy}
                  iconLeft={<LogIn className="h-4 w-4" />}
                >
                  Sign in
                </Button>
              </form>

              {canManageRegistration && (
                <section
                  aria-labelledby="registration-options-heading"
                  className="mt-6 border-t border-[var(--border)] pt-5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2
                        id="registration-options-heading"
                        className="text-[12px] font-semibold uppercase tracking-wide text-[var(--text-3)]"
                      >
                        Registration
                      </h2>
                      <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-3)]">
                        Manage this computer's registration details or add a local account.
                      </p>
                    </div>
                    <ShieldCheck
                      className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-3)]"
                      aria-hidden="true"
                    />
                  </div>

                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setEditOpen(true);
                      }}
                      iconLeft={<Pencil className="h-3.5 w-3.5" />}
                      className="justify-start"
                    >
                      Edit registration details
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setCreateOpen(true);
                      }}
                      iconLeft={<UserPlus className="h-3.5 w-3.5" />}
                      className="justify-start"
                    >
                      Create new account
                    </Button>
                  </div>
                </section>
              )}
            </div>
          </Card>

          {canManageRegistration &&
            registrationStatus !== null &&
            registrationStatus.administratorUsername !== null && (
              <>
                <EditRegistrationDialog
                  open={editOpen}
                  onOpenChange={setEditOpen}
                  username={registrationStatus.administratorUsername}
                  onSaved={async (message) => {
                    setRegistrationNotice(message);
                    await refreshSettings();
                  }}
                />
                <CreateRegistrationAccountDialog
                  open={createOpen}
                  onOpenChange={setCreateOpen}
                  administratorUsername={registrationStatus.administratorUsername}
                  onCreated={(message, createdUsername) => {
                    setRegistrationNotice(message);
                    setUsername(createdUsername);
                    setPassword("");
                    setError(null);
                  }}
                />
              </>
            )}

          <ForgotPasswordDialog
            open={forgotOpen}
            onOpenChange={setForgotOpen}
            initialUsername={username}
            onRecovered={(recoveredUsername) => {
              setRecoveryNotice("Password reset. Sign in with your new password.");
              setRegistrationNotice(null);
              setUsername(recoveredUsername);
              setPassword("");
              setPasswordVisible(false);
              setError(null);
            }}
          />

          {/*
            The app never talks to the network and keeps everything on this
            computer, so the note under the form says exactly that rather than
            the usual reassurance about a server somewhere else.
          */}
          <p className="mt-6 flex items-center justify-center gap-1.5 text-center text-[12px] text-[var(--text-3)]">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Secure desktop access — your data stays on this computer
          </p>
        </div>
      </main>
    </div>
  );
}

export function SetupPage(): React.JSX.Element {
  const { completeSetup } = useApp();

  const [form, setForm] = useState<SetupInput>({
    companyName: "",
    companyTrn: "",
    companyAddress: "",
    companyPhone: "",
    fiscalYearStartMonth: 1,
    adminUsername: "admin",
    adminDisplayName: "",
    adminPassword: "",
    currency: "PKR",
  });

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const update = <K extends keyof SetupInput>(key: K, value: SetupInput[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setError(null);

    void completeSetup(form)
      .catch((caught: unknown) => {
        setError(errorMessage(caught));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div className="min-h-full bg-[var(--page)] px-4 py-8">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Logo header */}
        <div className="text-center">
          <BrandMark className="mx-auto mb-4 h-14 w-14" />
          <p className="text-sm font-semibold text-[var(--text-primary)]">Set up EyerStock</p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            A few details and you are ready to trade.
          </p>
        </div>

        <Card>
          <h1 className="mb-6 text-xl font-semibold text-[var(--text-primary)]">
            Create administrator account
          </h1>

          <form onSubmit={submit} className="space-y-6" noValidate>
            <fieldset className="space-y-4">
              <legend className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                Company details
              </legend>

              <Field label="Company name" required>
                {(id) => (
                  <Input
                    id={id}
                    value={form.companyName}
                    onChange={(event) => {
                      update("companyName", event.target.value);
                    }}
                    autoFocus
                    required
                  />
                )}
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="TRN (tax number)" hint="Printed on every tax invoice.">
                  {(id) => (
                    <Input
                      id={id}
                      value={form.companyTrn}
                      onChange={(event) => {
                        update("companyTrn", event.target.value);
                      }}
                    />
                  )}
                </Field>

                <Field label="Company phone">
                  {(id) => (
                    <Input
                      id={id}
                      value={form.companyPhone}
                      onChange={(event) => {
                        update("companyPhone", event.target.value);
                      }}
                    />
                  )}
                </Field>
              </div>

              <Field label="Company address">
                {(id) => (
                  <Input
                    id={id}
                    value={form.companyAddress}
                    onChange={(event) => {
                      update("companyAddress", event.target.value);
                    }}
                  />
                )}
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Financial year starts in">
                  {(id) => (
                    <Select
                      id={id}
                      value={String(form.fiscalYearStartMonth)}
                      options={MONTH_OPTIONS}
                      onChange={(next) => {
                        update("fiscalYearStartMonth", Number(next));
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
            </fieldset>

            <div className="rounded-lg border border-[var(--info)] bg-[var(--info-soft)] p-3">
              <div className="flex items-start gap-2">
                <Info
                  className="h-4 w-4 shrink-0 mt-0.5 text-[var(--info-fg)]"
                  aria-hidden="true"
                />
                <div className="text-sm text-[var(--info-fg)]">
                  <p className="font-medium">
                    EyerStock trades in Pakistani Rupees. Every invoice, report and export shows
                    amounts as Rs.
                  </p>
                </div>
              </div>
            </div>

            <fieldset className="space-y-4">
              <legend className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                Administrator account
              </legend>

              <Field label="Your name" required>
                {(id) => (
                  <Input
                    id={id}
                    value={form.adminDisplayName}
                    onChange={(event) => {
                      update("adminDisplayName", event.target.value);
                    }}
                    required
                  />
                )}
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Username" required>
                  {(id) => (
                    <Input
                      id={id}
                      value={form.adminUsername}
                      onChange={(event) => {
                        update("adminUsername", event.target.value);
                      }}
                      autoComplete="username"
                      required
                    />
                  )}
                </Field>

                <Field
                  label="Password"
                  required
                  hint="Use at least 8 characters, with a capital letter and a number."
                  error={error}
                >
                  {(id, describedBy) => (
                    <Input
                      id={id}
                      type="password"
                      aria-describedby={describedBy}
                      aria-invalid={error !== null}
                      value={form.adminPassword}
                      onChange={(event) => {
                        update("adminPassword", event.target.value);
                      }}
                      autoComplete="new-password"
                      required
                    />
                  )}
                </Field>
              </div>
            </fieldset>

            {error && (
              <div className="flex items-center gap-2 text-sm text-[var(--danger-fg)] bg-[var(--danger-soft)] rounded-lg p-3">
                {error}
              </div>
            )}

            <Button
              type="submit"
              variant="primary"
              className="w-full"
              loading={busy}
              iconLeft={<ShieldCheck className="h-4 w-4" />}
            >
              Finish setup
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}

/** Card wrapper kept so the setup screen's scroll area has a consistent inset. */
export function SetupCard({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return <Card className="mb-4">{children}</Card>;
}
