# Manual QA Checklist

Run this before every release, on a clean Windows machine that does not have a
developer install. Automated tests and a successful build are necessary but not
sufficient: this catches what only a person using the app would notice.

**Release being tested:** ________________
**Tester:** ________________
**Date:** ________________
**Result:** PASS / FAIL

Record the app version shown on the startup screen: ________________

## A. Environment

- [ ] Installed from the installer, not from source.
- [ ] Desktop shortcut present and launches the app.
- [ ] Start Menu entry present.
- [ ] Installed for the current user only; no admin prompt during normal use.
- [ ] App version matches the intended release.
- [ ] Uninstall is offered on removal.
- [ ] Uninstall **asks** whether to keep the data, and defaults to keeping it.
- [ ] Choosing "No" removes `%APPDATA%\Minha Inventory` as well.
- [ ] Uninstall is refused while the app is running.
- [ ] After uninstall, `%APPDATA%\Minha Inventory` still exists (data kept).
- [ ] Reinstall launches and still shows the same data.
- [ ] Windows firewall did not prompt.
- [ ] No network activity: disconnect Wi-Fi and confirm the app still works fully.

## B. First run

- [ ] First launch creates the database without error.
- [ ] **The sign-in screen does not scroll**, at 100% and at 125% display
      scaling. The navy brand panel and the form fill the window side by side.
- [ ] On a short window (drag it to about half height) the sign-in card scrolls
      inside its own column; the brand panel stays full height.
- [ ] The setup screen behaves the same way: the form scrolls, the window does
      not.
- [ ] The Eyercall mark sits at the top of the brand panel, the headline
      "Smarter Inventory. Clearer Decisions." and the three feature lines below
      it, and the outlined box motif in the lower corner.
- [ ] "Powered by Eyercall" shows at the foot of the brand panel.
- [ ] The password field's eye button reveals the password and hides it again,
      and the error message appears without moving the Sign in button.
- [ ] Startup screen shows app name and version.
- [ ] Schema version shown is the expected value for this release.
- [ ] A `pre-migration-v0-backup-...` file appears in `backups/` on first run.
- [ ] On an upgrade from 0.1.0, a `pre-migration-v16-...` safety backup appears
      before the schema changes.
- [ ] `logs/main.log` exists and contains a start entry.
- [ ] `settings.json` created with sensible defaults.
- [ ] Closing and reopening does not re-run migrations or re-create backups
      unnecessarily.

## C. Startup and shutdown

- [ ] App closes cleanly with the X button.
- [ ] A backup-on-close file is created each time.
- [ ] Force-closing (task manager) leaves the database usable at next launch.
- [ ] Launching a second copy focuses the existing window instead of opening a
      second instance.
- [ ] Starting the app twice in quick succession does not corrupt anything.
- [ ] **Second launch of the app starts normally.** This is the case that broke
      before: with no migrations left to run there is nothing to await, so an
      ungated startup created the window before Electron was ready. Run the app
      twice in a row on a machine that already has a database.

## D. Money and VAT (accuracy check — do this with a calculator)

- [ ] Single item AED 100.00 → VAT AED 5.00, total AED 105.00.
- [ ] Three items on one invoice → VAT is 5% of the total net, not 5% of the
      gross.
- [ ] Fractional item, e.g. 1.5 units → VAT calculated on the exact amount.
- [ ] Prices with awkward cents (AED 0.03, AED 19.99) round as a shopkeeper
      expects, not by a visible fil.
- [ ] Credit note reverses VAT in the opposite direction.
- [ ] VAT report: output minus input equals net payable.
- [ ] VAT report with input greater than output shows a **negative** net, not zero.
- [ ] Zero-rated product adds no VAT.

## E. Stock and cost

- [ ] Purchase increases stock by the quantity entered.
- [ ] Sale decreases stock.
- [ ] Two purchases at different prices → sale cost is the average, not the
      latest price.
- [ ] Selling down to exactly zero, then buying again → cost is the new price,
      not a blended average with zero stock.
- [ ] Returning a unit sold months ago reverses at the **original** cost.
- [ ] Cannot sell more than is in stock (clear error, no negative stock).
- [ ] Stock value total on the stock report matches a manual calculation on one
      product.

## F. Documents and numbering

