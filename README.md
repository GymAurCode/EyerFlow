# Minha Inventory

Offline inventory, finance and service management for water purification
businesses in the UAE. Electron + React + SQLite, 100% local: no internet
connection is required or made at any point.

## What this is for

A small RO-filter and purifier business needs more than a sales screen. It needs
to know which customer still owes money, which post-dated cheque is due Friday,
which customer's filter is due, what a unit cost when it was sold, and how the
two partners split the month's profit. This app answers those questions on a
shop counter, offline, on one Windows PC.

## What it does

### Sales and purchases

- Invoices, quotations, delivery notes, credit notes, purchase invoices and
  purchase returns, all with sequential numbering and status tracking.
- Convert a quotation to an invoice; raise a credit note against an issued
  invoice; print a delivery note.
- Product kits (a 5-stage RO kit built from parts) are sold as one priced line
  that expands into its component lines, so stock moves per part.
- USB barcode scanners are supported on the sales screen: scan and the line is
  filled in.
- Code 128 labels, printable three-per-A4.

### Money

- All amounts are stored as integer fils. There is no floating point anywhere in
  the money path.
- UAE VAT at 5%, with standard, zero-rated, exempt and outside-scope treatments.
- Weighted average cost, so cost of goods is right even when prices move.
- Sales and purchase returns reverse stock **at the original cost**.
- Customer and supplier ledgers with statements, running balances, payment
  allocation and aging buckets (current / 1-30 / 31-60 / 60+).
- Receive and make payments, with partial payments allocated across invoices.
- Post-dated cheques with number, bank, due date and pending / cleared / bounced
  status, with dashboard reminders.
- VAT return by period, exportable to Excel as an accountant-ready summary.
- Profit and loss, stock valuation, receivables, payables and cash position.
- Partner accounting: capital and drawings per partner, and a period closing
  statement splitting net profit into a donation (2% by default) and partner
  shares (49% / 49%), computed in integer fils so the totals always match.
- Period lock: an administrator can close a month. Nothing in a locked period
  can be edited or backdated into.

### Water purification specifics

- Serial numbers per sold unit, with warranty start and end dates derived from
  the product's warranty period.
- Warranty lookup by serial number or by customer, plus an "expiring soon" list.
- Service contracts (AMC), service visits and a filter replacement schedule with
  "due this week" and "due this month" views.
- Printable service reminders and a WhatsApp click-to-chat link with a prefilled
  message. No WhatsApp API, no account, no network access from the app.
- Installation records: what was fitted, where, when and by whom.

### Security

- Fine-grained permissions per role across 23 modules and 6 actions (view,
  create, edit, delete, cancel, export). Custom roles can be defined in the UI.
- Login lockout after repeated failures, a password policy, and an
  administrator-only offline password reset that forces a change at next login.
- The database is encrypted with SQLCipher; the key is protected by Electron's
  `safeStorage`, which binds it to the Windows user account.
- Every IPC payload is validated with Zod. Every RPC method declares the
  permission it requires, checked in the main process rather than only hidden in
  the UI.
- An audit log with a tamper-evident hash chain. The viewer can verify the chain
  and export it; altering any entry breaks verification.
- Electron is hardened: context isolation, sandbox, strict CSP, navigation and
  `window.open` blocked, all permission requests denied, and a network request
  filter that cancels anything the app does not need.

### Data safety

- Automatic daily backup, plus a backup every time the app closes. Retention is
  configurable and old backups are pruned. The folder can be a USB stick or a
  OneDrive folder.
- Backups are encrypted with the same key as the live database, so a backup on
  a USB stick is no more readable than the original.
- Manual backup and restore. A restore runs SQLite's own integrity check and
  refuses a backup from a newer build before it will touch anything.
- Versioned, append-only migrations. A verified safety backup is written before
  the first one runs and startup aborts if it cannot be written.
- A database created by a version that predates encryption is converted in
  place on first sight, with the original kept beside it, so upgrading never
  costs a shop its history.
- Rotating log files and an "Export diagnostics" button.
- Single-instance lock, so the app cannot be opened twice against one database.

### Interface

- English and Arabic, with full right-to-left mirroring.
- A teal-on-white design system, defined entirely as tokens. Light and dark.
- Command palette (Ctrl+K), shortcuts for new sale (Ctrl+N), new purchase
  (Ctrl+P) and save (Ctrl+S).
- A `/design-system` route shows every component in every state, for review
  before shipping a change.

## Requirements

- Windows 10 or 11 (x64). Other platforms are not packaged.
- Node.js 20.11 or newer, to build from source.

## Getting started

```bash
npm install
npm run electron:fetch   # only if npm's postinstall skipped the Electron binary
npm run dev              # Vite dev server + Electron
```

### The native module

