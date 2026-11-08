import { useCallback, useRef } from "react";
import { toast } from "sonner";

/**
 * Undo for destructive actions that are safe to take back.
 *
 * Only reversible actions belong here. Anything that has already moved stock,
 * money or a serial number - issuing an invoice, receiving a payment - is not
 * offered an undo, because "undoing" it would mean silently rewriting posted
 * history. What qualifies is the set of actions that remove something which had
 * not yet taken effect: deleting a draft, removing a reminder, clearing a
 * setting. For those, holding the previous value for a few seconds and putting
 * it back is genuinely better than a confirmation dialog alone, because a
 * mis-click costs nothing.
 *
 * The restore callback is held in a ref rather than state: it must stay valid
 * for the lifetime of the toast without causing a re-render, and it closes over
 * whatever the screen knew at the moment of the action.
 */

export interface UndoHandle {
  /**
   * Show a toast with an Undo action.
   *
   * `restore` is invoked only if the user presses Undo before the toast
   * disappears, and its rejection is surfaced as an error toast rather than
   * being swallowed.
   */
  offer: (options: {
    /** What was undone, phrased for the user, e.g. "Draft deleted". */
    readonly description: string;
    readonly restore: () => Promise<void>;
  }) => void;
}

/** How long the undo affordance stays available. */
const UNDO_WINDOW_MS = 8_000;

export function useUndo(): UndoHandle {
  const restoreRef = useRef<(() => Promise<void>) | null>(null);

  const offer = useCallback<UndoHandle["offer"]>(
    ({ description, restore }) => {
      restoreRef.current = restore;

      toast.success(description, {
        duration: UNDO_WINDOW_MS,
        action: {
          label: "Undo",
          onClick: () => {
            const run = restoreRef.current;
            restoreRef.current = null;
            if (run === null) return;
            void run()
              .then(() => {
                toast.success("Undone");
              })
              .catch(() => {
                toast.error("That change could not be taken back.");
              });
          },
        },
      });
    },
    [],
  );

  return { offer };
}
