/**
 * Profile: the signed-in user's own account.
 *
 * Everything here is about one person - the session user. No screen takes a user
 * id, and none of the handlers below accept one, so there is nothing for a
 * tampered renderer to aim at another account.
 *
 * The page is one read and two writes, all through the existing RPC layer:
 *
 *   profile.get           the record, plus the picture as a data URL
 *   profile.update        name, email, phone, chosen picture
 *   profile.removeAvatar  back to initials
 *   auth.changePassword   the existing password flow, unchanged
 *
 * The picture is chosen through the main process and comes back as a file name
 * already written into the app's avatars folder, so nothing here deals in
 * browser object URLs and a saved picture survives a restart.
 *
 * Layout is two columns on a wide window and one on a narrow one, because the
 * left column - who you are - is an overview and the right column is a form.
 * Everything is built from the same Card, Field and Button primitives as the
 * rest of the app, so it themes with the rest of it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BadgeCheck,
  Building2,
  CalendarDays,
  Camera,
  KeyRound,
  Mail,
  Pencil,
  Phone,
  ShieldCheck,
  Trash2,
  User as UserIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Avatar } from "../components/ui/Avatar";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardFooter, CardHeader } from "../components/ui/Card";
import { Field, Input } from "../components/ui/Input";
import { Dialog } from "../components/ui/Dialog";
import { useApp } from "../lib/app-context";
import { call, errorMessage } from "../lib/api";
import type { ProfileDto } from "../../shared/types";

/** A deliberately permissive check; the authoritative one runs in the main process. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ProfileForm {
  readonly displayName: string;
  readonly email: string;
  readonly phone: string;
  /**
   * The picture to save, as a file name the main process produced. `undefined`
   * means "not changing the picture", "" means "go back to initials".
   */
  readonly avatarPath: string | undefined;
}

const EMPTY_FORM: ProfileForm = {
  displayName: "",
  email: "",
  phone: "",
  avatarPath: undefined,
};

