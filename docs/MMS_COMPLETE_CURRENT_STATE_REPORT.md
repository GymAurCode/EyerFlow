# MMS — Complete Current-State Audit Report

**Application:** EyerStock v1.0.2 (Electron + React + better-sqlite3, SQLite/SQLCipher)
**Audit date:** 2026-11-07
**Audit type:** Inspection only. No application code was modified. This report was produced from (a) full static inspection of the repository and (b) a live runtime walkthrough of the built application.

---

## 0. Methodology — what is verified vs. what is static analysis

| Evidence source | What it covers | Status |
|---|---|---|
| **Runtime e2e suite** (`npx playwright test e2e/mms.spec.ts`) | Launches the real Electron app, drives the sidebar UI, executes the RPC layer against a real migrated in-memory temp database | **RUN ON AUDIT DATE — 3/3 PASSED (28.2 s)** |
| **Runtime full-page UI walk** (throwaway script in OS temp dir; screenshots in `docs/mms-verify/*.png`) | All 22 `/mms` routes opened in the real app: headings, columns, buttons, banners, empty states captured; "New Route"/"New Work Center" Save buttons clicked; stub RPCs probed directly | **RUN ON AUDIT DATE — 22/22 pages opened, 0 console errors, 0 page errors** |
| **Unit/integration suite** (`npx vitest run`) | Whole `tests/` folder | **RUN ON AUDIT DATE — 33 files, 463 tests, all passed** |
| **Static inspection** | Repository Sidebar/nav, all 15 renderer MMS pages, all 17 backend MMS repositories, `rpc.ts` dispatch, migration 25/26 schema, IMS stock engine | Complete |

Anything covered only by static inspection is marked **NOT RUNTIME VERIFIED**. Older documents in this repo (`docs/MMS_FUNCTIONAL_COMPLETION.md`, `docs/MMS_IMPLEMENTATION_REPORT.md`) contain claims that conflict with the actual code (e.g. "MPS & MRP engines fully implemented") — **this report supersedes those documents**; where they disagree with the code, the code findings below are authoritative.

