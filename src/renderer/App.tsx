/**
 * Root component: routing, auth gating and the global error boundary.
 *
 * Four gates, in order:
 *  0. no preload bridge -> recovery screen: the window is not inside the
 *     Electron shell, so no API call can ever work;
 *  1. not ready yet -> splash, so no screen renders before settings are known;
 *  2. setup not complete -> setup wizard;
 *  3. not signed in -> login.
 *
 * After that the shell takes over and every route is permission-checked, so a
 * Staff account cannot reach a screen it has no rights to - the main process
 * re-checks every request as well.
 */

import { Component, useMemo } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { HashRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Toaster } from "sonner";
import { AlertTriangle, RotateCcw } from "lucide-react";
import type { PermissionModule } from "../shared/permissions";
import { AppProvider, useApp } from "./lib/app-context";
import { UpdateProvider } from "./lib/updates";
import { AppShell } from "./components/layout/AppShell";
import { UpdateNotifier } from "./components/updates/UpdateNotifier";
import { ThemeOnboarding } from "./components/theme/ThemeOnboarding";
import { Button } from "./components/ui/Button";
import { Spinner, TooltipProvider } from "./components/ui/Feedback";
import { bridge } from "./lib/api";
import { BrandMark } from "./components/layout/Sidebar";
import { canonicalPath, IMS_ALIASES, IMS_PATH, MMS_PATH } from "./lib/ims-nav";
import { LoginPage, SetupPage } from "./pages/auth/LoginPage";
import { ActivatePage } from "./pages/auth/ActivatePage";
import { HomeDashboardPage } from "./pages/HomeDashboard";
import { DashboardPage } from "./pages/Dashboard";
import { SalesListPage } from "./pages/sales/SalesListPage";
import { DocumentListPage } from "./pages/sales/DocumentListPage";
import { ProductsPage } from "./pages/inventory/ProductsPage";
import { StockLedgerPage } from "./pages/inventory/StockLedgerPage";
import { PartiesPage } from "./pages/parties/PartiesPage";
import { ExpensesPage } from "./pages/finance/ExpensesPage";
import { FinanceOverviewPage } from "./pages/finance/FinanceOverviewPage";
import { ChartOfAccountsPage } from "./pages/finance/ChartOfAccountsPage";
import { AccountLedgerPage } from "./pages/finance/AccountLedgerPage";
import { JournalEntriesPage } from "./pages/finance/JournalEntriesPage";
import { FinancePaymentsPage } from "./pages/finance/FinancePaymentsPage";
import { PayablesPage, ReceivablesPage } from "./pages/finance/PartyBalancesPage";
import { CashAndBankPage } from "./pages/finance/CashAndBankPage";
import { FinancialReportsPage } from "./pages/finance/FinancialReportsPage";
import { FinanceSettingsPage } from "./pages/finance/FinanceSettingsPage";
import { ReportsPage } from "./pages/ReportsPage";
import { ProfilePage } from "./pages/ProfilePage";
import { SettingsPage } from "./pages/admin/SettingsPage";
import { MmsDashboardPage } from "./pages/mms/MmsDashboardPage";
import { BomsPage } from "./pages/mms/BomsPage";
import { BomDetailPage } from "./pages/mms/BomDetailPage";
import { MoListPage } from "./pages/mms/MoListPage";
import { MoDetailPage } from "./pages/mms/MoDetailPage";
import { WorkOrderListPage } from "./pages/mms/WorkOrderListPage";
import { ShopFloorPage } from "./pages/mms/ShopFloorPage";
import { MaterialIssuesPage } from "./pages/mms/MaterialIssuesPage";
import { FinishedReceiptsPage } from "./pages/mms/FinishedReceiptsPage";
import { CostingPage } from "./pages/mms/CostingPage";
import { MmsReportsPage } from "./pages/mms/MmsReportsPage";
import { WorkCentersPage } from "./pages/mms/WorkCentersPage";
import { RoutesPage } from "./pages/mms/RoutesPage";
import { RouteDetailPage } from "./pages/mms/RouteDetailPage";
import { MmsCollectionPage } from "./pages/mms/MmsCollectionPage";
import { MpsPage } from "./pages/mms/MpsPage";
import { MrpPage } from "./pages/mms/MrpPage";
import { EquipmentPage } from "./pages/mms/EquipmentPage";
import { QualityPage } from "./pages/mms/QualityPage";
import { ScrapPage } from "./pages/mms/ScrapPage";
import { ReworkPage } from "./pages/mms/ReworkPage";
import { MmsSettingsPage } from "./pages/mms/MmsSettingsPage";
import { WmsPage } from "./pages/wms/WmsPage";
import { OutboundPage } from "./pages/wms/OutboundPage";
import { AnalyticsPage } from "./pages/wms/AnalyticsPage";