export function ProfilePage(): React.JSX.Element {
  const { refreshSession } = useApp();

  const [profile, setProfile] = useState<ProfileDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<ProfileForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof ProfileForm, string>>>({});

  const [passwordOpen, setPasswordOpen] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const next = await call("profile.get", {});
      setProfile(next);
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const startEditing = useCallback((): void => {
    if (profile === null) return;
    setForm({
      displayName: profile.displayName,
      email: profile.email ?? "",
      phone: profile.phone ?? "",
      avatarPath: undefined,
    });
    setErrors({});
    setEditing(true);
  }, [profile]);

  const cancelEditing = useCallback((): void => {
    setEditing(false);
    setErrors({});
    setForm(EMPTY_FORM);
  }, []);

  const save = useCallback(async (): Promise<void> => {
    if (profile === null) return;

    const trimmedName = form.displayName.trim();
    const trimmedEmail = form.email.trim();
    const trimmedPhone = form.phone.trim();

    const nextErrors: Partial<Record<"displayName" | "email" | "phone", string>> = {};
    if (trimmedName.length === 0) {
      nextErrors.displayName = "Enter the name people should see.";
    } else if (trimmedName.length > 120) {
      nextErrors.displayName = "That name is too long.";
    }
    if (trimmedEmail.length > 0 && !EMAIL_PATTERN.test(trimmedEmail)) {
      nextErrors.email = "Enter a valid email address, or leave it empty.";
    }
    if (trimmedPhone.length > 40) {
      nextErrors.phone = "That number is too long.";
    }

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSaving(true);
    try {
      await call("profile.update", {
        displayName: trimmedName,
        email: trimmedEmail,
        phone: trimmedPhone,
        // Omitted entirely when the picture was not touched, which the main
        // process reads as "keep what is stored".
        ...(form.avatarPath === undefined ? {} : { avatarPath: form.avatarPath }),
      });
      setEditing(false);
      setForm(EMPTY_FORM);
      await Promise.all([load(), refreshSession()]);
      toast.success("Profile saved.");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }, [form, profile, load, refreshSession]);

  /**
   * Choose a picture.
   *
   * The main process copies the file into the app's avatars folder and returns
   * its name; nothing is stored against the account until Save, so Cancel really
   * does cancel. Nothing here uses a browser object URL as a saved path.
   */
  const choosePicture = useCallback(async (): Promise<void> => {
    setPicking(true);
    try {
      const result = await call("profile.chooseAvatar", {});
      setForm((current) => ({ ...current, avatarPath: result.name }));
      toast.success("Picture selected. Save changes to keep it.");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPicking(false);
    }
  }, []);

  /** Queue a removal. Like choosing, it only takes effect on Save. */
  const removePicture = useCallback((): void => {
    setForm((current) => ({ ...current, avatarPath: "" }));
  }, []);

  /**
   * The preview shown while editing.
   *
   * A freshly chosen file is known only to the main process, so the preview is
   * the saved file read back rather than a blob URL that would die with the tab.
   */
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!editing || form.avatarPath === undefined) {
      setPreviewUrl(profile?.avatarDataUrl ?? null);
      return;
    }
    if (form.avatarPath === "") {
      setPreviewUrl(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const next = await call("profile.get", {});
        if (!cancelled) setPreviewUrl(next.avatarDataUrl);
      } catch {
        if (!cancelled) setPreviewUrl(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editing, form.avatarPath, profile?.avatarDataUrl]);

  const shownAvatar = useMemo(() => {
    if (editing && previewUrl !== null) return previewUrl;
    return profile?.avatarDataUrl ?? null;
  }, [editing, previewUrl, profile?.avatarDataUrl]);

  if (loading && profile === null) {
    return (
      <div className="card p-10 text-center text-sm text-ink-secondary">Loading your profile…</div>
    );
  }

  if (loadError !== null || profile === null) {
    return (
      <div className="card p-8 text-center">
        <p className="text-sm font-medium text-ink">Your profile could not be loaded.</p>
        <p className="mt-1 text-sm text-ink-secondary">{loadError ?? "Please try again."}</p>
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Overview */}
      <Card>
        <CardBody>
          <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-center">
            <Avatar
              name={profile.displayName}
              size="lg"
              src={shownAvatar}
              className="h-20 w-20 text-lg"
            />

            <div className="min-w-0 flex-1">
              <h2 className="truncate text-xl font-semibold text-[var(--text)]">
                {profile.displayName}
              </h2>
              <p className="mt-0.5 truncate text-[13px] text-[var(--text-2)]">
                {profile.email === null || profile.email.length === 0
                  ? "No email address set"
                  : profile.email}
              </p>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--glass-border)] bg-[var(--surface-2)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--text-2)]">
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                  {profile.roleName ?? "User"}
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--glass-border)] bg-[var(--surface-2)] px-2.5 py-1 text-[11.5px] text-[var(--text-3)]">
                  <UserIcon className="h-3.5 w-3.5" aria-hidden="true" />
                  {profile.username}
                </span>
              </div>
            </div>

            {!editing && (
              <Button
                variant="secondary"
                onClick={startEditing}
                iconLeft={<Pencil className="h-4 w-4" />}
              >
                Edit profile
              </Button>
            )}
          </div>
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
        {/* Details */}
        <Card>
          <CardHeader
            title="Personal information"
            description={editing ? "Changes are saved to this computer." : undefined}
          />
          <CardBody>
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (editing) void save();
              }}
            >
              {/* Picture */}
              <div className="flex items-center gap-4">
                <Avatar
                  name={
                    editing && form.displayName.trim().length > 0
                      ? form.displayName
                      : profile.displayName
                  }
                  size="lg"
                  src={shownAvatar}
                  className="h-16 w-16 text-base"
                />
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  {editing ? (
                    <>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => void choosePicture()}
                        loading={picking}
                        iconLeft={<Camera className="h-4 w-4" />}
                      >
                        {form.avatarPath === undefined && profile.avatarDataUrl === null
                          ? "Choose picture"
                          : "Replace"}
                      </Button>
                      {(profile.avatarDataUrl !== null || form.avatarPath !== undefined) && (
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={removePicture}
                          iconLeft={<Trash2 className="h-4 w-4" />}
                        >
                          Remove
                        </Button>
                      )}
                    </>
                  ) : (
                    <p className="text-[12.5px] text-[var(--text-3)]">
                      {profile.avatarDataUrl === null ? "Using your initials." : "Custom picture."}
                    </p>
                  )}
                </div>
              </div>

              <Field label="Full name" required error={errors.displayName}>
                {(id, describedBy) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    // Read-only shows what is stored; `form` is the draft and is
                    // only populated once editing begins.
                    value={editing ? form.displayName : profile.displayName}
                    disabled={!editing}
                    invalid={errors.displayName !== undefined}
                    maxLength={120}
                    onChange={(event) => {
                      setForm((current) => ({ ...current, displayName: event.target.value }));
                    }}
                  />
                )}
              </Field>

              <Field
                label="Email address"
                error={errors.email}
                hint={
                  editing
                    ? "Used for your account details only. Your sign-in name does not change."
                    : undefined
                }
              >
                {(id, describedBy) => (
                  <Input
                    id={id}
                    type="email"
                    aria-describedby={describedBy}
                    value={editing ? form.email : (profile.email ?? "")}
                    disabled={!editing}
                    invalid={errors.email !== undefined}
                    maxLength={254}
                    placeholder="you@example.com"
                    onChange={(event) => {
                      setForm((current) => ({ ...current, email: event.target.value }));
                    }}
                  />
                )}
              </Field>

              <Field label="Phone number" error={errors.phone} hint="Optional.">
                {(id, describedBy) => (
                  <Input
                    id={id}
                    type="tel"
                    aria-describedby={describedBy}
                    value={editing ? form.phone : (profile.phone ?? "")}
                    disabled={!editing}
                    invalid={errors.phone !== undefined}
                    maxLength={40}
                    placeholder="+971 50 000 0000"
                    onChange={(event) => {
                      setForm((current) => ({ ...current, phone: event.target.value }));
                    }}
                  />
                )}
              </Field>
            </form>
          </CardBody>

          {editing && (
            <CardFooter>
              <Button variant="ghost" onClick={cancelEditing} disabled={saving}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => void save()}
                loading={saving}
                iconLeft={<BadgeCheck className="h-4 w-4" />}
              >
                Save changes
              </Button>
            </CardFooter>
          )}
        </Card>

        {/* Security + account information */}
        <div className="space-y-5">
          <Card>
            <CardHeader
              title="Security"
              description="Your password is stored as a scrypt hash and never in plain text."
            />
            <CardBody>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="glass-chip chip-brand flex h-9 w-9 shrink-0 items-center justify-center">
                    <KeyRound className="h-4 w-4 text-[var(--brand)]" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-[var(--text)]">Password</p>
                    <p className="truncate text-[12px] text-[var(--text-3)]">
                      {profile.lastLoginAt === null
                        ? "This is your first session on this computer."
                        : `Last signed in ${formatWhen(profile.lastLoginAt)}`}
                    </p>
                  </div>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setPasswordOpen(true);
                  }}
                  iconLeft={<KeyRound className="h-4 w-4" />}
                >
                  Change password
                </Button>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Account"
              description="Read-only. Changing these is an administrator's job."
            />
            <CardBody>
              <dl className="space-y-3">
                <DetailRow
                  icon={<UserIcon className="h-4 w-4" />}
                  label="Sign-in name"
                  value={profile.username}
                />
                <DetailRow
                  icon={<ShieldCheck className="h-4 w-4" />}
                  label="Role"
                  value={profile.roleName ?? "User"}
                />
                <DetailRow
                  icon={<Building2 className="h-4 w-4" />}
                  label="Business"
                  value={profile.companyName}
                />
                <DetailRow
                  icon={<CalendarDays className="h-4 w-4" />}
                  label="Account created"
                  value={formatWhen(profile.createdAt)}
                />
                <DetailRow
                  icon={<Mail className="h-4 w-4" />}
                  label="Last sign-in"
                  value={formatWhen(profile.lastLoginAt)}
                />
                <DetailRow
                  icon={<Phone className="h-4 w-4" />}
                  label="Phone"
                  value={
                    profile.phone === null || profile.phone.length === 0 ? "Not set" : profile.phone
                  }
                />
              </dl>
            </CardBody>
          </Card>
        </div>
      </div>

      <PasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
    </div>
  );
}

