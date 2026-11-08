/**
 * Modal dialog and side drawer.
 *
 * One focus-trap implementation serves both: the dialog centres on a scrim,
 * the drawer slides in from the side edge that matches the reading direction.
 * Escape and scrim click both close, and focus returns to whatever opened them.
 *
 * Both enter and exit are driven by Radix's `data-state`, so the closing
 * animation runs to completion before the node unmounts instead of the panel
 * being cut out from under the user. They animate `opacity` and `transform`
 * only - never the backdrop-filter, box shadow or box size, which are what make
 * a glass surface expensive to move - and they are switched off wholesale by
 * the `prefers-reduced-motion` block in `styles.css`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "./Button";

export type DialogSize = "sm" | "md" | "lg" | "xl";

/**
 * Dialog widths, to the pixel so a simple form and an items table land on the
 * same sizes everywhere: 480px for simple forms, 920px for sale and purchase
 * dialogs whose items table needs the room.
 *
 * Max-width only. The element itself carries `w-[calc(100vw-2rem)]` for the
 * gutter on narrow windows, and a competing `w-full` here would be whichever
 * of the two Tailwind happened to emit last.
 */
const DIALOG_SIZES: Record<DialogSize, string> = {
  sm: "max-w-[480px]",
  md: "max-w-[560px]",
  lg: "max-w-[720px]",
  xl: "max-w-[920px]",
};

