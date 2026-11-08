# UI Redesign Specification: Compact, Dense, Professional

## Overview
Redesign the entire UI to match the density and professionalism of Zoho Books, Stripe Dashboard, and QuickBooks. Keep dark teal brand and sidebar. Use CSS variables/tokens only. Apply to EVERY page.

---

## 1. Global Density (Most Important)

### Typography
- **Base font size**: 14px (was 16px)
- **Table text**: 13px
- **Labels/hints**: 12px
- **Page title**: 18px semibold (was 24px)
- **Section/card titles**: 14px semibold (was 16px)
- **KPI value**: 22px semibold tabular-nums
- **KPI label**: 12px secondary color
- **Delta pill**: 11px
- **Sidebar menu items**: 13.5px

### Spacing Scale (4px base)
- **Page padding**: 20px (was 24px)
- **Gap between cards**: 16px (was 24px)
- **Card padding**: 16px (never more than 20px, was 20px/32px)
- **Top bar height**: 56px (was 64px)
- **Sidebar width**: 232px (was 260px)
- **Sidebar collapsed**: 64px (was 72px)
- **Menu item height**: 38px (was 44px)
- **Sidebar icon size**: 18px (was 20px)
- **Sidebar gaps**: 4px (was 8px/12px)

### Controls
- **Buttons**: 34px tall (was 40px)
- **Inputs/Selects**: 36px tall (was 40px)
- **Icon buttons**: 32px (was 40px)

### Radius & Shadows
- **Radius**: 8px for cards/inputs/buttons (was 12px)
- **Shadow**: Very light only `0 1px 2px rgba(0,0,0,0.05)` - rely on 1px borders for separation
- **Border**: 1px #D3DDDD on cards

### Tables
- **Row height**: 40px (was ~50px)
- **Header height**: 36px
- **Text**: 13px
- **Numbers**: Right-aligned, tabular-nums

### Window Sizing
- **Default BrowserWindow size**: 1280x800
- **Min width**: 1100px
- **Min height**: 650px
- **Test at**: 1366x768 AND 1920x1080 AND Windows 125% scaling
- **Constraint**: Dashboard KPI row + first chart visible without scrolling at 1366x768

---

## 2. KPI / Stat Cards (Compact with Mini Graph)

### Card Specs
- **Height**: ~92-100px
- **Padding**: 14px 16px
- **Background**: White
- **Border**: 1px #D3DDDD
- **Radius**: 8px
- **Layout**: ONE ROW of 5 cards on dashboard

### 5 KPI Cards (Dashboard)
1. Sales Today
2. Sales This Month
3. Purchases
4. Expenses
5. Net Profit (admin only)

**Low Stock** → Small alert chip in page header (not a KPI card)

### Card Internal Layout
```
┌─────────────────────────────────────────────┐
│ Label (12px, muted)          ● Icon (16px)  │
│                                             │
│ Rs 12,450.00              ┌─────────────┐  │
│ (currency 12px, value 22px)│  SPARKLINE  │  │
│                             │  110x36px   │  │
│ ▲ 12.4% vs last month       └─────────────┘  │
│ (11px pill, tinted bg)                      │
└─────────────────────────────────────────────┘
```

### Sparkline (Recharts AreaChart)
- **Size**: 110x36px
- **No axes, no grid, no tooltip**
- **Line**: Dark teal 1.5px
- **Area fill**: Very light teal (rgba)
- **Data**: Last 30 days or last 6 months of that metric
- **Expenses**: Amber/grey
- **Profit**: Green
- **Empty data**: Flat dashed line (not broken chart)

### Delta Calculation
- Compute vs previous equal period from real data
- Show "—" when no previous data
- Format: "▲ 12.4%" green or "▼ 3.1%" red

---

## 3. Dashboard Layout (12-Column Grid)

### Row 1: KPI Cards (5 cards)
- 5 cards spanning full width (~2.4 cols each)

### Row 2: Charts
- **Left (8 cols)**: "Sales vs Expenses" card
  - Recharts Area/Bar combo, last 6 months
  - Height: 260px
  - Dark teal for sales, grey for expenses
  - Light dashed grid
  - Small legend top-right
  - Range toggle (6M / 12M) in card header
- **Right (4 cols)**: "Sales by Category" donut chart
  - Teal shades + grey
  - Center total
  - Compact legend list below

### Row 3: Tables/Lists
- **Left (8 cols)**: "Recent Invoices" table
  - Last 8, compact
  - Status pills
- **Right (4 cols)**: Two sections stacked
  - "Low Stock" list: product, stock vs min with thin progress bar, red when below min
  - "Top 5 Products" mini horizontal bars

### All Cards
- Compact header: 48px height
- Title left, small ghost action ("View all") right
- 1px divider under header

---

## 4. List Pages (Sales, Purchases, Products, Customers, Suppliers, Expenses)

### Toolbar (Inside Same Card)
- Search box: 260px wide
- 1-2 filter selects
- Date range picker
- Primary "+ New" button on right
- All in one compact row

