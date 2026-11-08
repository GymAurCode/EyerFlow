/**
 * The update notification.
 *
 * The application checks for an update shortly after it starts, and says
 * something when it finds one. It does not open a dialog on its own: a modal
 * that appears while somebody is halfway through an invoice is an
 * interruption, not a courtesy. A notification in the corner can be read
 * between two sales, and it stays long enough to be noticed.
 *
 * Only somebody who can act on it is told. Installing an update replaces the
 * application, so it is an administrator's job - a Staff account is not shown
 * a prompt it would refuse.
 */

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useApp } from "../../lib/app-context";
import { useUpdates } from "../../lib/updates";
import { UpdateDialog } from "./UpdateDialog";

export function UpdateNotifier(): React.JSX.Element {
  const { can } = useApp();
  const { status } = useUpdates();
  const [dialogOpen, setDialogOpen] = useState(false);

  /**
   * The version that has already been announced.
   *
   * Without it, every push of the same state would raise another toast - and
   * the state is pushed on every progress event during a download.
   */
  const announced = useRef<string | null>(null);

  useEffect(() => {
    if (status.state !== "available") return;
    if (!can("settings", "edit")) return;

    const version = status.latestVersion;
    if (version === null || announced.current === version) return;
    announced.current = version;

    toast(`EyerStock ${version} is available`, {
      description: `You are running ${status.currentVersion}. The update keeps your data as it is.`,
      action: {
        label: "Update",
        onClick: () => {
          setDialogOpen(true);
        },
      },
      duration: 20_000,
    });
  }, [status.state, status.latestVersion, status.currentVersion, can]);

  useEffect(() => {
    if (status.state !== "downloaded") return;
    if (!can("settings", "edit")) return;
    if (announced.current === `ready-${String(status.latestVersion ?? "")}`) return;
    announced.current = `ready-${String(status.latestVersion ?? "")}`;

    toast("The update is ready to install", {
      description: "EyerStock will close and start again with the new version.",
      action: {
        label: "Install",
        onClick: () => {
          setDialogOpen(true);
        },
      },
      duration: 20_000,
    });
  }, [status.state, status.latestVersion, can]);

  return (
    <UpdateDialog
      open={dialogOpen}
      onOpenChange={(next) => {
        setDialogOpen(next);
      }}
    />
  );
}