/* -------------------------------------------------------------------------- */
/* error boundary                                                             */
/* -------------------------------------------------------------------------- */

interface BoundaryState {
  readonly error: Error | null;
}

/**
 * Catches render-time failures in the renderer.
 *
 * A blank white window tells a shopkeeper nothing; this shows what went wrong
 * and offers a reload.
 */
class ErrorBoundary extends Component<{ readonly children: ReactNode }, BoundaryState> {
  public override state: BoundaryState = { error: null };

  public static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The bridge can be missing when the main process failed to start, and
    // that is exactly the case where the boundary is the first thing to run.
    // Asking for it unguarded would replace the real error with "cannot read
    // property of undefined" and hide the cause.
    try {
      bridge()
        .exportDiagnostics()
        .then(() => {
          // Diagnostics written; the shopkeeper can attach the file.
        })
        .catch(() => {
          // Diagnostics are best-effort.
        });
    } catch {
      // No bridge: there is nothing to export to.
    }

    window.console.error("Renderer error", error, info.componentStack);
  }

  public override render(): ReactNode {
    const { error } = this.state;

    if (error === null) return this.props.children;

    return (
      <div className="flex min-h-full items-center justify-center bg-page px-6">
        <div className="card max-w-md p-6 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-danger-soft text-danger">
            <AlertTriangle className="h-6 w-6" aria-hidden="true" />
          </div>

          <h1 className="text-lg font-semibold text-ink">Something went wrong</h1>
          <p className="mt-2 text-sm text-ink-secondary">
            Your data has not been changed. A diagnostics file was written to your Desktop — send it
            with your support request.
          </p>

          <pre className="mt-4 max-h-32 overflow-auto rounded-lg bg-surface-sunken p-3 text-start text-xs text-ink-secondary">
            {error.message}
          </pre>

          <Button
            variant="primary"
            className="mt-4 w-full"
            iconLeft={<RotateCcw className="h-4 w-4" />}
            onClick={() => {
              window.location.reload();
            }}
          >
            Restart the screen
          </Button>
        </div>
      </div>
    );
  }
}

/* -------------------------------------------------------------------------- */
/* guards                                                                     */
/* -------------------------------------------------------------------------- */

function Splash(): React.JSX.Element {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 bg-page">
      <BrandMark className="h-12 w-12" />
      <Spinner />
    </div>
  );
}

/**
 * Recovery screen for a missing preload bridge.
 *
 * `window.api` is injected by the preload script, so it is absent exactly when
 * the window is not running inside the Electron shell - the page was opened in
 * a browser, or the main process died before the window was built. Without
 * this gate every screen would fail the same way, each reporting the useless
 * "Cannot read properties of undefined (reading 'invoke')" with no hint at the
 * actual cause.
 */
function BridgeUnavailable(): React.JSX.Element {
  return (
    <div className="flex min-h-full items-center justify-center bg-page px-6">
      <div className="card max-w-lg p-6 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-danger-soft text-danger">
          <AlertTriangle className="h-6 w-6" aria-hidden="true" />
        </div>

        <h1 className="text-lg font-semibold text-ink">EyerStock did not start correctly</h1>
        <p className="mt-2 text-sm text-ink-secondary">
          This window is not connected to the application&apos;s main process, so nothing can be
          loaded or saved. Your files are safe — no data was changed.
        </p>

        <ul className="mt-4 space-y-2 text-start text-sm text-ink-secondary">
          <li>
            • Close this window and start EyerStock again from its desktop or Start menu shortcut.
          </li>
          <li>• Open the app itself, not a web browser — it cannot run from a browser.</li>
          <li>
            • If it keeps happening, send the log file from the app&apos;s data folder to your
            supplier.
          </li>
        </ul>

        <Button
          variant="primary"
          className="mt-5 w-full"
          iconLeft={<RotateCcw className="h-4 w-4" />}
          onClick={() => {
            window.location.reload();
          }}
        >
          Try again
        </Button>
      </div>
    </div>
  );
}

