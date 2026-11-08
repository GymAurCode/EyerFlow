/**
 * The IMS navigation model, in one place.
 *
 * The rail, the route table, the compatibility redirects, the breadcrumbs and
 * the main dashboard's module card all read from here, so a page cannot appear
 * in one of those four and be missing from another.
 *
 * Only screens that actually exist are listed. The group names follow the
 * EyerFlow IMS specification, but a group never gains a link to a document type
 * this application has no backend for - an empty screen that looks like a
 * feature is worse than a missing one, because it is read as working until the
 * day it is needed.
 */

import {
  AlertTriangle,
  BarChart3,
  Banknote,
  BookOpen,
  Boxes,
  Factory,
  GanttChart,
  HandCoins,
  Landmark,
  LayoutDashboard,
  ListTree,
  NotebookText,
  Package,
  PieChart,
  Play,
  Receipt,
  ReceiptText,
  Radio,
  ScrollText,
  Settings,
  Settings2,
  ShoppingCart,
  SlidersHorizontal,
  Clock,
  Table,
  Truck,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { PermissionAction, PermissionModule } from "../../shared/permissions";

/**
 * Every IMS route, named.
 *
 * The screens and the in-app links take their path from here, so moving a page
 * means editing one line rather than hunting for the literals that pointed at
 * it.
 */
export const IMS_PATH = {
  home: "/ims",
  products: "/ims/products",
  purchaseInvoices: "/ims/purchasing/invoices",
  suppliers: "/ims/purchasing/suppliers",
  salesInvoices: "/ims/sales/invoices",
  customers: "/ims/sales/customers",
  stockLedger: "/ims/stock/ledger",
  financeOverview: "/ims/payments/overview",
  expenses: "/ims/payments/expenses",
  payments: "/ims/payments/records",
  receivables: "/ims/payments/receivables",
  payables: "/ims/payments/payables",
  cash: "/ims/payments/cash",
  accounts: "/ims/payments/accounts",
  accountLedger: "/ims/payments/ledger",
  journal: "/ims/payments/journal",
  operationsReports: "/ims/reports/operations",
  financialReports: "/ims/reports/financial",
  settings: "/ims/configuration/settings",
  financeSettings: "/ims/configuration/finance",
} as const;

/** MMS route paths. */
export const MMS_PATH = {
  home: "/mms",
  dashboard: "/mms",
  boms: "/mms/boms",
  bomDetail: "/mms/boms/:id",
  recipes: "/mms/recipes",
  routes: "/mms/routes",
  routeDetail: "/mms/routes/:id",
  planningMps: "/mms/planning/mps",
  planningMrp: "/mms/planning/mrp",
  planningCapacity: "/mms/planning/capacity",
  productionOrders: "/mms/production/orders",
  moDetail: "/mms/production/orders/:id",
  workOrders: "/mms/work-orders",
  woDetail: "/mms/work-orders/:id",
  shopfloor: "/mms/shopfloor",
  materials: "/mms/materials",
  workCenters: "/mms/work-centers",
  equipment: "/mms/equipment",
  quality: "/mms/quality",
  wip: "/mms/wip",
  scrap: "/mms/scrap",
  rework: "/mms/rework",
  finishedReceipts: "/mms/finished-receipts",
  costing: "/mms/costing",
  reports: "/mms/reports",
  maintenance: "/mms/maintenance",
  subcontracting: "/mms/subcontracting",
  settings: "/mms/settings",
} as const;

export interface NavItem {
  readonly path: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly module: PermissionModule;
  /**
   * Light only this exact path, not the screens below it.
   *
   * Needed wherever a shorter path is a real page and a longer one is a
   * different page under it - the Finance Overview at `/ims/payments/overview`
   * would otherwise light up on every finance screen.
   */
  readonly exact?: boolean | undefined;
}

export interface NavSection {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly items: readonly NavItem[];
}

/** The permission check the app context exposes, as the rail needs to see it. */
export type Can = (module: PermissionModule, action: PermissionAction) => boolean;

/** The top-level EyerFlow home, kept outside IMS on purpose. */
export const DASHBOARD_ITEM: NavItem = {
  path: "/",
  label: "Dashboard",
  icon: LayoutDashboard,
  module: "dashboard",
  exact: true,
};

export const IMS_LABEL = "Inventory Management System (IMS)";

/** The module's name where the rail has no room for the whole phrase. */
export const IMS_SHORT_LABEL = "IMS";

export const IMS_ICON = Boxes;

export const IMS_SECTIONS: readonly NavSection[] = [
  {
    id: "overview",
    label: "Overview",
    icon: LayoutDashboard,
    items: [
      {
        path: IMS_PATH.home,
        label: "Inventory Dashboard",
        icon: LayoutDashboard,
        module: "dashboard",
        exact: true,
      },
    ],
  },
  {
    id: "catalog",
    label: "Product Catalog",
    icon: Package,
    items: [{ path: IMS_PATH.products, label: "All Products", icon: Package, module: "products" }],
  },
  {
    id: "purchasing",
    label: "Purchasing",
    icon: ShoppingCart,
    items: [
      {
        path: IMS_PATH.purchaseInvoices,
        label: "Purchase Invoices",
        icon: ShoppingCart,
        module: "purchases",
      },
      { path: IMS_PATH.suppliers, label: "Suppliers", icon: Truck, module: "parties" },
    ],
  },
  {
    id: "sales",
    label: "Sales",
    icon: Receipt,
    items: [
      { path: IMS_PATH.salesInvoices, label: "Sales Invoices", icon: Receipt, module: "sales" },
      { path: IMS_PATH.customers, label: "Customers", icon: Users, module: "parties" },
    ],
  },
  {
    id: "stock",
    label: "Stock Control",
    icon: ScrollText,
    items: [
      { path: IMS_PATH.stockLedger, label: "Stock Ledger", icon: ScrollText, module: "inventory" },
    ],
  },
  {
    id: "payments",
    label: "Payments & Expenses",
    icon: Wallet,
    items: [
      {
        path: IMS_PATH.financeOverview,
        label: "Finance Overview",
        icon: Landmark,
        module: "finance",
        exact: true,
      },
      { path: IMS_PATH.expenses, label: "Expenses", icon: ReceiptText, module: "finance" },
      { path: IMS_PATH.payments, label: "Payments", icon: HandCoins, module: "finance" },
      { path: IMS_PATH.receivables, label: "Customer Balances", icon: Users, module: "finance" },
      { path: IMS_PATH.payables, label: "Supplier Balances", icon: Truck, module: "finance" },
      { path: IMS_PATH.cash, label: "Cash & Bank", icon: Banknote, module: "finance" },
      { path: IMS_PATH.accounts, label: "Chart of Accounts", icon: ListTree, module: "finance" },
      { path: IMS_PATH.accountLedger, label: "Account Ledger", icon: BookOpen, module: "finance" },
      { path: IMS_PATH.journal, label: "Journal Entries", icon: NotebookText, module: "finance" },
    ],
  },
  {
    id: "reporting",
    label: "Reporting",
    icon: BarChart3,
    items: [
      {
        path: IMS_PATH.operationsReports,
        label: "Inventory & Sales Reports",
        icon: BarChart3,
        module: "reports",
      },
      {
        path: IMS_PATH.financialReports,
        label: "Financial Reports",
        icon: TrendingUp,
        module: "finance",
      },
    ],
  },
  {
    id: "configuration",
    label: "Configuration",
    icon: SlidersHorizontal,
    items: [
      {
        path: IMS_PATH.settings,
        label: "Application Settings",
        icon: Settings,
        module: "settings",
      },
      {
        path: IMS_PATH.financeSettings,
        label: "Finance Settings",
        icon: SlidersHorizontal,
        module: "finance",
      },
    ],
  },
];

/**
 * The old flat paths, each sent to the screen that now serves it.
 *
 * These are the URLs this application has published for years - in
 * documentation, in bookmarks and in the links the print previews carry. They
 * keep working, query string included, and the address bar ends up on the
 * canonical path so the rail lights up correctly.
 */
export const IMS_ALIASES: readonly { readonly from: string; readonly to: string }[] = [
  { from: "/products", to: IMS_PATH.products },
  { from: "/purchases", to: IMS_PATH.purchaseInvoices },
  { from: "/sales", to: IMS_PATH.salesInvoices },
  { from: "/suppliers", to: IMS_PATH.suppliers },
  { from: "/customers", to: IMS_PATH.customers },
  { from: "/expenses", to: IMS_PATH.expenses },
  { from: "/finance", to: IMS_PATH.financeOverview },
  { from: "/finance/payments", to: IMS_PATH.payments },
  { from: "/finance/receivables", to: IMS_PATH.receivables },
  { from: "/finance/payables", to: IMS_PATH.payables },
  { from: "/finance/cash", to: IMS_PATH.cash },
  { from: "/finance/chart", to: IMS_PATH.accounts },
  { from: "/finance/ledger", to: IMS_PATH.accountLedger },
  { from: "/finance/journal", to: IMS_PATH.journal },
  { from: "/finance/reports", to: IMS_PATH.financialReports },
  { from: "/finance/settings", to: IMS_PATH.financeSettings },
  { from: "/reports", to: IMS_PATH.operationsReports },
  { from: "/settings", to: IMS_PATH.settings },
];

/** Every page in IMS, in rail order, sections flattened. */
export const IMS_ITEMS: readonly NavItem[] = IMS_SECTIONS.flatMap((section) => section.items);

/** MMS module label and icon. */
export const MMS_LABEL = "Manufacturing & Production (MMS)";
export const MMS_SHORT_LABEL = "MMS";
export const MMS_ICON = Factory;

/** MMS navigation sections, grouped per the EyerFlow manufacturing specification. */
export const MMS_SECTIONS: readonly NavSection[] = [
  {
    id: "overview",
    label: "Overview",
    icon: LayoutDashboard,
    items: [
      {
        path: MMS_PATH.dashboard,
        label: "Production Dashboard",
        icon: LayoutDashboard,
        module: "manufacturing",
        exact: true,
      },
    ],
  },
  {
    id: "planning",
    label: "Production Planning",
    icon: GanttChart,
    items: [
      {
        path: MMS_PATH.planningMps,
        label: "Master Production Schedule",
        icon: GanttChart,
        module: "manufacturing",
      },
      {
        path: MMS_PATH.planningMrp,
        label: "Material Requirements Planning",
        icon: Table,
        module: "manufacturing",
      },
    ],
  },
  {
    id: "engineering",
    label: "Engineering & BOM",
    icon: BookOpen,
    items: [
      {
        path: MMS_PATH.boms,
        label: "Bills of Materials",
        icon: Package,
        module: "manufacturing",
      },
      {
        path: MMS_PATH.recipes,
        label: "Recipes & Formulations",
        icon: Table,
        module: "manufacturing",
      },
      {
        path: MMS_PATH.routes,
        label: "Routes & Operations",
        icon: Radio,
        module: "manufacturing",
      },
    ],
  },
  {
    id: "operations",
    label: "Production Operations",
    icon: Play,
    items: [
      {
        path: MMS_PATH.productionOrders,
        label: "Manufacturing Orders",
        icon: Table,
        module: "manufacturing",
      },
      {
        path: MMS_PATH.workOrders,
        label: "Work Orders / Job Cards",
        icon: Clock,
        module: "manufacturing",
      },
      {
        path: MMS_PATH.shopfloor,
        label: "Shop Floor",
        icon: Play,
        module: "manufacturing",
      },
      {
        path: MMS_PATH.materials,
        label: "Material Issues",
        icon: Truck,
        module: "manufacturing",
      },
      {
        path: MMS_PATH.finishedReceipts,
        label: "Finished Goods Receipts",
        icon: Package,
        module: "manufacturing",
      },
    ],
  },
  {
    id: "resources",
    label: "Factory Resources",
    icon: Settings2,
    items: [
      {
        path: MMS_PATH.workCenters,
        label: "Work Centers",
        icon: Settings,
        module: "manufacturing",
      },
      {
        path: MMS_PATH.equipment,
        label: "Machines & Equipment",
        icon: Table,
        module: "manufacturing",
      },
      {
        path: MMS_PATH.maintenance,
        label: "Maintenance Requests",
        icon: AlertTriangle,
        module: "manufacturing",
      },
    ],
  },
  {
    id: "control",
    label: "Production Control",
    icon: PieChart,
    items: [
      {
        path: MMS_PATH.wip,
        label: "Work in Progress",
        icon: Table,
        module: "manufacturing",
      },
      {
        path: MMS_PATH.quality,
        label: "Quality Control",
        icon: AlertTriangle,
        module: "manufacturing",
      },
      {
        path: MMS_PATH.scrap,
        label: "Scrap & By-products",
        icon: Truck,
        module: "manufacturing",
      },
      {
        path: MMS_PATH.rework,
        label: "Rework Management",
        icon: Radio,
        module: "manufacturing",
      },
    ],
  },
  {
    id: "subcontracting",
    label: "Subcontracting",
    icon: Truck,
    items: [
      {
        path: MMS_PATH.subcontracting,
        label: "Subcontract Orders",
        icon: Table,
        module: "manufacturing",
      },
    ],
  },
  {
    id: "costing",
    label: "Costing & Analytics",
    icon: BarChart3,
    items: [
      {
        path: MMS_PATH.costing,
        label: "Production Costing",
        icon: Banknote,
        module: "manufacturing",
      },
      {
        path: MMS_PATH.reports,
        label: "Production Reports",
        icon: BarChart3,
        module: "manufacturing",
      },
    ],
  },
  {
    id: "configuration",
    label: "MMS Configuration",
    icon: SlidersHorizontal,
    items: [
      {
        path: MMS_PATH.settings,
        label: "Production Policies",
        icon: Settings,
        module: "manufacturing",
      },
    ],
  },
];

/** Every page in MMS, in rail order, sections flattened. */
export const MMS_ITEMS: readonly NavItem[] = MMS_SECTIONS.flatMap((section) => section.items);

/**
 * Where an MMS screen sits in the model, or null when it is not an MMS screen.
 *
 * Kept separate from `locate` because the two modules share section ids -
 * both have an `overview` and a `configuration` - so one function answering
 * for both would light the IMS rail on an MMS screen.
 */
export function locateMms(
  pathname: string,
): { readonly section: NavSection; readonly item: NavItem } | null {
  for (const section of MMS_SECTIONS) {
    for (const item of section.items) {
      if (matchesPath(pathname, item)) return { section, item };
    }
  }
  return null;
}

/** The trail an MMS screen announces: MMS / Operations / Work Orders. */
export function mmsTrailFor(pathname: string): readonly Crumb[] {
  const found = locateMms(pathname);
  if (found === null) return [];

  const trail: Crumb[] = [
    { label: "MMS", path: MMS_PATH.dashboard },
    { label: found.section.label, path: found.section.items[0]?.path ?? MMS_PATH.dashboard },
    { label: found.item.label, path: found.item.path },
  ];

  return trail.filter(
    (crumb, index) => trail.findIndex((other) => other.path === crumb.path) === index,
  );
}

/** ShieldAlert icon falls back to AlertTriangle in lucide-react. */
export const MMS_SHIELD_ALERT_ICON = AlertTriangle;

/** Sections with at least one page this user may open, empty sections dropped. */
export function visibleMmsSections(can: Can): readonly NavSection[] {
  return MMS_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => allowed(can, item)),
  })).filter((section) => section.items.length > 0);
}

