/**
 * Forgotten-password reset for the login screen.
 *
 * The customer types the EyerCall secret code they were given, chooses a new
 * password, and the main process performs the reset. The accepted codes live in
 * `src/main/password-recovery.ts` and are never sent to this component, so the
 * renderer can only check that the field was filled in.
 *
 * The copy deliberately tells the customer where to get a code: EyerCall
 * support issues it, and the app itself never displays the codes.
 */

import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import { AlertCircle, Info, KeyRound, ShieldCheck } from "lucide-react";
import { call, errorField, errorMessage } from "../../lib/api";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input } from "../../components/ui/Input";

export interface ForgotPasswordDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Prefills the login name the customer was already trying to use. */
  readonly initialUsername: string;
  readonly onRecovered: (username: string) => void;
}

interface RecoveryForm {
  username: string;
  secretCode: string;
  newPassword: string;
  confirmPassword: string;
}

const EMPTY_FORM: RecoveryForm = {
  username: "",
  secretCode: "",
  newPassword: "",
  confirmPassword: "",
};

export function ForgotPasswordDialog({
  open,
  onOpenChange,
  initialUsername,
  onRecovered,
}: ForgotPasswordDialogProps): React.JSX.Element {
  const formId = useId();
  const [form, setForm] = useState<RecoveryForm>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setForm({ ...EMPTY_FORM, username: initialUsername });
    setError(null);
    setFieldErrors({});
    setBusy(false);
  }, [initialUsername, open]);

  const update = <K extends keyof RecoveryForm>(key: K, value: RecoveryForm[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => {
      if (current[key] === undefined) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
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
    const username = form.username.trim();

    if (username.length === 0) {
      local.username = "Enter the username you sign in with.";
    }
    if (form.secretCode.trim().length === 0) {
      local.secretCode = "Enter the secret code EyerCall gave you.";
    }
    if (form.newPassword.length < 8) {
      local.newPassword = "Use at least 8 characters.";
    } else if (!/[A-Z]/.test(form.newPassword)) {
      local.newPassword = "Include at least one capital letter.";
    } else if (!/[a-z]/.test(form.newPassword)) {
      local.newPassword = "Include at least one small letter.";
    } else if (!/[0-9]/.test(form.newPassword)) {
      local.newPassword = "Include at least one number.";
    }
    if (form.newPassword !== form.confirmPassword) {
      local.confirmPassword = "The two passwords do not match.";
    }

    setFieldErrors(local);
    if (Object.keys(local).length > 0) return;

    setBusy(true);
    setError(null);
    try {
      await call("auth.recoverPassword", {
        username,
        secretCode: form.secretCode,
        newPassword: form.newPassword,
      });
      onOpenChange(false);
      onRecovered(username);
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
      title="Forgot password"
      description="Reset your password with a secret code from EyerCall."
      size="sm"
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
            iconLeft={<KeyRound className="h-4 w-4" />}
          >
            Reset password
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(event) => void submit(event)} noValidate>
        <div className="space-y-4">
          <div className="flex items-start gap-2 rounded-lg border border-[var(--info)]/40 bg-[var(--info-soft)] p-3 text-[12.5px] leading-relaxed text-[var(--info-fg)]">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-medium">Get your secret code from EyerCall.</p>
              <p className="mt-1">
                Contact EyerCall support to receive the secret code for this installation. The app
                does not display the code, so keep the one EyerCall gives you private.
              </p>
            </div>
          </div>

          <Field label="Username" required error={fieldErrors.username}>
            {(id, describedBy) => (
              <Input
                id={id}
                value={form.username}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required
                autoFocus
                aria-describedby={describedBy}
                invalid={fieldErrors.username !== undefined}
                onChange={(event) => {
                  update("username", event.target.value);
                }}
              />
            )}
          </Field>

          <Field
            label="Secret code"
            required
            error={fieldErrors.secretCode}
            hint="Issued by EyerCall support for this computer."
          >
            {(id, describedBy) => (
              <Input
                id={id}
                value={form.secretCode}
                autoComplete="off"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                required
                aria-describedby={describedBy}
                invalid={fieldErrors.secretCode !== undefined}
                onChange={(event) => {
                  update("secretCode", event.target.value);
                }}
              />
            )}
          </Field>

          <Field
            label="New password"
            required
            error={fieldErrors.newPassword}
            hint="At least 8 characters, with a capital letter, a small letter and a number."
          >
            {(id, describedBy) => (
              <Input
                id={id}
                type="password"
                autoComplete="new-password"
                required
                value={form.newPassword}
                aria-describedby={describedBy}
                invalid={fieldErrors.newPassword !== undefined}
                onChange={(event) => {
                  update("newPassword", event.target.value);
                }}
              />
            )}
          </Field>

          <Field label="Confirm new password" required error={fieldErrors.confirmPassword}>
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

          {error !== null && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg border-s-2 border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-2 text-[12.5px] leading-relaxed text-[var(--danger-fg)]"
            >
              <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </p>
          )}

          <p className="flex items-start gap-2 text-[11.5px] leading-relaxed text-[var(--text-3)]">
            <ShieldCheck className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Your business data, licence and other accounts are not changed by a password reset.
          </p>
        </div>
      </form>
    </Dialog>
  );
}