/**
 * Route guard: a screen the role may not open shows why, rather than a
 * redirect that leaves the user wondering what the menu item did.
 */
function Guard({
  module,
  children,
}: {
  readonly module: PermissionModule;
  readonly children: ReactNode;
}): React.JSX.Element {
  const { can } = useApp();

  if (!can(module, "view")) {
    return (
      <div className="card p-8 text-center">
        <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-warning" aria-hidden="true" />
        <p className="text-sm font-medium text-ink">You do not have access to this screen.</p>
        <p className="mt-1 text-sm text-ink-secondary">Ask an administrator to change your role.</p>
      </div>
    );
  }

  return <>{children}</>;
}

/**
 * The bridge from the pre-IMS URLs to the screens that serve them now.
 *
 * `Navigate` alone would drop the query string, and the two places that carry
 * one matter: `/settings?tab=appearance` is what the theme menu links to, and
 * `/finance/ledger?code=1000` is what the chart of accounts drills into. A
 * redirect that loses those opens the right screen on the wrong thing, which
 * reads as a bug rather than as a moved page.
 */
function LegacyRedirect(): React.JSX.Element {
  const location = useLocation();
  return <Navigate to={canonicalPath(location.pathname, location.search)} replace />;
}

/* -------------------------------------------------------------------------- */
/* routes                                                                     */
/* -------------------------------------------------------------------------- */

