/**
 * Sidebar navigation - the rail that holds the app together.
 *
 * A floating pane of glass: inset from the window edge by a gutter on every
 * side, generously rounded, blurred, and casting a soft shadow onto the page.
 * It is the same material as the cards beside it in the light theme and in the
 * dark theme - only the values differ - so navigation reads as an object
 * resting on the page rather than as a differently coloured column of it.
 *
 * The active item is a lit glass pill that is slightly raised above its
 * neighbours; every other item is a muted label that lifts on hover. Nothing
 * here is filled with a colour.
 *
 * Two top-level entries: the EyerFlow dashboard, and the Inventory Management
 * System. The module holds its screens in groups - Purchasing, Sales, Stock
 * Control - and one group opens at a time, because the ten finance screens alone
 * would need scrolling to reach Settings and the user is rarely hunting for two
 * groups at once. The group owning the route in front of the user opens on its
 * own, so a deep link never lands on a rail with nothing lit.
 *
 * The page list, the group names and the permissions they need all come from
 * `lib/ims-nav.ts`, which the route table and the breadcrumbs read too.
 */

import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { ChevronDown, ChevronLeft, ChevronRight, LogOut, X } from "lucide-react";
import {
  DASHBOARD_ITEM,
  IMS_ICON,
  IMS_LABEL,
  MMS_ICON,
  MMS_LABEL,
  locate,
  locateMms,
  visibleMmsSections,
  visibleSections,
  type NavItem,
  type NavSection,
} from "../../lib/ims-nav";
import { useApp, useTheme } from "../../lib/app-context";
import { APP_VERSION } from "../../lib/app-version";
import { cn } from "../../lib/utils";
import { Avatar } from "../ui/Avatar";
import logoUrl from "@assets/Logo.png";
import { WMS_ICON, WMS_SECTIONS } from "../../lib/wms-nav";

export type { NavItem } from "../../lib/ims-nav";

export interface SidebarProps {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  /** Drawer mode for narrow windows: overlays the page and can be dismissed. */
  readonly mobileOpen?: boolean | undefined;
  readonly onMobileClose?: (() => void) | undefined;
}