- [ ] First invoice is `INV-0001`.
- [ ] Numbering continues with no gaps or repeats.
- [ ] First credit note is `CN-0001`; numbering continues across invoices.
- [ ] Cancelling a document does not reuse its number.
- [ ] Delivery note and quotation have their own series (`DN-`, `QUO-`).
- [ ] Converting a quotation to an invoice keeps the number series unbroken.

## G. Payments, ledgers and credit

- [ ] Partial payment reduces the balance correctly.
- [ ] Payment auto-allocates oldest invoice first.
- [ ] Overpayment is held as on-account credit, not discarded.
- [ ] Customer statement balance matches their card balance.
- [ ] Supplier statement shows the opposite sign convention (what you owe).
- [ ] Aging buckets land correctly at 0, 30, 31, 60 and 61 days.
- [ ] Invoice on 30-day terms is not overdue before day 31.
- [ ] **The Chart of Accounts shows a tree**: the five categories, a parent with
      its sub-account indented under it, and a chevron that folds the branch
      without selecting the account.
- [ ] "Collapse all" folds the five categories; "Expand all" opens them again.
- [ ] Searching for a sub-account shows it *and* the parent it sits under.
- [ ] Selecting an account shows its balance, and its transaction history
      carries the same running balance as the Account Ledger.
- [ ] An asset grows with a debit and a liability grows with a credit: the
      balance on the account agrees with the ledger's.
- [ ] "View Ledger" opens the ledger for that account, and the way back brings
      the same account with it.
- [ ] An account with ledger lines cannot be deleted, only deactivated.

## H. Post-dated cheques

- [ ] Cheque recorded with number, bank and due date.
- [ ] Dashboard lists cheques due soon.
- [ ] Reminder appears before the due date.
- [ ] Marking cleared removes it from the due list.
- [ ] Marking bounced keeps a record with the reason.

## I. Serial numbers and warranty

- [ ] Serialised product requires a serial at sale.
- [ ] Duplicate serial number is refused.
- [ ] Warranty start and end dates are set from the sale date and the product's
      warranty period.
- [ ] Warranty lookup by serial works.
- [ ] Warranty lookup by customer works.
- [ ] Expiring warranties appear on the dashboard 60 days ahead.

## J. Service and AMC

- [ ] Installation recorded against a customer.
- [ ] Service contract with number, dates and visit count.
- [ ] Filter replacement schedule created with a due date.
- [ ] "Due this week" and "due this month" lists are correct.
- [ ] Printable service reminder shows the right customer and equipment.
- [ ] WhatsApp link opens with the prefilled message and the right number.

## K. Partners

- [ ] Closing statement: revenue, COGS, expenses, net profit add up.
- [ ] Donation is exactly 2% and is taken before the split.
- [ ] Each partner's share is 49% of the remainder.
- [ ] Shares plus donation equal net profit **to the fils**, with no gap.
- [ ] Odd profit amounts still balance (try a deliberately awkward figure).
- [ ] Drawings reduce the correct partner's capital account.
- [ ] Capital account closing balances reconcile.
- [ ] Loss period is refused with a clear message rather than split negatively.

## L. Period lock

- [ ] Admin can lock a month.
- [ ] After locking, an old invoice cannot be edited.
- [ ] After locking, an old payment cannot be edited.
- [ ] New documents in the current month are unaffected.
- [ ] Unlock requires admin rights.
- [ ] Non-admin users cannot lock or unlock.

## M. Users and permissions

- [ ] Login with a correct password succeeds.
- [ ] Wrong password fails with no hint about which part was wrong.
- [ ] Repeated wrong attempts lock the account and tell the user how long.
- [ ] Locked account unlocks automatically after the timeout.
- [ ] Deactivated user cannot log in.
- [ ] Each role sees only its permitted modules.
- [ ] Create/edit/delete/cancel/export are separately controllable per module.
- [ ] A custom role behaves as configured.
- [ ] Password policy enforced (length, complexity).
- [ ] "Forgot password" requires admin, not self-service.

## N. Audit log

- [ ] Creating, editing and deleting are all logged.
- [ ] Log shows who, what, when, and old and new values.
- [ ] Filtering by user, module, action and date works.
- [ ] Export produces a readable file.
- [ ] Editing a row directly in the database is detectable (hash chain
      verification reports the break).

