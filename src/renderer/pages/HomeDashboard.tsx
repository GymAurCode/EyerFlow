/**
 * EyerFlow main dashboard.
 *
 * The workspace home, so it answers a different question to the IMS overview:
 * not "how is my stock" but "what is installed, and is it healthy". It lists
 * the modules this application actually has - today, the Inventory Management
 * System - and pulls each figure from the same `dashboard.summary` read the IMS
 * overview makes for the same window, so the two screens can never disagree.
 *
 * Nothing here is estimated or seeded: a tile the role may not see is omitted
 * rather than shown as zero, and a module card never claims a page the user
 * cannot open.
 */

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  Coins,
  LayoutDashboard,
  Package,
  TrendingUp,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { call } from "../lib/api";
import { useApp } from "../lib/app-context";
import { APP_VERSION } from "../lib/app-version";
import { formatMoney } from "../lib/format";
import { addDaysIso, cn, todayIso } from "../lib/utils";
import { IMS_PATH, visibleSections } from "../lib/ims-nav";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState, PageHeader, Skeleton } from "../components/ui/Feedback";
import { GlassChip } from "../components/ui/Glass";
import { StatCard } from "../components/ui/StatCard";

function greetingFor(hour: number): string {
  if (hour < 12) return "Good Morning";
  if (hour < 17) return "Good Afternoon";
  return "Good Evening";
}

/** Change as a fraction, or null when there is nothing to compare against. */
function ratio(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return (current - previous) / previous;
}

