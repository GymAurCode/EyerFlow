/**
 * Top bar - the application header.
 *
 * One floating pane of glass, sticky at the top of the page, holding everything
 * the user reaches for: the global search (which searches products, customers
 * and invoices in one box, because a counter assistant rarely knows which
 * screen a thing lives on), the low-stock alerts, settings, the theme switch and
 * the account menu - all taken from the live session rather than hardcoded.
 *
 * It is a single container rather than a row of separate floating controls
 * because that is what glass is: one slab of material with things sitting on
 * it. The blur, the fill and the shadow belong to the header and nowhere else,
 * and the controls inside are ordinary buttons over that one surface.
 *
 * The header is rendered *inside* the page's scroll container and sticks there.
 * That is not a layout detail: a sticky element only sticks within its nearest
 * scroll container, and the content passing under it has to be the real page
 * content, so the header has to live where the scrolling happens rather than
 * beside it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Bell,
  ChevronDown,
  KeyRound,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Package,
  Palette,
  Receipt,
  Search,
  Settings,
  Sun,
  UserCog,
  Users,
} from "lucide-react";
import { call } from "../../lib/api";
import { useApp, useTheme, type ThemePreference } from "../../lib/app-context";
import { formatMoney } from "../../lib/format";
import { IMS_PATH } from "../../lib/ims-nav";
import { useLookup } from "../../lib/lookups";
import { cn } from "../../lib/utils";
import { THEME_CATALOG } from "../../../shared/themes";
import type { DocumentDto, PartyDto, ProductDto } from "../../../shared/types";
import { Avatar } from "../ui/Avatar";
import { Badge } from "../ui/Badge";

export interface TopbarProps {
  readonly title: string;
  /** Supplied only when the sidebar is a drawer, to open it. */
  readonly onOpenNav?: (() => void) | undefined;
}

interface SearchHit {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly to: string;
  readonly icon: typeof Package;
}

