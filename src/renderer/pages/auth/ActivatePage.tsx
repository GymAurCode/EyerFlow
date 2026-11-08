/**
 * Activate screen - shown when no valid license is found.
 */

import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { Copy, Check } from "lucide-react";
import { useApp } from "../../lib/app-context";
import { copyText } from "../../lib/clipboard";
import { errorMessage } from "../../lib/api";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Field, Input } from "../../components/ui/Input";
import { toast } from "sonner";

export function ActivatePage(): React.JSX.Element {
  const { activateLicense, machineId } = useApp();

  const [licenseKey, setLicenseKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyMachineId = async (): Promise<void> => {
    try {
      await copyText(machineId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Could not copy. Select the ID and press Ctrl+C instead.");
    }
  };

  /**
   * Guards a second activation while the first is still in flight.
   *
   * `busy` state cannot do this on its own: the handler closes over the value
   * it had when it was created, so a second click landing before the re-render
   * would still see `false` and start a second activation on top of the first.
   */
  const inFlight = useRef(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();

    // Set synchronously, before the first await, so a second click during the
    // round trip cannot start another one.
    if (inFlight.current) return;
    inFlight.current = true;

    setBusy(true);
    setError(null);

    try {
      await activateLicense(licenseKey);
      toast.success("License activated successfully");
    } catch (caught: unknown) {
      // One message, in one place: under the field. It used to be shown here
      // *and* by the Field wrapper *and* as a toast, so a single rejection
      // produced the same sentence three times.
      setError(errorMessage(caught));
    } finally {
      // Unconditional. The button is disabled on `busy`, so anything that left
      // this true left the screen permanently unusable - and a rejection that
      // was not an Error instance used to take this branch's catch out of the
      // picture entirely.
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="min-h-full flex items-center justify-center bg-[var(--page)] px-4 py-8">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="mb-8 text-center">
          <svg
            className="mx-auto mb-4 h-14 w-14 text-[var(--brand-700)]"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">Activate License</h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            Enter your license key to unlock the application.
          </p>
        </div>

        <Card className="space-y-5">
          {/* A form element, not a bare div: the Activate button is
              type="submit", and without a form the click does nothing and Enter
              never reaches submit(). */}
          <form onSubmit={(event) => void submit(event)} className="space-y-5" noValidate>
            {/* Machine ID Card */}
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">Machine ID</h2>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => void copyMachineId()}
                  disabled={machineId === ""}
                  iconOnlyLabel={copied ? "Copied" : "Copy machine ID"}
                >
                  {copied ? (
                    <Check className="h-4 w-4 text-[var(--success)]" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <div className="relative">
                <Input
                  value={machineId}
                  readOnly
                  className="bg-[var(--surface-sunken)] font-mono text-xs pr-10"
                  aria-label="Machine ID"
                  placeholder="Reading this computer's ID…"
                />
              </div>
              <p className="mt-2 text-xs text-[var(--text-muted)]">
                {machineId === ""
                  ? "Still reading this computer's hardware. Restart the app if this does not fill in."
                  : "This ID is unique to this computer. A new key is required if hardware changes."}
              </p>
            </div>

            {/* License Key Input. The error is rendered by Field itself, under
                the input; it is not repeated in a banner below as well. */}
            <Field label="License Key" required error={error}>
              {(id, describedBy) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  invalid={error !== null}
                  value={licenseKey}
                  onChange={(event) => {
                    setLicenseKey(event.target.value);
                    setError(null);
                  }}
                  placeholder="Paste your license key here"
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              )}
            </Field>

            {/* Disabled only while a request is in flight. Button derives its
                disabled state from `loading`, so passing nothing else here is
                what keeps the button live the moment the request settles. */}
            <Button type="submit" variant="primary" className="w-full" loading={busy}>
              Activate
            </Button>
          </form>
        </Card>

        <p className="mt-6 text-center text-xs text-[var(--text-muted)]">
          Need a license key? Contact your supplier with the Machine ID above.
        </p>
      </div>
    </div>
  );
}