/** The paths that get a tile on the mobile dock, in the order a shop works. */
export const DOCK_PATHS: readonly string[] = [
  "/",
  IMS_PATH.products,
  IMS_PATH.salesInvoices,
  IMS_PATH.purchaseInvoices,
];

/** True when `pathname` is the item's own path or, unless exact, a screen below it. */
export function matchesPath(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.path;
  return pathname === item.path || pathname.startsWith(`${item.path}/`);
}

function allowed(can: Can, item: NavItem): boolean {
  return can(item.module, "view");
}

/** Sections with at least one page this user may open, empty sections dropped. */
export function visibleSections(can: Can): readonly NavSection[] {
  return IMS_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => allowed(can, item)),
  })).filter((section) => section.items.length > 0);
}

/** The dock's tiles: the flat page list, filtered by permission and by the dock. */
export function visibleDockItems(can: Can): readonly NavItem[] {
  return [DASHBOARD_ITEM, ...IMS_ITEMS].filter(
    (item) => DOCK_PATHS.includes(item.path) && allowed(can, item),
  );
}

/** The alias a legacy path resolves to, or the path itself when it is canonical. */
function aliasTarget(pathname: string): string {
  const entry = IMS_ALIASES.find(
    (candidate) => pathname === candidate.from || pathname.startsWith(`${candidate.from}/`),
  );
  // A legacy path with pages beneath it keeps its own tail: `/finance/ledger`
  // has no exact entry only because nothing links deeper, and a deeper future
  // path should not be swallowed by its parent.
  return entry === undefined ? pathname : `${entry.to}${pathname.slice(entry.from.length)}`;
}