export function Topbar({ title, onOpenNav }: TopbarProps): React.JSX.Element {
  const { user, can, licenseStatus, signOut } = useApp();
  const { resolvedTheme, setTheme } = useTheme();
  const navigate = useNavigate();

  const [alertsOpen, setAlertsOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);

  const canSeeLowStock = can("products", "view");
  const canSeeSettings = can("settings", "view");

  // The bell is only ever about low stock. Anything noisier would train people
  // to ignore it.
  const { data: lowStock } = useQuery({
    queryKey: ["products", { onlyLowStock: true }],
    queryFn: () => call("products.list", { onlyLowStock: true, limit: 8 }),
    enabled: canSeeLowStock,
    staleTime: 60_000,
  });

  const alerts = useMemo(() => lowStock ?? [], [lowStock]);
  const alertCount = alerts.length;

  return (
    // One shared surface: the fill, the rim, the shadow and the blur all live
    // on this element, and the controls inside it are ordinary buttons sitting
    // on that one piece of glass.
    <header className="glass-header flex h-[var(--header-height)] items-center gap-2 rounded-[var(--radius-header)] px-3">
      {onOpenNav !== undefined && (
        <button
          type="button"
          onClick={onOpenNav}
          aria-label="Open menu"
          className="-ms-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--text-2)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)] lg:hidden"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </button>
      )}

      <h1 className="sr-only">{title}</h1>

      <GlobalSearch />

      <div className="ms-auto flex items-center gap-1">
        {canSeeLowStock && (
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setAlertsOpen((current) => !current);
                setUserOpen(false);
              }}
              aria-label={
                alertCount === 0 ? "No low stock alerts" : `${String(alertCount)} low stock alerts`
              }
              aria-expanded={alertsOpen}
              className={cn(
                "relative flex h-10 w-10 items-center justify-center rounded-full",
                "text-[var(--text-2)] transition-colors duration-fast",
                "hover:bg-[var(--surface-2)] hover:text-[var(--text)]",
              )}
            >
              <Bell className="h-5 w-5" aria-hidden="true" />
              {alertCount > 0 && (
                <span
                  className={cn(
                    "tabular absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center",
                    "rounded-full px-1 text-[10px] font-semibold",
                    "bg-[var(--danger)] text-[var(--on-danger)]",
                  )}
                >
                  {alertCount > 9 ? "9+" : String(alertCount)}
                </span>
              )}
            </button>

            {alertsOpen && (
              <>
                <button
                  type="button"
                  aria-label="Close alerts"
                  className="fixed inset-0 z-10 cursor-default"
                  onClick={() => {
                    setAlertsOpen(false);
                  }}
                />
                <div className="card glass-float absolute end-0 top-[calc(100%+8px)] z-20 w-80 overflow-hidden">
                  <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
                    <p className="text-[13px] font-semibold text-[var(--text)]">Low stock</p>
                    {alertCount > 0 && <Badge tone="danger">{String(alertCount)}</Badge>}
                  </div>
                  {alerts.length === 0 ? (
                    <p className="px-4 py-6 text-center text-[13px] text-[var(--text-3)]">
                      Everything is in stock.
                    </p>
                  ) : (
                    <ul className="max-h-72 overflow-y-auto">
                      {alerts.map((product) => (
                        <li key={product.id}>
                          <button
                            type="button"
                            onClick={() => {
                              setAlertsOpen(false);
                              void navigate(IMS_PATH.products);
                            }}
                            className="flex w-full items-center gap-2.5 px-4 py-2 text-start transition-colors duration-fast hover:bg-[var(--surface-2)]"
                          >
                            <Avatar name={product.name} size="xs" square tone="neutral" />
                            <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text)]">
                              {product.name}
                            </span>
                            <span className="tabular shrink-0 text-xs text-[var(--danger)]">
                              {(product.quantityMilli / 1000).toLocaleString("en-US")}{" "}
                              {product.unit}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="border-t border-[var(--border)] p-2">
                    <button
                      type="button"
                      onClick={() => {
                        setAlertsOpen(false);
                        void navigate(IMS_PATH.products);
                      }}
                      className="w-full rounded-md py-1.5 text-xs font-medium text-[var(--brand)] transition-colors hover:bg-[var(--brand-soft)]"
                    >
                      View all products
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {canSeeSettings && (
          <button
            type="button"
            onClick={() => {
              void navigate(IMS_PATH.settings);
            }}
            aria-label="Settings"
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-full",
              "text-[var(--text-2)] transition-colors duration-fast",
              "hover:bg-[var(--surface-2)] hover:text-[var(--text)]",
            )}
          >
            <Settings className="h-5 w-5" aria-hidden="true" />
          </button>
        )}

        <ThemeToggle
          theme={resolvedTheme}
          onChange={(next) => void setTheme(next)}
          // Staff cannot open Settings, so the shortcut is only offered when
          // the destination is actually reachable. The light/dark choice above
          // still works for everyone.
          onExplore={
            canSeeSettings
              ? () => {
                  void navigate(`${IMS_PATH.settings}?tab=appearance`);
                }
              : undefined
          }
        />

        {user !== null && (
          <div className="relative ms-1 border-s border-[var(--border)] ps-3">
            <button
              type="button"
              onClick={() => {
                setUserOpen((current) => !current);
                setAlertsOpen(false);
              }}
              aria-expanded={userOpen}
              aria-haspopup="menu"
              className={cn(
                "pressable flex h-11 items-center gap-2.5 rounded-full ps-1 pe-2",
                "transition-colors duration-fast hover:bg-[var(--surface-2)]",
              )}
            >
              <Avatar name={user.displayName} size="md" src={user.avatarDataUrl} />
              <span className="hidden text-start lg:block">
                <span className="block text-[13px] font-medium leading-tight text-[var(--text)]">
                  {user.displayName}
                </span>
                <span className="block text-[11px] leading-tight text-[var(--text-3)]">
                  {user.roleName ?? "User"}
                </span>
              </span>
              <ChevronDown className="h-4 w-4 text-[var(--text-3)]" aria-hidden="true" />
            </button>

            {userOpen && (
              <>
                <button
                  type="button"
                  aria-label="Close menu"
                  className="fixed inset-0 z-10 cursor-default"
                  onClick={() => {
                    setUserOpen(false);
                  }}
                />
                <div
                  role="menu"
                  className="card glass-float absolute end-0 top-[calc(100%+8px)] z-20 w-56 overflow-hidden p-1"
                >
                  <div className="px-3 py-2">
                    <p className="truncate text-[13px] font-medium text-[var(--text)]">
                      {user.displayName}
                    </p>
                    <p className="truncate text-[11px] text-[var(--text-3)]">{user.username}</p>
                  </div>
                  <div className="my-1 h-px bg-[var(--border)]" />
                  {/* Your own account first, then the things an administrator
                      looks after. Staff never see the settings entry.

                      Changing the password is not here: it belongs to the
                      profile page, which is where the account's own details
                      live, and a second entry for it in this menu only meant
                      two ways to reach the same screen. */}
                  <MenuItem
                    icon={UserCog}
                    label="Profile"
                    onClick={() => {
                      setUserOpen(false);
                      void navigate("/profile");
                    }}
                  />
                  {licenseStatus !== null && licenseStatus.isExpiringSoon && (
                    <MenuItem
                      icon={KeyRound}
                      label="Renew licence"
                      onClick={() => {
                        setUserOpen(false);
                        void navigate(IMS_PATH.settings);
                      }}
                    />
                  )}
                  <MenuItem icon={LogOut} label="Sign out" onClick={() => void signOut()} />
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </header>
  );
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
}: {
  readonly icon: typeof LogOut;
  readonly label: string;
  readonly onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-3 py-2 text-start text-[13px]",
        "text-[var(--text-2)] transition-colors duration-fast",
        "hover:bg-[var(--surface-2)] hover:text-[var(--text)]",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {label}
    </button>
  );
}

/**
 * Sun / moon / system switch.
 *
 * Puts the choice straight onto <html>, so the whole app - dialogs, charts,
 * toasts and all - repaints in the same frame rather than component by
 * component. The same choice is also in Settings › Appearance; both write the
 * same stored preference.
 *
 * The menu also advertises the full catalogue. Most people never open
 * Settings, so a light/dark toggle on its own would hide the fifteen colour
 * packs entirely; the last entry takes them straight to the picker.
 */
function ThemeToggle({
  theme,
  onChange,
  onExplore,
}: {
  readonly theme: "light" | "dark";
  readonly onChange: (next: ThemePreference) => void;
  /** Omitted when the signed-in user cannot open Settings. */
  readonly onExplore?: (() => void) | undefined;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  const options = useMemo(
    () =>
      [
        { value: "light", label: "Light", icon: Sun },
        { value: "dark", label: "Dark", icon: Moon },
        { value: "system", label: "System", icon: Monitor },
      ] as const,
    [],
  );

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((current) => !current);
        }}
        aria-label={`Theme: ${theme}. Change theme`}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          "flex h-10 w-10 items-center justify-center rounded-full",
          "text-[var(--text-2)] transition-colors duration-fast",
          "hover:bg-[var(--surface-2)] hover:text-[var(--text)]",
        )}
      >
        {theme === "dark" ? (
          <Moon className="h-5 w-5" aria-hidden="true" />
        ) : (
          <Sun className="h-5 w-5" aria-hidden="true" />
        )}
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="Close theme menu"
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => {
              setOpen(false);
            }}
          />
          <div
            role="menu"
            className="card glass-float absolute end-0 top-[calc(100%+8px)] z-20 w-52 p-1"
          >
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={theme === option.value}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-3 py-2 text-start text-[13px]",
                  "transition-colors duration-fast",
                  theme === option.value
                    ? "bg-[var(--brand-soft)] font-medium text-[var(--brand)]"
                    : "text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]",
                )}
              >
                <option.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                {option.label}
              </button>
            ))}

            {onExplore !== undefined && (
              <>
                <div role="separator" className="my-1 h-px bg-[var(--divider)]" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    onExplore();
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-3 py-2 text-start text-[13px]",
                    "text-[var(--text-2)] transition-colors duration-fast",
                    "hover:bg-[var(--surface-2)] hover:text-[var(--text)]",
                  )}
                >
                  <Palette className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1">Explore more themes</span>
                  <span
                    className="rounded-full bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-3)]"
                    aria-hidden="true"
                  >
                    {THEME_CATALOG.length}
                  </span>
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Global search across products, customers and invoices.
 *
 * Searches the cached lookup lists plus a bounded invoice query, debounced so a
 * fast typist costs one round trip rather than one per keypress. Enter opens
 * the top hit; the arrow keys walk the list.
 */
