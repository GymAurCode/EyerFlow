# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
semantic versioning.

## [Unreleased]

## [1.0.0] - 2026-10-24

### Added

- **The application tells you when there is a newer version.** Shortly after it
  starts, EyerStock looks on the publisher's release page and compares the
  version it is running with the newest one published. When there is one, a
  notification appears with the version on offer; the dialog that follows
  downloads the installer, shows its progress and installs it - closing the app
  and starting it again. Nothing is downloaded and nothing is installed until
  the user asks for it, and the same thing can be done by hand under Settings >
  About > Updates. The update never touches the shop's data: the installer's
  uninstall step recognises an update and leaves the data folder alone.

### Fixed

- **The "Create invoice" and "Create purchase" buttons are reachable again.** The
  sale and purchase dialogs sized their scrolling body against a fixed
  allowance for the header and the footer, which was smaller than the real
  footer - a totals panel, an error line and the buttons. The panel grew past
  its own height, the footer was clipped away, and the button that saves the
  document sat below the fold with nothing to scroll to. The dialog is now a
  column: the header and the footer keep their own height, and the body takes
  whatever is left and scrolls inside it, so the totals and the button stay on
  screen at every window size.
- **A payment can no longer be larger than what is owed.** The Update Payment
  button appears on a purchase or a sale only while a balance is outstanding,
  the amount may not exceed that balance, and the rule is checked again by the
  server inside the transaction that writes the payment - so a second click, a
  second window, or a tampered request cannot overpay either. The message says
  what the balance is: "Payment cannot exceed the outstanding balance of
  Rs 4,000.00." A payment of nothing, of a negative amount, or of an amount
  that is not a number is refused. The payment history keeps every payment that
  was made, and the invoice's status and the party's balance follow the
  payments that are recorded. A payment may not be set against an invoice that
  belongs to somebody else, and money received may not be set against a
  purchase.
- **The partner split is 49% / 49% with a 2% donation, and it adds up to
  100%.** A partner's share is now a percentage of the net profit rather than
  a weight on what was left after the donation, so the report no longer shows
  "50%" next to an amount that was 49% of the profit - which is where
  "50% to each partner and nothing for the donation" came from. The donation
  and the partners' shares are percentages of the same net profit and have to
  come to 100% between them; a partnership that does not add up is reported
  rather than given money that is not there, and a partner whose share would
  push the split over 100% is refused. The two percentages in Settings that
  were never used by anything have gone: each partner's share now lives with
  the partner. A partnership with no partners is seeded with two partners at
  49% each, so the split works from the first day.
- **The split is written down when a period is closed.** Closing an accounting
  period records each partner's share and the part of the donation that partner
  bears, in the partnership's own ledger, once per period - so the donation is
  calculated, recorded and never written twice. The recorded splits are shown
  in Settings.
- **A payment recorded through Finance now reaches the ledger.** A receipt or a
  payment taken through Finance > Payments was written to the business records
  but never posted to the journal, so the cash balance on the dashboard and in
  the cash book was short by exactly what had been taken.
- **A refund to a customer is now part of what they owe.** Money given back
  was left out of the customer's balance, so a customer who had been refunded
  was shown as owing less than they did.
- **Transfers between the till and the bank no longer inflate the cash flow
  chart.** A transfer is money moving between two of the shop's own accounts,
  not money received from outside, and it was counting as both.
- **The end-to-end tests date their records by the shop's own day.** They used
  the UTC date while the application dates a record by the local one, so in
  Pakistan a sale recorded "today" landed yesterday for five hours every
  evening and the dashboard showed nothing for it.

### Added

- **Update Payment on a purchase or a sale.** The button is on the document
  and on its row, and only while money is still owed. The dialog shows the
  outstanding, the total and what has been paid, and starts at the balance.
- **The recorded partner splits**, shown in Settings so the donation that has
  been set aside can be seen rather than inferred.

### Removed