## O. Backup and restore (the critical section)

- [ ] Manual backup creates a file in the chosen folder.
- [ ] Backup folder can be changed to a USB stick and works from there.
- [ ] Retention removes the oldest beyond the keep count.
- [ ] Backups restore correctly into a fresh install.
- [ ] Backup listing shows date and size.
- [ ] Restoring runs the integrity check and reports **Backup verified.** for a
      good file.
- [ ] Restoring a corrupted file is refused with a clear message.
- [ ] Restoring an unrelated SQLite file is refused with a clear message.
- [ ] Restore refuses to proceed without typing `RESTORE`.
- [ ] Restore takes a safety copy of current data first.
- [ ] After restore, data matches the backup exactly.
- [ ] Restoring a backup from a newer version is refused with an explanation.
- [ ] Daily automatic backup runs at the configured hour.
- [ ] App with no free disk space reports a backup failure rather than crashing.

## P. Import and export

- [ ] Export all data produces a file that re-imports cleanly.
- [ ] Excel import of products shows a validation preview before committing.
- [ ] Invalid rows are highlighted and explained, not silently skipped.
- [ ] Importing with a duplicate SKU is refused or clearly reported.
- [ ] Opening stock import calculates the right average cost.
- [ ] CSV with wrong column names fails with a helpful message.

## Q. Print layouts

- [ ] A4 invoice prints with logo, footer and terms.
- [ ] Thermal 80mm receipt fits without cutting text off.
- [ ] Arabic invoice is right-to-left and correct.
- [ ] Bilingual invoice shows both languages correctly.
- [ ] QR code renders on a tax invoice when a TRN is set, in the position a
      UAE e-invoice QR occupies, and is scannable.
- [ ] With no TRN set, the QR slot shows the documented "no TRN" state rather
      than a broken image.
- [ ] "Developed by Eyercall" prints in the footer of every document type.
- [ ] Clearing **Developed by** in Settings removes the line from the login
      panel, the About page and printed documents — no dangling label is left.
- [ ] Barcode label prints scannable.
- [ ] A USB barcode scanner types into the sale screen correctly.
- [ ] Printed invoice numbers, VAT and totals match the on-screen document.

## R. Language and formatting

- [ ] Language switches between English and Arabic.
- [ ] Arabic UI is fully right-to-left, including tables and forms.
- [ ] Dates use UAE format (dd/mm/yyyy).
- [ ] Numbers and currency use UAE conventions.
- [ ] Language choice persists after restart.
- [ ] Fiscal year setting affects period reports.

## S. Search, shortcuts and speed

- [ ] Ctrl+K opens the command palette and searches products and customers.
- [ ] Keyboard shortcut creates a new sale.
- [ ] Enter moves to the next field in fast invoice entry.
- [ ] Barcode scanner input needs no clicking first.
- [ ] Large product list (50k) scrolls without stuttering.
- [ ] Large transaction list (50k) scrolls without stuttering.
- [ ] Opening a dashboard with large data stays under 3 seconds.
- [ ] No console errors during normal use.

## T. Crash handling

- [ ] A deliberately thrown renderer error shows a friendly message, not a blank
      window.
- [ ] App logs the error with a stack trace.
- [ ] Export diagnostics writes a file to the Desktop.
- [ ] Diagnostics contain no customer or financial data.
- [ ] After a crash, the next launch works and the data is intact.

## U. Packaging

- [ ] Installer icon and name are correct.
- [ ] Custom icon appears on desktop, Start Menu and taskbar.
- [ ] Installer language is English.
- [ ] Per-user install works without administrator rights.
- [ ] Install location can be changed.
- [ ] Uninstall leaves data behind by default.
- [ ] Code signing is configured and signing runs when certificates are supplied.
- [ ] `npm run release:check` blocks the build with no certificates and no
      deliberate `MINHA_REQUIRE_SIGNING=false`.

## V. Offline guarantee

- [ ] App works with the network cable unplugged.
- [ ] App works with Wi-Fi disabled.
- [ ] No network requests in developer tools (Network tab empty).
- [ ] CSP blocks any attempt to load a remote resource.
- [ ] No cloud sync, telemetry or crash-reporting upload anywhere.

## W. Kits (added in 0.2.0)