export function Sidebar({
  collapsed,
  onToggle,
  mobileOpen = false,
  onMobileClose,
}: SidebarProps): React.JSX.Element {
  const { can, licenseStatus, user, signOut } = useApp();
  const { resolvedTheme } = useTheme();
  const location = useLocation();

  const sections = visibleSections(can);
  const onImsRoute = locate(location.pathname, location.search) !== null;

  const mmsSections = visibleMmsSections(can);
  const onMmsRoute = location.pathname.startsWith("/mms");

  // The module closes as a whole, and the group inside it closes on its own.
  // Two chevrons on the same seam would invite a click on the wrong one, so the
  // outer one is the only control that opens or shuts the list.
  const [moduleOpen, setModuleOpen] = useState(true);
  const [mmsModuleOpen, setMmsModuleOpen] = useState(false);
  const [wmsModuleOpen,setWmsModuleOpen]=useState(location.pathname.startsWith("/wms"));
  const [openWmsSection,setOpenWmsSection]=useState<string|null>(()=>WMS_SECTIONS.find(s=>s.items.some(i=>i.path===location.pathname))?.id??"wms-overview");

  // One group open at a time, so the rail stays a list a shopkeeper can read at
  // a glance rather than a wall of thirty links. `null` means the user closed
  // every group, which is a state they are allowed to be in.
  const [openSection, setOpenSection] = useState<string | null>(
    () => locate(location.pathname, location.search)?.section.id ?? null,
  );

  // MMS keeps its own open group. Sharing one with IMS would close the group
  // the user is working in the moment they look at the other module, and the
  // rail remembers one group per module the way it remembers one module.
  const [openMmsSection, setOpenMmsSection] = useState<string | null>(
    () => locateMms(location.pathname)?.section.id ?? null,
  );

  // Arriving from a deep link, a keyboard shortcut, the dock or the search box
  // has to reveal the group the page belongs to, or the rail would show nothing
  // lit while the user stands inside the module.
  useEffect(() => {
    if(location.pathname.startsWith("/wms")) {
      setWmsModuleOpen(true);
      setOpenWmsSection(WMS_SECTIONS.find(s=>s.items.some(i=>i.path===location.pathname))?.id??"wms-overview");
    }
    const found = locate(location.pathname, location.search);
    if (found !== null) {
      setModuleOpen(true);
      setOpenSection(found.section.id);
    }
    if (location.pathname.startsWith("/mms")) {
      setMmsModuleOpen(true);
      setOpenMmsSection(locateMms(location.pathname)?.section.id ?? null);
    }
  }, [location.pathname, location.search]);

  // The rail and the page behind it must not scroll apart on a narrow window.
  useEffect(() => {
    if (!mobileOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [mobileOpen]);

  const online = licenseStatus === null;

  return (
    <>
      {/* Scrim behind the drawer. The rail is always visible on desktop, where
          `mobileOpen` never becomes true. */}
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={onMobileClose}
          className="fixed inset-0 z-40 bg-[var(--surface-overlay)] lg:hidden"
        />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 start-0 z-50 shrink-0 p-[var(--sidebar-gutter)]",
          // Width is the only thing that changes on collapse, and it reads the
          // same token the page margin does, so the rail and the content beside
          // it move as one object.
          //
          // `transform` is deliberately not in this list: it belongs to the
          // mobile drawer slide, and a transition list containing both means the
          // desktop collapse and the narrow-window drawer share one duration and
          // one interrupt rule for unrelated movement.
          "transition-[width] duration-sidebar ease-sidebar lg:z-40",
          "max-lg:transition-transform max-lg:duration-normal",
          collapsed ? "w-[var(--sidebar-width-collapsed)]" : "w-[var(--sidebar-width)]",
          mobileOpen
            ? "translate-x-0 rtl:translate-x-0"
            : "max-lg:-translate-x-full rtl:max-lg:translate-x-full",
          // Named so the print stylesheet can take the rail out of the page.
          "app-sidebar",
        )}
        aria-label="Main navigation"
      >
        <div className="glass-sidebar flex h-full flex-col overflow-hidden rounded-[var(--radius-sidebar)]">
          {/* Brand.

              The mark keeps one size in both states. It used to shrink from 36px
              to 32px on collapse, which moved it while the rail was still moving.

              Its start padding is animated rather than snapped between "left
              aligned" and "centred", so the mark glides to the middle of the
              collapsed rail instead of jumping there. The target is derived from
              the rail's own width: (collapsed panel width - the 1px panel border
              - the 36px mark) / 2. */}
          <div
            className={cn(
              "flex h-[68px] shrink-0 items-center gap-2.5 pe-4",
              "transition-[padding-inline-start] duration-sidebar ease-sidebar",
              collapsed
                ? "ps-[calc((var(--sidebar-panel-width-collapsed)-2.25rem)/2-1px)]"
                : "ps-4",
            )}
          >
            <BrandMark className="h-9 w-9 shrink-0" />
            {/* Kept mounted rather than unmounted on collapse: a node that
                appears and disappears at the instant of the toggle is what reads
                as a flash. */}
            <div
              className={cn(
                "min-w-0 flex-1 overflow-hidden",
                "transition-[opacity,transform] duration-sidebar ease-sidebar",
                collapsed
                  ? "-translate-x-1.5 opacity-0 rtl:translate-x-1.5"
                  : "translate-x-0 opacity-100",
              )}
            >
              <p className="truncate text-[15px] font-semibold leading-tight text-[var(--sidebar-active-fg)]">
                EyerStock
              </p>
              <p className="truncate text-[11px] leading-tight text-[var(--sidebar-text-muted)]">
                Inventory Management
              </p>
            </div>
            {mobileOpen && !collapsed && (
              <button
                type="button"
                onClick={onMobileClose}
                aria-label="Close menu"
                className="ms-auto flex h-8 w-8 items-center justify-center rounded-lg text-[var(--sidebar-text)] transition-colors hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-active-fg)] lg:hidden"
              >
                <X className="h-[18px] w-[18px]" aria-hidden="true" />
              </button>
            )}
          </div>

          {/* Navigation.

              The nav's own horizontal padding is what centres the icons once the
              rail is collapsed, and it is animated so every item slides to its
              new place together instead of snapping on its own. The collapsed
              value is (collapsed panel width - 46px) / 2, where 46px is the
              chrome a row carries when it holds nothing but its icon: the 1px
              panel border, the 1px row border, 12px of row padding on each side,
              and the 18px icon itself. */}
          <nav
            className={cn(
              "flex-1 space-y-1 overflow-y-auto py-2",
              "transition-[padding-inline-start,padding-inline-end] duration-sidebar ease-sidebar",
              collapsed ? "px-[calc((var(--sidebar-panel-width-collapsed)-46px)/2)]" : "px-3",
            )}
            aria-label="Main"
          >
            {can(DASHBOARD_ITEM.module, "view") && (
              <SidebarLink item={DASHBOARD_ITEM} collapsed={collapsed} />
            )}

            {sections.length > 0 && (
              <SidebarGroup
                sections={sections}
                collapsed={collapsed}
                active={onImsRoute}
                open={moduleOpen}
                openSection={openSection}
                onToggle={() => {
                  // A collapsed rail cannot show a submenu, so its job there is
                  // to open the rail wide enough to be worth using.
                  if (collapsed) {
                    onToggle();
                    setModuleOpen(true);
                    return;
                  }
                  setModuleOpen((previous) => !previous);
                }}
                onToggleSection={(id) => {
                  setOpenSection((previous) => (previous === id ? null : id));
                }}
              />
            )}

            {mmsSections.length > 0 && (
              <SidebarGroup
                sections={mmsSections}
                collapsed={collapsed}
                active={onMmsRoute}
                open={mmsModuleOpen}
                openSection={openMmsSection}
                moduleLabel={MMS_LABEL}
                moduleIcon={MMS_ICON}
                onToggle={() => {
                  if (collapsed) {
                    onToggle();
                    setMmsModuleOpen(true);
                    return;
                  }
                  setMmsModuleOpen((previous) => !previous);
                }}
                onToggleSection={(id) => {
                  setOpenMmsSection((previous) => (previous === id ? null : id));
                }}
              />
            )}
            {can("warehouse","view")&&<SidebarGroup sections={WMS_SECTIONS} collapsed={collapsed} active={location.pathname.startsWith("/wms")} open={wmsModuleOpen} openSection={openWmsSection} moduleLabel="Warehouse Management System (WMS)" moduleIcon={WMS_ICON} onToggle={()=>{if(collapsed)onToggle();setWmsModuleOpen(v=>!v);}} onToggleSection={id=>setOpenWmsSection(v=>v===id?null:id)} />}
          </nav>

          {/* Profile, status and the collapse control. */}
          <div className="shrink-0 space-y-2 p-3">
            {!collapsed && user !== null && (
              <div className="flex items-center gap-2.5 rounded-[18px] border border-[var(--glass-border)] bg-[var(--sidebar-panel)] py-2 ps-2.5 pe-1.5 shadow-[inset_0_1px_0_var(--sidebar-edge-top)]">
                <Avatar name={user.displayName} size="sm" src={user.avatarDataUrl} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12.5px] font-medium leading-tight text-[var(--sidebar-active-fg)]">
                    {user.displayName}
                  </p>
                  <p className="truncate text-[11px] leading-tight text-[var(--sidebar-text-muted)]">
                    {user.roleName ?? "User"}
                  </p>
                </div>
                {/* Signing out is the one thing a user does deliberately, so it
                    is a control in its own right rather than an item three menus
                    deep. The user guide has always pointed at the bottom of this
                    menu. */}
                <button
                  type="button"
                  onClick={() => {
                    void signOut();
                  }}
                  aria-label="Sign out"
                  title="Sign out"
                  className="pressable flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--sidebar-text)] transition-colors duration-fast hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-danger)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                >
                  <LogOut className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            )}

            {collapsed && (
              <button
                type="button"
                onClick={() => {
                  void signOut();
                }}
                aria-label="Sign out"
                title="Sign out"
                className="pressable flex h-9 w-full items-center justify-center rounded-xl text-[var(--sidebar-text)] transition-colors duration-fast hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-danger)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
              >
                <LogOut className="h-[17px] w-[17px]" aria-hidden="true" />
              </button>
            )}

            {!collapsed && (
              <div className="flex items-center gap-2 px-1.5">
                <span
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-full",
                    online ? "bg-[var(--success)]" : "bg-[var(--warning)]",
                  )}
                  aria-hidden="true"
                />
                <p className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--sidebar-text)]">
                  {online ? "System Online" : "Licence expiring"}
                </p>
                <p className="tabular shrink-0 text-[11px] text-[var(--sidebar-text-muted)]">
                  v{APP_VERSION}
                  {import.meta.env.DEV ? " · DEV" : ""}
                </p>
              </div>
            )}

            <button
              type="button"
              onClick={onToggle}
              className={cn(
                "hidden h-9 w-full items-center gap-2.5 rounded-xl px-3 text-[13px] font-medium",
                "text-[var(--sidebar-text)] transition-colors duration-fast lg:flex",
                "hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-active-fg)]",
                collapsed && "justify-center px-0",
              )}
              aria-label={collapsed ? "Expand menu" : "Collapse menu"}
            >
              {collapsed ? (
                <ChevronRight className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
              ) : (
                <>
                  <ChevronLeft className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
                  <span>Collapse</span>
                </>
              )}
            </button>

            {/* Vendor credit.

                It lives here, in the rail's own non-scrolling footer, rather
                than in the page: the page scrolls, so a credit placed there would
                scroll out of view and would have to be repeated on every screen.

                Collapsed there is no room for two words, so the whole line
                collapses to nothing instead of wrapping or clipping mid-word. It
                stays mounted for the same reason the nav labels do, so the
                footer does not jump as the rail changes. */}
            <div
              className={cn(
                // `mx-auto` as well as `text-center`: a block with a max-width
                // is left-aligned in its parent by default, so the two lines
                // would sit 13px left of the rail's centre however their text
                // was aligned inside them.
                "mx-auto w-full overflow-hidden text-center",
                "transition-[max-width,opacity] duration-sidebar ease-sidebar",
                collapsed ? "max-w-0 opacity-0" : "max-w-[200px] opacity-100",
              )}
              aria-hidden={collapsed}
            >
              <p className="text-[10.5px] leading-tight text-[var(--sidebar-text-muted)]">
                Powered by
              </p>
              <p className="text-[11.5px] font-semibold leading-tight text-[var(--sidebar-text)]">
                Eyercall
              </p>
            </div>
          </div>
        </div>

        <span className="sr-only">{resolvedTheme}</span>
      </aside>
    </>
  );
}

