/**
 * Dashboard.
 *
 * The screen a shopkeeper sees when they open the app, so it answers four
 * questions in one look and nothing else: how many products are there, how much
 * stock is on hand, what is about to run out, and what is that stock worth -
 * then shows the five newest products and the things waiting to be done.
 *
 * Layout, top to bottom:
 *   greeting + the period the figures cover + that period's sales
 *   four KPI tiles, one per question above, in a single row on desktop
 *   recent products beside stock overview, quick actions and recent activity
 *
 * Every figure is read from the live database through the same RPC surface the
 * rest of the app uses, and is subject to the same permissions. The period
 * selector in the header drives the sales readout, the trend window and the
 * activity list, so changing it genuinely changes what the page claims; tiles
 * whose data the viewer may not see are omitted rather than shown as zero.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Boxes,
  CalendarDays,
  ChevronDown,
  ClipboardList,
  Coins,
  HandCoins,
  Package,
  Receipt,
  ShoppingCart,
  TrendingUp,
  UserPlus,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  DashboardInventoryCategoryDto,
  DocumentDto,
  ProductDto,
  StockMovementDto,
} from "../../shared/types";
import { call } from "../lib/api";
import { useApp } from "../lib/app-context";
import { APP_VERSION } from "../lib/app-version";
import { formatMoney, formatMoneyCompact, formatQuantity } from "../lib/format";
import { IMS_PATH } from "../lib/ims-nav";
import { addDaysIso, formatDate, todayIso } from "../lib/utils";
import { Avatar } from "../components/ui/Avatar";
import { Badge, StockBadge, type BadgeTone } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { DropdownMenu, DropdownItem, RowActions } from "../components/ui/Dropdown";
import { EmptyState, Skeleton } from "../components/ui/Feedback";
import { DeltaPill, StatCard } from "../components/ui/StatCard";
import { MixDonut } from "../components/charts/MixDonut";
import { cn } from "../lib/utils";

/* -------------------------------------------------------------------------- */
/* periods                                                                    */
/* -------------------------------------------------------------------------- */

type PeriodId = "today" | "7d" | "30d" | "month";

interface Period {
  readonly id: PeriodId;
  readonly label: string;
  /** Human wording for the greeting and the trend subtitle. */
  readonly noun: string;
  /** The sales readout's own title, so it always names its period. */
  readonly salesTitle: string;
  /** One line describing what "previous" means for the delta. */
  readonly comparison: string;
  /** How many days the stock trend is drawn over. */
  readonly trendDays: number;
  /** Length of the window, used to place the previous one. */
  readonly lengthDays: number;
}

const PERIODS: readonly Period[] = [
  {
    id: "today",
    label: "Today",
    noun: "today",
    salesTitle: "Sales Today",
    comparison: "vs yesterday",
    trendDays: 7,
    lengthDays: 1,
  },
  {
    id: "7d",
    label: "Last 7 Days",
    noun: "the last 7 days",
    salesTitle: "Sales (Last 7 Days)",
    comparison: "vs previous 7 days",
    trendDays: 7,
    lengthDays: 7,
  },
  {
    id: "30d",
    label: "Last 30 Days",
    noun: "the last 30 days",
    salesTitle: "Sales (Last 30 Days)",
    comparison: "vs previous 30 days",
    trendDays: 30,
    lengthDays: 30,
  },
  {
    id: "month",
    label: "This Month",
    noun: "this month",
    salesTitle: "Sales (This Month)",
    comparison: "vs same period last month",
    trendDays: 30,
    lengthDays: Number.parseInt(todayIso().slice(8, 10), 10),
  },
];

/** The window a period covers, ending today. */
function periodBounds(period: Period, today: string): { from: string; to: string } {
  if (period.id === "today") return { from: today, to: today };
  if (period.id === "month") return { from: `${today.slice(0, 7)}-01`, to: today };
  return { from: addDaysIso(today, -(period.lengthDays - 1)), to: today };
}

function greetingFor(hour: number): string {
  if (hour < 12) return "Good Morning";
  if (hour < 17) return "Good Afternoon";
  return "Good Evening";
}