- [ ] A kit appears in the **Kits** picker on a new sale.
- [ ] Choosing it adds one line per component, each with its own quantity.
- [ ] The line prices sum to exactly the kit price — no fil lost or created.
- [ ] Saving the invoice deducts stock for **each component**, not the kit.
- [ ] A kit short on a component warns before saving.
- [ ] The kit picker is not offered on a purchase or a return.

## X. Barcode labels and scanning (added in 0.2.0)

- [ ] **Barcode labels** screen lists products and ticks them.
- [ ] Printing produces scannable Code 128 bars, three per A4.
- [ ] A product with no barcode still labels, showing the SKU as text.
- [ ] A USB scanner adds the matching product to the sale without a click.
- [ ] Scanning an unknown code reports the code rather than failing silently.
- [ ] Typing normally in a text field is never mistaken for a scan.

## Y. Installations (added in 0.2.0)

- [ ] **Installations** screen records customer, date, location and engineer.
- [ ] Editing an installation saves the correction rather than duplicating it.
- [ ] Deleting an installation asks first.
- [ ] Deleting an installation does not remove the linked warranty record.

## Z. Undo (added in 0.2.0)

- [ ] Deleting a draft offers **Undo** in the toast.
- [ ] Pressing **Undo** brings the draft back with its lines.
- [ ] The restored draft has a **new** number; the old one is not reused.
- [ ] Issued documents offer no Undo, only Cancel — their history is real.

## AA. Data visibility by role (added in 0.2.0)

- [ ] A user without the reports permission does not see net profit on the
      dashboard.
- [ ] The same user does not see the expenses figure or the expense bar in the
      sales-versus-expenses chart.
- [ ] The same user still sees their own sales figures.
- [ ] The profit tiles are hidden entirely, not merely blanked.

## AB. Arabic and RTL (added in 0.2.0)

- [ ] Sidebar, tables, forms and dialogs all mirror in Arabic.
- [ ] Row-action menus open on the correct side.
- [ ] Charts and meters mirror correctly.
- [ ] Toolbar icons that imply direction (next/previous page) mirror.
- [ ] Currency and numbers use Arabic-Indic digits and `ar-AE` formatting.
- [ ] Arabic invoice prints right-to-left with the teal band intact.

## AC. New in 0.2.0 — VAT and outside scope

- [ ] A product set to **Outside scope** adds no VAT.
- [ ] It still appears in the net figure on the VAT report.
- [ ] The VAT report opens without error for a period containing sales — this
      was broken in 0.1.0 and is the single most important regression to check.
- [ ] **Export** on the VAT report produces a VAT return summary, not a raw
      document dump.
- [ ] Opening a product saved before 0.2.0 still shows its old VAT treatment.

## AD. Encryption and backup integrity (added in 0.2.0)

- [ ] **Back up now** succeeds. Backups of an encrypted database failed
      outright before this release while still being reported as taken — confirm
      the file really appears and really grows.
- [ ] The backup file is encrypted: opening it in a text editor or a SQLite tool
      does not reveal `SQLite format 3` or any customer names.
- [ ] Restoring that backup works on the same machine.
- [ ] The on-close backup appears after closing the app normally.
- [ ] The daily backup appears on next launch.
- [ ] A pre-migration safety backup appears before the schema changes on upgrade.

## AE. Upgrading from a pre-encryption database (added in 0.2.0)

- [ ] Start from a 0.1.0 data folder and open the app: it starts without the
      "key file may belong to another machine" error.
- [ ] Every customer, invoice and stock movement is present afterwards.
- [ ] `minha-inventory.db.plaintext-backup` exists beside the database.
- [ ] That backup file opens as a normal, readable SQLite database.
- [ ] The converted database is encrypted and opens with the app.
- [ ] The app starts normally a second time (the conversion does not repeat).
- [ ] If the key file is deliberately deleted, the app refuses rather than
      silently replacing the database.

## Notes on failures

Record the section, the step, what happened and what you expected:

| #   | Section | What happened | Expected |
| --- | ------- | ------------- | -------- |
| 1   |         |               |          |
| 2   |         |               |          |
| 3   |         |               |          |

Do not skip a failed step and carry on: a failure in section O (backup and
restore) or V (offline) blocks release regardless of anything else passing.