### Summary Strip (Above Table)
- 3-4 inline stats in ONE LINE (NOT big cards)
- Example: "Total sales: Rs x | Paid: Rs x | Due: Rs x | 48 invoices"
- 13px text, muted separators

### Table
- Sticky header
- Sortable columns
- Row hover tint
- Status pills: Paid (green), Partial (amber), Unpaid (red), Cancelled (grey)
- Row actions: Icon buttons (view, print, more)
- Row height: 40px

### Pagination Footer
- Height: 36px
- Rows per page + page numbers

### Create/Edit Forms (Invoice, Purchase)
- Two-column layout
- Items table with inline editable rows:
  - Product combobox
  - Qty
  - Price
  - Discount
  - Line total
- Compact totals panel on right:
  - Subtotal, Discount, VAT, Total, Paid, Balance
- Keyboard-friendly

---

## 5. Reports Page

### Left Filter Bar
- Date presets + custom range
- Compact, sticky or sidebar-style

### Main Area
- Compact P&L table
- Small bar chart
- Partner Split section as clean 3-row card:
  - Donation 2%
  - Partner 1 49%
  - Partner 2 49%
  - Amounts + thin stacked bar showing split
- Export CSV / PDF buttons in card header

---

## 6. Polish Details

### Colors
- **Page background**: #EEF2F2
- **Cards**: White with 1px #D3DDDD border
- **Icons**: Lucide 16-18px, stroke 1.75
- **Muted colors**: Use color only for meaning (status, positive/negative)

### Numbers
- **tabular-nums** everywhere
- **Negative amounts**: Red with minus sign
- **Zero**: Muted dash (—)

### Empty States
- Small icon + one line + action button
- NO giant illustrations

### Loading
- Skeleton loaders instead of spinners on first load
- Smooth 150ms hover transitions only

### Visual Polish
- No oversized headings
- No gradients except subtle sparkline area fill
- No decorative blobs
- Consistent 8px radius
- Consistent 1px borders

---

## 7. Files to Change

### Core Styles & Tokens
1. `src/renderer/styles.css` - CSS variables, base styles, card/component classes
2. `tailwind.config.ts` - Tailwind theme tokens

### Layout Components
3. `src/renderer/components/layout/AppShell.tsx` - Page padding, content width
4. `src/renderer/components/layout/Sidebar.tsx` - Width, item height, fonts
5. `src/renderer/components/layout/Topbar.tsx` - Height, title size

### UI Components
6. `src/renderer/components/ui/Card.tsx` - Padding, radius, header height
7. `src/renderer/components/ui/Button.tsx` - Heights (34px md, 30px sm, 28px icon)
8. `src/renderer/components/ui/Input.tsx` - Height 36px, radius 8px
9. `src/renderer/components/ui/DataTable.tsx` - Row height, header height, font sizes
10. `src/renderer/components/ui/Dropdown.tsx` - Pagination height, menu sizing
11. `src/renderer/components/ui/Feedback.tsx` - Skeleton, EmptyState, PageHeader sizes
12. `src/renderer/components/ui/Badge.tsx` - Size adjustments

### Pages
13. `src/renderer/pages/Dashboard.tsx` - Complete KPI redesign + grid layout + charts
14. `src/renderer/pages/sales/DocumentListPage.tsx` - Toolbar, summary strip, table
15. `src/renderer/pages/purchases/PurchaseListPage.tsx` - Same as sales
16. `src/renderer/pages/inventory/ProductsPage.tsx` - Toolbar, summary, table
17. `src/renderer/pages/parties/PartiesPage.tsx` - Toolbar, summary, table
18. `src/renderer/pages/finance/ExpensesPage.tsx` - Toolbar, summary, table
19. `src/renderer/pages/ReportsPage.tsx` - Filter bar, P&L, partner split
20. `src/renderer/pages/sales/SalesEditorPage.tsx` - Compact form layout
21. `src/renderer/pages/purchases/PurchaseEditorPage.tsx` - Compact form layout

### Main Process
22. `src/main/window.ts` - Window default/min sizes

### Charts (New Components)
23. `src/renderer/components/charts/Sparkline.tsx` - New reusable sparkline
24. `src/renderer/components/charts/SalesExpenseChart.tsx` - Sales vs Expenses chart
25. `src/renderer/components/charts/CategoryDonut.tsx` - Sales by category donut
26. `src/renderer/components/charts/MiniBars.tsx` - Top products mini bars

---

## 8. Implementation Order

1. **CSS Variables & Tailwind** - Foundation tokens
2. **Layout Shell** - Sidebar, Topbar, AppShell
3. **UI Primitives** - Card, Button, Input, DataTable, Feedback
4. **Chart Components** - Sparkline, SalesExpenseChart, CategoryDonut, MiniBars
5. **Dashboard** - KPI cards + grid layout
6. **List Pages** - Toolbar, summary strip, tables
7. **Reports Page** - Filters, P&L, partner split
8. **Editor Pages** - Compact forms
9. **Window Config** - Default/min sizes
10. **Verification** - Test at required resolutions