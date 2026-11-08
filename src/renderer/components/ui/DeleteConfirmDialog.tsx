/**
 * The confirmation shown before a record is deleted.
 *
 * The message names the record, so the person confirming knows exactly what
 * they are about to remove rather than agreeing to an abstract "this record".
 */

import { ConfirmDialog } from "./Dialog";

export interface DeleteConfirmDialogProps {
  readonly open: boolean;
  /** What is being deleted, named in the title. */
  readonly subject: string;
  /** What will happen, and what will not. */
  readonly message: string;
  readonly confirmLabel?: string | undefined;
  readonly busy?: boolean | undefined;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function DeleteConfirmDialog({
  open,
  subject,
  message,
  confirmLabel = "Delete",
  busy = false,
  onCancel,
  onConfirm,
}: DeleteConfirmDialogProps): React.JSX.Element {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title={`Delete ${subject}?`}
      message={message}
      confirmLabel={confirmLabel}
      cancelLabel="Keep it"
      busy={busy}
      onConfirm={() => {
        onConfirm();
      }}
    />
  );
}