- **Every currency but Pakistani Rupees.** The currency is a fact about the
  shop, not a choice: the setting, the setup wizard and the money input now
  say PKR and cannot be changed, and there is no AED or USD anywhere in the
  interface, the reports, the exports or the printed documents. Amounts are
  written by one formatter, so every screen, PDF and CSV says "Rs 1,500.00"
  the same way. No stored amount was converted: the amounts in the database are
  plain integers with no currency attached to them, so the only thing that
  changed is the label.

### Changed

- **The Finance dashboard shows six figures.** Cash & Bank Balance, Accounts
  Receivable, Accounts Payable, Total Income, Total Expenses and Net Profit,
  in one grid. The separate cash and bank figures, the gross profit, the stock
  value and the working capital are gone - the first two repeated what the
  cash card said and the last two were numbers the shop has to look up
  somewhere else. The charts, the aging summaries and the period selector are
  still there.

### Fixed

- **The installed application no longer opens on a blank window.** A packaged
  build serves its renderer out of the asar archive, and the Electron fuse
  `grantFileProtocolExtraPrivileges` was switched off, which stops the `file:`
  protocol from reading files inside an archive. The main process could still
  read them - the application started normally and logged that it had - but the
  renderer could not load its own page, so the window came up empty with no
  error anywhere. The fuse is on again, which the application needs: the
  renderer only ever loads the bundle the application itself ships, and the
  Content-Security-Policy still refuses every remote origin.
- **The theme is now applied before the first paint in a packaged build.** The
  script that puts the light or dark palette on the page was referenced by the
  renderer but never copied into the build, so a launch always started on the
  light palette and snapped to the dark one a moment later.
- **A window that cannot load its renderer now says so.** The failure is
  written to the log and the empty window is replaced by a page that explains
  what happened, rather than a blank white one.
- **The Content-Security-Policy response header is no longer added to
  `file:` responses.** A packaged build loads its renderer from disk, where
  the `<meta>` tag in `index.html` is the policy that governs it; the header
  only ever mattered for a document served over http.

### Added

- **The Chart of Accounts is now a master-detail screen.** The left panel is
  the chart itself - the five categories, the accounts under them, folded the
  way a filing cabinet is - with a search over the code and the name, a type
  filter, and an Add Account button. The right panel is the account that is
  selected: its name, code, type, parent and status, its balance, its period
  activity, and its transaction history, in three tabs (Overview, Transaction
  History, Account Information). A category shows the total of the accounts
  inside it; an account shows the balance that was posted to *it*, and says so
  when its sub-accounts add up to something different.
- **An account's transaction history.** The journal lines that touched the
  selected account, in date order, with a running balance carried along the
  same way the General Ledger carries it, and a reference that opens the entry
  behind the line. It is the General Ledger's own data, so the two screens
  cannot tell different stories about the same account.
- **"View Ledger" hands the account and the period over** to the Account
  Ledger, which now opens with that account and that range already chosen,
  and offers a way back to the chart with the same account still selected.

### Changed

- **The sign-in screen is now a split screen.** The left half is Eyercall's
  own: the mark in a glass chip, the company name, the headline "Smarter
  Inventory. Clearer Decisions.", a line about what the product does, the three
  things it is good at - inventory and stock control, sales and purchase
  management, financial insights and reporting - and "Powered by Eyercall" at
  the foot. It is a deep navy panel with one soft light, a faint ledger ruling
  and a block of boxes drawn in outline (the mark on the logo is a box, and
  boxes are what the software counts), all of it in the green of the Eyercall
  mark. The right half is the form: "Welcome back", the two fields, and the
  button, in the app's own glass. On a narrow window the panel becomes a slim
  brand bar so the logo, the product and the form all stay reachable, and
  nothing scrolls sideways.
- **The sign-in form gained a show/hide password toggle, a reserved home for
  its error message and a proper entrance.** The toggle is a real button, so
  it is reachable by keyboard and announces its own state; the error lands in
  a slot that is the same size whether the message is there or not, so a
  rejected sign-in never moves the button under the pointer; and the two
  panels arrive with a short, compositor-only movement that the
  authentication call is never held back for. The sign-in name, the password,
  the service that checks them, the lockout policy and the session afterwards
  are all exactly what they were.
