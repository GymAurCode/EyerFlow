/**
 * Bottom navigation for narrow windows.
 *
 * On a phone the rail is a drawer behind a menu button, which means the four
 * modules a shop moves between all day cost a tap and a swipe to reach. The
 * dock puts them under the thumb instead, as a floating pane of glass that is
 * clearly an overlay rather than part of the page: it blurs the content
 * scrolling under it, lifts its active tile, and never grows past what a thumb
 * can comfortably hit.
 *
 * The items come from the same list and the same permission check as the rail,
 * so a Staff account sees the same modules here as it does in the sidebar - the
 * dock can never show something the rail would hide.
 */

import { NavLink } from "react-router-dom";
import { LayoutGrid } from "lucide-react";
import { useApp } from "../../lib/app-context";
import { cn } from "../../lib/utils";
import { visibleDockItems } from "../../lib/ims-nav";

export interface BottomNavProps {
  /** Opens the full rail; supplied only when the rail is a drawer. */
  readonly onOpenMenu?: (() => void) | undefined;
}

export function BottomNav({ onOpenMenu }: BottomNavProps): React.JSX.Element | null {
  const { can } = useApp();

  const items = visibleDockItems(can);

  // A role that cannot see any of the dock's modules gets no dock rather than
  // an empty bar.
  if (items.length === 0) return null;

  return (
    <nav
      aria-label="Quick navigation"
      className="glass-float-strong fixed inset-x-0 bottom-0 z-30 flex justify-center px-3 pb-3 lg:hidden"
      // The dock floats over the last row of a table; without this the bottom
      // row is unreachable on a phone.
      style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}
    >
      <ul className="flex w-full max-w-md items-stretch gap-1 rounded-[22px] border border-[var(--glass-border)] p-1.5">
        {items.map((item) => (
          <li key={item.path} className="min-w-0 flex-1">
            <NavLink
              to={item.path}
              end={item.path === "/"}
              className={({ isActive }) =>
                cn(
                  "pressable flex h-[52px] flex-col items-center justify-center gap-1 rounded-[16px] px-1 text-[11px] font-medium",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
                  isActive
                    ? "border border-[color-mix(in_srgb,var(--brand)_36%,transparent)] bg-[var(--brand-soft)] text-[var(--brand)] shadow-[inset_0_1px_0_var(--glass-edge-top)]"
                    : "border border-transparent text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]",
                )
              }
            >
              <item.icon className="h-[19px] w-[19px] shrink-0" aria-hidden="true" />
              <span className="w-full truncate text-center leading-none">{item.label}</span>
            </NavLink>
          </li>
        ))}

        {onOpenMenu !== undefined && (
          <li className="min-w-0 flex-1">
            <button
              type="button"
              onClick={onOpenMenu}
              className="pressable flex h-[52px] w-full flex-col items-center justify-center gap-1 rounded-[16px] border border-transparent px-1 text-[11px] font-medium text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
            >
              <LayoutGrid className="h-[19px] w-[19px] shrink-0" aria-hidden="true" />
              <span className="w-full truncate text-center leading-none">More</span>
            </button>
          </li>
        )}
      </ul>
    </nav>
  );
}