function GlobalSearch(): React.JSX.Element {
  const navigate = useNavigate();

  const [term, setTerm] = useState("");
  const [debounced, setDebounced] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Ctrl/Cmd + K is advertised in the field, so it has to work: the hint is
  // only honest if the shortcut is real.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(term);
      setHighlight(0);
    }, 150);
    return () => {
      window.clearTimeout(timer);
    };
  }, [term]);

  const products = useLookup<ProductDto>("product");
  const customers = useLookup<PartyDto>("customer");

  const invoiceQuery = useQuery({
    queryKey: ["documents", "search", debounced],
    queryFn: () => call("documents.list", { search: debounced, limit: 5 }),
    enabled: debounced.trim().length >= 2,
    staleTime: 30_000,
  });

  const invoices = useMemo<readonly DocumentDto[]>(
    () => invoiceQuery.data ?? [],
    [invoiceQuery.data],
  );

  const hits = useMemo<SearchHit[]>(() => {
    const needle = debounced.trim().toLowerCase();
    if (needle.length < 2) return [];

    const found: SearchHit[] = [];

    // Products and customers come from the prefetched cache, so they appear on
    // the keystroke with no wait. Only invoices need a round trip.
    for (const product of products) {
      if (!product.name.toLowerCase().includes(needle)) continue;
      if (found.length >= 6) break;
      found.push({
        id: `product-${String(product.id)}`,
        label: product.name,
        detail: `${(product.quantityMilli / 1000).toLocaleString("en-US")} ${product.unit}`,
        to: IMS_PATH.products,
        icon: Package,
      });
    }

    for (const party of customers) {
      if (!party.name.toLowerCase().includes(needle)) continue;
      if (found.length >= 9) break;
      found.push({
        id: `party-${String(party.id)}`,
        label: party.name,
        detail: "Customer",
        to: IMS_PATH.customers,
        icon: Users,
      });
    }

    for (const document of invoices) {
      if (found.length >= 12) break;
      found.push({
        id: `document-${String(document.id)}`,
        label: document.number,
        detail: document.partyName ?? formatMoney(document.netFils),
        to: IMS_PATH.salesInvoices,
        icon: Receipt,
      });
    }

    return found;
  }, [debounced, products, customers, invoices]);

  const open = hits.length > 0;

  const choose = useCallback(
    (hit: SearchHit) => {
      setTerm("");
      setDebounced("");
      void navigate(hit.to);
    },
    [navigate],
  );

  return (
    <div className="relative w-full max-w-[560px]">
      <div
        className={cn(
          "glass-input flex h-10 items-center gap-2.5 rounded-[14px] px-3",
          "focus-within:ring-0",
        )}
      >
        <Search className="h-[18px] w-[18px] shrink-0 text-[var(--text-3)]" aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          value={term}
          onChange={(event) => {
            setTerm(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setTerm("");
              return;
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setHighlight((current) => Math.min(current + 1, hits.length - 1));
              return;
            }
            if (event.key === "Enter") {
              const hit = hits[highlight];
              if (hit !== undefined) {
                event.preventDefault();
                choose(hit);
              }
            }
          }}
          placeholder="Search products, categories..."
          aria-label="Search products, customers and invoices"
          className="min-w-0 flex-1 bg-transparent text-[13.5px] text-[var(--text)] outline-none placeholder:text-[var(--text-3)]"
        />
        {term.length > 0 ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setTerm("");
            }}
            className="shrink-0 text-[11px] text-[var(--text-3)] hover:text-[var(--text)]"
          >
            Esc
          </button>
        ) : (
          <kbd className="kbd shrink-0" aria-hidden="true">
            Ctrl + K
          </kbd>
        )}
      </div>

      {open && (
        <ul className="card glass-float absolute inset-x-0 top-[calc(100%+6px)] z-20 overflow-hidden p-1">
          {hits.map((hit, index) => (
            <li key={hit.id}>
              <button
                type="button"
                onClick={() => {
                  choose(hit);
                }}
                onMouseEnter={() => {
                  setHighlight(index);
                }}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-start",
                  index === highlight && "bg-[var(--surface-2)]",
                )}
              >
                <hit.icon className="h-4 w-4 shrink-0 text-[var(--text-3)]" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text)]">
                  {hit.label}
                </span>
                <span className="tabular shrink-0 text-xs text-[var(--text-3)]">{hit.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <span className="sr-only" aria-live="polite">
        {debounced.length >= 2 ? `${String(hits.length)} results` : ""}
      </span>
      <span className="sr-only">PKR</span>
    </div>
  );
}
