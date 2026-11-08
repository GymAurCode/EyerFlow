/**
 * App shell: sidebar + header + routed content.
 *
 * Owns the global keyboard shortcuts, because they have to work from anywhere
 * and belong to no particular screen, and the one piece of responsive state the
 * rail needs: below `lg` the sidebar becomes an overlay drawer opened from the
 * header rather than a column that squeezes the page, and a glass dock along
 * the bottom edge carries the modules that are used most.
 *
 * The rail floats: it is inset from the window edge by `--sidebar-gutter` on
 * every side, so the page shows past it. The header floats too, and it is
 * rendered *inside* the scroll container rather than beside it - that is what
 * makes it sticky, and what puts the real page content behind the glass.
 *
 * Nothing here blurs the page content. The header, the menus, the dialogs and
 * the dock are the only surfaces that pay for `backdrop-filter`, because they
 * are the only ones with moving content behind them; a panel in the page layout
 * is translucent over a smooth field, so a blur there would cost a backdrop
 * readback per panel and change nothing.
 */

import { useCallback, useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { BottomNav } from "./BottomNav";
import { useApp } from "../../lib/app-context";
import { IMS_PATH, locate, locateMms, mmsTrailFor, trailFor } from "../../lib/ims-nav";
import { WMS_SECTIONS } from "../../lib/wms-nav";
import { cn } from "../../lib/utils";

/** The one screen outside IMS that the header menu links to. */
const PROFILE_PATH = "/profile";

/**
 * The screen's own name, for the top bar's screen-reader heading.
 *
 * Read from the navigation model rather than a second table of titles, so a page
 * cannot be called one thing by the rail and another by the header.
 */
function titleForPath(pathname: string): string {
  if (pathname === "/") return "Dashboard";
  if (pathname === PROFILE_PATH) return "Profile";
  // Both modules answer here: an MMS screen used to fall through to the
  // application name, so the header said "EyerFlow" on every manufacturing page.
  return WMS_SECTIONS.flatMap(s=>s.items).find(i=>i.path===pathname)?.label ?? locate(pathname)?.item.label ?? locateMms(pathname)?.item.label ?? "EyerFlow";
}

/** Below this width the sidebar stops reserving space and becomes a drawer. */
const DRAWER_BREAKPOINT = 1024;

export function AppShell(): React.JSX.Element {
  const { can } = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isNarrow, setIsNarrow] = useState(
    () => typeof window !== "undefined" && window.innerWidth < DRAWER_BREAKPOINT,
  );

  // One listener for the whole app: the rail is a column on a wide window and a
  // drawer on a narrow one, and switching has to survive a resize or a rotate.
  useEffect(() => {
    const media = window.matchMedia(`(max-width: ${String(DRAWER_BREAKPOINT - 1)}px)`);

    const apply = (matches: boolean): void => {
      setIsNarrow(matches);
      if (!matches) setDrawerOpen(false);
    };

    const onChange = (event: MediaQueryListEvent | MediaQueryList): void => {
      apply(event.matches);
    };

    apply(media.matches);
    media.addEventListener("change", onChange);
    return () => {
      media.removeEventListener("change", onChange);
    };
  }, []);

  // A route change must dismiss the drawer, or the page it opened is hidden
  // behind the menu that was used to get there.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const ctrl = event.ctrlKey || event.metaKey;
      if (!ctrl) return;

      const key = event.key.toLowerCase();

      // Ctrl+N / Ctrl+P open the sale / purchase dialog on the relevant list.
      // The dialogs are owned by the list pages, so navigate there and let the
      // page open its own dialog via a custom event.
      if (key === "n" && can("sales", "create")) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("eyerstock:new-sale"));
        if (location.pathname !== IMS_PATH.salesInvoices) {
          void navigate(IMS_PATH.salesInvoices);
        }
        return;
      }

      if (key === "p" && can("purchases", "create")) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("eyerstock:new-purchase"));
        if (location.pathname !== IMS_PATH.purchaseInvoices) {
          void navigate(IMS_PATH.purchaseInvoices);
        }
        return;
      }

      if (key === "s") {
        event.preventDefault();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [can, navigate, location.pathname]);

  const toggleSidebar = useCallback((): void => {
    setSidebarCollapsed((previous) => !previous);
  }, []);

  const toggleDrawer = useCallback((): void => {
    setDrawerOpen((previous) => !previous);
  }, []);

  return (
    // `overflow-clip` rather than `overflow-hidden`: both clip, but only the
    // latter also makes this element a scroll container, and a scroll container
    // anywhere above a sticky element becomes the box that sticky positions
    // against - which would stop the header sticking to the page.
    <div className="flex w-full overflow-clip app-shell">
      {isNarrow ? (
        <Sidebar
          collapsed={false}
          onToggle={toggleSidebar}
          mobileOpen={drawerOpen}
          onMobileClose={() => {
            setDrawerOpen(false);
          }}
        />
      ) : (
        <Sidebar collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <main
          id="main-content"
          className={cn(
            "app-main flex-1 overflow-y-auto",
            // Room for the dock, so the last row of a table is never trapped
            // underneath it on a phone.
            isNarrow && "pb-[calc(var(--bottomnav-height)+1.5rem)]",
          )}
          style={
            isNarrow
              ? undefined
              : {
                  marginInlineStart: sidebarCollapsed
                    ? "var(--sidebar-width-collapsed)"
                    : "var(--sidebar-width)",
                  // The same tokens the rail uses, so the page edge and the rail
                  // edge arrive together. Two independently timed transitions on
                  // the same seam is what produces a visible drag between them.
                  transition: "margin-inline-start var(--dur-sidebar) var(--ease-sidebar)",
                }
          }
        >
          {/*
           * The header lives inside the scroll container, not beside it, so
           * that `sticky` has the page itself as its constraint and the content
           * passing under it is real content for the blur to pick up. It shares
           * the content column's width and padding, so the search field and the
           * cards below it line up on one edge.
           */}
          <div className="sticky top-0 z-30 mx-auto w-full max-w-[1440px] px-4 pb-2 pt-4 sm:px-6 lg:px-7 app-topbar">
            <Topbar
              title={titleForPath(location.pathname)}
              onOpenNav={isNarrow ? toggleDrawer : undefined}
            />
          </div>

          <div className="mx-auto w-full max-w-[1440px] px-4 pb-6 sm:px-6 lg:px-7">
            {/* Where the screen sits in the module. It sits above the page's own
                heading rather than inside the glass header, because the header is
                one row of controls and a second line there would move every
                button on the page whenever a title wrapped. */}
            <Breadcrumbs pathname={location.pathname} search={location.search} />
            <Outlet />
          </div>
        </main>
      </div>

      {isNarrow && <BottomNav onOpenMenu={toggleDrawer} />}
    </div>
  );
}

/**
 * The trail from the module to the screen in front of the user.
 *
 * Every step but the last is a button: on a window this narrow a browser-back
 * gesture is not something a shopkeeper reaches for, and the point of the trail
 * is to get out of a deep screen in one click. A step the role may not open is
 * printed rather than linked, so the trail never offers a door that the guard
 * behind it would close.
 */
function Breadcrumbs({
  pathname,
  search,
}: {
  readonly pathname: string;
  readonly search: string;
}): React.JSX.Element | null {
  const { can } = useApp();
  const navigate = useNavigate();
  // Manufacturing keeps its own trail table, because its section ids are the
  // same words as IMS's (overview, configuration) under a different module.
  const mmsTrail = mmsTrailFor(pathname);
  const wmsSection=WMS_SECTIONS.find(section=>section.items.some(item=>item.path===pathname));
  const wmsItem=wmsSection?.items.find(item=>item.path===pathname);
  const wmsTrail=wmsSection&&wmsItem?[{label:'WMS',path:'/wms/overview'},{label:wmsSection.label,path:wmsSection.items[0]?.path??'/wms/overview'},{label:wmsItem.label,path:wmsItem.path}].filter((crumb,index,all)=>all.findIndex(other=>other.path===crumb.path)===index):[];
  const trail = wmsTrail.length>0?wmsTrail:mmsTrail.length > 0 ? mmsTrail : trailFor(pathname, search);

  // The module's own home has nothing above it, and the two screens outside IMS
  // have no trail at all.
  if (trail.length < 2) return null;

  return (
    <nav aria-label="Breadcrumb" className="-mt-1 mb-2">
      <ol className="flex flex-wrap items-center gap-1 text-[11.5px] text-[var(--text-3)]">
        {trail.map((crumb, index) => {
          const last = index === trail.length - 1;
          const target = locateMms(crumb.path) ?? locate(crumb.path, "");
          const reachable = crumb.path.startsWith('/wms/')?can('warehouse','view'):target !== null && can(target.item.module, "view");

          return (
            <li key={crumb.path} className="flex items-center gap-1">
              {index > 0 && <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />}
              {last || !reachable ? (
                <span
                  className={last ? "text-[var(--text-2)]" : ""}
                  aria-current={last ? "page" : undefined}
                >
                  {crumb.label}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    void navigate(crumb.path);
                  }}
                  className="rounded transition-colors duration-fast hover:text-[var(--brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                >
                  {crumb.label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
