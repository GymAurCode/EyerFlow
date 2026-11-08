/**
 * Status pills and badges.
 *
 * Small, quiet, and always the same shape: a soft tint of one semantic colour
 * behind that colour's text, with a rim so the pill reads as a piece of glass
 * sitting on the panel rather than a flat sticker. A badge reports state; it
 * never competes with the number or name beside it.
 */

import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export type BadgeTone =
  "brand" | "success" | "warning" | "danger" | "info" | "violet" | "gold" | "neutral";

const TONES: Record<BadgeTone, string> = {
  brand:
    "bg-[var(--brand-soft)] text-[var(--brand)] border-[color-mix(in_srgb,var(--brand)_32%,transparent)]",
  success:
    "bg-[var(--success-soft)] text-[var(--success)] border-[color-mix(in_srgb,var(--success)_32%,transparent)]",
  warning:
    "bg-[var(--warning-soft)] text-[var(--warning)] border-[color-mix(in_srgb,var(--warning)_34%,transparent)]",
  danger:
    "bg-[var(--danger-soft)] text-[var(--danger)] border-[color-mix(in_srgb,var(--danger)_34%,transparent)]",
  info: "bg-[var(--info-soft)] text-[var(--info)] border-[color-mix(in_srgb,var(--info)_32%,transparent)]",
  // Identity, not state: a category pill, so the same category reads the same
  // in every row and never implies something is wrong.
  violet:
    "bg-[var(--violet-soft)] text-[var(--violet)] border-[color-mix(in_srgb,var(--violet)_32%,transparent)]",
  // The asset category's identity colour. Like violet, it never means a state.
  gold: "bg-[var(--gold-soft)] text-[var(--gold)] border-[color-mix(in_srgb,var(--gold)_32%,transparent)]",
  neutral: "bg-[var(--surface-2)] text-[var(--text-2)] border-[var(--glass-border)]",
};

export function Badge({
  tone = "neutral",
  children,
  className,
  dot = false,
}: {
  readonly tone?: BadgeTone | undefined;
  readonly children: ReactNode;
  readonly className?: string | undefined;
  readonly dot?: boolean | undefined;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium leading-5",
        "shadow-[inset_0_1px_0_var(--glass-edge-top)]",
        TONES[tone],
        className,
      )}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}

/** Map a document status to a badge tone. */
export function StatusBadge({
  status,
  label,
}: {
  readonly status: "draft" | "issued" | "partPaid" | "paid" | "cancelled";
  readonly label: string;
}): React.JSX.Element {
  const tone: BadgeTone =
    status === "paid"
      ? "success"
      : status === "partPaid"
        ? "warning"
        : status === "issued"
          ? "info"
          : status === "cancelled"
            ? "neutral"
            : "neutral";

  return <Badge tone={tone}>{label}</Badge>;
}

/**
 * Stock state, in the order a shopkeeper cares about: none left, too little,
 * healthy. Driven by the quantity and the product's own low-stock flag so the
 * wording always matches the rule the list is filtered by.
 *
 * "Low Stock" is an amber warning rather than a red one: it is a thing to act
 * on, not a thing that has already failed. Only nothing on the shelf is red.
 */
export function StockBadge({
  quantityMilli,
  isLowStock,
  isActive,
}: {
  readonly quantityMilli: number;
  readonly isLowStock: boolean;
  readonly isActive: boolean;
}): React.JSX.Element {
  if (!isActive) return <Badge tone="neutral">Inactive</Badge>;
  if (quantityMilli <= 0) return <Badge tone="danger">Out of stock</Badge>;
  if (isLowStock) return <Badge tone="warning">Low Stock</Badge>;
  return <Badge tone="success">In Stock</Badge>;
}