`better-sqlite3-multiple-ciphers` is a native module, and the same binary cannot
serve both Node and Electron - they use different ABIs. Rather than making the
developer remember which rebuild to run before which command, `npm run native`
builds **both** and keeps them side by side in `build-native/`.
`src/data/connection.ts` picks the right one at runtime. Every script that needs
it runs `npm run native` first, so it never matters what you ran last.

```bash
npm run native            # build both (idempotent, no-op once cached)
```

## Build and package

```bash
npm run dist              # installer -> release/EyerStock-Setup-<version>.exe
npm run dist:dir          # unpacked build, faster, for smoke testing
npm run release:check     # version, changelog, update server and signing checks
npm run dist:release      # release:check + dist + verify
```

### Publishing an update

The application checks this repository's GitHub releases for a newer version
and offers it in the app, so a release has to say where it comes from. Put
your GitHub account and repository in `package.json` before the first release:

```json
"publish": {
  "provider": "github",
  "owner": "your-account",
  "repo": "eyerstock"
}
```

`npm run release:check` refuses to build a release while those are still the
placeholders, because an installer pointing at a repository that does not
exist ships an application whose update button fails for every shop that
installs it.

Then publish:

```bash
# bump the version in package.json and add a CHANGELOG entry
git tag v0.3.0
git push origin v0.3.0
```

The `Release` workflow builds the installer and publishes it, the update
manifest (`latest.yml`) and its blockmap to the GitHub release. All three are
needed: the manifest is what the application reads to decide whether there is
anything to download. Shops running an older build find the new version on
their next launch.

A **public** repository needs nothing else. For a private one, the
application has to authenticate when it asks GitHub for the release list, and
a read-only token is set as an environment variable on the shop's machine:

```
GH_TOKEN=<a token with read access to the repository>
```

Without it, the check fails with a message saying the release could not be
found, and everything else in the application carries on working.

### Code signing

Set `CSC_LINK` and `CSC_KEY_PASSWORD` (a `.pfx`), or `WIN_CSC_LINK` (a
certificate thumbprint), before `npm run dist`. Without them the build still
succeeds but Windows SmartScreen will warn every user.

`npm run release:check` blocks a release that has no signing credentials unless
`MINHA_REQUIRE_SIGNING=false` is set deliberately. See `.env.example`.

## Quality gates

```bash
npm run verify           # everything below, in order
npm test                 # 296 unit tests
npm run test:perf        # 50,000-row seed and EXPLAIN query-plan checks
npm run test:e2e         # Playwright, drives the real app
npm run typecheck        # strict TypeScript, three projects
npm run lint             # ESLint, type-aware, no `any`
npm run format           # Prettier
```

All of these must pass before a release.

## Layout

```
src/
  domain/     Pure business logic. No database, no Electron, fully unit tested.
  data/       SQLite connection, migrations, backup and restore.
  main/       Electron main process: window, IPC, logging, settings.
  preload/    The contextBridge API. The only thing the renderer can call.
  renderer/   React UI.
  shared/     Types, validation and permissions shared across the boundary.
tests/        Vitest unit tests.
perf/         Seed performance and query-plan tests.
e2e/          Playwright end-to-end tests.
scripts/      Build and maintenance tooling.
```

The dependency rule is one-directional: `domain` knows nothing about the
database, and `renderer` knows nothing about Node. This is what makes the
financial logic testable without a running app, and it is enforced by the
module boundaries rather than convention.

## Data location

| What            | Where                                          |
| --------------- | ---------------------------------------------- |
| Database        | `%APPDATA%\Minha Inventory\minha-inventory.db` |
| Settings        | `%APPDATA%\Minha Inventory\settings.json`      |
| Logs            | `%APPDATA%\Minha Inventory\logs\main.log`      |
| Default backups | `%APPDATA%\Minha Inventory\backups\`           |

Set the backup folder to a USB stick or a OneDrive folder from Settings. The
uninstaller asks whether to keep your data and defaults to keeping it.

## Documentation

- [USER_GUIDE.md](USER_GUIDE.md) — day-to-day use, written for shop staff.
- [ADMIN_GUIDE.md](ADMIN_GUIDE.md) — backup, restore, updates, troubleshooting.
- [QA_CHECKLIST.md](QA_CHECKLIST.md) — manual test pass before a release.
- [CHANGELOG.md](CHANGELOG.md) — what changed, per release.

## Single-machine note

The database is a single local file and the app takes a single-instance lock.
**It is designed for one PC and is not a network or multi-terminal system.**
Two machines cannot share the database over a LAN: SQLite over a network share
will corrupt under concurrent writes. If a second till is needed, run a second
installation with its own database and reconcile deliberately. A client/server
architecture would be required to change this.

## Licence

Proprietary. All rights reserved.