/**
 * The row a nav entry is drawn with, lit or not.
 *
 * Shared by the plain links and the group headers, because a group and its
 * pages must read as the same kind of object - one pill, one hover.
 */
function rowClasses(isActive: boolean): string {
  return cn(
    // The row's own box does not change shape on collapse: only the label
    // inside it shrinks. Animating the row's padding or alignment instead
    // would move the icon at the instant of the toggle, which is the jump
    // this is here to prevent.
    "transition-[background-color,box-shadow,border-color,transform] duration-normal",
    isActive
      ? "border border-[var(--sidebar-border)] bg-[var(--sidebar-active-bg)] text-[var(--sidebar-active-fg)] " +
          "shadow-[inset_0_1px_0_var(--glass-edge-top),var(--sidebar-active-shadow)]"
      : "border border-transparent text-[var(--sidebar-text)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-active-fg)]",
  );
}

/** The label, kept mounted so a toggle fades it instead of flashing it. */
function RowLabel({
  children,
  collapsed,
}: {
  readonly children: string;
  readonly collapsed: boolean;
}): React.JSX.Element {
  return (
    /* Always mounted. `truncate` keeps it on one line, and shrinking it
       to zero width - rather than unmounting it - is what keeps the row
       from flashing on every toggle. The text stays in the accessibility
       tree either way, which is why the collapsed rail can rely on the
       tooltip alone. */
    <span
      className={cn(
        "min-w-0 flex-1 truncate",
        "transition-[opacity,transform] duration-sidebar ease-sidebar",
        collapsed ? "-translate-x-1 opacity-0 rtl:translate-x-1" : "translate-x-0 opacity-100",
      )}
    >
      {children}
    </span>
  );
}

