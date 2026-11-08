/**
 * Button.
 *
 * One electric blue for anything that commits, a pane of glass for everything
 * else, and a text-only ghost for table and card chrome. 40px tall by default
 * so a row of controls lines up with the inputs beside it; `sm` drops to 32px
 * for dense toolbars.
 *
 * Every variant is a small piece of the same material as the panels - a fill, a
 * rim, a specular line along the top edge and a bloom underneath - so a toolbar
 * of buttons looks cut from the card it sits in rather than dropped onto it.
 */

import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "../../lib/utils";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive" | "danger" | "link";

export type ButtonSize = "sm" | "md" | "lg" | "icon";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant | undefined;
  readonly size?: ButtonSize | undefined;
  readonly loading?: boolean | undefined;
  readonly iconLeft?: ReactNode | undefined;
  readonly iconRight?: ReactNode | undefined;
  /** Screen-reader text when the button shows only an icon. */
  readonly iconOnlyLabel?: string | undefined;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "text-[var(--on-brand)] border border-[color-mix(in_srgb,var(--brand)_72%,white)] " +
    "bg-[linear-gradient(180deg,color-mix(in_srgb,var(--brand)_86%,white),var(--brand))] " +
    "shadow-[inset_0_1px_0_rgba(255,255,255,0.34),0_10px_22px_-14px_var(--brand-glow)] " +
    "hover:bg-[var(--brand-hover)] " +
    "hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.42),0_14px_26px_-12px_var(--brand-glow)] " +
    "active:bg-[color-mix(in_srgb,var(--brand-hover)_86%,black)]",
  secondary:
    "text-[var(--text)] border border-[var(--glass-border)] bg-[var(--surface)] " +
    "shadow-[inset_0_1px_0_var(--glass-edge-top),0_8px_18px_-14px_rgba(0,0,0,0.4)] " +
    "hover:bg-[var(--surface-2)] hover:border-[var(--glass-edge-top)] " +
    "hover:shadow-[inset_0_1px_0_var(--glass-edge-top),0_12px_24px_-14px_var(--brand-glow)] " +
    "active:bg-[var(--surface-3)]",
  ghost:
    "bg-transparent text-[var(--text-2)] border border-transparent hover:bg-[var(--surface-2)] " +
    "hover:text-[var(--text)] hover:border-[var(--glass-border)]",
  destructive:
    "text-[var(--on-danger)] border border-[color-mix(in_srgb,var(--danger)_72%,white)] " +
    "bg-[linear-gradient(180deg,color-mix(in_srgb,var(--danger)_86%,white),var(--danger))] " +
    "shadow-[inset_0_1px_0_rgba(255,255,255,0.3),0_10px_22px_-14px_var(--danger)] " +
    "hover:opacity-95 active:opacity-90",
  danger:
    "text-[var(--danger)] border border-[var(--glass-border)] bg-[var(--surface)] " +
    "shadow-[inset_0_1px_0_var(--glass-edge-top)] " +
    "hover:bg-[var(--danger-soft)] hover:border-[var(--danger)] active:bg-[var(--danger-soft)]",
  link: "bg-transparent text-[var(--brand)] border-0 underline underline-offset-4 hover:text-[var(--brand-hover)] p-0 h-auto",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5",
  md: "h-10 px-4 text-[13.5px] gap-2",
  lg: "h-11 px-5 text-sm gap-2",
  icon: "h-8 w-8 p-0",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    loading = false,
    iconLeft,
    iconRight,
    iconOnlyLabel,
    className,
    children,
    disabled,
    type = "button",
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      data-variant={variant}
      disabled={disabled === true || loading}
      aria-label={iconOnlyLabel}
      aria-busy={loading || undefined}
      className={cn(
        "pressable inline-flex items-center justify-center rounded-lg border font-medium",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2",
        "focus-visible:ring-offset-[var(--surface)] disabled:pointer-events-none disabled:opacity-50",
        "whitespace-nowrap select-none",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : iconLeft}
      {children !== undefined && children !== null && <span>{children}</span>}
      {iconRight !== undefined && !loading && iconRight}
    </button>
  );
});

Button.displayName = "Button";