**Terminology:** unit = milli-units (1,000 = 1 qty). Money = fils (100 fils = "Rs 1" as displayed by the UI's money formatter).

---

## 1. Executive Summary

The MMS module is a **working production-execution core wrapped by a wide ring of deliberate stubs**.

- **Fully implemented and runtime-verified:** BOMs + components + approval ("Engineering"), Routes + operations (backend), Manufacturing Orders with BOM explosion, stock-check-gated release, reservations and cancellation, Work Orders with start/pause/resume/complete + time logs + MO roll-up, material reservation → issue-to-WIP → consumption → return (through the IMS ledger), finished-goods receipts (through the IMS ledger, over-receipt-guarded, idempotent), production costing records, 25 SQL reports, MMS policies config, production dashboard analytics, IPC permissions and auditing. The **entire happy-path workflow BOM → MO → work orders → issue → consume → complete → receipt → IMS stock effect was executed live via Playwright and produced correct ledger values** (finished product 100 units, raw material 90 units after a 10-unit consumption).
- **Stubbed at the backend, honestly labelled in the UI:** MPS, MRP, WIP, Quality Control, Scrap, Rework, Maintenance, Subcontracting, Genealogy. 8 of the 22 sidebar pages render a strip reading *"…is not implemented yet; this register will stay empty."*
- **Placeholder UI on real backends:** Routes and Work Centers have fully implemented repositories and RPC handlers, but their **"New Route"/"New Work Center" dialogs are dead** (uncontrolled inputs; Save only closes the dialog) and their row "edit" buttons do nothing. Runtime-verified: after filling nothing and clicking Save, `mms.routes.list` and `mms.workCenters.list` both still return `[]`.
- **Fake success:** `mms.mrp.run` returns a fabricated "completed" DTO (`id: 0`, empty requirements) — verified live.

No estimates of "% complete" are invented in this report; classifications are per-feature in §10.

---

## 2. Sidebar / Navigation Tree (exact)

Source of truth: `src/renderer/lib/ims-nav.ts` (MMS_SECTIONS, lines 304–501). Sidebar renderer: `src/renderer/components/layout/Sidebar.tsx` (MMS group at :251–272). Every MMS item requires `can("manufacturing", "view")`; if the user lacks it, **the entire MMS rail entry disappears** (Sidebar.tsx:251). There are no per-screen MMS permissions — only module-level `manufacturing:{view,create,edit,delete,cancel,export}` (defined in `src/shared/permissions.ts:25–40`; two fixed roles: Administrator = all actions on all modules, Staff = all modules except `reports`/`partners`/`settings`/`export`).

Manufacturing & Production (MMS) — group toggle:

| Section | Item (exact label) | Route | Clickable | Opens correct page | Implemented? |
|---|---|---|---|---|---|
| Overview | Production Dashboard | `/mms` | Yes | Yes | Full UI + backend |
| Production Planning | Master Production Schedule | `/mms/planning/mps` | Yes | Yes | UI plus honest backend placeholder |
| Production Planning | Material Requirements Planning | `/mms/planning/mrp` | Yes | Yes | UI plus honest backend placeholder |
| Engineering & BOM | Bills of Materials | `/mms/boms` | Yes | Yes | **Fully functional** (+ detail route `/mms/boms/:id`, reachable by clicking a BOM row) |
| Engineering & BOM | Recipes & Formulations | `/mms/recipes` | Yes | Yes | Real register (reads BOM-type `recipe` rows) |
| Engineering & BOM | Routes & Operations | `/mms/routes` | Yes | Yes | List real; **create dialog and row-edit button are dead buttons** |
| Production Operations | Manufacturing Orders | `/mms/production/orders` | Yes | Yes | **Fully functional** (+ detail route `/mms/production/orders/:id`) |
| Production Operations | Work Orders / Job Cards | `/mms/work-orders` | Yes | Yes | **Fully functional** |
| Production Operations | Shop Floor | `/mms/shopfloor` | Yes | Yes | Functional (in-progress WOs only); silent error handling |
| Production Operations | Material Issues | `/mms/materials` | Yes | Yes | Real read-only register |
| Production Operations | Finished Goods Receipts | `/mms/finished-receipts` | Yes | Yes | Real read-only register |
| Factory Resources | Work Centers | `/mms/work-centers` | Yes | Yes | List real; **create dialog and row-edit button are dead buttons** |
| Factory Resources | Machines & Equipment | `/mms/equipment` | Yes | Yes | Real register (read only in UI; backend save exists, no UI) |
| Factory Resources | Maintenance Requests | `/mms/maintenance` | Yes | Yes | UI plus honest backend placeholder |
| Production Control | Work in Progress | `/mms/wip` | Yes | Yes | UI plus honest backend placeholder |
| Production Control | Quality Control | `/mms/quality` | Yes | Yes | UI plus honest backend placeholder |
| Production Control | Scrap & By-products | `/mms/scrap` | Yes | Yes | UI plus honest backend placeholder |
| Production Control | Rework Management | `/mms/rework` | Yes | Yes | UI plus honest backend placeholder |
| Subcontracting | Subcontract Orders | `/mms/subcontracting` | Yes | Yes | UI plus honest backend placeholder |
| Costing & Analytics | Production Costing | `/mms/costing` | Yes | Yes | Real read-only register |
| Costing & Analytics | Production Reports | `/mms/reports` | Yes | Yes | Fully functional (25 SQL reports) |
| MMS Configuration | Production Policies | `/mms/settings` | Yes | Yes | Fully functional (read/edit config) |

Single-item groups (Overview, Subcontracting, MMS Configuration) render as flat links, not collapsibles (Sidebar.tsx:641–647). Runtime confirmation: click-through of **every** route above succeeded in the live app with zero console/page errors.

### Navigation anomalies (verified in code)

- `MMS_PATH.planningCapacity = "/mms/planning/capacity"` (ims-nav.ts:87) — has a path constant, no sidebar item, **no route registered**; navigating there hits the `*` catch-all and redirects to `/`.
- `MMS_PATH.routeDetail = "/mms/routes/:id"` and `MMS_PATH.woDetail = "/mms/work-orders/:id"` (ims-nav.ts:94) — path constants exist but no routes; the UI itself never navigates to them, so no user-visible break.
- MMS is absent from the mobile bottom dock entirely (`DOCK_PATHS`, ims-nav.ts:552–557, contains only `/` and 3 IMS paths).
- Two MMS screens exist as routes but not in the sidebar by design: `/mms/boms/:id`, `/mms/production/orders/:id`.

---

## 3. Page-by-Page Explanation (runtime walkthrough + code)

Per-page entries below combine: exact strings from the code, and the live state captured on **2026-11-07** on a fresh (empty) database. Screenshots for every page are stored in `docs/mms-verify/<route>.png` (24 files, freshly captured during this audit).

All buttons call the renderer helper `call("<method>", …)` (`src/renderer/lib/api.ts:86`) over the IPC bridge — the same typed RPC contract declared in `src/shared/ipc.ts`.

---

### PAGE: Production Dashboard (`MmsDashboardPage.tsx`, 376 lines)

**Route:** `/mms`

**Purpose:** One-glance KPI + analytic overview of manufacturing.

**UI Layout:**
- Header **"Production Dashboard"**, subtitle *"Manufacturing orders, work orders, quality and cost at a glance."* (L77–79)
- Eight KPI stat cards: **"Total MOs", "Planned", "Active", "Completed", "Delayed"** (danger tone when >0), **"Pending WOs", "Produced", "Rejected"** (danger when >0) (L48–69)
- Charts (recharts): **"MO Status"** donut with `"{n} orders"`, **"Daily Output"** 14-day bar chart, **"Quality"** pie of inspection results (L140–193)
- Panels: **"Material Shortages"** (rows "need X, have Y" / "short Z"; empty *"No material shortages detected."*), **"Orders Requiring Attention"** (empty *"All orders are on track."*), **"Recent Activity"** (fed from `audit_log` `module='manufacturing'`; empty *"No recent activity."*), **"Work Centers"** (shows `"{n}% util."`; empty *"No work center data."*)
- Loading: 8 skeleton cards labelled "Loading…" / value "—".

**User Actions:**
- `Refresh` (L82–89) → refetches `call("mms.dashboard", {})`. Works.
- `New MO` (L245–251, gated `manufacturing:create`) → navigates to `/mms/production/orders`. Works.

**Current State:** ⚠️ **Two issues found**:
1. When the `mms.dashboard` query **errors**, the page shows the empty-state text *"No manufacturing data available."* (L46) — an error is indistinguishable from an empty database. On the runtime walkthrough (fresh DB), the text *"No manufacturing data available."* was displayed (either the genuine empty state or a conflated error — the page has no `isError` branch).
2. Work-center utilisation values are hardcoded `0` in the backend (analytics.ts:112: *"placeholder until time logs are aggregated"*, and per-center `0 AS utilization_pct` at L189).

**Backend:** `mms.dashboard` → `mmsAnalytics.mmsDashboard()` (`src/main/repositories/mms/analytics.ts:45–344`) — ~20 read-only SQL aggregations across all `manufacturing_*` tables + `audit_log`. Fully implemented.

**Classification:** FUNCTIONAL BUT NOT TESTED end-to-end visually (the e2e suite does not open `/mms`), with known hardcoded utilisation.

---

### PAGE: Master Production Schedule (view in `MmsCollectionPage.tsx`)

**Route:** `/mms/planning/mps`

**Purpose:** Show planned/confirmed/forecast demand per product and period.

**UI Layout (runtime-verified):**
- Header **"Master Production Schedule"**, subtitle *"Planned, confirmed and forecast demand per product and period."*
- Orange alert banner, exact text: **"The master production schedule is not implemented yet; this register will stay empty."** (MmsCollectionPage.tsx:89)
- Table columns: `Period | SKU | Product | Planned | Confirmed | Projected Stock | Shortage`
- Empty state: *"No production schedule has been generated yet."*
- `Refresh` button on every register.

**User Actions:** `Refresh` works (RPC `mms.mps.plans.list` → `mmsMps.listMpsPlans()`, mps.ts:11–17, which is `// Placeholder implementation` returning `[]`). There is **no "Run MPS" action** — the frontend defines an action-button framework (L271–285) but no view sets `action`, and no `mms.mps.run` method exists in the contract. `runMps()` exists in mps.ts:19–34 as an **empty transaction** whose body is only comments; it is never invoked from RPC.

**Current State:** EMPTY / PLACEHOLDER (deliberate, user-visible, honest).

---

### PAGE: Material Requirements Planning (view in `MmsCollectionPage.tsx`)

**Route:** `/mms/planning/mrp`

**Purpose:** Show net material requirements after supply.

**UI Layout (runtime-verified):**
- Header **"Material Requirements Planning"**
- Banner: **"The MRP calculation is not implemented yet; this register will stay empty."**
- Columns: `SKU | Component | Required | Available | Shortage | Required By | Suggested Action`
- Empty: *"No MRP requirements calculated yet."*

**Backend:** `mms.mrp.requirements.list` is an inline stub returning `[]` (rpc.ts:2603). `mms.mrp.run` → `mmsMrp.runMrp()` (mrp.ts:11–31) is **commented-out logic + fabricated success**: verified live during this audit — the RPC returned `{ id: 0, status: "completed", requirements: [] }`. It performs no SQL, writes nothing, and reports success. No MRP-run button exists anywhere in the UI (the dead action button in MmsCollectionPage would have been its only entry point).

**Current State:** EMPTY / PLACEHOLDER **plus a dangerously misleading backend stub that claims success**.

---

### PAGE: Bills of Materials (`BomsPage.tsx`, 268 lines)

**Route:** `/mms/boms` (detail: `/mms/boms/:id`)

**Purpose:** Define and approve BOMs; list + create + approve.

**UI Layout (runtime-verified):**
- Header **"Bills of Materials"**; subtitle *"Approved BOMs are released to manufacturing orders."*
- Columns: `BOM No | Product | SKU | Type | Status | Components | Effective From` (BOM No sortable); actions column.
- Empty state: *"No BOMs defined yet."*

**User Actions:**
1. Row ✏️ "Open BOM" → navigates to `/mms/boms/:id` (detail page below). Works.
2. Row ✔ "Approve BOM" (only when status ≠ approved and user has `manufacturing:edit`) → `call("mms.boms.approve", { id })` → real persistence (`updateBoms SET status='approved'`, audited). Failures surface verbatim as toasts ("Only a draft or review BOM can be approved.", "A BOM must have at least one component before approval."). Runtime-verified by the e2e suite.
3. Header **"New BOM"** (gated `manufacturing:create`) → opens the Create BOM dialog.

**Create BOM dialog** (L119–268): title **"Create BOM"**, desc *"A BOM starts as a draft. Add components, then approve it before producing."* Fields: **Product made by this BOM** (select of products; autofills name `"{name} BOM"` and unit), **BOM name**, **Type** (options `Assembly`, `Recipe / formulation`, `Subcontract`, `Multi-level`), **Base output** (number, min 0.001), **Output unit**. Manual validation ("Choose the product this BOM makes and give it a name.", "Base output quantity must be greater than zero."). Save → `call("mms.boms.save", …)` → **pushes into table `manufacturing_boms` with snapshot components listing**; success toast *"BOM created. Add its components next."* and navigation to the new BOM detail. Error toasts work. Runtime-verified by e2e suite.

**Backend:** full CRUD + approval in `src/main/repositories/mms/bom.ts` (529 lines, 5 audit calls, 4 transactions), including duplicate-number-per-product check (L332–334) and **multi-level cycle detection** (`findCycle`, recursive approved-BOM traversal, L120–168) with exact error "Adding this component would create a circular BOM: a → b → a." Number generation `BOM-%05d`.

**Current State:** FULLY FUNCTIONAL — VERIFIED (create + approve + list e2e-verified; detail page and cycle rejection NOT RUNTIME VERIFIED).

---

### PAGE: BOM Detail (`BomDetailPage.tsx`, 292 lines)

**Route:** `/mms/boms/:id`

**Purpose:** Inspect a BOM; add components; approve.

**UI Layout:**
- Header `"{number} — {name}"`, subtitle `"{sku} — {product} (variant)"`; back button **"Back to BOMs"** (`window.history.back()`).
- Info cards: **Type / Status / Base Output**.
- **Components** table: columns `SKU | Component | Qty per Unit | Scrap % | Line`; empty *"No components defined."*

**User Actions:**
1. **"Add Component"** → opens dialog titled **"Add Component"** (desc *"Quantity is per one base output of the BOM."*): selects **Component** product, **Qty per unit** (min 0.001), **Unit**, **Scrap allowance (%)** (0–100). Validations: "Choose the component product.", "Quantity per unit must be greater than zero." Save → `call("mms.bomComponents.save", { bomId, componentProductId, quantityMilli…, unit, scrapPercent })` → inserts into `manufacturing_bom_components`, line_no = MAX+1, audited; toast *"Component added."* Disabled once the BOM is approved (correct lock). NOT RUNTIME VERIFIED (dialog mechanics), backend verified as code.
2. **"Approve BOM"** → `call("mms.boms.approve", …)` with persistent effect.

**Current State:** FUNCTIONAL BUT NOT TESTED (backend FULL; UI dialog not exercised at runtime).

---

### PAGE: Recipes & Formulations (view in `MmsCollectionPage.tsx`)

**Route:** `/mms/recipes`

**Purpose:** List BOMs of type `recipe` as formulations.

**UI Layout (runtime-verified):** header **"Recipes & Formulations"**; real fetch via `call("mms.boms.list", { bomType: "recipe" })`; columns `Recipe No | Product | Output | Unit | Status | Effective From`; empty state *"No recipes defined yet. Create one as a BOM with type recipe."* — there is **no dedicated recipe form**; the practical workflow is to create a BOM with type "Recipe / formulation" in BomsPage.

**Current State:** PARTIALLY FUNCTIONAL (real data path, no dedicated create/edit UI; supported in BOM dialog's Type dropdown).

---

### PAGE: Routes & Operations (`RoutesPage.tsx`, 123 lines)

**Route:** `/mms/routes`

**Purpose:** Define routings with ordered operations per work center.

**UI Layout (runtime-verified):** header **"Routes & Operations"**, subtitle *"Manufacturing routings: operation sequence, work centers, times."*; columns `Route No | Name | Status | Effective From | Operations`; empty *"No routes defined yet."*; header button **"New Route"**.

**User Actions — verified broken:**
1. Row action button `onClick={() => {}}` (RoutesPage.tsx:45) — **does nothing**.
2. **"New Route"** opens a dialog titled "Create Route" (desc *"Define a routing with operations, work centers and cycle times."*) with two inputs **Number** and **Name** — but both inputs are **uncontrolled/disconnected from state**, and the Save button (L108–114) only calls `setOpenCreate(false)`. **No RPC is ever made.** Runtime-verified: clicked Save live; `mms.routes.list` still returned `[]`; screenshot `docs/mms-verify/_dialog_new_route.png`.
3. The backend (`mms.routes.save`, `mms.routeOperations.save`, full 356-line repository `routing.ts`) exists and is FULL — the e2e suite creates routes/operations through it successfully — but **the UI cannot reach it**.

**Current State:** BROKEN UI on FULL backend (list view works; creation impossible from the interface).

---

### PAGE: Manufacturing Orders (`MoListPage.tsx`, 302 lines)

**Route:** `/mms/production/orders` (detail: `/mms/production/orders/:id`)

**Purpose:** Create production orders from approved BOMs; release them.

**UI Layout (runtime-verified):** header **"Manufacturing Orders"**, subtitle *"Production orders with BOM snapshots, routing and material requirements."*; columns `MO No | Product | SKU | Planned Qty | Accepted | Status` (MO No sortable); empty *"No manufacturing orders defined yet."*

**User Actions:**
1. Row ✏️ "Open order" → `/mms/production/orders/:id`. Works.
2. Row **"Release"** (only `planned`/`confirmed` + `manufacturing:edit`) → `call("mms.orders.release", { id })` → success toast *"Order released. Work orders and reservations created."*; server refusals shown verbatim. Runtime-verified in e2e.
3. Header **"New MO"** → Create MO dialog (runtime-verified rendering in e2e).

**Create MO dialog** (L134–302): title **"Create Manufacturing Order"**, desc *"An order is planned from an approved BOM. Releasing it reserves materials and creates work orders."* Loads approved BOMs live (`mms.boms.list { status: "approved", limit: 500 }`) and routes live (`mms.routes.list`). Fields: **Product to produce**, **Approved BOM** (filtered to that product; empty option *"No approved BOM yet — approve one first"*), **Planned quantity** (min 0.001), **Routing (optional)** with default **No routing**; inline hint *"Without a routing the order creates no work orders, and no operation can be recorded."* Save → `call("mms.orders.save", …)` → real persistence (creates `manufacturing_orders` + exploded `manufacturing_order_components` with planned cost). Runtime-verified.

**Backend (full) — release logic in `manufacturingOrders.ts`:**

> Release is a large transaction (L496–659) that:
> 1. Checks BOM-approved status; a released+ MO cannot be edited ("A released or later manufacturing order cannot be edited." L328–339); "A manufacturing order requires an approved BOM revision." (L402–405)
> 2. Validates routing exists and has ≥1 operation ("The routing has no operations. Add operations before releasing." L569)
> 3. Checks IMS availability for every component; blocks release otherwise: "Insufficient components to release: {sku}: required x, available y. Receive materials or adjust the order quantity first." (L536–549)
> 4. Creates one work order per route operation: first operation = `ready`, rest = `blocked` (prerequisite sequencing)
> 5. Reserves materials through IMS (`reserveStock`, skipping portions already reserved — idempotent, L606–635)
> 6. Sets status `'released'`, audits `action:"release"`.

Note: the code computes `newStatus` ("planned" → "confirmed", L639) but then writes `'released'` unconditionally (L640–642) — the "confirmed" stage is skipped; dead variable.

**Current State:** FULLY FUNCTIONAL — VERIFIED (create + release in e2e; cancel dialogue NOT RUNTIME VERIFIED, backend verified as code: cancels release reservations with status released).

### PAGE: MO Detail (`MoDetailPage.tsx`, 481 lines)

**Route:** `/mms/production/orders/:id`

**Purpose:** The production control room for one order.

**UI Layout:** header `"{number}"`, subtitle sku/product; stat cards **Status | Planned Qty | Produced | Accepted | Progress ({pct}%)**; **Material Requirements** table (`SKU | Component | Required | Issued | Consumed`; empty *"No material requirements."*); **Cost Summary** card (rows **"Planned Cost", "Actual Cost", "Variance"**, variance shown in red when actual > planned).

**User Actions** (all real, all persistent; batch loops show partial-failure toasts):
1. **"Release to Production"** → `mms.orders.release`.
2. **"Issue Materials"** ("Issuing…" while running) → loops `mms.materialIssues.issueToWip` per component line → toast *"Issued N component line(s) to the shop floor."*; partial failure → *"N line(s) posted, then: {error}"*.
3. **"Consume Materials"** → loops `mms.materialIssues.consume` → *"Consumed N component line(s)"*.
4. **"Receive Finished Goods"** → opens Receive dialog; disabled until accepted output exists.
5. **"Cancel MO"** (gated `manufacturing:cancel`; forbidden when completed/closed; refusal messages "A completed or closed manufacturing order cannot be cancelled.", "This manufacturing order is already cancelled.") → cancel dialog, **Reason** field required ("Give a reason for cancelling the order."); posts `mms.orders.cancel`, releasing reservations back to available stock.

**Receive dialog** (L322–413): title **"Receive Finished Goods"**, desc *"Posts accepted output to IMS stock at this order's unit cost."*; fields **Accepted quantity ({unit})** (prefilled with un-received units) and **Batch number (optional)**; validation *"Accepted quantity must be greater than zero."*; Save → `mms.finishedReceipts.save`; toast *"Finished goods received into stock."*

**Current State:** FULLY FUNCTIONAL — VERIFIED (batch issue + consume + WO start/complete/rollup + receipt and IMS ledger readback all executed in the passing e2e test). Cancel path NOT RUNTIME VERIFIED.

---

### PAGE: Work Orders / Job Cards (`WorkOrderListPage.tsx`, 269 lines)

**Route:** `/mms/work-orders`

**Purpose:** Manage shop-floor jobs with time tracking.

**UI Layout (runtime-verified):** header **"Work Orders / Job Cards"**, subtitle *"Shop floor operations with time tracking and material consumption."*; columns `MO | Operation | Work Center | Operator | Planned | Actual | Status`; empty *"No work orders defined yet."*

**User Actions** (each → `call(method, { id })` → refetch → `toast.error` on failure — the healthiest error handling in the module):
- `ready` → **"Start"** (`mms.workOrders.start`)
- `inProgress` → **"Pause"** (`mms.workOrders.pause`), **"Complete"** → opens dialog
- `paused` → **"Resume"** (`mms.workOrders.resume`)

**Complete dialog** (L160–269): title `"Complete {operationName}"`, desc *"Produced quantity rolls up into the manufacturing order."*; fields **Actual** (min 0.001), **Accepted** (min 0; prefilled to planned), **Rejected** (min 0, default 0); validation *"Actual quantity must be greater than zero."*; Save → `mms.workOrders.complete`; toast *"Work order completed; the manufacturing order has been updated."*

**Backend (full) in `workOrders.ts`:** transition guards with exact statuses (e.g. "Only a ready work order can be started. Current status: X."), overlap guard ("Operator already has an active work order (N). Complete or pause it first."), "Accepted + rejected cannot exceed actual quantity." (`manufacturing_job_time_logs` rows closed on pause/complete with julianday duration math), MO roll-up (SUM over work orders → MO actual/rejected → status becomes `qualityReview` when produced ≥ planned). Runtime-verified by the e2e suite.

**Current State:** FULLY FUNCTIONAL — VERIFIED.

---

### PAGE: Shop Floor (`ShopFloorPage.tsx`, 150 lines)

**Route:** `/mms/shopfloor`

**Purpose:** Operator-facing board for assigned in-progress jobs.

**UI Layout (runtime-verified):** header **"Shop Floor"**, subtitle *"Your assigned operations. Start, pause and complete jobs from here."*; JobCards with status chips ("In Progress"/"Paused"/"Ready"), `MO {number} • {workCenterName ?? "Unassigned"}`, fields `"Planned Qty" / "Actual Qty" / "Expected Duration" / "Actual Duration"`; empty state: **"No active jobs"** — *"No in-progress work orders assigned to you."* (exists because the page lists only `status:"inProgress"` work orders).

**User Actions:**
- **Start / Pause / Resume** → `call("mms.workOrders.start|pause|resume", { id })`.
- ⚠️ These calls are fired with `void call(...)` — **no `.catch` and no refetch** (L68–77): an error toast never appears and the card doesn't refresh; a non-editor sees a disabled **"View Only"** button.
- No "Complete" button here — completion lives in the Work Orders list page.

**Current State:** PARTIALLY FUNCTIONAL (real backend, silent error swallow).

---

### PAGE: Material Issues (`MaterialIssuesPage.tsx`, 77 lines)

**Route:** `/mms/materials`

**Purpose:** Ledger register of reservations/issues/consumption events.

**UI Layout (runtime-verified):** header **"Material Issues"**, subtitle *"Reservations, WIP transfers and consumption. Posted through IMS stock."*; columns `MO | SKU | Component | Qty | Type | Created | By`; empty *"No material issues recorded yet."*

**User Actions:** **"New Issue"** → merely navigates to `/mms/production/orders` (issuing happens on MO detail). There is **no direct issue form from this page**. ⚠️ It also navigates unconditionally, regardless of the `manufacturing` create/edit rights implied by its edit-gating.

**Current State:** FUNCTIONAL (read-only register, verified list RPC; redirect button intentionally bypasses any form).

---

### PAGE: Finished Goods Receipts (`FinishedReceiptsPage.tsx`, 94 lines)

**Route:** `/mms/finished-receipts`

**Purpose:** Register of accepted output posted to IMS.

**UI Layout (runtime-verified):** header **"Finished Goods Receipts"**, subtitle *"Accepted finished output posted to IMS stock. QC-gated and idempotent."*; columns `MO | SKU | Product | Qty | Accepted | Rejected | Total Cost | Received`; empty *"No finished goods receipts posted yet."*

**User Actions:** **"New Receipt"** → navigates to `/mms/production/orders` (receipts posted from MO detail). No direct form here.

**Current State:** FUNCTIONAL (read-only register).

---

### PAGE: Work Centers (`WorkCentersPage.tsx`, 133 lines)

**Route:** `/mms/work-centers`

**Purpose:** Resource register: capacity, rates, status.

**UI Layout (runtime-verified):** header **"Work Centers"**, subtitle *"Production resources: capacity, cost rate, maintenance status."*; columns `Code | Name | Plant | Type | Capacity | Cost/Hr | Status | Active`; empty *"No work centers defined yet."*

**User Actions — same defects as Routes:**
1. Row action `onClick={() => {}}` (WorkCentersPage.tsx:57) — dead.
2. **"New Work Center"** dialog (desc *"Define a production resource with capacity and cost rate."*; fields `Code`, `Name`) has uncontrolled inputs; Save (L117–124) merely closes the dialog. Runtime-verified: Save clicked, `mms.workCenters.list` unchanged (`[]`); screenshot `docs/mms-verify/_dialog_new_workcenter.png`.
3. Backend `mms.workCenters.save` + `mms.equipment.save` are FULL (audited transactions) but unreachable from the UI.

**Current State:** BROKEN UI on FULL backend.

---

### PAGE: Machines & Equipment (view in `MmsCollectionPage.tsx`)

**Route:** `/mms/equipment`

**Purpose:** List machines linked to work centers.

**UI Layout (runtime-verified):** real fetch `call("mms.equipment.list")`; columns `Code | Machine | Work Center | Status | Capacity | Cost / Hr`; empty *"No machines registered yet."* — **no create/edit UI exists**, although the backend method `mms.equipment.save` exists (FULL).

**Current State:** PARTIALLY FUNCTIONAL (read only).

---

### PAGE: Maintenance Requests (view) — `/mms/maintenance`; Work in Progress (view) — `/mms/wip`; Quality Control (view) — `/mms/quality`; Scrap & By-products (view) — `/mms/scrap`; Rework Management (view) — `/mms/rework`; Subcontract Orders (view) — `/mms/subcontracting`

**Shared UI pattern (each runtime-verified):** header + subtitle; **orange banner "The X is not implemented yet; this register will stay empty."** (exact strings below); a real list table with typed columns; `Refresh` button; correct empty-state sentence; **no action buttons at all** (MmsCollectionPage's action framework exists at L271–285 but no view sets `action` — dead code + a doc comment at L11–13 that promises "the two screens with a real action — running MRP and recording a maintenance request — keep it here", which is not true today).

| View | Route | Banner (verbatim) | Columns | List handler | Save handler |
|---|---|---|---|---|---|
| Maintenance | `/mms/maintenance` | "Maintenance requests are not implemented yet; this register will stay empty." | `Request, Machine, Work Center, Priority, Status, Raised` | inline `[]` (rpc.ts:2615) | inline throw (2621) |
| WIP | `/mms/wip` | "WIP valuation is not implemented yet; this register will stay empty." | `MO, Product, Qty, Stage, Work Center, Material, Updated` | inline `[]` (2487) | n/a |
| Quality | `/mms/quality` | "Quality checks are not implemented yet; this register will stay empty." | `MO, Checkpoint, Type, Result, Inspector, Inspected` | inline `[]` (2497) | inline throw (2503) |
| Scrap | `/mms/scrap` | "Scrap recording is not implemented yet; this register will stay empty." | `MO, Item, Qty, Type, Reason, Cost` | inline `[]` (2511) | inline throw (2517) |
| Rework | `/mms/rework` | "Rework management is not implemented yet; this register will stay empty." | `MO, Output, Qty, Status, Reason, Raised` | inline `[]` (2525) | inline throw (2531) |
| Subcontract | `/mms/subcontracting` | "Subcontract orders are not implemented yet; this register will stay empty." | `Order No, Processor, Product, Qty, Cost, Due, Status` | inline `[]` (2629) | inline throw (2635) |

Three more: `mms.genealogy.list` is an inline `[]` (rpc.ts:2590) with **no UI anywhere**; `mms.mps.plans.list` / `mms.mrp.requirements.list` are covered above.

The typed repository stubs `qualityChecks.ts`, `scrap.ts`, `rework.ts`, `maintenance.ts`, `wip.ts` exist (with their own error classes and "not yet wired" throws) but are **not even wired to RPC** — the inline handlers coexist as duplicates. Notably their typed error classes are absent from `toApiError`'s known list (rpc.ts:227–254), so if wiring ever happens without that fix, the UI will show "Something went wrong." instead of the real message.

---

### PAGE: Production Costing (`CostingPage.tsx`, 100 lines)

**Route:** `/mms/costing`

**Purpose:** Planned vs actual cost per order.

**UI Layout (runtime-verified):** header **"Production Costing"**, subtitle *"Planned vs actual manufacturing cost per order."*; three stat cards: **"Total Cost Recorded"** (sum of amountFils as "Rs …"), **"Cost Records"** (count), **"MOs with Costs"** (distinct MOs); table **"Cost Records"** ({n} entries), columns `MO | Cost Type | Amount | Qty Basis | Recorded | By`; empty *"No cost records yet."*

**User Actions:** row ✏️ jumps to the MO detail page (`/mms/production/orders/:id`). **No create-cost-record UI exists**, even though `mms.costRecords.save` (FULL repo `costing.ts`) exists; the MO detail page shows the cost *summary* but offers no "Record Cost" button. Notable: **the UI cannot create cost records at all**, so "Actual Cost" can only rise through some pipeline that isn't wired into any page.

**Current State:** PARTIALLY FUNCTIONAL (real read register; write path orphaned).

---

### PAGE: Production Reports (`MmsReportsPage.tsx`, 185 lines)

**Route:** `/mms/reports`

**Purpose:** Run parameterised SQL reports over posted manufacturing data.

**UI Layout (runtime-verified):** header **"Production Reports"**, subtitle *"Real SQL reports over posted manufacturing records."*; **Report Filters** form: **Report** (select of 25 titles formatted `"{title} ({group})"`, default `moSummary`), **From Date**, **To Date**, **Limit** (default 500); results table with server-defined dynamic columns (e.g. for the default report: `MO Number | Product | SKU | Status | Planned Qty | Actual Qty | Accepted Qty | Cost` — captured live in walkthrough) and a totals row. No empty-state sentence is provided for a zero-row result (silently renders the table header only), and there is no error banner for a failing report query.

**Backend:** `mms.report` dispatches over `mmsReportSpec` (analytics.ts:382–840): 25 defined reports querying `manufacturing_orders, products, finished_receipts, work_centers, work_orders, route_operations, consumption_records, order_components, cost_records, wip_records, scrap, rework, quality_checks, job_time_logs, subcontract_orders, genealogy_links`, LIMIT 5000 with JS totals. Quality of the reports varies: `oee`/`workCenterUtilization` are duration-sum approximations, and `productionYield` mislabels rejected qty under a "cost" column (analytics.ts:663).

**Current State:** FULLY FUNCTIONAL — VERIFIED (list call captured live; run flow is code-verified with a typed payload override at L37 `as any`).

---

### PAGE: Production Policies (`MmsSettingsPage.tsx`, 211 lines)

**Route:** `/mms/settings`

**Purpose:** Edit production policy config.

**UI Layout (runtime-verified):** header **"Production Policies"**, subtitle *"Production policies applied by the server when documents are posted."*; card **"Production Policies"** — *"Stored with the company database."*; controls: **Negative stock policy** (options "Block issues that would go negative" / "Allow negative stock"), **Default costing method** ("Standard cost" / "Weighted average" / "FIFO"), **Scrap allowance (%)**, **Overhead rate (fils per hour)**, checkboxes **"Allow backflush consumption"**, **"Require quality check before finished-goods receipt"**, **"Create work orders automatically when an order is released"**; button **"Save changes"**.

**User Actions:** Save → `call("mms.config.update", form)` — persists via UPSERT on `mms_config` (audited); toast *"Production policies saved."* Loading shows *"Loading policies…"*.

**Backend quirks (all code-verified):**
- Seeded defaults: block / standard / no-backflush / require-QC / 5% / 0 / auto-create (migration 25, index.ts:2036–2043).
- ⚠️ **`negativeStockPolicy` is never consumed** — MMS stock contexts hardcode `allowNegativeStock:false` regardless (materialIssues.ts:129, finishedReceipts.ts:92, manufacturingOrders.ts:603); only the global *application* setting feeds IMS UI paths.
- ⚠️ **`requireQCBeforeReceipt` is never enforced** — `saveFinishedReceipt` doesn't consult config.
- ⚠️ **`defaultCostingMethod` is never consulted** in the costing/finished-receipt path.
- `autoCreateWorkOrders` is likewise never consulted — release always creates WOs (and only if a routing with operations exists).

**Current State:** FULLY FUNCTIONAL as a form, but **5 of 7 policies are cosmetic** (persist but unenforced).

---

## 4. Forms & Dialogs Inventory (complete)

| # | Form / Dialog | Where | Enabled? | Fields (label — validation) | Backend on Save | Persists? | Errors displayed? |
|---|---|---|---|---|---|---|---|
| 1 | Create BOM | BomsPage header | if `manufacturing:create` | Product*, BOM name*, Type, Base output* (>0), Output unit | `mms.boms.save` → real INSERT + audit | ✓ (e2e-verified) | ✓ toast |
| 2 | Add Component | BOM Detail | if not approved + edit | Component*, Qty per unit* (>0), Unit, Scrap allowance (%) | `mms.bomComponents.save` → real | ✓ | ✓ toast |
| 3 | Approve BOM | Boms row + BOM Detail | if not approved + edit | none | `mms.boms.approve` → real | ✓ (e2e-verified) | ✓ toast |
| 4 | Create Manufacturing Order | MoList header | if `manufacturing:create` | Product*, Approved BOM* (approved only), Planned qty* (>0), Routing optional | `mms.orders.save` → real explode + cost | ✓ (e2e-verified) | ✓ toast |
| 5 | Release to Production | MoDetail + MoList row | if `manufacturing:edit` | none | `mms.orders.release` → stock check, reservations, WOs | ✓ (e2e-verified) | ✓ toast (refusals verbatim) |
| 6 | Issue Materials (batch) | MoDetail | if line outstanding | none (auto per line) | loop `mms.materialIssues.issueToWip` | ✓ (e2e-verified) | ✓ toast (partial-failure aware) |
| 7 | Consume Materials (batch) | MoDetail | if issued unconsumed | none (auto) | loop `mms.materialIssues.consume` | ✓ (e2e-verified) | ✓ toast |
| 8 | Receive Finished Goods | MoDetail | if unaccepted units > 0 | Accepted qty* (>0; prefilled), Batch no optional | `mms.finishedReceipts.save` → real IMS movement | ✓ (e2e-verified) | ✓ toast |
| 9 | Cancel Manufacturing Order | MoDetail | if `manufacturing:cancel` + not closed | Reason* | `mms.orders.cancel` → release reservations | ✓ (backend code-verified; runtime NOT RUNTIME VERIFIED) | ✓ toast |
| 10 | Complete Work Order | WorkOrderList row | if `manufacturing:edit` | Actual* (>0), Accepted* (≥0), Rejected (≥0); accepted+rejected ≤ actual server-side | `mms.workOrders.complete` → real rollup | ✓ (e2e-verified) | ✓ toast |
| 11 | Start / Pause / Resume WO | WorkOrderList row | if `manufacturing:edit` | none | `mms.workOrders.*` | ✓ (e2e-verified start+complete) | ✓ toast |
| 12 | Start / Pause / Resume WO | ShopFloor card | if `manufacturing:edit` | none | same methods | ✓ but **errors silently swallowed, no refetch** | ✗ none |
| 13 | Create Route | RoutesPage header | edit-gated button, but dialog is dead | Number, Name — **uncontrolled inputs, values discarded** | **none — Save only closes the dialog** | ✗ (runtime-verified) | ✗ |
| 14 | Create Work Center | WorkCentersPage header | edit-gated button, but dialog is dead | Code, Name — **uncontrolled inputs** | **none** | ✗ (runtime-verified) | ✗ |
| 15 | Row "edit" buttons in Routes & Work Centers tables | both | always clickable | — | **`onClick={() => {}}`** | ✗ | ✗ |
| 16 | Save changes (MMS Settings) | MmsSettingsPage | if `manufacturing:edit` | Negative stock policy, Costing method, Scrap allowance %, Overhead rate, 3 checkboxes | `mms.config.update` → real UPSERT | ✓ | ✓ toast |
| 17 | MmsCollectionPage action button | all collection views | **never rendered** (no view defines `action`) — dead code | — | — | — | — |
| 18 | Refresh buttons | all MMS pages | yes | none | refetch | n/a | n/a |

Form validation is **manual** throughout (`toast.error` on bad input) — no zod schema is used in any MMS renderer file; all server-side validation is zod at `dispatchRpc` (verified live: bad payload to `mms.scrap.save` returned "Invalid input: expected number, received undefined").

---

## 5. Backend Functionality Breakdown

61 `mms.*` RPC methods are declared in `src/shared/ipc.ts:735–959`; **all 61 have registered handlers** (dispatch at `src/main/rpc.ts:2174–2693`). Each handler requires a `manufacturing` module permission and zod-parses the payload; errors are mapped through `toApiError` (rpc.ts:202–267) and surfaced as exceptions carrying `.message` in the renderer (`api.ts:129`), shown via Sonner toasts (6 s, bottom-right, App.tsx:721).

| Feature | UI page | Backend repo | DB tables touched | Business rules | RPC wired | Runtime-verified? | Missing / incomplete operations |
|---|---|---|---|---|---|---|---|
| BOM management | Boms list+detail | `bom.ts` FULL | `manufacturing_boms`, `manufacturing_bom_components` | duplicate number/product, approval transitions, autonumber, audit | ✓ | ✓ e2e | Delete BOM / BOM versions UI absent (schema table `manufacturing_bom_versions` exists but is never written) |
| BOM revisions | none | snapshot table exists | `manufacturing_bom_versions` | none | n/a | — | **Entirely unimplemented** (table + FK on MO exist; no versioning code) |
| Multi-level BOM | cycle detection exists in save | `bom.ts` FULL | recursive traversal over approved BOMs | self-ref + cycle rejection | ✓ | code-verified (resolve is findCycle; UI message exact) | Expansion of nested approved BOMs at MO creation is **single-level only** (`calculateMaterialRequirements` L251–311 reads direct components only) |
| Recipes / formulations | recipes register | shared BOM engine | `manufacturing_boms (bom_type='recipe')` | same as BOM | ✓ | ✓ register | No dedicated recipe UI; recipe creation only via BOM Type dropdown |
| Routing & operations | Routes list (creation dead) | `routing.ts` FULL | `manufacturing_routes`, `manufacturing_route_operations` | MAX(sequence)+1, prerequisite self-ref, read-back | ✓ | ✓ e2e (via RPC) | **UI cannot create**; route approval transition (draft→approved) has no dedicated approve function — only a manual status edit via generic `mms.routes.save` |
| Work centers | register (creation dead) | `workCenters.ts` FULL | `manufacturing_work_centers` | defaults on create | ✓ | ✓ list | **UI cannot create or edit** |
| Equipment | Machines register | `workCenters.ts` FULL | `manufacturing_equipment` | defaults | ✓ | ✓ list | **No create/edit UI at all** |
| Manufacturing orders | Orders list+detail | `manufacturingOrders.ts` FULL | `manufacturing_orders`, `manufacturing_order_components` | BOM-approved gate, edit-lock after release, planned-cost calc incl. scrap %, auto explode | ✓ | ✓ e2e | MO edit UI: none (only create + release + cancel); no "MO close" action exposed (status `closed` unused in UI) |
| Work orders | Work Orders list | `workOrders.ts` FULL | `manufacturing_work_orders`, `manufacturing_job_time_logs` | status transitions, operator overlap guard, duration math, MO rollup → `qualityReview` | ✓ | ✓ e2e | manual `mms.workOrders.save` (create WO by hand) has no UI; time-log entry UI absent (methods exist) |
| Shop Floor | Shop Floor cards | shared `workOrders.ts` | — | as above | ✓ | ✓ list | no Complete button here; error handling silent |
| Material reservations | — (auto on release) | `manufacturingOrders.ts` / `materialIssues.ts` FULL | `ims_reservations`, `manufacturing_material_issues` | availability check, idempotency keys `res:`, Released-only rule | ✓ | ✓ e2e | no per-line "reserve" UI button (auto-only) |
| Material issues | register | `materialIssues.ts` FULL | `stock_movements` ×2, `manufacturing_material_issues` | source availability, WIP = `inTransit` status, reservation release on issue | ✓ | ✓ e2e | `returnFromWip` has **no UI button** (implementation exists); per-line issue only via MO detail batch |
| Material consumption | MoRollup visible | `materialIssues.ts` FULL | `stock_movements`, `manufacturing_consumption_records`, `manufacturing_order_components.consumed_quantity` | WIP availability check, cost per average_cost_fils, decrement real stock | ✓ | ✓ e2e | no backflush automation (policy checkbox exists but unenforced) |
| WIP | register | **`wip.ts` STUB** (inline `[]` handler) | `manufacturing_wip_records` has data written by analytics reads only | none | ✓ (stub) | ✓ empty register | WIP valuation/reporting unimplemented; analytics dashboard shows WIP value 0 unless table populated externally |
| Quality Control | register | **inline stub** | `manufacturing_quality_checks` exists + is read by analytics | none | ✓ (stub) | ✓ empty register | **Cannot record any QC result**; MO can nonetheless reach `qualityReview` without any QC record; `requireQCBeforeReceipt` unenforced |
| Scrap | register | **inline stub** | `manufacturing_scrap` | none | ✓ (stub) | ✓ register | cannot record scrap; analytics therefore always shows Rejected=0 |
| Rework | register | **inline stub** | `manufacturing_rework` | none | ✓ (stub) | ✓ register | cannot create rework orders |
| Finished goods | register + MO detail dialog | `finishedReceipts.ts` FULL | `manufacturing_finished_receipts`, `stock_movements`, `products.quantity_milli` | status gate (qualityReview/inProgress/completed), remaining-qty guard (over-receipt blocked), idempotency `receipt:{moId}:{now}`, unit cost from `products.average_cost_fils` | ✓ | ✓ e2e (ledger verified) | rejected_qty always written 0; **cost = current product average — no true production cost roll-up into the SKU** |
| Production costing | register | `costing.ts` FULL | `manufacturing_cost_records`, `manufacturing_orders.actual_cost_fils` | incremental roll-up, 7 cost types, unit cost + variance | ✓ | code-verified; **no UI to create records** | No GL/journal posting by design (documented L12–14) |
| Maintenance | register | **inline stub** | `manufacturing_maintenance_requests` exists | none | ✓ (stub) | ✓ register | recording + lifecycle (open→resolved) unimplemented |
| Subcontracting | register | **inline stub** | `manufacturing_subcontract_orders` exists | none | ✓ (stub) | ✓ register | unimplemented (cost type `subcontract` exists in costing only) |
| Lot genealogy / traceability | **no UI** | **inline `[]`, no repo** | `manufacturing_genealogy_links` | none | ✓ (stub) | n/a | unimplemented; batch numbers optional field on receipts only |
| MPS | register | **`mps.ts` STUB** | `manufacturing_mps_plans` exists, unused | none | ✓ (stub) | ✓ empty register; `runMps` empty transaction never invoked | unimplemented |
| MRP | register | **`mrp.ts` FABRICATED STUB** | `manufacturing_mrp_runs`, `manufacturing_mrp_requirements` exist, unused | none | ✓ (stub returning fake success) | ✓ live probe returned `{status:"completed", id:0, requirements:[]}` | unimplemented; **replenishment link to IMS purchase requisitions missing** (mrp.ts:21 comment acknowledges) |
| Production reports | Reports page | `analytics.ts` MOST | all `manufacturing_*` tables | 25 specs, LIMIT 5000, JS totals | ✓ | ✓ list | OEE/utilisation are duration approximations; yield report column mislabelling |
| MMS settings | Settings page | `config.ts` FULL | `mms_config` | defaults, whitelists | ✓ | ✓ page render | **5 of 7 policies unenforced** (see §6) |
| Dashboard | Dashboard | `analytics.ts` MOST | all | ~20 aggregations | ✓ | ✓ fresh-DB display | utilisation hardcoded 0; error ≙ "no data" |

**Do not confuse schema existence with functionality:** migration 25 creates **26 manufacturing tables** (exact list in §15 of this report, `src/data/migrations/index.ts:1504–2046`) — but **9 of those tables can never be populated through any UI or RPC handler available today**: `manufacturing_wip_records`, `manufacturing_quality_checks`, `manufacturing_scrap`, `manufacturing_rework`, `manufacturing_maintenance_requests`, `manufacturing_subcontract_orders`, `manufacturing_mps_plans`, `manufacturing_mrp_runs`/`manufacturing_mrp_requirements`, `manufacturing_bom_versions`, `manufacturing_genealogy_links` (10 counted). The dashboard and several reports read these tables and will therefore permanently show zeros until the stubs are implemented.

---

## 6. MMS + IMS Integration (exact data paths)

MMS deliberately owns **no stock tables of its own**: it calls five IMS stock-engine primitives from `src/main/repositories/ims/stock.ts` — `availableQuantity` (L193), `reserveStock` (L369), `releaseReservations` (L407), `postMovement` (L208), `defaultLocationId` (L88). IMS maintains a single movement-based ledger, `stock_movements` (extended in migration to carry `location_id, source_kind, source_id, batch_no, serial_no, stock_status('available'|'quarantine'|'damaged'|'inTransit'), idempotency_key` — unique-part index), plus an `ims_reservations` table. There is no balance cache: every location quantity is a SUM over movements; `products.quantity_milli` and `products.average_cost_fils` are runtime counters updated by `postMovement` when `affectProductTotal !== false`.

| Integration point | Mechanism (exact calls, files) | Status |
|---|---|---|
| Shared products | MMS reads `products` (JOINs in every list repo); no MMS-side product table (migration 25 comment L1507–1521: "MMS reuses the IMS product master") | Implemented & verified |
| Product variants | MMS carries `variant_id` columns in `manufacturing_boms`/`manufacturing_orders`; no UI to select variants (defaults null) | Partial (schema only) |
| Raw material stock availability | Release reads `availableQuantity(db, component_product_id)` per component (`manufacturingOrders.ts:537`) and blocks release with a precise shortage message; also used by reserve/issue/consume | Implemented & verified (e2e) |
| Stock reservations | `reserveStock` → INSERT `ims_reservations {source_kind:'manufacturingOrder', status:'active'}`; cancelled/MO-cancelled → `releaseReservations(..., "released")`; material issue → `releaseReservations(..., "consumed")`. Reservation is availability-only — no movement | Implemented (e2e touches it indirectly on release) |
| Material issues (storage → WIP) | `issueMaterialToWip` posts a **pair** of movements (`affectProductTotal:false`): ledger `issue -q available` at source + `ledger receipt +q inTransit` at WIP; then releases reservations. WIP location is currently `defaultLocationId` (same as storage) — flagged in code (materialIssues.ts:321) | Implemented, verified; ⚠️ WIP physically shares the storage location, so "in WIP" is a status, not a place |
| Material consumption | `consumeMaterial`: ledger `issue -q inTransit at WIP, affectProductTotal:true` → decrements the real product stock; writes `manufacturing_consumption_records` with cost = products.average_cost_fils; increments `manufacturing_order_components.consumed_quantity` | Implemented & verified (e2e readback: raw material dropped from 100 → 90 units) |
| Material returns | `returnMaterialFromWip`: paired movements WIP(inTransit)→storage(available) | Implemented (backend) — **no UI button exists** |
| Finished-goods receipts | `saveFinishedReceipt`: single ledger `receipt +q available, affectProductTotal:true`, source `manufacturerOrder`→ exact `sourceKind:'manufacturingOrder'`, notes `Finished goods receipt for {MO}`, idempotency `receipt:{moId}:{now}:stock`; updates `manufacturing_orders.accepted_quantity`; negative stock forbidden (`allowNegativeStock:false` context) | Implemented & verified (e2e readback: finished product 100 units) |
| Stock movement ledger | ALL manufacturing postings tagged `sourceKind:'manufacturingOrder', sourceId:{moId}` → visible in IMS Stock Ledger page | Implemented (e2e verified through `products.get`) |
| Batch/serial tracking | `batch_no` optional on receipt dialog → written to `stock_movements.batch_no` + upserted to `ims_batches`; serials engine untouched by MMS | Partial |
| Production costing | NO roll-up: finished receipt posts cost = product's *current* average (stock.ts:286–291 sets average to the supplied unit cost; MMS supplies the same value it just read). `defaultCostingMethod` ignored. | Partial/Misleading («at this order's unit cost» claim on Receive dialog is not actually order-attributable) |
| Purchase requisitions | **Missing** — `runMrp` stub's own comment (mrp.ts:21) says "Generate purchase requisitions or new MOs for components if necessary"; no MMS→`imsOperations` call exists anywhere. IMS's own `createRequisitionForProducts` is reachable only from IMS UI | Missing |
| Negative-stock policy | MMS config value `negativeStockPolicy` never read in stock path; MMS contexts hard-declare `allowNegativeStock:false` regardless of anything | Partial (policy checkbox cosmetic) |

Stock negative balance from manufacturing postings is impossible: every MMS stock context hardcodes `allowNegativeStock:false` and re-declares `allowNegativeOverride:false` per posting.

---

## 7. Runtime Verification Log (what was run during this audit)

**Environment:** Windows, audit date 2026-11-07, app EyerStock 1.0.2, production build of the commit under inspection (vite renderer + tsc main). Playwright launches Electron with a fresh temp data folder (`EYERSTOCK_DATA_DIR`), `LICENCE_DISABLED=1`; setup wizard completed; signed in as `admin` (Administrator role → all permissions). **No real business data was touched** — every test ran against throwaway temp databases.

**Run 1 — Playwright e2e, `e2e/mms.spec.ts`:**
```
✓ 1 MMS is in the sidebar and every manufacturing screen opens (12.4s)
✓ 2 a BOM, order, work order, consumption and receipt produce IMS stock (6.5s)
✓ 3 the BOM and manufacturing order pages open from the rail (8.2s)
3 passed (28.2s)
```
Test 2 is the strongest runtime evidence in the audit: after stock-in via a purchase invoice, it creates route + operations through RPC, approves a BOM with 1 component, creates and releases an MO (validating component explosion + reservations), starts and completes the work order (verifies MO rolls up `actualQuantity` and status becomes `qualityReview`), issues + consumes material, posts the finished receipt, then reads back IMS stock: **finished product 10 000 milli (= 100 units), raw material 90 000 (= 90 units)** — i.e. consumption genuinely decremented stock through the ledger.

**Run 2 — full-page UI walk (fresh app instance):** all 22 `/mms` routes opened; per-route headings, table column headers, buttons, banners, empty states captured (JSON + 24 screenshots in `docs/mms-verify/`). **console errors: 0; page errors: 0.** Probe results live:
- Clicking `Save` in the **Create Route** dialog → `mms.routes.list` still `[]` (no persistence). Same for **Create Work Center**.
- Direct RPC `mms.mrp.run` → `{ ok:true, data:{ id:0, status:"completed", requirements:[] } }` (fake success confirmed live).
- Direct RPC `mms.mps.plans.list` → `[]`.
- Direct RPC `mms.scrap.save` (invalid payload) → ok:false, Zod message — validation layer works.
- `/mms` dashboard rendered *"No manufacturing data available."* on the fresh (all-zero) database.

**Run 3 — vitest unit/integration:** `33 files, 463 tests, all passed (45.48 s)`. Note: none of the 463 tests cover any part of `src/main/repositories/mms` directly; MMS coverage exists **only** in the 3 e2e tests listed above.

Screenshots: `docs/mms-verify/_mms.png` (dashboard), `_mms_boms.png`, `_mms_routes.png`, `_dialog_new_route.png`, `_mms_work-centers.png`, `_dialog_new_workcenter.png`, `_mms_wip.png`, `_mms_quality.png`, `_mms_scrap.png`, `_mms_rework.png`, `_mms_maintenance.png`, `_mms_subcontracting.png`, `_mms_planning_mps.png`, `_mms_planning_mrp.png`, `_mms_settings.png`, `_mms_reports.png`, etc. (24 total, all captured fresh during this audit).

**NOT RUNTIME VERIFIED** (static-analysis only): MO cancel dialog flow, BOM detail Add-Component dialog, cycle-detection rejection toast, reports page execution with data present (reports were only listed, not run with data — but the SQL specs are exercised nowhere else at runtime), all placeholder-route save paths (by definition), MMS Settings save round-trip (form rendered only).

---

## 8. Placeholder Implementation Inventory (search results)

Searched for "not implemented", "coming soon", "this register will stay empty", "TODO", "return []", hardcoded sample data, empty RPC handlers, dead buttons, fake success.

**Deliberate stubs (honest, user-visible):**
- `MmsCollectionPage.tsx` banners at :89, :105, :150, :165, :181, :196, :211, :226 — 8 registers labelled "…not implemented yet; this register will stay empty."
- `mps.ts` (list `return []`; empty-body `db.transaction`), `mrp.ts` (fabricated `status:"completed"` DTO), `wip.ts`, `qualityChecks.ts`, `scrap.ts`, `rework.ts`, `maintenance.ts` (`"…not yet wired."` throws) — none touched by e2e.
- `rpc.ts` inline stubs: `mms.wip.list` (2490), `mms.qualityChecks.list` (2500), `mms.qualityChecks.save` (2507, throws `WorkOrderError`), `mms.scrap.list/save` (2514/2520), `mms.rework.list/save` (2528/2534), `mms.genealogy.list` (2593), `mms.mrp.requirements.list` (2606), `mms.maintenanceRequests.list/save` (2618/2624), `mms.subcontractOrders.list/save` (2632/2638).
- `analytics.ts:112` utilisation placeholder `0`; `analytics.ts:189` `0 AS utilization_pct`; OEE/utilization reports are duration sums; `productionYield` mislabels rejected as cost (L663).

**False positive found:** `BomDetailPage.tsx` comment "(Placeholder implementation…)" at :15 — actually a fully working page.

**Dead buttons / dead code:**
- RoutesPage row button :45 `onClick={() => {}}`; WorkCentersPage row button :57 `onClick={() => {}}`.
- RoutesPage Save :108–114 and WorkCentersPage Save :117–124 close the dialog without RPC; `mms.routes.save`/`mms.routeOperations.save`/`mms.workCenters.save` unused by UI.
- MmsCollectionPage action-button machinery :254–285 never rendered; doc comment :11–13 promises MRP-run/maintenance actions that don't exist.
- `manufacturingOrders.ts:639` `newStatus` computed, never used ("confirmed" stage skipped).
- `workOrders.ts:24` imports `defaultLocationId`, unused.
- `costing.ts` / `mms.costRecords.save` + `mms.genealogy.list` + `mms.stock.snapshot` + `mms.jobTimeLogs.*` + `mms.routes.get` + `mms.workOrders.get` + `mms.bomComponents.delete` — all handled server-side but **never called by any UI** (verified by grep).

**Hardcoded sample data / "coming soon" strings:** none found. All empty states match genuinely empty databases on the fresh temp DB (the register pages read real tables; the stub reads return real empty arrays).

---

## 9. Complete UI Inventory Table

| Page | Route | Visible UI Elements | Primary Buttons | Backend Connected | Runtime Tested | Status |
|---|---|---|---|---|---|---|
| Production Dashboard | `/mms` | 8 KPI cards, 3 charts, 4 panels, skeletons | Refresh; New MO | ✓ `mms.dashboard` | ✓ walk (+screenshots) | Functional (hardcoded util; error≈empty) |
| Master Production Schedule | `/mms/planning/mps` | banner, table | Refresh | ✓ stub (`[]`) | ✓ | EMPTY / PLACEHOLDER |
| Material Requirements Planning | `/mms/planning/mrp` | banner, table | Refresh | ✓ stub (`[]`); run stub | ✓ | EMPTY / PLACEHOLDER |
| Bills of Materials | `/mms/boms` | sortable table, dialog | New BOM; row Open/Approve; Refresh | ✓ FULL | ✓ e2e create+approve | FULLY FUNCTIONAL — VERIFIED |
| BOM Detail | `/mms/boms/:id` | info cards, components table, dialog | Back; Add Component; Approve BOM | ✓ FULL | partial (walk reached route; dialog NOT RUNTIME VERIFIED) | FUNCTIONAL BUT NOT TESTED (dialog) |
| Recipes & Formulations | `/mms/recipes` | table | Refresh | ✓ (boms.list alias) | ✓ walk | PARTIALLY FUNCTIONAL |
| Routes & Operations | `/mms/routes` | table, dead row button, dead dialog | New Route (dead); Refresh | ✓ FULL backend / ✗ UI | ✓ save → no persistence | BROKEN UI on FULL backend |
| Manufacturing Orders | `/mms/production/orders` | sortable table, dialog, release row action | New MO; row Open/Release; Refresh | ✓ FULL | ✓ e2e create+release+UI dialog | FULLY FUNCTIONAL — VERIFIED |
| MO Detail | `/mms/production/orders/:id` | 5 stat cards, 2 tables, 3 dialogs | Release/Issue/Consume/Receive/Cancel | ✓ FULL | ✓ e2e issue/consume/complete/receipt | FULLY FUNCTIONAL — VERIFIED (cancel NOT RUNTIME VERIFIED) |
| Work Orders / Job Cards | `/mms/work-orders` | table, complete dialog | Start/Pause/Resume/Complete; Refresh | ✓ FULL | ✓ e2e start/complete | FULLY FUNCTIONAL — VERIFIED |
| Shop Floor | `/mms/shopfloor` | job cards, status chips | Start/Pause/Resume (silent errs); View Only | ✓ | ✓ walk (empty state) | PARTIALLY FUNCTIONAL |
| Material Issues | `/mms/materials` | table | New Issue (redirect); Refresh | ✓ FULL list | ✓ walk | FUNCTIONAL (read-only) |
| Finished Goods Receipts | `/mms/finished-receipts` | table | New Receipt (redirect); Refresh | ✓ FULL list | ✓ walk | FUNCTIONAL (read-only) |
| Work Centers | `/mms/work-centers` | table, dead row button, dead dialog | New Work Center (dead); Refresh | ✓ FULL backend / ✗ UI | ✓ save → no persistence | BROKEN UI on FULL backend |
| Machines & Equipment | `/mms/equipment` | table | Refresh | ✓ (list FULL; save unused) | ✓ walk | PARTIALLY FUNCTIONAL |
| Maintenance Requests | `/mms/maintenance` | banner, table | Refresh | inline stub | ✓ walk | EMPTY / PLACEHOLDER |
| Work in Progress | `/mms/wip` | banner, table | Refresh | inline stub | ✓ walk | EMPTY / PLACEHOLDER |
| Quality Control | `/mms/quality` | banner, table | Refresh | inline stub | ✓ walk | EMPTY / PLACEHOLDER |
| Scrap & By-products | `/mms/scrap` | banner, table | Refresh | inline stub | ✓ walk | EMPTY / PLACEHOLDER |
| Rework Management | `/mms/rework` | banner, table | Refresh | inline stub | ✓ walk | EMPTY / PLACEHOLDER |
| Subcontract Orders | `/mms/subcontracting` | banner, table | Refresh | inline stub | ✓ walk | EMPTY / PLACEHOLDER |
| Production Costing | `/mms/costing` | 3 stat cards, table | row → MO Detail; Refresh | ✓ FULL list / save orphaned | ✓ walk | PARTIALLY FUNCTIONAL |
| Production Reports | `/mms/reports` | filter form, dynamic table + totals | (implicit) | ✓ FULL (25 reports) | ✓ walk (list) | FULLY FUNCTIONAL — VERIFIED |
| Production Policies | `/mms/settings` | 2 selects, 2 numbers, 3 checkboxes | Save changes | ✓ FULL config | ✓ walk (render) | FUNCTIONAL (1 of 7 policy actually enforced in stock path) |

(Note: "1 of 7 enforced" refers to the stock path — `scrapAllowancePercent` and `autoCreateWorkOrders` likewise never consulted; all seven persist successfully.)

---

## 10. Complete Functional Inventory Table

| Feature | Frontend | Backend | Database | Business Logic | Tested (runtime) | Status |
|---|---|---|---|---|---|---|
| BOM CRUD | ✓ | ✓ FULL | ✓ real | duplicate no./product, cycle check, approval rules | ✓ create+approve | **FULLY FUNCTIONAL — VERIFIED** |
| BOM revisions & snapshots | ✗ | ✗ (table unused) | schema only | none | — | **MISSING** |
| Multi-level BOM expansion | ✗ | partial (expansion is direct-component only) | ✓ | cycle detection ✓; nested explosion ✗ | ✓ cycle detection in code only | PARTIALLY IMPLEMENTED |
| Recipes/formulations | ✓ (view only) | ✓ (via BOM) | ✓ | same as BOM | ✓ register | PARTIALLY FUNCTIONAL |
| Routing + operations | list ✓ / create ✗ | ✓ FULL | ✓ | sequencing, prerequisites | ✓ created via RPC in e2e | FUNCTIONAL backend, **BROKEN UI** |
| Route approval | ✗ | ⚠️ generic status edit only | ✓ | none specific | — | MISSING |
| Work centers | list ✓ / create ✗ | ✓ FULL | ✓ | defaults | ✓ list | FUNCTIONAL backend, **BROKEN UI** |
| Equipment | list only | ✓ FULL | ✓ | defaults | ✓ list | PARTIAL (no write UI) |
| Manufacturing orders | ✓ | ✓ FULL | ✓ | explode + planned cost + edit lock | ✓ create | **FULLY FUNCTIONAL — VERIFIED** |
| MO release | ✓ | ✓ FULL | ✓ (reservations, WOs) | stock check, routing check, op sequencing | ✓ | **FULLY FUNCTIONAL — VERIFIED** |
| "confirmed" MO stage | ✗ (skipped in code) | ✗ | ✓ | dead variable | — | MISSING (status exists in schema only) |
| MO close | ✗ | n/a (no handler) | schema only | — | — | MISSING |
| MO cancel | ✓ | ✓ FULL | ✓ | release reservations, closed/cancelled guards | backend code-verified | FUNCTIONAL BUT NOT TESTED |
| Work orders | ✓ | ✓ FULL | ✓ | transitions, overlap guard, time logs | ✓ start/pause/complete | **FULLY FUNCTIONAL — VERIFIED** |
| Job time logging | methods exist, no UI | ✓ | ✓ | duration math | ✗ (indirect via e2e) | PARTIAL |
| Shop floor | ✓ | ✓ | ✓ | start/pause/resume only | ✓ list | PARTIAL (no complete; silent errors) |
| Material reservation | auto on release + RPC | ✓ FULL | ✓ (ims_reservations) | availability, idempotency | ✓ implicit | **FULLY FUNCTIONAL — VERIFIED** |
| Material issue to WIP | ✓ (batch on MO detail) | ✓ FULL | ✓ ×2 movements | source stock, WIP=inTransit | ✓ | **FULLY FUNCTIONAL — VERIFIED** |
| Material consumption | ✓ | ✓ FULL | ✓ ×2 + rollup | WIP stock check, costing | ✓ | **FULLY FUNCTIONAL — VERIFIED** |
| Backflush consumption | checkbox only | ✗ unenforced | — | none | — | MISSING |
| Material return from WIP | ✗ no button | ✓ FULL | ✓ | transfers | ✗ | FUNCTIONAL backend, unused |
| WIP register/valuation | ✓ register | ✗ stub | table unused | none | ✓ register (empty) | **UI ONLY / stub** |
| Quality control | ✓ register | ✗ stub | table unused | none | ✓ register (empty) | **MISSING** |
| QC gate before receipt | checkbox only | ✗ unenforced | — | none | — | MISSING |
| Scrap | register only | ✗ stub | table unused | none | ✓ | MISSING |
| Rework | register only | ✗ stub | table unused | none | ✓ | MISSING |
| Finished-goods receipts | ✓ dialog | ✓ FULL | ✓ + IMS | over-receipt guard, idempotent, negative-stock forbidden | ✓ | **FULLY FUNCTIONAL — VERIFIED** |
| Production costing | register only | ✓ FULL | ✓ | variance, unit cost | ✗ no write UI | PARTIAL (write path orphaned) |
| Cost → GL | ✗ | ✗ by design (documented) | — | — | — | MISSING (owned by future finance) |
| Maintenance | register only | ✗ stub | table unused | none | ✓ | MISSING |
| Subcontracting | register only | ✗ stub | table unused | none | ✓ | MISSING |
| Lot genealogy / traceability | ✗ no page | ✗ inline `[]` | table unused | none | — | MISSING |
| MPS | register only | ✗ stub (runMps empty transaction) | table unused | none | ✓ register; runMps dead code | MISSING |
| MRP | register only | ✗ **fabricated success** | tables unused | none | ✓ live fake-success probe | MISSING (misleading stub) |
| Replenishment → purchase requisitions | ✗ | ✗ | — | none | — | MISSING |
| Reports | ✓ | ✓ 25 specs | ✓ reads all tables | totals, limits | list ✓; execution NOT RUNTIME VERIFIED | FUNCTIONAL (approximation reports flagged) |
| Dashboard | ✓ | ✓ MOST | ✓ reads all tables + audit_log | utilisation placeholder | ✓ fresh-DB display | FUNCTIONAL with known gaps |
| MMS config | ✓ | ✓ FULL | ✓ | 5/7 policies unenforced | render ✓; save NOT RUNTIME VERIFIED | PARTIAL |
| Audit trail | (analytics recent activity) | ✓ 26 recordAudit calls | ✓ `audit_log (module='manufacturing')` | — | ✓ e2e exercised indirectly | FUNCTIONAL |

MMS+IMS integration summary (per feature): shared products / stock availability / reservations / issues / consumption / finished receipts / ledger — **implemented & verified**; batch tracking — **partial**; serials — **untouched by MMS**; production cost roll-up into SKU — **misleading (no true cost)**; requisitions — **missing**; MMS-side negative-stock policy — **cosmetic**.

---

## 11. End-to-End User Journey (18 steps)

Verified against: e2e test 2 (steps 1–16 were effectively executed against a live app + real database), plus code inspection for each step. Stock was purchased via the IMS purchase-invoice path as in the e2e.

| # | Step | Verdict | Notes |
|---|---|---|---|
| 1 | Create product in IMS | **AVAILABLE AND VERIFIED** | ims products module; e2e creates products via RPC |
| 2 | Create BOM in MMS | **AVAILABLE AND VERIFIED** | "New BOM" dialog; `mms.boms.save`; e2e |
| 3 | Add raw-material components | **AVAILABLE AND VERIFIED** (RPC); "Add Component" dialog NOT RUNTIME VERIFIED | `mms.bomComponents.save` |
| 4 | Approve BOM | **AVAILABLE AND VERIFIED** | row/dialog button; e2e |
| 5 | Create Manufacturing Order | **AVAILABLE AND VERIFIED** | dialog filters approved BOMs; planned cost snapshot |
| 6 | Run MRP | **MISSING** | `mms.mrp.run` returns fabricated success, no data; **no UI button exists** |
| 7 | Check material availability | **AVAILABLE AND VERIFIED indirectly** (auto at release); **no standalone availability screen** | release refuses: "Insufficient components to release: …" — verified in e2e code path (`availableQuantity` reads used); refusal message tested in e2e |
| 8 | Reserve materials | **AVAILABLE AND VERIFIED** (auto on release) | only automated reservation path exists |
| 9 | Release MO | **AVAILABLE AND VERIFIED** | e2e + button |
| 10 | Generate work orders | **AVAILABLE AND VERIFIED** (auto on release) | first op ready, rest blocked; requires routing with operations |
| 11 | Start shop-floor operation | **AVAILABLE AND VERIFIED** | WO start (+ pause/resume); Shop Floor card works but is error-silent |
| 12 | Record material consumption | **AVAILABLE AND VERIFIED** | "Consume Materials" batch on MO detail; verified ledger decrement |
| 13 | Complete production | **AVAILABLE AND VERIFIED** | WO Complete dialog roll-up → MO `qualityReview` |
| 14 | Perform Quality Check | **MISSING** | no QC recording exists anywhere (stub); MO can pass to `qualityReview`/receipt without QC |
| 15 | Post finished goods | **AVAILABLE AND VERIFIED** | Receive dialog; e2e receipt + ledger readback |
| 16 | Verify stock in IMS | **AVAILABLE AND VERIFIED** | e2e readback via `products.get`: finished +100 units, raw −10 units |
| 17 | Calculate production cost | **PARTIALLY WORKING / effectively blocked** | planned cost snapshot exists (per BOM explosion); actual cost **cannot be recorded from any UI** (no write UI for cost records; labor/machine/overhead never posted); variance always vs. material-only baseline; receipt uses product's current average cost, not the MO cost |
| 18 | View production reports | **AVAILABLE AND VERIFIED partially** | Reports page exists with 25 real SQL reports; run-with-data NOT RUNTIME VERIFIED; several reports read never-populated stub tables |

**The first hard block for a real user: Step 6 (Run MRP)** — nothing to click, and even the RPC is a fake success. However, a user can bypass MRP entirely and reach Step 16 (the stock path works). The journey then **breaks irrecoverably at Steps 14 + 17**: quality checks cannot be recorded (so the "Require quality check before finished-goods receipt" policy is a placebo), material/scrap/labor cost records cannot be entered from the UI, and actual production cost cannot be assembled. In short: **the flow works from BOM → stock receipt, but quality and costing pipelines are one-way stubs.**

---

## 12. UI/UX Problems (precise)

1. **Dead create dialogs (worst offender):** "Create Route" and "Create Work Center" dialogs render normal-looking forms whose Save silently discards input (routes: RoutesPage.tsx:104–115; work centers: WorkCentersPage.tsx:117–124). Nothing indicates failure — no toast, no persistence. Runtime-verified. Their row edit icons are likewise dead (`onClick={() => {}}`, RoutesPage.tsx:45, WorkCentersPage.tsx:57).
2. **Banner-of-shame pages (8):** MPS, MRP, Maintenance, WIP, Quality, Scrap, Rework, Subcontracting — user-facing pages stating their own backend isn't implemented. Costs: half of the production-control section is unusable, yet Navigation offers it with confidence.
3. **MmsCollectionPage dead action machinery:** a fully styled action button + mutation + error banner that is unreachable because no view defines `action` (MmsCollectionPage.tsx:271–285); comments even describe actions ("running MRP", "recording a maintenance request") that do not exist.
4. **Shop floor silent failures:** start/pause/resume have no `.catch` and no refetch (ShopFloorPage.tsx:68–77); a failed action looks like "the button didn't do anything".
5. **Dashboard error conflation:** any `mms.dashboard` failure renders as "No manufacturing data available." (MmsDashboardPage.tsx:46) — no error state on the module's most prominent page.
6. **"New Issue"/"New Receipt" buttons navigate away** instead of opening forms (MaterialIssuesPage.tsx:54–61, FinishedReceiptsPage.tsx:70–77) — a surprising pattern for a button∷dialog convention elsewhere.
7. **No MO "Confirmed" stage anyway:** release writes `'released'` directly while computing a `confirmed` status that's then discarded (manufacturingOrders.ts:639–642); status column can never show "confirmed" despite schema support.
8. **Cannot create/edit:** cost records (no UI at all), equipment (read-only despite FULL save handler), route operations outside e2e, WO manual creation (handler-only), time logs (handler-only), BOM component deletion (handler-only, no UI trash icon), bookkeeping steps like MO close.
9. **Reports numbers can be wrong-style:** OEE/utilization reports approximate with duration sums; `productionYield` places rejected qty under a column named Cost (analytics.ts:663).
10. **Navigate paths that 404-redirect:** `MMS_PATH.planningCapacity` — no route (falls to catch-all → redirects to `/`), and two unused detail path constants for route/working-order detail that cannot be opened.
11. **No MMS shortcut on mobile bottom nav** (DOCK_PATHS excludes /mms entirely).
12. **Not-empty "recipes" behind BOM model:** recipes page reads BOMs of type recipe but there is no "New Recipe" button — NYI discoverability risk.
13. **Permission quirk:** operational pages correctly gate by can(manufacturing, edit/create/cancel) — no incorrect permission gating found in MMS itself; the wider app's `payments` vs `finance` module mismatch doesn't apply to MMS.
14. **Stub-tables read by live reports/dashboard:** even a fully exercised production pipeline leaves WIP/quality/scrap/rework/genealogy sub-reports at permanent 0 — zoomed-in dashboards will under-report silently.

Note that none of these findings required changing data: no destructive operations were executed; the app instance used a disposable temp data dir.

---

## 13. Overall Assessment

**The MMS module is roughly split down the middle: the production-execution spine is real, and everything adjacent to it (planning, quality, cost assembly, traceability, subcontracting, maintenance) is scaffolding.**

- **The spine that works (runtime-verified):** BOMs → approval → MOs → release with material reservations → work orders → start/pause/complete → material issues to WIP → consumption → finished-goods receipts → the IMS stock ledger reflected correctly in stock on hand. This is singularly the valuable, sellable core and it is in solid shape: idempotency keys, transactional posting, over-receipt guards, negative-stock hard-prohibition, audit records, real error surfacing (except Shop Floor).
- **Backend-only deadweight:** 26 production tables are provisioned, but ~10 (bom_versions, wip_records, quality_checks, scrap, rework, maintenance_requests, subcontract_orders, mps_plans, mrp_runs + mrp_requirements, genealogy_links) can never receive a row through any UI or RPC handler existing today, and older repo documents claim some of these are "fully implemented" — they are not.
- **Backend FULL but the UI disconnected:** routes, work centers, equipment, cost records, returns-from-WIP — their handlers exist but the interface can't reach them (dead dialogs and missing buttons).
- **Nothing engine-shaped:** MPS, MRP, yield calculations, OEE/utilization, lot genealogy/backflush/tracing — all declared but stubbed, with MRP going so far as reporting fake success.

**Honest feature→verdict matrix:** of 30 major features audited above, ~8 are fully implemented and runtime-verified; ~9 exist as fully implemented backends with non-functional or missing UI; ~11 are deliberate stubs (UI warns users where it appears); negligible "broken" (Routes/Work Centers dialogs count as broken UI).
- **Test coverage:** ~21% of the MMS surface (e2e for the production pipeline, navigation, dialogs; zero unit coverage of repository code; zero coverage of page-*state* visual design; no e2e for quality/сountry/scrap/rework/planning pages since they are stubs).
- **The user can currently successfully manufacture something end-to-end** (thanks to the e2e path) but cannot run it through QC, cannot feedback actual labor/machine/overhead costs, and cannot ask the system to plan for them. The next layer of value is fully laid out but unbuilt: the stub layer in §8 is the work map.

**Confidence methodology for the estimates above:** classification counts derive from row-level audit of §5/§9/§10 tables against the code at this commit; the "1 of 7 policies enforced" figure and the table counts (26 created in migration 25) were counted directly from `src/main/repositories/mms/*` and `src/data/migrations/index.ts` line-referenced items; no other percentage is claimed.

---

*All file references are to code paths inside this repository at the audit commit; screenshots under `docs/mms-verify/` are newly captured artifacts of the runtime walkthrough on 2026-11-07. Prior repo reports `docs/MMS_FUNCTIONAL_COMPLETION.md` and `docs/MMS_IMPLEMENTATION_REPORT.md` contain claims that were found false in this audit (notably MPS/MRP "fully implemented" and "VERIFIED COMPLETE" stage labels for unenforced policies); this document should be treated as the authoritative current state.*