- **Change password was removed from the top profile menu.** The account menu
  duplicated the Profile page, which is where the password actually lives; the
  menu now holds Profile and Sign out (and Renew licence when the licence is
  about to expire), and the Profile page's own Change password button is
  untouched.

### Fixed

- **Dropdowns are themed in the dark palette.** A native `<select>` paints its
  option list with the operating system's own colours, which no design token can
  reach, so every filter, category picker, status picker, currency picker and
  unit picker came up white-on-white in the dark theme. All of them now use one
  shared themed listbox (Radix, portalled, capped at 280px with the app's own
  scrollbar, 36px rows, a check on the selected row, `--brand-soft` on
  highlight and `--text-3` on disabled rows). The product category field's
  `<datalist>` became clickable category chips for the same reason, and toasts
  take their colours from tokens instead of Sonner's own palette. Keyboard
  selection, type-ahead and Escape all behave as they did.
- A document can no longer be saved with more paid against it than it is worth.
  The sale and purchase dialogs now say so inline, disable Save, and offer
  "Full amount" and "Mark unpaid"; the balance is floored at zero rather than
  shown negative; and the totals panel states Paid / Part paid / Unpaid in
  words. Money beyond the bill is a credit on the party's account, not a
  payment against the invoice.

### Changed

- **The header is now a single floating pane of glass.** The search field, the
  low-stock alerts, settings, the theme switch and the account menu all sit
  inside one rounded container that sticks to the top of the page, and the blur
  belongs to that container rather than to each control. It is rendered inside
  the page's scroll container so that `position: sticky` has the real page as
  its constraint and the tables, cards and rows passing under it are what the
  `blur(20px)` is picking up. Light and dark use the same construction - a
  translucent white surface over a cool-grey page, a translucent deep-navy
  surface over the dark page - and every control behaves exactly as before,
  including search, the shortcut hint, the alert count, settings, the theme
  switch and the account menu.
- The interface was redesigned as a minimal, neutral "3D liquid glass"
  product.** The sidebar is now a floating, rounded, frosted pane inset from the
  window edge instead of a dark slab, in the light theme as well as the dark
  one; the top bar is a row of floating glass controls (search pill, alert,
  settings, theme, account) rather than a full-width band; the page is a single
  cool value with one neutral lift and one neutral shade, with the coloured
  ambient lights and the decorative glass spheres removed entirely. Cards,
  tables, dialogs, menus, forms and charts all pick their surface from the same
  four elevation levels, and colour is spent on actions, statuses and small icon
  accents only - no panel is filled with one. The dashboard follows the same
  shape: four KPI tiles, a Recent Products table with status and row actions, a
  Stock Overview ring with its category legend, Quick Actions, and a status
  strip. Light and dark are the same construction with different values, the
  theme switch still writes the stored preference, and every figure on every
  screen still comes from the live database.
- The application logo is now the artwork in `assets/Logo.png`. The installer,
  desktop shortcut, taskbar and title-bar icons, the sidebar, the splash screen
  and the setup and sign-in headers all show it, where previously the installer
  icon and the in-app mark were two unrelated procedurally drawn teardrops.
  `npm run icons` regenerates `build/icon.ico` from the artwork (no image
  dependencies - the ICO wraps the PNG directly) and `npm run dist` runs it, so
  replacing the file and rebuilding refreshes every surface.

### Fixed

- A missing preload bridge no longer poisons every screen with "Cannot read
  properties of undefined (reading 'invoke')". The renderer's RPC helper
  touched `window.api` directly instead of going through the guarded accessor
  that exists for this case, so when the bridge is absent - the app opened in
  a plain browser, or the main process died before the window was built - each
  call surfaced a useless TypeError. Calls now go through the guard, and a
  startup check shows one recovery screen naming the cause and the ways out.

## [0.2.0] - 2026-10-10

Phase 2: the product. Every feature screen from the brief is built, the schema
grew to 17 migrations, and the defects listed under 0.1.0's limitations are
closed.