/** The lit edge that replaces the label in the collapsed rail. */
function ActiveEdge(): React.JSX.Element {
  return (
    <span
      className="absolute inset-y-2 start-0 w-[3px] rounded-full bg-[var(--sidebar-active-indicator)]"
      aria-hidden="true"
    />
  );
}

/**
 * A chevron that turns rather than being swapped for a second icon, so the
 * control reads as one object changing state instead of two icons replacing
 * each other.
 */
function Chevron({ open }: { readonly open: boolean }): React.JSX.Element {
  return (
    <ChevronDown
      className={cn(
        "h-4 w-4 shrink-0 text-[var(--sidebar-text-muted)]",
        "transition-transform duration-sidebar ease-sidebar",
        open ? "rotate-0" : "-rotate-90",
      )}
      aria-hidden="true"
    />
  );
}

/**
 * A list that opens and shuts without a measured height.
 *
 * `grid-template-rows` from `0fr` to `1fr` is what animates a height the CSS
 * cannot know in advance: the list is as long as the section's permission-
 * filtered pages, and a fixed `max-height` would either clip it or leave the
 * animation lagging behind the real size.
 *
 * `visibility` is in the transition list rather than swapped on its own, so a
 * closed group drops its links out of the tab order at the end of the fade
 * instead of leaving invisible, unreachable screens.
 */