function AppRoutes(): React.JSX.Element {
  const { ready, bridgeMissing, licenseChecking, licenseRequired, setupRequired, user } = useApp();

  if (bridgeMissing) return <BridgeUnavailable />;
  if (!ready) return <Splash />;
  if (licenseChecking) return <Splash />;
  if (licenseRequired) return <ActivatePage />;
  if (setupRequired) return <SetupPage />;
  if (user === null) return <LoginPage />;

  // If setup is complete but user is null, show login (not setup)
  // This is the normal path after setup completion

  // The route table is a variable so the chooser can sit beside it without
  // reindenting every route.
  //
  // Every IMS screen is named by `IMS_PATH`, which is the same table the rail,
  // the breadcrumbs and the redirects read, so a screen cannot be mounted at a
  // path its own navigation does not know about.
  const routes = (
    <Routes>
      <Route element={<AppShell />}>
        {/* The EyerFlow workspace home. */}
        <Route index element={<HomeDashboardPage />} />

        {/* IMS overview: the inventory dashboard, filed under its module. */}
        <Route path={IMS_PATH.home} element={<DashboardPage />} />

        {/* product catalog */}
        <Route
          path={IMS_PATH.products}
          element={
            <Guard module="products">
              <ProductsPage />
            </Guard>
          }
        />

        {/* purchasing */}
        <Route
          path={IMS_PATH.purchaseInvoices}
          element={
            <Guard module="purchases">
              <DocumentListPage kind="purchaseInvoice" />
            </Guard>
          }
        />
        <Route
          path={IMS_PATH.suppliers}
          element={
            <Guard module="parties">
              <PartiesPage kind="supplier" />
            </Guard>
          }
        />

        {/* sales */}
        <Route
          path={IMS_PATH.salesInvoices}
          element={
            <Guard module="sales">
              <SalesListPage />
            </Guard>
          }
        />
        <Route
          path={IMS_PATH.customers}
          element={
            <Guard module="parties">
              <PartiesPage kind="customer" />
            </Guard>
          }
        />

        {/* stock control */}
        <Route
          path={IMS_PATH.stockLedger}
          element={
            <Guard module="inventory">
              <StockLedgerPage />
            </Guard>
          }
        />

        {/* payments, expenses and the ledger behind them */}
        <Route
          path={IMS_PATH.financeOverview}
          element={
            <Guard module="finance">
              <FinanceOverviewPage />
            </Guard>
          }
        />
        <Route
          path={IMS_PATH.expenses}
          element={
            <Guard module="finance">
              <ExpensesPage />
            </Guard>
          }
        />
        <Route
          path={IMS_PATH.payments}
          element={
            <Guard module="finance">
              <FinancePaymentsPage />
            </Guard>
          }
        />
        <Route
          path={IMS_PATH.receivables}
          element={
            <Guard module="finance">
              <ReceivablesPage />
            </Guard>
          }
        />
        <Route
          path={IMS_PATH.payables}
          element={
            <Guard module="finance">
              <PayablesPage />
            </Guard>
          }
        />
        <Route
          path={IMS_PATH.cash}
          element={
            <Guard module="finance">
              <CashAndBankPage />
            </Guard>
          }
        />
        <Route
          path={IMS_PATH.accounts}
          element={
            <Guard module="finance">
              <ChartOfAccountsPage />
            </Guard>
          }
        />
        <Route
          path={IMS_PATH.accountLedger}
          element={
            <Guard module="finance">
              <AccountLedgerPage />
            </Guard>
          }
        />
        <Route
          path={IMS_PATH.journal}
          element={
            <Guard module="finance">
              <JournalEntriesPage />
            </Guard>
          }
        />

        {/* reporting */}
        <Route
          path={IMS_PATH.operationsReports}
          element={
            <Guard module="reports">
              <ReportsPage />
            </Guard>
          }
        />
        <Route
          path={IMS_PATH.financialReports}
          element={
            <Guard module="finance">
              <FinancialReportsPage />
            </Guard>
          }
        />

        {/* configuration */}
        <Route
          path={IMS_PATH.settings}
          element={
            <Guard module="settings">
              <SettingsPage />
            </Guard>
          }
        />
        <Route
          path={IMS_PATH.financeSettings}
          element={
            <Guard module="finance">
              <FinanceSettingsPage />
            </Guard>
          }
        />

        {/* MMS routes */}
        <Route path="/wms" element={<Navigate to="/wms/overview" replace />} />
        {["reports","settings"].map(page=><Route key={page} path={`/wms/${page}`} element={<Guard module="warehouse"><AnalyticsPage /></Guard>} />)}
        {["dispatch-requests","picking","packing","staging","dispatch"].map(page=><Route key={page} path={`/wms/${page}`} element={<Guard module="warehouse"><OutboundPage /></Guard>} />)}
        {["overview","warehouses","bins","inbounds","receiving","putaway","stock-locator","transfers","reconciliation","tasks","counts","returns","replenishment","docks","appointments"].map(page=><Route key={page} path={`/wms/${page}`} element={<Guard module="warehouse"><WmsPage /></Guard>} />)}
        <Route
          path={MMS_PATH.dashboard}
          element={
            <Guard module="manufacturing">
              <MmsDashboardPage />
            </Guard>
          }
        />
        <Route
          path={MMS_PATH.boms}
          element={
            <Guard module="manufacturing">
              <BomsPage />
            </Guard>
          }
        />
        <Route
          path={MMS_PATH.bomDetail}
          element={
            <Guard module="manufacturing">
              <BomDetailPage />
            </Guard>
          }
        />
        <Route
          path={MMS_PATH.productionOrders}
          element={
            <Guard module="manufacturing">
              <MoListPage />
            </Guard>
          }
        />
        <Route
          path={MMS_PATH.moDetail}
          element={
            <Guard module="manufacturing">
              <MoDetailPage />
            </Guard>
          }
        />
        <Route
          path={MMS_PATH.workOrders}
          element={
            <Guard module="manufacturing">
              <WorkOrderListPage />
            </Guard>
          }
        />
        <Route
          path={MMS_PATH.shopfloor}
          element={
            <Guard module="manufacturing">
              <ShopFloorPage />
            </Guard>
          }
        />
        <Route
          path={MMS_PATH.materials}
          element={
            <Guard module="manufacturing">
              <MaterialIssuesPage />
            </Guard>
          }
        />
        <Route
          path={MMS_PATH.finishedReceipts}
          element={
            <Guard module="manufacturing">
              <FinishedReceiptsPage />
            </Guard>
          }
        />
        <Route
          path={MMS_PATH.costing}
          element={
            <Guard module="manufacturing">
              <CostingPage />
            </Guard>
          }
        />
        <Route
          path={MMS_PATH.reports}
          element={
            <Guard module="manufacturing">
              <MmsReportsPage />
            </Guard>
          }
        />
        <Route
          path={MMS_PATH.workCenters}
          element={
            <Guard module="manufacturing">
              <WorkCentersPage />
            </Guard>
          }
        />
        <Route
          path={MMS_PATH.routes}
          element={
            <Guard module="manufacturing">
              <RoutesPage />
            </Guard>
          }
        />
        <Route
          path={MMS_PATH.routeDetail}
          element={
            <Guard module="manufacturing">
              <RouteDetailPage />
            </Guard>
          }
        />
        {/*
          The remaining MMS registers.

          Each is a route of its own rather than a link to the dashboard: a
          sidebar entry that silently lands somewhere else reads as a broken
          module. They share one screen because they are one table each.
        */}
        <Route
          path={MMS_PATH.planningMps}
          element={
            <Guard module="manufacturing">
              <MpsPage />
            </Guard>
          }
        />
        <Route
          path={MMS_PATH.planningMrp}
          element={
            <Guard module="manufacturing">
              <MrpPage />
            </Guard>
          }
        />
        <Route
          path={MMS_PATH.recipes}
          element={
            <Guard module="manufacturing">
              <MmsCollectionPage view="recipes" />
            </Guard>
          }
        />
        <Route
          path={MMS_PATH.equipment}
          element={
            <Guard module="manufacturing">
              <EquipmentPage />
            </Guard>
          }
        />
        <Route
          path={MMS_PATH.maintenance}
          element={
            <Guard module="manufacturing">
              <MmsCollectionPage view="maintenance" />
            </Guard>
          }
        />
        <Route
          path={MMS_PATH.wip}
          element={
            <Guard module="manufacturing">
              <MmsCollectionPage view="wip" />
            </Guard>
          }
        />
        <Route
          path={MMS_PATH.quality}
          element={
            <Guard module="manufacturing">
              <QualityPage />
            </Guard>
          }
        />
        <Route
          path={MMS_PATH.scrap}
          element={
            <Guard module="manufacturing">
              <ScrapPage />
            </Guard>
          }
        />
        <Route
          path={MMS_PATH.rework}
          element={
            <Guard module="manufacturing">
              <ReworkPage />
            </Guard>
          }
        />
        <Route
          path={MMS_PATH.subcontracting}
          element={
            <Guard module="manufacturing">
              <MmsCollectionPage view="subcontracting" />
            </Guard>
          }
        />
        <Route
          path={MMS_PATH.settings}
          element={
            <Guard module="manufacturing">
              <MmsSettingsPage />
            </Guard>
          }
        />

        {/* profile - no Guard: every signed-in user has one, staff included */}
        <Route path="profile" element={<ProfilePage />} />

        {/*
          The paths published before IMS existed. They resolve to the canonical
          address rather than rendering a second copy of a screen, so a
          bookmark, an old link in a printed document and the browser's back
          button all keep working - and the rail lights up either way.
        */}
        {IMS_ALIASES.map((alias) => (
          <Route key={alias.from} path={alias.from} element={<LegacyRedirect />} />
        ))}

        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );

  return (
    <>
      {routes}

      {/*
        First-login theme chooser. It is mounted beside the routes rather than
        inside the dashboard so it appears wherever the first sign-in lands,
        while the guard chain above still decides when it may render.
      */}
      <ThemeOnboarding />
    </>
  );
}

export function App(): React.JSX.Element {
  const content = useMemo(
    () => (
      <ErrorBoundary>
        {/* Radix tooltips are mounted at the app root rather than per screen:
            a screen that forgot to add one would silently render dead help
            text. */}
        <TooltipProvider>
          <AppProvider>
            {/*
              The update provider wraps the whole app, not the shell: the
              check runs in the main process and the notification has to be
              able to appear on the login screen too, because that is where
              the application often sits when it is left switched on.
            */}
            <UpdateProvider>
              <AppRoutes />
              <UpdateNotifier />
            </UpdateProvider>
          </AppProvider>
        </TooltipProvider>
      </ErrorBoundary>
    ),
    [],
  );

  return (
    <>
      {/*
        HashRouter, not BrowserRouter: a packaged build is loaded from disk over
        file://, where there is no web server to rewrite paths. BrowserRouter
        reads the document's own path as the route, so every screen resolved to
        `/C:/.../index.html`, matched no route, and the shell rendered with an
        empty <main>. It looked fine in development, where the dev server makes
        the URL look like a normal site.
      */}
      <HashRouter>{content}</HashRouter>
      <Toaster position="bottom-right" richColors closeButton toastOptions={{ duration: 6000 }} />
    </>
  );
}