### Added

- A **Developed by** credit, defaulting to Eyercall. It appears on the sign-in
  panel, on the About page and in the footer of every printed document, and is
  editable in Settings so a distributor can resell under their own name. Clearing
  the field removes the line entirely rather than printing a dangling label, and
  the value is escaped so it cannot inject markup into a printed document.

**Feature screens**

- Sales and purchase editors, list screens, document detail, quotations,
  delivery notes, credit notes, purchase returns, stock adjustments.
- Customer and supplier ledger with statements, aging, print.
- Receive Payment and Make Payment with partial allocation and an
  auto-allocate action.
- Post-dated cheque register with mark-cleared and mark-bounced, plus dashboard
  reminders for cheques falling due in the next seven days.
- Expenses, VAT report, profit and loss, stock valuation, reports.
- Partner accounts, period closing statement, and the period-lock screen.
- Warranty and serial-number lookup, "expiring soon" list, claim logging.
- Service contracts, service visits, filter replacement schedule with due-this-week
  and due-this-month views, printable reminders and WhatsApp click-to-chat.
- Installation records, with edit and delete.
- Product kits screen, and kits are now sellable: choosing one on a sales line
  expands it into its component lines with the kit price apportioned by cost.
- Users, custom roles with a permission matrix, audit log viewer, backup and
  restore, settings, About.
- Barcode labels screen: tick products, print Code 128 labels three per A4.
- USB scanner support on the sales screen. A HID scanner's key burst is detected
  and the product is added to the document.
- Excel/CSV import wizard with a row-by-row validation preview and an explicit
  commit step. Files are chosen through a main-process picker that only accepts
  a purpose, never an arbitrary path.
- Offline licence screen: enter a key, see the machine ID it must be issued
  against, and toggle the licence check, which is off by default.

**Printing**

- Bilingual English/Arabic tax invoice, receipt, statement, partner closing
  statement, service reminder and barcode labels, all in the teal-on-white
  identity and legible in black and white.
- Direct print and save-as-PDF, on A4 or an 80 mm thermal roll.
- UAE e-invoicing QR field, generated from seller TRN, invoice number, date,
  total and VAT. Documented as prepared, not certified.
- Configurable company logo, printed on every document. Main inlines the chosen
  file as a data URL because printed documents render in a sandboxed window with
  no filesystem access.
- Configurable invoice footer and terms.

**Interface**

- Full teal-on-white design system as tokens, light and dark, with a
  `/design-system` page showing every component in every state.
- English/Arabic with RTL mirroring throughout, using CSS logical properties so
  no component has a hand-written RTL variant.
- Sidebar with grouped sections and an icon-only collapse; top bar with page
  title, breadcrumbs, global search, notifications, language and theme.
- Command palette (Ctrl+K) over every screen, permission-filtered.
- Ctrl+N new sale, Ctrl+P new purchase, Ctrl+S save.
- Skeleton loaders, empty states with an illustration and a primary action, toasts
  bottom-right, 150-200 ms transitions, reduced-motion respected.
- Virtualised table bodies above 150 rows, using a real `<table>` with spacer
  rows so the sticky header, sticky totals row and column layout are unaffected.
- Undo for destructive actions that are safe to reverse, offered in the toast.
  Actions that have already moved stock or money are not given one.

**Data safety**

- SQLCipher database encryption, with the key held by Electron `safeStorage`
  and bound to the Windows user account.
- `npm run native` builds the SQLite binding for both the Node and Electron
  ABIs and keeps them side by side, so `npm test` and `npm run dist` work in
  either order without a manual rebuild step.

### Fixed

- The sign-in and setup screens scrolled the whole window. Both now fill the
  viewport with no page scroll, and the long setup form scrolls inside its own
  column so the teal panel stays full height instead of sliding off the top.
- The water-drop illustration on the sign-in panel was scaled to cover the whole
  column and cropped through its own ripples, competing with the text beneath
  it. It is now a compact mark confined to the top of the panel, drawn to fit
  rather than to fill.