/**
 * The canonical location a legacy path resolves to.
 *
 * The caller's query string travels with it: `/settings?tab=appearance` and
 * `/finance/ledger?code=1000` both have to arrive with their parameter
 * attached, or the bookmark opens the right screen on the wrong thing.
 */
export function canonicalPath(pathname: string, search = ""): string {
  return `${aliasTarget(pathname)}${search}`;
}

/** Where a screen sits in the model, or null when it is not an IMS screen. */
export function locate(
  pathname: string,
  search = "",
): { readonly section: NavSection; readonly item: NavItem } | null {
  const [path = ""] = splitQuery(canonicalPath(pathname, search));
  if (path !== IMS_PATH.home && !path.startsWith(`${IMS_PATH.home}/`)) return null;
  for (const section of IMS_SECTIONS) {
    for (const item of section.items) {
      if (matchesPath(path, item)) return { section, item };
    }
  }
  return null;
}

/** One step of the trail: what it is called, and where clicking it lands. */
export interface Crumb {
  readonly label: string;
  readonly path: string;
}

/**
 * The trail a screen announces: IMS / Purchasing / Purchase Invoices.
 *
 * A group whose only page is the group - Overview - appears once, not twice, so
 * the trail does not read "IMS / Overview / Inventory Dashboard" for a module
 * with nothing in between.
 */
export function trailFor(pathname: string, search = ""): readonly Crumb[] {
  const found = locate(pathname, search);
  if (found === null) return [];

  const group = found.section.items[0];
  const trail: Crumb[] = [
    { label: IMS_SHORT_LABEL, path: IMS_PATH.home },
    { label: found.section.label, path: group?.path ?? IMS_PATH.home },
    { label: found.item.label, path: found.item.path },
  ];

  return trail.filter(
    (crumb, index) => trail.findIndex((other) => other.path === crumb.path) === index,
  );
}

function splitQuery(pathname: string): readonly [string, string] {
  const index = pathname.indexOf("?");
  if (index === -1) return [pathname, ""];
  return [pathname.slice(0, index), pathname.slice(index)];
}
