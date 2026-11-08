/**
 * The update dialog.
 *
 * Shown when the application has found a newer version, and again while that
 * version is being downloaded, so the two are one conversation rather than a
 * toast that disappears and a dialog that appears from nowhere.
 *
 * The wording is careful about what is about to happen. Installing an update
 * closes the application, and a shopkeeper who is halfway through an invoice
 * needs to be told that before they press the button - not after.
 */

import { Download, ExternalLink, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { MeterBar } from "../ui/Feedback";
import { bridge } from "../../lib/api";
import { useUpdates } from "../../lib/updates";

export interface UpdateDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function UpdateDialog({ open, onOpenChange }: UpdateDialogProps): React.JSX.Element {
  const { status, busy, error, check, download, install } = useUpdates();

  const version = status.latestVersion ?? status.currentVersion;

  const title = ((): string => {
    switch (status.state) {
      case "available":
        return `Version ${version} is available`;
      case "downloading":
        return "Downloading the update";
      case "downloaded":
        return "The update is ready to install";
      case "error":
        return "The update could not be completed";
      case "checking":
        return "Checking for updates";
      default:
        return "Updates";
    }
  })();

  const description = ((): string => {
    switch (status.state) {
      case "available":
        return `You are running ${status.currentVersion}. The new version keeps your data exactly as it is.`;
      case "downloading":
        return "The installer is on its way. Nothing changes on this computer until it has arrived.";
      case "downloaded":
        return "The installer has been downloaded. Installing it closes EyerStock and starts it again.";
      case "error":
        return error ?? status.message ?? "The update could not be completed.";
      case "checking":
        return "Asking the release server whether there is a newer version.";
      default:
        return "EyerStock can check for a newer version for you.";
    }
  })();

  const footer = ((): React.JSX.Element => {
    if (status.state === "downloaded") {
      return (
        <>
          <Button
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
            }}
            disabled={busy}
          >
            Later
          </Button>
          <Button
            variant="primary"
            iconLeft={<RotateCcw className="h-4 w-4" />}
            loading={busy}
            onClick={() => {
              void install();
            }}
          >
            Restart and install
          </Button>
        </>
      );
    }

    if (status.state === "downloading") {
      return (
        <Button
          variant="secondary"
          onClick={() => {
            onOpenChange(false);
          }}
          disabled={busy}
        >
          Continue in the background
        </Button>
      );
    }

    if (status.state === "available") {
      return (
        <>
          <Button
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
            }}
            disabled={busy}
          >
            Not now
          </Button>
          <Button
            variant="primary"
            iconLeft={<Download className="h-4 w-4" />}
            loading={busy}
            onClick={() => {
              void download();
            }}
          >
            Download and install
          </Button>
        </>
      );
    }

    if (status.state === "error") {
      return (
        <>
          <Button
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
            }}
            disabled={busy}
          >
            Close
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => {
              void check();
            }}
          >
            Try again
          </Button>
        </>
      );
    }

    return (
      <>
        <Button
          variant="secondary"
          onClick={() => {
            onOpenChange(false);
          }}
          disabled={busy}
        >
          Close
        </Button>
        <Button
          variant="primary"
          loading={busy}
          onClick={() => {
            void check();
          }}
        >
          Check for updates
        </Button>
      </>
    );
  })();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onOpenChange(false);
      }}
      size="sm"
      title={title}
      description={description}
      busy={busy}
      footer={footer}
    >
      <div className="space-y-3">
        {status.state === "downloading" && (
          <div className="space-y-1.5">
            <MeterBar value={status.progressPercent ?? 0} total={100} label="Download progress" />
            <p className="text-[12px] text-[var(--text-2)]">
              {String(status.progressPercent ?? 0)}% downloaded
            </p>
          </div>
        )}

        {status.state === "available" && (
          <p className="text-[13px] text-[var(--text-2)]">
            EyerStock will close and install the new version, then start again. Your products,
            invoices, stock and accounts are not touched.
          </p>
        )}

        {status.releaseUrl !== null && status.state === "available" && (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[12px] text-[var(--brand)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
            onClick={() => {
              const url = status.releaseUrl;
              if (url === null) return;
              void bridge()
                .openExternal(url)
                .catch(() => {
                  toast.error("The release page could not be opened.");
                });
            }}
          >
            Read what changed in this release
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </button>
        )}
      </div>
    </Dialog>
  );
}