- **Backups of an encrypted database always failed.** The backup was taken with
  `db.backup(path)`, which opens the destination itself with no key; SQLite
  refuses to copy between a cipher database and a plain one, so every backup
  raised "backup is not supported with incompatible source and target
  databases". The automatic daily backup, the backup on close and the
  pre-migration safety backup were all silently failing — the app was
  reporting backups it had never made. Backups are now taken with
  `VACUUM INTO`, which writes through the same codec, so the result is
  encrypted with the same key and is still a consistent snapshot. Covered by
  `tests/encryption.test.ts`.
- **Upgrading from 0.1.0 appeared to lose all data.** 0.1.0 shipped an
  unencrypted database file. 0.2.0 applies a key on open, so that file became
  unreadable and the app refused to start with "the key file may belong to
  another machine". A plaintext database is now detected and converted in
  place, every row preserved, with the original kept beside it as
  `.plaintext-backup` and the replacement verified before anything is replaced.
- **The VAT report threw on any period containing a sale.** Its detail queries
  aliased columns as `net_fils`/`vat_fils`/`gross_fils` while the code read
  `netFils`/`vatFils`/`grossFils`, so every row summed as `undefined`, the
  totals became `NaN`, and the integer-money assertion rejected them. A shop
  could not run a VAT return at all. Covered by `tests/reports.test.ts`.
- `findModifiedMigrations` was written but never called: editing a migration
  that had already run on a shop's database went undetected. Startup now
  refuses to start rather than diverge a live database from a fresh one.
- An isolated run (an end-to-end test, or a second checkout) could not start
  while the real installation was open, and vice versa: Electron's
  single-instance lock is keyed on its own user-data directory, which the
  `MINHA_DATA_DIR` override did not redirect. The override now applies to that
  directory too, so a redirected instance touches nothing belonging to a real
  one.
- **The app exited with "Cannot create BrowserWindow before app is ready" on
  any machine that already had a database.** Startup ran from module scope with
  no `app.whenReady()` gate. It appeared to work on a fresh install only because
  the pre-migration backup is awaited, and that await happened to span enough of
  the event loop for Electron to finish starting; with nothing to await, the
  promise resumed in a microtask — still before `ready` — and the window could
  not be created. This is why it appeared only after a first successful run.
  Startup is now gated on `app.whenReady()`, and the ordering is asserted in
  `tests/startup-order.test.ts`.
- The "Your logo on invoices" feature was documented but did not exist.
- "Settings → Performance → virtualised tables" was documented but there was no
  such setting and no such screen.
- The backup screen documented a **Verify** button that was not on the page.
- The `/service/installations` route rendered a placeholder pointing elsewhere,
  although the backend for it was complete.

### Changed

- `npm run dist` no longer needs a manual `rebuild:electron` first.
- The uninstaller now **asks** whether to keep the shop's data and defaults to
  keeping it, via a custom NSIS macro. `deleteAppDataOnUninstall` can only ever
  be "always keep" or "always delete", never "ask".
- `npm run release:check` blocks a release with no code-signing credentials
  unless `MINHA_REQUIRE_SIGNING=false` is set deliberately, and checks that the
  changelog has an entry for the version being built.

### Added tests

- Encryption and backup round-trips: that a backup of an encrypted database is
  encrypted, readable with the same key, holds the same rows, and contains no
  plaintext of the data it copied; that a pre-encryption database is converted
  with every row and index intact; and that a genuinely wrong key still refuses
  rather than triggering a destructive conversion.
- Migration 17's table rebuild: every column, id and row preserved, indexes
  restored, foreign keys intact.
- Report-layer arithmetic, including the VAT report that was broken.
- A 50,000-row seed with wall-clock budgets, and `EXPLAIN QUERY PLAN` assertions
  that the hot queries use an index. A dropped index does not throw, so nothing
  else would have noticed.
- The e2e specs are type-checked as their own project rather than excluded.
- The vendor credit: it prints in English and Arabic, disappears when the name
  is cleared or blank, and escapes its input.