export function HomeDashboardPage(): React.JSX.Element {
  const { user, can, licenseStatus } = useApp();
  const navigate = useNavigate();

  const canSeeProducts = can("products", "view");
  const canSeeSales = can("sales", "view");

  const open =
    (path: string): (() => void) =>
    () => {
      void navigate(path);
    };

  const summary = useQuery({
    queryKey: ["dashboard", "summary", "today", canSeeProducts],
    queryFn: () => {
      const today = todayIso();
      const yesterday = addDaysIso(today, -1);
      return call("dashboard.summary", {
        fromDate: today,
        toDate: today,
        previousFromDate: yesterday,
        previousToDate: yesterday,
        includeInventory: canSeeProducts,
      });
    },
  });

  // One tile per group in the rail, aimed at the first screen of that group.
  // Listing all eighteen pages here would be the old flat menu back again, and
  // the point of the module card is to say what IMS is made of.
  const chips = visibleSections(can).flatMap((section) => {
    const first = section.items[0];
    return first === undefined
      ? []
      : [{ label: section.label, icon: section.icon, path: first.path }];
  });

  const greeting = `${greetingFor(new Date().getHours())}${
    user === null ? "" : `, ${user.displayName}`
  }`;

  const header = <PageHeader title="Dashboard" description={`${greeting}.`} />;

  if (chips.length === 0) {
    return (
      <>
        {header}
        <EmptyState
          icon={<Boxes className="h-6 w-6" />}
          title="No modules available"
          description="Your role has not been given access to any module yet. Ask an administrator to change your role."
        />
      </>
    );
  }

  if (summary.isLoading || summary.data === undefined) {
    return (
      <>
        {header}
        <HomeSkeleton />
      </>
    );
  }

  const data = summary.data;
  const inventory = data.inventory;
  const salesDelta = ratio(data.salesFils, data.previousSalesFils);

  return (
    <>
      {header}

      <div className="space-y-5">
        {/* The modules this installation has, in one card per module. */}
        <Card flush>
          <div className="flex min-h-[60px] items-center gap-2.5 border-b border-[var(--border)] px-5 py-3">
            <Boxes className="h-[18px] w-[18px] shrink-0 text-[var(--text-2)]" aria-hidden="true" />
            <h2 className="truncate text-[15px] font-semibold text-[var(--text)]">Modules</h2>
          </div>

          <div className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-4 px-1 pb-4">
              <div className="flex min-w-0 items-start gap-3">
                <GlassChip tone="brand" className="h-11 w-11 shrink-0">
                  <LayoutDashboard className="h-5 w-5 text-[var(--brand)]" aria-hidden="true" />
                </GlassChip>
                <div className="min-w-0">
                  <p className="text-[14.5px] font-semibold text-[var(--text)]">
                    Inventory Management System (IMS)
                  </p>
                  <p className="mt-1 text-[12.5px] text-[var(--text-2)]">
                    Your catalogue, trading ledgers, contacts, money and reports in one place.
                  </p>
                </div>
              </div>

              <Button
                variant="primary"
                size="sm"
                iconRight={<ArrowRight className="h-4 w-4" />}
                onClick={open(IMS_PATH.home)}
              >
                Open IMS
              </Button>
            </div>

            {/* The groups inside the module, filtered by the same permissions the
                rail uses, so the card never offers a screen it cannot open. */}
            <ul className="flex flex-wrap gap-2 border-t border-[var(--divider)] pt-4">
              {chips.map((page) => {
                const Icon: LucideIcon = page.icon;
                return (
                  <li key={page.path}>
                    <button
                      type="button"
                      onClick={open(page.path)}
                      className={cn(
                        "pressable glass flex items-center gap-1.5 rounded-[16px] px-2 py-2 text-[12px]",
                        "font-medium text-[var(--text)] hover:-translate-y-0.5",
                        "hover:shadow-[var(--shadow-glass-hover)] focus-visible:outline-none",
                        "focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
                      )}
                    >
                      <GlassChip tone="neutral" className="h-[26px] w-[26px] shrink-0">
                        <Icon
                          className="h-[14px] w-[14px] text-[var(--text-2)]"
                          aria-hidden="true"
                        />
                      </GlassChip>
                      <span className="min-w-0 truncate">{page.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </Card>

        {/* Live figures for the module that is installed, all read for today. */}
        {can('warehouse','view')&&<Card><div className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="text-[15px] font-semibold text-ink">Warehouse Management System (WMS)</h2><p className="mt-1 text-sm text-ink-secondary">Receiving, physical storage, warehouse tasks and shipment execution.</p></div><Button size="sm" onClick={open('/wms/overview')} iconRight={<ArrowRight className="h-4 w-4"/>}>Open WMS</Button></div></Card>}
        <section
          aria-label="Key metrics"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
        >
          <StatCard
            label="Total Products"
            value={inventory.productCount.toLocaleString("en-US")}
            icon={<Package className="h-5 w-5" aria-hidden="true" />}
            tone="brand"
            deltaLabel="Across the catalogue"
            onClick={canSeeProducts ? open(IMS_PATH.products) : undefined}
            hiddenForStaff={!canSeeProducts}
          />
          <StatCard
            label="Low Stock"
            value={data.lowStockCount.toLocaleString("en-US")}
            hint="Five units or fewer"
            icon={<AlertTriangle className="h-5 w-5" aria-hidden="true" />}
            tone={data.lowStockCount > 0 ? "danger" : "neutral"}
            deltaLabel={data.lowStockCount > 0 ? "Needs reordering" : "Nothing to reorder"}
            onClick={canSeeProducts ? open(IMS_PATH.products) : undefined}
            hiddenForStaff={!canSeeProducts}
          />
          <StatCard
            label="Total Inventory Value"
            value={formatMoney(inventory.totalStockValueFils)}
            hint="At the last recorded cost"
            icon={<Coins className="h-5 w-5" aria-hidden="true" />}
            tone="violet"
            deltaLabel="Today"
            onClick={canSeeProducts ? open(IMS_PATH.products) : undefined}
            hiddenForStaff={!canSeeProducts}
          />
          <StatCard
            label="Sales Today"
            value={formatMoney(data.salesFils)}
            icon={<TrendingUp className="h-5 w-5" aria-hidden="true" />}
            tone="success"
            delta={salesDelta}
            deltaLabel="vs yesterday"
            onClick={canSeeSales ? open(IMS_PATH.salesInvoices) : undefined}
            hiddenForStaff={!canSeeSales}
          />
        </section>

        {/* System status, the one line that says the application itself is healthy. */}
        <Card flush className="flex items-center gap-3 p-4">
          <span
            className={cn(
              "h-2.5 w-2.5 shrink-0 rounded-full",
              licenseStatus === null ? "bg-[var(--success)]" : "bg-[var(--warning)]",
            )}
            aria-hidden="true"
          />
          <p className="shrink-0 text-[12.5px] font-medium text-[var(--text)]">
            {licenseStatus === null ? "System Online" : "Licence expiring"}
          </p>
          <span className="h-4 w-px shrink-0 bg-[var(--border)]" aria-hidden="true" />
          <p className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--text-3)]">
            {licenseStatus === null
              ? "All systems operational"
              : `Licence for ${licenseStatus.clientName} needs attention`}
          </p>
          <p className="tabular hidden shrink-0 text-[12px] text-[var(--text-3)] sm:block">
            v{APP_VERSION}
          </p>
        </Card>
      </div>
    </>
  );
}

function HomeSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-5" aria-busy="true">
      <Skeleton className="h-[180px] rounded-panel" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_unused, index) => (
          <Skeleton key={index} className="h-[148px] rounded-panel" />
        ))}
      </div>
      <Skeleton className="h-[60px] rounded-panel" />
    </div>
  );
}