function Reveal({
  open,
  children,
}: {
  readonly open: boolean;
  readonly children: React.JSX.Element;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "grid overflow-hidden",
        "transition-[grid-template-rows,opacity,visibility] duration-sidebar ease-sidebar",
        open ? "visible grid-rows-[1fr] opacity-100" : "invisible grid-rows-[0fr] opacity-0",
      )}
    >
      {children}
    </div>
  );
}

function SidebarLink({
  item,
  collapsed,
  nested = false,
}: {
  readonly item: NavItem;
  readonly collapsed: boolean;
  /** A page inside a group: slightly lighter than the group header. */
  readonly nested?: boolean | undefined;
}): React.JSX.Element {
  const Icon = item.icon;

  return (
    <NavLink
      to={item.path}
      // A group header that is also a page - IMS's own Overview - must not stay
      // lit for every screen beneath it.
      end={item.exact === true || item.path === "/"}
      className={({ isActive }) =>
        cn(
          "pressable relative flex w-full items-center gap-3 rounded-xl px-3 font-medium",
          nested ? "h-9 text-[13px]" : "h-10 text-[13.5px]",
          rowClasses(isActive),
        )
      }
      title={collapsed ? item.label : undefined}
    >
      {({ isActive }) => (
        <>
          {/* In the collapsed rail the label is gone, so a lit edge is the only
              thing left that can answer "where am I". Expanded, the raised pill
              already says it. */}
          {isActive && collapsed && <ActiveEdge />}
          <Icon
            className={cn(
              "h-[18px] w-[18px] shrink-0",
              isActive ? "text-[var(--sidebar-active-indicator)]" : "",
            )}
            aria-hidden="true"
          />
          <RowLabel collapsed={collapsed}>{item.label}</RowLabel>
        </>
      )}
    </NavLink>
  );
}