## [0.1.0] - 2026-10-09

Phase 1: application foundation. Financial core, schema migrations, backup and
restore, and a hardened Electron shell.

### Added

**Financial core (pure, fully unit tested)**

- Integer fils money arithmetic. No floating point is used for stored or
  computed money, removing binary rounding errors from VAT and profit.
- `allocateFils`: largest-remainder allocation so splits always sum exactly to
  the input, with no fils lost or invented.
- UAE VAT at 5%, computed per invoice line so returns and credit notes can
  reverse lines exactly. Zero-rated and exempt treatments supported.
- Net VAT payable, reporting negative (carry-forward credit) rather than
  clamping to zero.
- Weighted average cost for stock, with the cost recorded on each movement so
  a later return reverses at the original cost, not today's average.
- Gross profit and margin, safe on zero revenue and on loss-making lines.
- Sequential gap-free document numbers (`CN-0001`, `INV-0042`) with per-kind
  prefixes.
- Sales return / credit note and purchase return valuation.
- Return quantity guard against over-returning beyond the amount invoiced.
- Receivables and payables aging in 0-30 / 31-60 / 60+ day buckets, with
  payment terms applied before the clock starts.
- Party ledgers with running balance.
- Payment allocation across invoices, oldest first, holding any excess as an
  on-account credit rather than dropping it.
- Partnership closing: net profit, 2% donation taken off the top, then a 49/49
  split, balancing to the fils.
- Partner capital accounts and a closing balance verification.

**Data layer**

- Versioned migrations, append-only, 12 migrations covering parties, products,
  sales and purchase documents, stock movements, payments, post-dated cheques,
  serial numbers and warranties, service contracts, users and roles, audit log,
  partner accounts, period locks, settings, sequences and bundles.
- One transaction per migration: a failure rolls back to the last good version
  rather than leaving a half-applied schema.
- Refuses to open a database written by a newer build.
- Automatic verified safety backup taken before any migration runs. Startup
  aborts if that backup cannot be written.
- Migration safety test proving an existing v1 database upgrades with every
  row intact.
- Backups via SQLite's online backup API, which captures a consistent snapshot
  while the app is writing.
- Backup verification before restore: integrity check plus schema version
  check, and a refusal to restore a file made by a newer build.
- Restore takes a safety copy of current data first and swaps the file by
  rename, so a partial failure cannot destroy the live database.
- Configurable backup retention with oldest-first pruning.

**Electron shell**

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- Strict CSP: `default-src 'self'` with `connect-src 'none'`, reflecting that
  the app is fully offline.
- Navigation, redirects, `window.open` and `<webview>` all blocked. External
  links are handed to the OS browser only for `https:` and `mailto:`.
- All permission requests denied.
- Typed, validated IPC surface; the renderer gets a frozen API via
  `contextBridge` and never touches Node or the database.
- Single-instance lock, so two instances cannot fight over the database file.
- Rotating main-process logs, plus `Export diagnostics`.
- Backup on close and a daily backup setting.

**Packaging and quality**

- electron-builder NSIS installer, per-user install, desktop and Start Menu
  shortcuts, custom icon, choice of install directory.
- Uninstall leaves user data in place.
- Generated rather than committed icon artwork, reproducible from source.
- Strict TypeScript with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- ESLint with type-aware rules and `no-explicit-any` enforced as an error.
- Prettier.
- 156 unit tests covering all financial logic and the migration and backup paths.
- `db:inspect` script for manual verification of a database on a shop machine.

### Known limitations

Superseded by 0.2.0: this release is the foundation only, and the feature
screens, printing, localisation and encryption described in the brief were not
yet implemented.


[Unreleased]: https://example.invalid/minha-inventory/compare/1.0.0...HEAD
[1.0.0]: https://example.invalid/minha-inventory/releases/1.0.0
[0.2.0]: https://example.invalid/minha-inventory/releases/0.2.0
[0.1.0]: https://example.invalid/minha-inventory/releases/0.1.0