/* -------------------------------------------------------------------------- */
/* stock value series                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Walk the ledger backwards from today's valuation.
 *
 * `todayValueFils` is the sum every product already reports. Each movement after
 * a given day changed stock by `costFils` - signed, so a receipt adds and an
 * issue subtracts - and therefore subtracting everything after that day gives
 * the value at its close. The last point always equals the headline figure, so
 * the chart and the tile can never disagree.
 */
export function buildStockValueSeries(
  todayValueFils: number,
  movements: readonly StockMovementDto[],
  today: string,
  days: number,
): readonly { readonly date: string; readonly valueFils: number }[] {
  const points: { date: string; valueFils: number }[] = [];

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = addDaysIso(today, -offset);
    let moved = 0;
    for (const movement of movements) {
      if (movement.movementDate > date) moved += movement.costFils;
    }
    points.push({ date, valueFils: Math.max(0, todayValueFils - moved) });
  }

  return points;
}

/** Change as a fraction, or null when there is nothing to compare against. */
function ratio(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return (current - previous) / previous;
}

/* -------------------------------------------------------------------------- */
/* category mix                                                               */
/* -------------------------------------------------------------------------- */

/** How many slices the ring shows before the rest is folded into "Other". */
const MAX_SLICES = 5;

/**
 * What the catalogue is made of, by value.
 *
 * Value is the honest measure here because that is what the tile above it
 * totals, but a brand-new shop has products at zero cost and would otherwise
 * get a ring with nothing in it - so with no value recorded anywhere, the
 * count of products per category is used instead and says so in the legend's
 * own tooltip.
 */
function buildCategoryMix(categories: readonly DashboardInventoryCategoryDto[]): {
  readonly slices: readonly { readonly name: string; readonly value: number }[];
  readonly total: number;
  readonly byValue: boolean;
} {
  let totalValue = 0;
  let productCount = 0;
  for (const category of categories) {
    totalValue += category.valueFils;
    productCount += category.count;
  }

  const byValue = totalValue > 0;
  const measure = (category: DashboardInventoryCategoryDto): number =>
    byValue ? category.valueFils : category.count;

  // The database returns categories in name order, so ties stay stable in the
  // same way they did when this was built from an alphabetical product list.
  const sorted = [...categories].sort((a, b) => measure(b) - measure(a));
  const head = sorted
    .map((category) => ({ name: category.name, value: measure(category) }))
    // A category holding nothing is not part of the answer; listing it at 0%
    // only makes the real slices harder to read.
    .filter((slice) => slice.value > 0)
    .slice(0, MAX_SLICES);

  if (sorted.length > MAX_SLICES) {
    const rest = sorted.slice(MAX_SLICES).reduce((sum, category) => sum + measure(category), 0);
    if (rest > 0) head.push({ name: "Other", value: rest });
  }

  return { slices: head, total: byValue ? totalValue : productCount, byValue };
}

const EMPTY_PRODUCTS: readonly ProductDto[] = [];
const EMPTY_CATEGORIES: readonly DashboardInventoryCategoryDto[] = [];
const EMPTY_UNITS: readonly string[] = [];

/* -------------------------------------------------------------------------- */
/* page                                                                       */
/* -------------------------------------------------------------------------- */

