/**
 * Card: the single surface primitive used by every panel in the app.
 *
 * A slab of glass: translucent fill, a specular sheen across the top edge, a
 * luminous rim, an inner shadow underneath and a coloured drop shadow that
 * lifts it off the page. 24px radius, 20px padding. The header is a quiet 52px
 * band with a hairline underneath, so a row of card titles lines up across a
 * dashboard without a grid of its own.
 *
 * Panels that float over the page - dialogs, menus, the top bar - ask for
 * `glass-float` instead, which adds a real backdrop blur; panels that sit in
 * the page layout do not, because the background behind them is a gradient and
 * blurring it would cost a readback per card for no visible gain.
 */

import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  readonly children: ReactNode;
  /** Removes body padding, for a card whose child manages its own edges. */
  readonly flush?: boolean | undefined;
  /** Blurs what is behind the panel. For overlays, not for page layout. */
  readonly float?: boolean | undefined;
}

export function Card({
  children,
  className,
  flush = false,
  float = false,
  ...rest
}: CardProps): React.JSX.Element {
  return (
    <div className={cn("card", float ? "glass-float" : "glass", className)} {...rest}>
      {flush ? children : <div className="p-5">{children}</div>}
    </div>
  );
}

export interface CardHeaderProps {
  readonly title: ReactNode;
  readonly description?: ReactNode | undefined;
  readonly actions?: ReactNode | undefined;
  readonly className?: string | undefined;
}

export function CardHeader({
  title,
  description,
  actions,
  className,
}: CardHeaderProps): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex min-h-[52px] items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-3",
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="truncate text-[15px] font-semibold text-[var(--text)]">{title}</h2>
        {description !== undefined && (
          <p className="truncate text-xs text-[var(--text-2)]">{description}</p>
        )}
      </div>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string | undefined;
}): React.JSX.Element {
  return <div className={cn("p-5", className)}>{children}</div>;
}

export function CardFooter({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string | undefined;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex min-h-[48px] items-center justify-end gap-2 border-t border-[var(--border)] bg-[var(--surface-2)] px-5 py-2.5",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * A titled block inside a dialog or a form.
 *
 * The two-card product form is the clearest use: "Product Information" beside
 * "Pricing & Stock", each with its own heading and its own fields, rather than
 * one long undifferentiated column.
 */
export function FormSection({
  title,
  description,
  children,
  className,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode | undefined;
  readonly children: ReactNode;
  readonly className?: string | undefined;
}): React.JSX.Element {
  return (
    <section
      className={cn(
        "rounded-xl border border-[var(--glass-border)] bg-[var(--surface-2)] p-4 shadow-[inset_0_1px_0_var(--glass-edge-top)]",
        className,
      )}
    >
      <header className="mb-3">
        <h3 className="text-[13.5px] font-semibold text-[var(--text)]">{title}</h3>
        {description !== undefined && (
          <p className="mt-0.5 text-xs text-[var(--text-3)]">{description}</p>
        )}
      </header>
      {children}
    </section>
  );
}