/** One read-only line in the account summary. */
function DetailRow({
  icon,
  label,
  value,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly value: string;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-2)] text-[var(--text-3)]">
        {icon}
      </span>
      <dt className="w-[130px] shrink-0 text-[12.5px] text-[var(--text-3)]">{label}</dt>
      <dd className="min-w-0 flex-1 truncate text-[13px] text-[var(--text)]">{value}</dd>
    </div>
  );
}

/** A short, readable date, or an honest "unknown". */
function formatWhen(iso: string | null): string {
  if (iso === null || iso.length === 0) return "Not recorded";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "Not recorded";
  return parsed.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * Change password.
 *
 * This calls the existing `auth.changePassword` handler, which verifies the
 * current password against the stored scrypt hash, enforces the password
 * policy, re-salt-and-hash the new one and writes an audit entry. Nothing about
 * it is re-implemented here.
 */
function PasswordDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setErrors({});
  }, [open]);

  const submit = useCallback(async (): Promise<void> => {
    const nextErrors: Record<string, string> = {};
    if (currentPassword.length === 0) nextErrors.current = "Enter your current password.";
    if (newPassword.length < 8) nextErrors.new = "Use at least 8 characters.";
    if (newPassword !== confirmPassword) nextErrors.confirm = "The two passwords do not match.";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSaving(true);
    try {
      await call("auth.changePassword", { currentPassword, newPassword });
      toast.success("Password changed.");
      onOpenChange(false);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }, [currentPassword, newPassword, confirmPassword, onOpenChange]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Change password"
      description="You will stay signed in on this computer."
      size="sm"
      busy={saving}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
            }}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={saving}
            onClick={() => {
              void submit();
            }}
          >
            Change password
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Current password" required error={errors.current}>
          {(id, describedBy) => (
            <Input
              id={id}
              type="password"
              autoComplete="current-password"
              aria-describedby={describedBy}
              value={currentPassword}
              invalid={errors.current !== undefined}
              onChange={(event) => {
                setCurrentPassword(event.target.value);
              }}
            />
          )}
        </Field>

        <Field label="New password" required error={errors.new} hint="At least 8 characters.">
          {(id, describedBy) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              aria-describedby={describedBy}
              value={newPassword}
              invalid={errors.new !== undefined}
              onChange={(event) => {
                setNewPassword(event.target.value);
              }}
            />
          )}
        </Field>

        <Field label="Confirm new password" required error={errors.confirm}>
          {(id, describedBy) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              aria-describedby={describedBy}
              value={confirmPassword}
              invalid={errors.confirm !== undefined}
              onChange={(event) => {
                setConfirmPassword(event.target.value);
              }}
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}