export function DashboardPage(): React.JSX.Element {
  const { user, can, licenseStatus } = useApp();
  const navigate = useNavigate();

  const [periodId, setPeriodId] = useState<PeriodId>("today");
  // `PERIODS` is a const list that is never empty, so the fallback needs no
  // runtime check - only the type system cannot see that.
  const period = PERIODS.find((entry) => entry.id === periodId) ?? PERIODS[0]!;

  const today = todayIso();

  const canSeeProducts = can("products", "view");
  const canSeeInventory = can("inventory", "view");
  const canSeeSales = can("sales", "view");

  const bounds = periodBounds(period, today);

  // The previous window is the same length immediately before this one, so a
  // delta always compares like with like.
  const previous = useMemo(
    () => ({
      from: addDaysIso(bounds.from, -period.lengthDays),
      to: addDaysIso(bounds.to, -period.lengthDays),
    }),
    [bounds.from, bounds.to, period.lengthDays],
  );

  const summary = useQuery({
    queryKey: [
      "dashboard",
      "summary",
      bounds.from,
      bounds.to,
      previous.from,
      previous.to,
      canSeeProducts,
    ],
    queryFn: () =>
      call("dashboard.summary", {
        fromDate: bounds.from,
        toDate: bounds.to,
        previousFromDate: previous.from,
        previousToDate: previous.to,
        includeInventory: canSeeProducts,
      }),
  });

  // The trend window's movements, plus today's valuation to walk backwards
  // from. Both are real reads; neither is estimated.
  const trendFrom = addDaysIso(today, -(period.trendDays - 1));
  const canSeeTrend = canSeeProducts && canSeeInventory;
  const movements = useQuery({
    queryKey: ["dashboard", "movements", trendFrom],
    queryFn: () => call("products.movements", { fromDate: trendFrom, limit: 5000 }),
    enabled: canSeeTrend,
  });

  const invoices = useQuery({
    queryKey: ["dashboard", "invoices", bounds.from, bounds.to],
    queryFn: () =>
      call("documents.list", {
        kind: "invoice",
        fromDate: bounds.from,
        toDate: bounds.to,
        limit: 50,
      }),
    enabled: canSeeSales,
  });

  const inventory = summary.data?.inventory;
  const productCount = inventory?.productCount ?? 0;
  const totalStockValue = inventory?.totalStockValueFils ?? 0;
  const units = inventory?.units ?? EMPTY_UNITS;
  const categories = inventory?.categories ?? EMPTY_CATEGORIES;
  const recentProducts = inventory?.recentProducts ?? EMPTY_PRODUCTS;
  const lowStockRows = inventory?.lowStockProducts ?? EMPTY_PRODUCTS;

  /**
   * Units on hand, summed across the catalogue.
   *
   * A catalogue can hold more than one unit - pieces and litres in the same
   * shop - so the tile says so in its hint rather than pretending the sum is a
   * single physical quantity.
   */
  const totalStock = useMemo(() => {
    return {
      milli: inventory?.totalQuantityMilli ?? 0,
      stocked: inventory?.stockedCount ?? 0,
      unitHint:
        units.length > 1
          ? "Units on hand (mixed units)"
          : units.length === 1
            ? `Units on hand (${units[0]})`
            : "Units on hand",
    };
  }, [inventory?.totalQuantityMilli, inventory?.stockedCount, units]);

  const trend = useMemo(
    () => buildStockValueSeries(totalStockValue, movements.data ?? [], today, period.trendDays),
    [totalStockValue, movements.data, today, period.trendDays],
  );

  const mix = useMemo(() => buildCategoryMix(categories), [categories]);

  if (summary.isLoading || summary.data === undefined) {
    return <DashboardSkeleton />;
  }

  const data = summary.data;
  const salesDelta = ratio(data.salesFils, data.previousSalesFils);

  const go =
    (path: string): (() => void) =>
    () => {
      void navigate(path);
    };

  const open =
    (event: string, path: string): (() => void) =>
    () => {
      void navigate(path);
      window.dispatchEvent(new CustomEvent(event));
    };

  return (
    <div className="space-y-5">
      {/* Greeting, and the period every figure below is scoped to */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold leading-7 text-[var(--text)]">
            {greetingFor(new Date().getHours())}
            {user === null ? "" : `, ${user.displayName}`}
          </h1>
          <p className="mt-1 text-[13px] text-[var(--text-2)]">
            Here&apos;s an overview of your inventory for {period.noun}.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {/* Sales for the chosen period. It belongs to the period selector
              rather than to a tile, so the four KPIs stay about stock. */}
          {canSeeSales && (
            <div className="glass flex items-center gap-3 rounded-[18px] px-4 py-2">
              <span className="glass-chip chip-teal h-8 w-8 text-[var(--success)]">
                <TrendingUp className="h-4 w-4" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-[11.5px] text-[var(--text-3)]">{period.salesTitle}</p>
                <p className="tabular truncate text-[15px] font-semibold leading-tight text-[var(--text)]">
                  {formatMoney(data.salesFils)}
                </p>
              </div>
              {salesDelta !== null && <DeltaPill delta={salesDelta} />}
            </div>
          )}

          <DropdownMenu
            align="end"
            trigger={
              <Button
                variant="secondary"
                iconLeft={<CalendarDays className="h-4 w-4" />}
                iconRight={<ChevronDown className="h-4 w-4" />}
              >
                {period.label}
              </Button>
            }
          >
            {PERIODS.map((entry) => (
              <DropdownItem
                key={entry.id}
                checked={entry.id === periodId}
                onSelect={() => {
                  setPeriodId(entry.id);
                }}
              >
                {entry.label}
              </DropdownItem>
            ))}
          </DropdownMenu>
        </div>
      </header>

      {/* Four separate KPI tiles, each the same neutral panel */}
      <section
        aria-label="Key metrics"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <StatCard
          label="Total Products"
          value={productCount.toLocaleString("en-US")}
          icon={<Package className="h-5 w-5" aria-hidden="true" />}
          tone="brand"
          deltaLabel="Across the catalogue"
          onClick={canSeeProducts ? go(IMS_PATH.products) : undefined}
          hiddenForStaff={!canSeeProducts}
        />
        <StatCard
          label="Total Stock"
          value={formatQuantity(totalStock.milli)}
          hint={totalStock.unitHint}
          icon={<Boxes className="h-5 w-5" aria-hidden="true" />}
          tone="info"
          deltaLabel={`${String(totalStock.stocked)} of ${String(productCount)} stocked`}
          onClick={canSeeProducts ? go(IMS_PATH.products) : undefined}
          hiddenForStaff={!canSeeProducts}
        />
        <StatCard
          label="Low Stock"
          value={data.lowStockCount.toLocaleString("en-US")}
          hint="Five units or fewer"
          icon={<AlertTriangle className="h-5 w-5" aria-hidden="true" />}
          tone={data.lowStockCount > 0 ? "danger" : "neutral"}
          deltaLabel={data.lowStockCount > 0 ? "Needs reordering" : "Nothing to reorder"}
          onClick={canSeeProducts ? go(IMS_PATH.products) : undefined}
          hiddenForStaff={!canSeeProducts}
        />
        <StatCard
          label="Total Inventory Value"
          value={formatMoney(totalStockValue)}
          hint="At the last recorded cost"
          icon={<Coins className="h-5 w-5" aria-hidden="true" />}
          tone="violet"
          // Only the value tile has a real history behind it: the movement
          // ledger is the only series the database keeps a history of, and a
          // shop that has never recorded a cost has no value to plot.
          sparkline={
            canSeeTrend && totalStockValue > 0 ? trend.map((point) => point.valueFils) : undefined
          }
          sparklineTone="brand"
          deltaLabel={`Last ${String(period.trendDays)} days`}
          onClick={canSeeProducts ? go(IMS_PATH.products) : undefined}
          hiddenForStaff={!canSeeProducts}
        />
      </section>

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-12">
        {/* Recent products, and the status strip underneath it */}
        <div className="space-y-5 xl:col-span-8">
          <Card flush>
            <div className="flex min-h-[60px] items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <Package
                  className="h-[18px] w-[18px] shrink-0 text-[var(--text-2)]"
                  aria-hidden="true"
                />
                <h2 className="truncate text-[15px] font-semibold text-[var(--text)]">
                  Recent Products
                </h2>
              </div>
              {canSeeProducts && (
                <button
                  type="button"
                  onClick={go(IMS_PATH.products)}
                  className="pressable inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--glass-border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-[12.5px] font-medium text-[var(--text)] hover:bg-[var(--surface)] hover:shadow-[var(--shadow-sm)]"
                >
                  View All
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </div>

            {!canSeeProducts ? (
              <EmptyState
                compact
                icon={<Package className="h-5 w-5" />}
                title="Not available for your role"
                description="The product catalogue is part of the products module."
              />
            ) : recentProducts.length === 0 ? (
              <EmptyState
                compact
                icon={<Package className="h-5 w-5" />}
                title="No products yet"
                description="Add the items you sell and they will show up here."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-[13.5px]">
                  <thead>
                    <tr className="border-b border-[var(--divider)] bg-[var(--table-header-bg)] text-[12px] text-[var(--text-3)]">
                      <th className="px-5 py-2.5 text-start font-medium">Product</th>
                      <th className="px-5 py-2.5 text-start font-medium">Category</th>
                      <th className="px-5 py-2.5 text-end font-medium">Stock</th>
                      <th className="px-5 py-2.5 text-end font-medium">Price</th>
                      <th className="px-5 py-2.5 text-start font-medium">Status</th>
                      <th className="w-12 px-3 py-2.5">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentProducts.map((product) => (
                      <tr
                        key={product.id}
                        className="border-b border-[var(--divider)] transition-colors duration-fast last:border-0 hover:bg-[var(--table-row-hover)]"
                      >
                        <td className="px-5 py-3">
                          <span className="flex items-center gap-3">
                            <Avatar name={product.name} size="md" square tone="neutral" />
                            <span className="min-w-0">
                              <span className="block truncate font-medium text-[var(--text)]">
                                {product.name}
                              </span>
                              <span className="tabular block truncate text-[11.5px] text-[var(--text-3)]">
                                {product.sku}
                              </span>
                            </span>
                          </span>
                        </td>
                        <td className="px-5 py-3">
                          <CategoryPill name={product.category} />
                        </td>
                        <td
                          className={cn(
                            "tabular px-5 py-3 text-end",
                            product.isLowStock ? "font-medium text-[var(--danger)]" : "",
                          )}
                        >
                          {formatQuantity(product.quantityMilli)}
                        </td>
                        <td className="tabular px-5 py-3 text-end">
                          {product.lastSalePriceFils > 0
                            ? formatMoney(product.lastSalePriceFils)
                            : "—"}
                        </td>
                        <td className="px-5 py-3">
                          <StockBadge
                            quantityMilli={product.quantityMilli}
                            isLowStock={product.isLowStock}
                            isActive={product.isActive}
                          />
                        </td>
                        <td className="px-3 py-3 text-end">
                          <RowActions
                            items={[
                              {
                                id: "open",
                                label: "Open in products",
                                icon: <Package className="h-4 w-4" />,
                                onSelect: go(IMS_PATH.products),
                              },
                            ]}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Recent activity belongs with the other record lists, in the wide column. */}
          <Card flush>
            <div className="flex min-h-[60px] items-center gap-2.5 border-b border-[var(--border)] px-5 py-3">
              <Receipt
                className="h-[18px] w-[18px] shrink-0 text-[var(--text-2)]"
                aria-hidden="true"
              />
              <h2 className="truncate text-[15px] font-semibold text-[var(--text)]">
                Recent Activity
              </h2>
              {canSeeSales && (
                <button
                  type="button"
                  onClick={go(IMS_PATH.salesInvoices)}
                  className="ms-auto shrink-0 text-[12.5px] font-medium text-[var(--brand)] hover:underline"
                >
                  View All
                </button>
              )}
            </div>
            <RecentActivity
              invoices={invoices.data ?? []}
              loading={invoices.isLoading}
              visible={canSeeSales}
            />
          </Card>

          {/* Bottom status: the one line that says the app itself is healthy. */}
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

        {/* Stock overview and quick actions */}
        <div className="dashboard-split space-y-5 xl:col-span-4">
          <Card flush>
            <div className="flex min-h-[60px] items-center gap-2.5 border-b border-[var(--border)] px-5 py-3">
              <BarChart3
                className="h-[18px] w-[18px] shrink-0 text-[var(--text-2)]"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <h2 className="truncate text-[15px] font-semibold text-[var(--text)]">
                  Stock Overview
                </h2>
                <p className="truncate text-[11.5px] text-[var(--text-3)]">
                  {mix.byValue ? "Value held in each category" : "Products in each category"}
                </p>
              </div>
            </div>

            <div className="p-4">
              {!canSeeProducts ? (
                <EmptyState
                  compact
                  icon={<Boxes className="h-5 w-5" />}
                  title="Not available for your role"
                  description="The stock breakdown is part of the products module."
                />
              ) : (
                <MixDonut
                  data={mix.slices}
                  total={mix.total}
                  centerValue={
                    mix.byValue ? formatMoneyCompact(totalStockValue) : String(productCount)
                  }
                  centerLabel={mix.byValue ? "Inventory Value" : "Products"}
                  tooltipFormat={(value) =>
                    mix.byValue ? formatMoney(value) : value.toLocaleString("en-US")
                  }
                  emptyMessage="Add products to see the split by category."
                />
              )}
            </div>

            {/* The rows that explain the Low Stock tile above. */}
            {canSeeProducts && lowStockRows.length > 0 && (
              <div className="border-t border-[var(--border)]">
                <div className="flex items-center justify-between gap-3 px-5 py-2.5">
                  <h3 className="text-[11.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
                    Needs Reordering
                  </h3>
                  <button
                    type="button"
                    onClick={go(IMS_PATH.products)}
                    className="text-[12px] font-medium text-[var(--brand)] hover:underline"
                  >
                    View All
                  </button>
                </div>
                <ul className="divide-y divide-[var(--divider)]">
                  {lowStockRows.slice(0, 3).map((product) => (
                    <li key={product.id} className="flex items-center gap-3 px-5 py-2.5">
                      <Avatar name={product.name} size="xs" square tone="neutral" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-[var(--text)]">
                          {product.name}
                        </p>
                        <p className="tabular truncate text-[11.5px] text-[var(--text-3)]">
                          {formatQuantity(product.quantityMilli)} {product.unit}
                        </p>
                      </div>
                      <Badge tone={product.quantityMilli <= 0 ? "danger" : "warning"}>
                        {product.quantityMilli <= 0 ? "Out of stock" : "Low Stock"}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>

          <Card flush>
            <div className="flex min-h-[60px] items-center gap-2.5 border-b border-[var(--border)] px-5 py-3">
              <TrendingUp
                className="h-[18px] w-[18px] shrink-0 text-[var(--text-2)]"
                aria-hidden="true"
              />
              <h2 className="truncate text-[15px] font-semibold text-[var(--text)]">
                Quick Actions
              </h2>
            </div>
            <div className="grid grid-cols-2 gap-2 p-4">
              <QuickAction
                icon={Package}
                label="Add Product"
                tone="brand"
                visible={can("products", "create")}
                onClick={open("eyerstock:new-product", IMS_PATH.products)}
              />
              <QuickAction
                icon={Receipt}
                label="New Sale"
                tone="success"
                visible={can("sales", "create")}
                onClick={open("eyerstock:new-sale", IMS_PATH.salesInvoices)}
              />
              <QuickAction
                icon={ShoppingCart}
                label="New Purchase"
                tone="violet"
                visible={can("purchases", "create")}
                onClick={open("eyerstock:new-purchase", IMS_PATH.purchaseInvoices)}
              />
              <QuickAction
                icon={BarChart3}
                label="View Reports"
                tone="neutral"
                visible={can("reports", "view")}
                onClick={go(IMS_PATH.operationsReports)}
              />
              <QuickAction
                icon={UserPlus}
                label="Add Customer"
                tone="info"
                visible={can("parties", "create")}
                onClick={open("eyerstock:new-customer", IMS_PATH.customers)}
              />
              <QuickAction
                icon={ClipboardList}
                label="Record Expense"
                tone="warning"
                visible={can("finance", "create")}
                onClick={open("eyerstock:new-expense", IMS_PATH.expenses)}
              />
              <QuickAction
                icon={HandCoins}
                label="Receive Payment"
                tone="info"
                visible={can("payments", "create") && can("parties", "view")}
                onClick={open("eyerstock:new-payment", IMS_PATH.customers)}
              />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* category pill                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The tints a category name may take.
 *
 * Identity, not status: the same category always gets the same tint, so a row
 * can be recognised at a glance, and no tint means anything is wrong.
 */
const CATEGORY_TONES: readonly BadgeTone[] = ["brand", "info", "violet", "success", "neutral"];

function CategoryPill({ name }: { readonly name: string | null }): React.JSX.Element {
  const label = name?.trim() === "" ? null : name;

  if (label === null || label === undefined) {
    return <span className="text-[13px] text-[var(--text-3)]">—</span>;
  }

  let hash = 0;
  for (let index = 0; index < label.length; index += 1) {
    hash = (hash * 31 + label.charCodeAt(index)) | 0;
  }

  return (
    <Badge tone={CATEGORY_TONES[Math.abs(hash) % CATEGORY_TONES.length] ?? "neutral"}>
      {label}
    </Badge>
  );
}

/* -------------------------------------------------------------------------- */
/* quick actions                                                              */
/* -------------------------------------------------------------------------- */

function QuickAction({
  icon: Icon,
  label,
  tone,
  onClick,
  visible,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly tone: "brand" | "success" | "warning" | "info" | "violet" | "neutral";
  readonly onClick: () => void;
  readonly visible: boolean;
}): React.JSX.Element | null {
  if (!visible) return null;

  const tones = {
    brand: "text-[var(--brand)] chip-brand",
    success: "text-[var(--success)] chip-teal",
    warning: "text-[var(--warning)] chip-amber",
    info: "text-[var(--cyan)] chip-cyan",
    violet: "text-[var(--violet)] chip-violet",
    neutral: "text-[var(--text-2)] chip-neutral",
  } as const;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "pressable glass flex w-full items-center gap-1.5 rounded-[16px] px-2 py-2 text-start",
        "text-[12px] font-medium text-[var(--text)]",
        "hover:-translate-y-0.5 hover:shadow-[var(--shadow-glass-hover)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
      )}
    >
      <span className={cn("glass-chip h-[26px] w-[26px] shrink-0", tones[tone])}>
        <Icon className="h-[14px] w-[14px]" aria-hidden="true" />
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* recent activity                                                            */
/* -------------------------------------------------------------------------- */

interface ActivityEntry {
  readonly id: string;
  readonly icon: LucideIcon;
  readonly chip: string;
  readonly title: string;
  readonly detail: string;
  readonly when: string;
}

/**
 * The most recent real records, newest first.
 *
 * Drawn from the invoices inside the period already chosen in the header, so
 * this panel always describes the same window as the sales readout above it
 * instead of quietly showing something else.
 */
function RecentActivity({
  invoices,
  loading,
  visible,
}: {
  readonly invoices: readonly DocumentDto[];
  readonly loading: boolean;
  readonly visible: boolean;
}): React.JSX.Element {
  const entries = useMemo<ActivityEntry[]>(
    () =>
      invoices
        .filter((document) => document.status !== "cancelled")
        .slice(0, 4)
        .map((document) => ({
          id: `invoice-${String(document.id)}`,
          icon: document.status === "paid" ? HandCoins : Receipt,
          chip:
            document.status === "paid"
              ? "text-[var(--success)] chip-teal"
              : document.status === "partPaid"
                ? "text-[var(--warning)] chip-amber"
                : "text-[var(--brand)] chip-brand",
          title: document.status === "paid" ? "Sale settled" : "New sale recorded",
          detail: `${document.number} · ${document.partyName ?? "Walk-in"}`,
          when: formatDate(document.issueDate),
        })),
    [invoices],
  );

  if (!visible) {
    return (
      <EmptyState
        compact
        icon={<Receipt className="h-5 w-5" />}
        title="Not available for your role"
        description="Activity is drawn from the sales ledger."
      />
    );
  }

  if (loading) {
    return (
      <div className="space-y-3 p-4" aria-busy="true">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <EmptyState
        compact
        icon={<Receipt className="h-5 w-5" />}
        title="Nothing recorded yet"
        description="Sales in this period appear here as they are entered."
      />
    );
  }

  return (
    <ul className="divide-y divide-[var(--divider)]">
      {entries.map((entry) => (
        <li key={entry.id} className="flex items-center gap-3 px-4 py-3">
          <span className={cn("glass-chip h-8 w-8 shrink-0", entry.chip)}>
            <entry.icon className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-[var(--text)]">{entry.title}</p>
            <p className="truncate text-[11.5px] text-[var(--text-3)]">{entry.detail}</p>
          </div>
          <span className="shrink-0 text-[11.5px] text-[var(--text-3)]">{entry.when}</span>
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/* skeleton                                                                   */
/* -------------------------------------------------------------------------- */

function DashboardSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-5" aria-busy="true">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-10 w-36" />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_unused, index) => (
          <Skeleton key={index} className="h-[148px] rounded-panel" />
        ))}
      </div>

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-12">
        <div className="space-y-5 xl:col-span-8">
          <Skeleton className="h-[420px] rounded-panel" />
          <Skeleton className="h-[60px] rounded-panel" />
        </div>
        <div className="space-y-5 xl:col-span-4">
          <Skeleton className="h-[230px] rounded-panel" />
          <Skeleton className="h-[230px] rounded-panel" />
          <Skeleton className="h-[220px] rounded-panel" />
        </div>
      </div>
    </div>
  );
}