/**
 * The Inventory Management System: one row in the rail, its groups inside it.
 *
 * In the collapsed rail there is no room for a submenu at any depth, so the
 * module shows its icon alone and opening it widens the rail as well - nested
 * lists of 18px glyphs with no labels would answer nothing.
 */
function SidebarGroup({
  sections,
  collapsed,
  active,
  open,
  openSection,
  onToggle,
  onToggleSection,
  moduleLabel = IMS_LABEL,
  moduleIcon: ModuleIconProp = IMS_ICON,
}: {
  readonly sections: readonly NavSection[];
  readonly collapsed: boolean;
  readonly active: boolean;
  readonly open: boolean;
  readonly openSection: string | null;
  readonly onToggle: () => void;
  readonly onToggleSection: (id: string) => void;
  readonly moduleLabel?: string;
  readonly moduleIcon?: typeof IMS_ICON;
}): React.JSX.Element {
  const ModuleIcon = ModuleIconProp;
  const expanded = open && !collapsed;

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        title={collapsed ? moduleLabel : undefined}
        className={cn(
          "pressable relative flex h-10 w-full items-center gap-3 rounded-xl px-3 text-[13.5px] font-medium",
          rowClasses(active),
        )}
      >
        {active && collapsed && <ActiveEdge />}
        <ModuleIcon
          className={cn(
            "h-[18px] w-[18px] shrink-0",
            active ? "text-[var(--sidebar-active-indicator)]" : "",
          )}
          aria-hidden="true"
        />
        <RowLabel collapsed={collapsed}>{moduleLabel}</RowLabel>
        {/* Dropped entirely in the collapsed rail, where the row has no width
            left for it once the icon is centred. */}
        {!collapsed && <Chevron open={open} />}
      </button>

      <Reveal open={expanded}>
        <ul className="ms-[19px] min-h-0 space-y-0.5 overflow-hidden border-s border-[var(--sidebar-border)] ps-2 pt-1">
          {sections.map((section) => (
            <SidebarSection
              key={section.id}
              section={section}
              open={openSection === section.id}
              onToggle={onToggleSection}
            />
          ))}
        </ul>
      </Reveal>
    </div>
  );
}

/**
 * One group inside the module - Purchasing, Sales, Stock Control.
 *
 * A group with a single page is that page: a collapsible with one child adds a
 * click and hides where it goes, so Overview and Product Catalog render as rows.
 */
function SidebarSection({
  section,
  open,
  onToggle,
}: {
  readonly section: NavSection;
  readonly open: boolean;
  readonly onToggle: (id: string) => void;
}): React.JSX.Element {
  const Icon = section.icon;

  if (section.items.length === 1) {
    return (
      <li>
        <SidebarLink item={section.items[0] as NavItem} collapsed={false} nested />
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        onClick={() => {
          onToggle(section.id);
        }}
        aria-expanded={open}
        className={cn(
          "pressable flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-[13px] font-medium",
          // A group heading is quieter than the pages under it: it is a label
          // that happens to open, not a destination of its own.
          "text-[var(--sidebar-text)] transition-colors duration-normal",
          "hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-active-fg)]",
          open && "text-[var(--sidebar-active-fg)]",
        )}
      >
        <Icon className="h-[17px] w-[17px] shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-start">{section.label}</span>
        <Chevron open={open} />
      </button>

      <Reveal open={open}>
        <ul className="ms-[15px] min-h-0 space-y-0.5 overflow-hidden border-s border-[var(--sidebar-border)] ps-2 pt-0.5">
          {section.items.map((item) => (
            <li key={item.path}>
              <SidebarLink item={item} collapsed={false} nested />
            </li>
          ))}
        </ul>
      </Reveal>
    </li>
  );
}

/**
 * The application logo mark.
 */
export function BrandMark({ className }: { readonly className?: string }): React.JSX.Element {
  return (
    <span
      className={cn("flex h-8 w-8 shrink-0 items-center justify-center", className)}
      aria-hidden="true"
    >
      <img src={logoUrl} alt="" className="h-full w-full object-contain" />
    </span>
  );
}