export interface DialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: ReactNode;
  readonly description?: ReactNode | undefined;
  readonly children: ReactNode;
  readonly footer?: ReactNode | undefined;
  readonly size?: DialogSize | undefined;
  /** Blocks scrim-click and Escape while a save is in flight. */
  readonly busy?: boolean | undefined;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  busy = false,
}: DialogProps): React.JSX.Element {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[var(--surface-overlay)] data-[state=open]:animate-scrim-in data-[state=closed]:animate-scrim-out" />
        <DialogPrimitive.Content
          className={cn(
            // Centred with `inset-0 m-auto` rather than `top-1/2 left-1/2`
            // plus a `-translate-1/2`. A running CSS animation owns `transform`
            // outright, so a keyframe that scales the panel silently discarded
            // the centring translate for the length of the animation - the
            // dialog sat offset by half its own size and then jumped back on
            // the final frame. That jump is what read as lag. Auto margins let
            // the box centre itself and leave `transform` to the animation.
            "glass-float-strong card fixed inset-0 z-50 m-auto flex h-fit w-[calc(100vw-2rem)]",
            "max-h-[90vh] flex-col overflow-hidden",
            "focus:outline-none",
            // Driven by Radix's own data-state so the exit runs before the
            // node unmounts. Opacity and transform only; the backdrop-filter and
            // box-shadow on `.glass-float-strong` stay exactly as they are.
            "data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out",
            DIALOG_SIZES[size],
          )}
        >
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--border)] px-6 py-4">
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-[16px] font-semibold text-[var(--text)]">
                {title}
              </DialogPrimitive.Title>
              {description !== undefined && (
                <DialogPrimitive.Description className="mt-0.5 text-[13px] text-[var(--text-2)]">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>

            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" iconOnlyLabel="Close" disabled={busy}>
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DialogPrimitive.Close>
          </div>

          {/*
            The body is the only part of the dialog that grows and scrolls; the
            header and the footer keep their own height.

            It used to be capped with a hard-coded `calc(90vh - 8rem)`, which
            assumed the header and the footer together were 128px tall. They
            are not: the header is about 115px and the sale and purchase
            footers - a totals panel, an error line and the buttons - are
            about 220px on their own. The body took its full 90vh minus 8rem
            anyway, so the panel overflowed its own 90vh cap, the footer was
            clipped away by the panel's `overflow-hidden`, and the "Create
            invoice" / "Create purchase" button sat below the fold with no
            way to scroll to it.

            A flex column with a shrinking body cannot get that wrong: the
            body takes whatever height is left between the header and the
            footer, whatever those happen to be.
          */}
          <div className="dialog-body min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5">
            {children}
          </div>

          {footer !== undefined && (
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border)] bg-[var(--surface-2)] px-6 py-3.5">
              {footer}
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export interface DrawerProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode | undefined;
  /** Which edge the drawer slides in from. Defaults to the inline-end edge. */
  readonly side?: "start" | "end" | undefined;
  readonly widthClass?: string | undefined;
}

/**
 * Slide-in panel for filters and detail views.
 *
 * Used where a modal would be wrong: the underlying list should stay visible so
 * the user keeps their place while working in the panel.
 */
export function Drawer({
  open,
  onOpenChange,
  title,
  children,
  footer,
  side = "end",
  widthClass = "w-full max-w-md",
}: DrawerProps): React.JSX.Element {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[var(--surface-overlay)] data-[state=open]:animate-scrim-in data-[state=closed]:animate-scrim-out" />
        <DialogPrimitive.Content
          className={cn(
            "glass-float-strong fixed inset-y-0 z-50 flex flex-col",
            "focus:outline-none",
            "data-[state=open]:animate-drawer-in data-[state=closed]:animate-drawer-out",
            widthClass,
            side === "end" ? "end-0 border-s" : "start-0 border-e",
          )}
          // The panel is already pinned to its edge with start-0/end-0, so the
          // animation only needs to know how far off that edge to start. The
          // sign lives in CSS, which is what makes it correct in RTL too.
          style={{ "--drawer-from": `var(--drawer-from-${side})` } as CSSProperties}
        >
          <div className="flex items-center justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
            <DialogPrimitive.Title className="text-[15px] font-semibold text-[var(--text)]">
              {title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" iconOnlyLabel="Close">
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DialogPrimitive.Close>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>

          {footer !== undefined && (
            <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] bg-[var(--surface-2)]/60 px-5 py-3">
              {footer}
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: ReactNode;
  readonly message: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly destructive?: boolean | undefined;
  readonly busy?: boolean | undefined;
  /** When set, the user must type this exact word before confirming. */
  readonly confirmationWord?: string | undefined;
  readonly onConfirm: (confirmation: string) => void;
}

/**
 * Confirmation dialog for destructive actions.
 *
 * The typed-confirmation mode exists for the two actions that destroy data
 * irreversibly (restoring a backup, closing a locked period). Typing the word is
 * slow on purpose; a single click on the wrong row must not be enough.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  message,
  confirmLabel,
  cancelLabel,
  destructive = true,
  busy = false,
  confirmationWord,
  onConfirm,
}: ConfirmDialogProps): React.JSX.Element {
  const [typed, setTyped] = useState("");
  const canConfirm =
    confirmationWord === undefined || typed.trim().toUpperCase() === confirmationWord;

  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
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
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "destructive" : "primary"}
            loading={busy}
            disabled={!canConfirm}
            onClick={() => {
              onConfirm(typed);
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="text-sm text-ink-secondary">{message}</div>

        {confirmationWord !== undefined && (
          <div className="rounded-lg border border-[var(--warning)]/40 bg-[var(--warning-soft)] p-3">
            <p className="mb-2 text-sm text-[var(--warning)]">
              Type <span className="kbd">{confirmationWord}</span> to confirm.
            </p>
            <input
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canConfirm) onConfirm(typed);
              }}
              autoFocus
              aria-label={`Type ${confirmationWord} to confirm`}
              className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
            />
          </div>
        )}
      </div>
    </Dialog>
  );
}

/**
 * Element that returns focus on unmount.
 *
 * Radix restores focus automatically for its own dialogs; this is for the
 * command palette and menus, which are not built on Radix primitives.
 */
export function useFocusRestore<T extends HTMLElement>(): {
  readonly ref: React.RefObject<T | null>;
  readonly capture: () => void;
} {
  const ref = useRef<T | null>(null);
  const previous = useRef<HTMLElement | null>(null);

  const capture = useCallback(() => {
    previous.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, []);

  useEffect(() => {
    return () => {
      previous.current?.focus();
    };
  }, []);

  return { ref, capture };
}
