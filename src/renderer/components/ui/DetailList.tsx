/**
 * A read-only list of labelled values.
 *
 * Used by the detail dialogs - a product, a customer, an expense - so they all
 * read the same way: the label on the left, the value on the right, aligned
 * and separated by a hairline.
 */

import type { ReactNode } from "react";

export function DetailList({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13.5px]">{children}</div>;
}

export function DetailRow({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[var(--divider)] pb-1.5">
      <span className="text-[var(--text-3)]">{label}</span>
      <span className="tabular text-end font-medium text-[var(--text)]">{value}</span>
    </div>
  );
}
