# Administrator Guide

**Minha Inventory** — version 1.0.0

For whoever is responsible for the computer, not for the day-to-day selling:
installation, users and permissions, backups, restores, updates, security and
troubleshooting.

Names of buttons, menu entries and form fields are shown in **bold**, exactly as
they are written on screen.

## Contents

1. [Your responsibilities](#1-your-responsibilities)
2. [Installing on Windows](#2-installing-on-windows)
3. [First run](#3-first-run)
4. [Users, roles and permissions](#4-users-roles-and-permissions)
5. [Passwords](#5-passwords)
6. [Backups](#6-backups)
7. [Restoring from a backup](#7-restoring-from-a-backup)
8. [Updates](#8-updates)
9. [The audit log](#9-the-audit-log)
10. [Security posture](#10-security-posture)
11. [Diagnostics](#11-diagnostics)
12. [The offline licence](#12-the-offline-licence)
13. [Where your data lives](#13-where-your-data-lives)
14. [The single-machine limitation](#14-the-single-machine-limitation)
15. [Troubleshooting](#15-troubleshooting)

---

## 1. Your responsibilities

Four things, in order of how much damage they do if you get them wrong:

1. **Backups.** The app does them for you, but only into its own folder unless
   you point it somewhere else. [Section 6](#6-backups).
2. **Knowing how to restore.** A backup you have never tested is not a backup.
   [Section 7](#7-restoring-from-a-backup).
3. **User accounts.** Every member of staff gets their own sign-in. Never share
   one. [Section 4](#4-users-roles-and-permissions).
4. **Updates.** Install them promptly; the app refuses to start on a database
   written by a newer version. [Section 8](#8-updates).

---

## 2. Installing on Windows

### 2.1 Requirements

| | |
| --- | --- |
| Operating system | Windows 10 or Windows 11, 64-bit (x64) |
| Free disk space | ~500 MB for the app, plus whatever your database and backups need |
| Internet | Not needed at any point, including during installation |

Other platforms are not packaged.

### 2.2 Installing

The installer is a single file named `Minha Inventory-Setup-<version>.exe`.

1. Copy the installer to the shop PC (a USB stick is fine).
2. Double-click it.
3. Choose **Install for me only**.

   The install is per-user by design. It does **not** need administrator rights
   and does **not** touch the machine for every user on it. Do not choose "for
   all users".
4. Accept the default installation folder unless you have a reason to change it.
5. Click install.

Windows may show a SmartScreen warning if the build is not code-signed. Choose
**More info → Run anyway** only if you obtained the installer from your supplier.

The installer creates a desktop shortcut and a Start Menu entry, both called
**Minha Inventory**.

### 2.3 Uninstalling, and what it leaves behind

The uninstaller refuses to run while the app is open: it asks you to close
**Minha Inventory** first.

When it does run it asks:

> Remove Minha Inventory only, and keep your data (products, invoices, customers
> and backups)? Choose No if you also want to delete the data folder.

It **defaults to keeping the data**. Answer **Yes** unless you are deliberately
wiping the shop. An uninstall is usually an upgrade, not a decision to destroy
three years of trading.

### 2.4 Upgrading later

You do not uninstall first. Run the new `Minha Inventory-Setup-<version>.exe`
straight over the old one, choose **Install for me only** again, and accept the
same folder. Your data is kept. See [Section 8](#8-updates) for the full
procedure and for how to roll back.

---

## 3. First run

### 3.1 The setup wizard

The first time the app opens, the **Set up Minha Inventory** screen appears.
Nobody can get past it, and the app cannot be used at all until it is finished.
It creates the database, applies the schema and writes the first administrator.

Fill in:

| Field | Why it matters |
| --- | --- |
| **Company name** | Prints on every invoice. |
| **TRN (tax number)** | Prints on every tax invoice. Must be correct. |
| **Company phone** | Printed on invoices. |
| **Company address** | Printed on invoices. |
| **Financial year starts in** | Drives the financial-year groupings in Partners and Period lock. |
| **Language** | English or العربية. Changeable later. |
| **Your name** | The administrator's display name, recorded on every audit entry. |
| **Username** | The sign-in name. Keep it short and lowercase. |
| **Password** | See [Section 5](#5-passwords). |

Click **Finish setup**. The app signs you in and shows the **Dashboard**.

### 3.2 The things to do straight afterwards

1. **Administration → Settings**. Check the company name, TRN, address and phone
   are right. These print on documents and are hard to unpick later.
2. **Administration → Settings → Invoice & receipt**. Set the **Footer text**,
   **Terms and conditions** and the **Financial year**.
3. **Administration → Settings → Company details → Choose logo**. A PNG or JPG up
   to 2 MB. It is printed on every document. You can **Remove logo** again.
4. **Administration → Backup & restore → Change folder**. Point it at a USB
   stick or a OneDrive folder. See [Section 6](#6-backups).
5. **Administration → Backup & restore → Back up now**. Confirm a file appears.
   This step is not optional.
6. Create a user for each member of staff. See [Section 4](#4-users-roles-and-permissions).
7. Work through the **Getting started** list at the bottom of the **Dashboard**.

Settings save themselves when you click away from a box. There is no separate
save button to press.

---

## 4. Users, roles and permissions

### 4.1 Creating a user

1. Go to **Administration → Users**.
2. Click **New user**.
3. Fill in:

| Field | Notes |
| --- | --- |
| **Your name** | Their real name. This is what the audit log records. Use a name a person can be identified by. |
| **Username** | Unique, no spaces. |
| **Role** | Choose from the roles on this machine. |
| **Password** | Only on a new user. On an existing user the field is **New password**; leave it blank to keep the current one. |
| **You must set a new password before continuing.** | Leave ticked. They choose their own password at next sign-in. |
| **Active** | Leave **Active**. |

4. Click **Save**.

Each user sees **Last signed in**, which is the quickest way to spot an account
nobody has touched since it was created.

### 4.2 Deactivating a user

Do not delete a user. Open them with **Edit** and switch **Active** to
**Inactive**, then click **Save**.

An inactive user cannot sign in but their name stays attached to every invoice,
payment and audit entry they created. Deleting a person would rewrite history.

Use **Activate** to bring them back.

### 4.3 The built-in roles

Four roles are created during setup:

| Role | What it is for |
| --- | --- |
| **Administrator** | Full access to everything, including settings and user management. |
| **Manager** | Everything except user management and period locking. |
| **Sales** | Customers, sales invoices, quotations and receipts. |
| **Store Keeper** | Stock, purchases, products and suppliers. |

### 4.4 The six actions

Every permission is a (module, action) pair. There are **23 modules** and
**6 actions**. The six actions mean:

| Action | In practice |
| --- | --- |
| **view** | Can open the screen at all. Without it the menu item is hidden and the screen shows **You do not have access to this screen.** |
| **create** | Can make something new: an invoice, a customer, an expense. |
| **edit** | Can change something that already exists, including editing a saved draft. |
| **delete** | Can remove a record outright. Used for things that have had no lasting effect: a draft invoice, an expense, a payment, a kit definition, an installation record. |
| **cancel** | Can void an issued document with a reason. This is the action that reverses stock and VAT, so it is kept separate from **delete**. |
| **export** | Can write files out of the app: **Export to Excel**, **Export data**, **Export log**. |

The 23 modules are: `dashboard`, `parties`, `products`, `sales`, `purchases`,
`inventory`, `payments`, `cheques`, `returns`, `quotations`, `service`,
`warranty`, `finance`, `vat`, `partners`, `periodLock`, `reports`, `users`,
`roles`, `audit`, `settings`, `backup`, `designSystem`.

### 4.5 Creating a custom role

1. Go to **Administration → Roles & permissions**.
2. Click **New role**.
3. Enter a **Name** and a **Description** that says who it is for.
4. Work down the matrix. Each row is a module, each column is one of the six
   actions. Tick the boxes.
5. Click **Save**.

The screen says *Tick what this role can do. View is added automatically.* Tick
**view** for any module where you want the menu item visible; nothing else on
that module will work without it.

Use **Edit** on a role card to change it later. Each role card lists the
permissions it currently holds as a set of badges.

### 4.6 A worked set of roles

- **Counter clerk**: view/create/edit on `sales`, `quotations`, `parties`,
  `payments`, `products`; view on `returns`; no `delete`, no `cancel`, no
  `export`.
- **Store keeper**: the **Store Keeper** role as shipped, plus create on
  `parties` for suppliers.
- **Accountant**: view/export on everything, create/edit on none.
- **Owner**: **Administrator**, with a named password rather than a shared one.

### 4.7 Hiding a module entirely

`settings`, `users`, `roles`, `audit`, `backup` and `periodLock` are modules like
any other. Remove **view** from a role and the corresponding menu group
disappears for that user — no empty heading is left behind.

### 4.8 How this is enforced

Hiding a menu item is a convenience, not the security boundary. Every request
from the interface is checked again in the main process against the signed-in
user's role, and the user interface cannot reach the database or the file system
at all. A user who cannot see **Backup & restore** cannot restore a database
even if they craft the request themselves.

---

## 5. Passwords

### 5.1 The rule

*Use at least 8 characters, with a capital letter and a number.* The actual
policy also requires a small letter; no symbol is required.

### 5.2 Lockout

After **5** consecutive wrong attempts the account locks for **15 minutes**. A
successful sign-in resets the counter. With two or fewer attempts left the app
warns before the lock happens.

The lockout is per-account and applies to the administrator account too.

### 5.3 Resetting someone's password

Administrator-only, and it does not need the old password:

1. Go to **Administration → Users**.
2. Click the key icon next to the user — **Reset password**.
3. Enter a **New password** meeting the rule.
4. Click **Save**.

The reset always forces **You must set a new password before continuing.**, so
the person must choose their own password at next sign-in. It also clears the
lockout immediately.

### 5.4 Changing your own password

**Administration → Settings → Change password**: **Current password**,
**New password**, **Confirm password**, then **Change password**.

### 5.5 Everyone is locked out

This is the one failure the app cannot recover from on its own, because password
resetting needs a signed-in administrator.

Work down this list:

1. **Wait 15 minutes.** The lock is time-based and expires on its own. This
   solves it more often than people expect — check whether anyone simply mistyped
   a password five times.
2. **Find another administrator.** **Manager** cannot manage users, so only
   someone on the **Administrator** role can reset a password. If a second
   administrator exists, use them.
3. **Export diagnostics and contact your supplier.** If there is genuinely no way
   in, the supplier has an offline procedure for this. Supply them with the
   diagnostics file from [Section 11](#11-diagnostics).

There is deliberately no "forgotten password" email link, because the app never
touches the internet. Plan around this: keep **two** administrator accounts, and
store the second one's credentials in a sealed envelope with the shop's papers.

### 5.6 Storage

Passwords are hashed with scrypt and a per-user random salt. They are never
stored, logged or exported in readable form — not in the database, not in the
diagnostics file, not in a backup you can read with a text editor. All the
diagnostics export contains is row counts and settings.

---

## 6. Backups

### 6.1 What happens automatically

| When | What |
| --- | --- |
| First launch of the day | A daily backup, if **Daily automatic backup** is on |
| Every proper close (the **X**) | A backup of that session's work |
| Before any schema migration | A verified safety backup, before anything is changed |
| Immediately before a restore | A copy of the live database |

The daily backup runs on the first opening of the day because an offline desktop
app cannot schedule itself to start at 2 a.m. The **Back up at (hour)** field
records the hour you want the daily copy to represent; the on-close backup is
what captures the rest of the day's work.

### 6.2 File names

Every backup is a complete, standalone database file, named with a prefix and a
timestamp (`YYYYMMDD-HHMMSS`):

| Prefix | Taken |
| --- | --- |
| `auto-` | First launch of the day |
| `onclose-` | Closing the app |
| `backup-` | Before a schema migration, named `pre-migration-v<old>-…` |
| `minha-` | **Back up now** |
| `<database>.prerestore-<timestamp>` | Immediately before a restore |

Backups are taken with SQLite's own online backup API, so the copy is a
consistent snapshot even while the app is writing. They are not a raw file copy.

### 6.3 Retention

**Keep last N backups** on the **Backup & restore** screen sets how many are
kept. The default is 30, which is about a month of daily copies.

Pruning happens on every backup run and always removes the **oldest** first. The
screen shows **Last backup** and **Backups saved**, so an empty or stale value is
immediately visible.

### 6.4 Pointing backups at a USB stick or OneDrive

This is the most important thing you will configure, and it takes two minutes.

1. Plug in the USB stick. Windows will not let you choose a drive that is not
   connected.
2. Go to **Administration → Backup & restore**.
3. Click **Change folder**.
4. Pick the folder on the stick, or your OneDrive folder.
5. Click **Back up now** and confirm the file appears there.

Good destinations:

| Destination | Verdict |
| --- | --- |
| A USB stick kept somewhere else | Good. Physically separate from the PC. |
| A OneDrive folder that is syncing | Good. Already copied off the machine. |
| A second internal drive | Acceptable, but it fails with the machine. |
| The default app folder on this PC | **Not a backup.** It dies with the disk. |

### 6.5 Why a network share is not suitable

Do not point the backup folder at `\\server\share` or a mapped network drive.

- SQLite over a network share is not safe. File locking on SMB is unreliable and
  can corrupt a database under concurrent writes.
- The file is written while other machines may be reading it.
- If the network is down when the app closes, the backup silently does not
  happen and nobody notices for a week.
- The backup would sit next to the live database anyway, so it offers no
  protection against the thing you are protecting against.

If you need off-site copies, use OneDrive or a USB stick. A second shop needs a
second installation and a deliberate reconciliation — see
[Section 14](#14-the-single-machine-limitation).

### 6.6 Manual backups

Click **Back up now** on the **Backup & restore** screen. Do it:

- at the end of every trading day,
- before handing the computer to someone else,
- before a large spreadsheet import,
- before any restore.

### 6.7 Checking that backups work

1. Open the backup folder in File Explorer.
2. Confirm the newest file is today.
3. Pick one and check its size is not zero and not wildly smaller than the last.
4. Once a quarter, do a real test: take a fresh **Back up now**, then restore an
   older file and check the app still works and the figures look right. See
   [Section 7](#7-restoring-from-a-backup). Do this on the same PC — see
   [Section 10.2](#102-if-you-copy-the-database-file-to-another-pc).

---

## 7. Restoring from a backup

> A restore replaces everything currently in the app. Every sale, payment and
> service visit recorded since that backup was taken will be gone. Only an
> administrator with the `backup` / `edit` permission can do it, from the
> **Backup & restore** screen only.

### 7.1 Before you start

1. Write down what you are restoring and why. You will need to explain it to
   whoever owns the business.
2. Click **Back up now**. If the restore goes wrong, this is your way back.
3. Decide which file you want. The list is newest first, with the date and size
   beside each name:
   - `auto-` = the first open of the day
   - `onclose-` = a proper close
   - `minha-` = a manual backup
   - `backup-` = taken before an update

   **Newer is later.** Pick the most recent file that predates the problem.

### 7.2 The steps

1. Open the app normally and let it load.
2. Go to **Administration → Backup & restore**.
3. In the **Restore** list, click **Restore** on the file you want.
4. A dialog titled **Restore selected backup** opens. It says:

   > This replaces all current data with the backup's contents.

5. Before confirming, click **Backup verified** to check the file. The app runs
   SQLite's own integrity check plus a schema-version check and reports the
   result. If the file is corrupt, or was made by a **newer build**, it refuses
   to go any further. Choose a different file.
6. Type **RESTORE** in the box, in capitals. The **Restore** button stays greyed
   out until you do.
7. Click **Restore**.
8. The app closes and reopens by itself. **Do not close it yourself.** The
   existing database handle is stale after the file is swapped, so the app
   restarts rather than continuing on a dead connection.

### 7.3 What happens to existing data

- The current database is copied to `<database>.prerestore-<timestamp>` **before**
  anything is replaced. If the restore itself fails, your data is untouched.
- The replacement is written to a temporary file and then renamed over the live
  one. A failure part-way cannot leave a half-written database.
- Everything the old database held is gone: invoices issued since, payments
  received since, new customers, stock movements. You will have to re-enter
  them, or reconcile from the paper record.
- **Backup and licence settings live outside the database** in `settings.json`.
  A restore therefore does not change where backups go or how many are kept.

### 7.4 After a restore

1. Check the **Dashboard** figures look right.
2. Check the invoice numbering is continuous.
3. Take a fresh **Back up now** so the restored state is captured immediately.

---

## 8. Updates

### 8.1 The app tells you when a new version is there

Shortly after it starts, EyerStock looks on the publisher's release page and
compares the version it is running with the newest one published.

- If there is nothing newer, nothing happens. No badge, no message.
- If there is a newer version, a small notification appears in the corner:
  **EyerStock 0.3.0 is available**. Press **Update** to see the details.
- In the dialog, press **Download and install**. The download shows its
  progress; when it has finished, press **Restart and install**.
- Installing closes the app and starts it again with the new version. Your
  products, invoices, stock and accounts are not touched.

You can also do all of this by hand under **Administration → About → Updates**,
which shows the installed version, the latest version, and a **Check for
updates** button.

Only an administrator sees the update prompt, because installing an update
replaces the application. A Staff account is not shown a button it would be
refused.

The app needs an internet connection to check for an update. Everything else it
does works with no internet at all, and the app keeps working if the check
fails - a failed check is reported, never acted on.

### 8.2 Installing a new version over an old one

If you downloaded the installer yourself - a supplier sent you a file, or you
are updating a machine with no internet - the manual path is:

1. **Administration → Backup & restore → Back up now.**
2. Close the app properly with the **X**. Wait a few seconds for the on-close
   backup.
3. Run the new `EyerStock-Setup-<version>.exe`.
4. Choose **Install for me only** again, accept the folder, install.
5. Open the app.

Your data is never deleted by an update. The uninstall/upgrade path keeps the
data folder, and the first thing the new build does is take a verified safety
backup named `pre-migration-v<old>-…` before it changes any table. If a
migration fails, it rolls back to the last good version and the backup is in your
backup folder.

Check the version afterwards under **Administration → About**, which also shows
the database schema version.

### 8.3 Rolling back

You cannot go back to an older build once a newer one has migrated the database:
the older build refuses to open a database whose schema is newer than it
supports, and stops rather than corrupting it.

To roll back:

1. Install the older version over the newer one.
2. Open **Administration → Backup & restore**.
3. Restore the `backup-` file taken immediately before the update — that is the
   `pre-migration-v<old>-…` copy in your backup folder.
4. Do this on the shop's normal machine, with the staff told that the day's
   entries will be lost.

Rolling back loses everything done since the update, which is why you take
**Back up now** first.

---

## 9. The audit log

### 9.1 What it records

**Administration → Audit log**. Every change made through the app is written
inside the same database transaction as the change itself, so the log cannot
claim something that was rolled back.

Each entry records:

- the **actor** — who was signed in, by display name
- the **module** — which part of the product
- the **action** — what was done
- the **entity** — what it was done to, with its record number
- the **timestamp**
- the old and new values

You can filter by **Search**, **From** and **Module**. It shows the most recent
500 entries.

### 9.2 The hash chain

Each entry stores the hash of the entry before it, together with a hash of its
own contents. That makes the log tamper-evident: edit any entry and the hash of
every entry after it no longer matches.

**Check log integrity** re-walks the chain from the first entry and reports
**Audit log verified.** with the number of entries, or fails with the position of
the first break.

This does not mean the log is encrypted or unchangeable by someone with the
database file. It means the chain detects accidental or casual editing, and it
gives you a defensible answer if a customer or an auditor asks whether the
history has been touched.

### 9.3 Exporting it

**Export log** writes `audit-log-<timestamp>.csv` to the app's `exports` folder.
Send it with a support request when investigating who changed something.

---

## 10. Security posture

### 10.1 The database is encrypted

The database file is encrypted at page level (ChaCha20, via SQLCipher-compatible
ciphering). The key is held by Electron's `safeStorage`, which on Windows wraps
it with DPAPI and binds it to the Windows user account. The key file sits in the
app's data folder protected by that same mechanism.

**Database encryption** on **Administration → About** shows the mode in use.

If `safeStorage` is unavailable, the app falls back to a weaker key-file mode
and records a warning in the log. On a normal Windows 10 or 11 shop machine you
will see the encrypted mode reported on the About page.

**Backups are encrypted too**, with the same key. A backup file on a USB stick is
no more readable than the live database, and restoring one needs the same key.

### 10.1a If you are upgrading from an older version

Versions before 0.2.0 stored an unencrypted database. The first time you open
the app after upgrading, it converts that file to an encrypted one:

- It happens automatically, before the window opens.
- Every row, setting and history entry is carried across.
- The original, unencrypted file is kept beside it as
  `minha-inventory.db.plaintext-backup` until you delete it yourself.
- If anything goes wrong, nothing is replaced — the original stays exactly as it
  was and the app tells you rather than starting with missing data.

Delete the `.plaintext-backup` file once you have confirmed your data looks
right. It is the only copy of your ledger that is not encrypted.

### 10.2 If you copy the database file to another PC

It will not open. The file is encrypted with a key bound to the Windows user
account that first created it, so on a different machine — or a different
Windows user on the same machine — the app cannot decrypt it.

This is deliberate: a stolen disk is not a readable ledger. It also means:

- **A backup restores on the machine it was made from.** Test your restores on
  the shop's own PC, signed in as the Windows user who installed the app.
- **If you replace the PC**, the old database cannot simply be moved across.
  Install the app on the new machine first, and expect to reconstruct the data
  from the paper record or from a re-keyed copy supplied by your supplier. Tell
  your supplier before the disk dies, not after.
- Keep the encrypted backup anyway. It protects against theft, accidental
  deletion and corruption on the machine you are actually using.

### 10.3 The application shell

- Context isolation and sandbox are on; Node integration is off.
- A strict content security policy with `connect-src 'none'` reflects the fact
  that the app is fully offline. A network request filter cancels anything the
  app does not need.
- Navigation, redirects, `window.open` and `<webview>` are all blocked. External
  links are handed to the operating system browser only for `https:` and
  `mailto:`.
- Every permission request is denied.
- The interface cannot reach the file system, the network or the database
  directly. Everything goes through a narrow, validated bridge.
- Only one copy of the app may run at a time. A second launch focuses the
  existing window rather than starting a rival process against the same file.

### 10.4 The single-machine limitation, stated plainly

**This app is for one PC. It is not a network or multi-terminal system.**

- The database is a single local file and the app takes a single-instance lock.
- Two machines cannot share the database over a LAN. SQLite over a network share
  **will corrupt under concurrent writes**.
- Opening the same database file on two PCs at once will corrupt it. There is no
  locking that makes this safe.
- If you need a second till or a second office, run a second installation with
  its own database and reconcile deliberately. A genuine client/server
  architecture would be required to change this, and that is a different product.

---

## 11. Diagnostics

### 11.1 Where the logs are

| What | Where |
| --- | --- |
| Main log | `%APPDATA%\Minha Inventory\logs\main.log` |
| Exported audit log | `%APPDATA%\Minha Inventory\exports\` |
| Diagnostics file | Your Desktop, written on demand |

Log files rotate, so an old one is deleted rather than filling the disk.

### 11.2 Export diagnostics

**Administration → Backup & restore → Export diagnostics**.

It writes `minha-diagnostics-<timestamp>.txt` to the Desktop, containing:

- app version, and the Electron, Chromium and Node versions
- the database **schema** version and the **encryption** mode
- the result of a database integrity check
- row counts only: products, customers, invoices, invoice lines, payments, stock
  movements, serial units, audit entries
- the file paths in use
- the current settings
- the names and count of the backup files
- the tail of the main log

It contains **no customer, product, financial or password data**. It is safe to
send to your supplier as-is.

### 11.3 When support asks for it

Send:

1. the diagnostics file,
2. the exact message you saw, typed out rather than described,
3. the app version from **Administration → About**,
4. the document or invoice number if it concerns one record.

If a screen has crashed, a diagnostics file is written automatically. You will
find it on the Desktop with the message **Something went wrong** and a
**Restart the screen** button. Attach that file.

---

## 12. The offline licence

### 12.1 The default: off

The licence check is **off by default** and is entirely optional. An unlicensed
installation runs the whole product — every screen, every feature. Nothing is
disabled and nothing expires.

Turn it on only if your supplier has issued you a key.

### 12.2 Turning it on and entering a key

1. Go to **Administration → Licence key**.
2. Note the **Machine ID** shown on the screen. A key is only valid for the
   machine it was issued against, so give this to your supplier.
3. Enter the **Licence key** they gave you.
4. Optionally enter the **Company name** the licence is issued to, so
   **Licensed to** shows something meaningful.
5. Click **Activate licence**.

The screen then shows the status as **Active** or **Expired**, with
**Licensed to**, **Machine ID** and the expiry **Date**.

6. Switch on the licence check in the **Settings** card at the bottom of the
   same screen, so the key is verified at start-up.

An **Expired** key does not delete anything. It just means the shop needs a new
one.

### 12.3 Moving to a new machine

The **Machine ID** changes with the machine. A key issued against the old PC will
not validate on the new one. Ask your supplier for a new key, activated against
the new **Machine ID**. The licence check does not lock the data either way — a
shop's ledger is never held hostage to a licence.

---

## 13. Where your data lives

Everything is in one folder:

```
C:\Users\<your username>\AppData\Roaming\Minha Inventory\
```

Press **Windows key + R**, paste `%APPDATA%\Minha Inventory` and press Enter.

| What | Where | Purpose |
| --- | --- | --- |
| `minha-inventory.db` | App folder | **All your data.** This file is everything. |
| `settings.json` | App folder | Backup folder, retention, daily backup hour, licence flag. Survives a restore. |
| `logs\main.log` | App folder | Technical log. Support may ask for it. |
| `backups\` | App folder | Default backup destination. Move it — see [Section 6](#6-backups). |
| `exports\` | App folder | Exported VAT summary, reports and audit CSV. |

Three rules:

- **Never open `minha-inventory.db` in a text editor or a spreadsheet.** It is an
  encrypted binary database and it will be destroyed. Use the app.
- **Never delete or move this folder while the app is running.**
- **Never copy the database file to another machine and expect it to work.** See
  [Section 10.2](#102-if-you-copy-the-database-file-to-another-pc).

---

## 14. The single-machine limitation

Restated here because it is the assumption most likely to cost a shop its data.

The app stores everything in one local file and enforces a single-instance lock.
It is designed for one PC and is not a network or multi-terminal system. Two
machines cannot share the database over a LAN: SQLite over a network share will
corrupt under concurrent writes. Changing this would require a client/server
architecture, not a setting.

If you need a second till:

1. Run a second, independent installation on the second PC, with its own
   database.
2. Reconcile deliberately — by hand, on a schedule you set.
3. Back both up separately.

Do not attempt to point both installations at one database file, and do not put
that file on a network share.

---

## 15. Troubleshooting

### 15.1 Quick table

| Symptom | Cause | Fix |
| --- | --- | --- |
| "Wrong username or password." | Wrong username or password. | Check capitals and spaces. After 5 wrong attempts the account locks for 15 minutes — wait and try again. |
| Account locked, correct password refused | 5 consecutive failures. | Wait 15 minutes, or reset the password from **Administration → Users** as an administrator. |
| Nobody can sign in at all | Everyone locked out or no administrator exists. | See [Section 5.5](#55-everyone-is-locked-out). Keep a second administrator account. |
| "You do not have access to this screen." | The role lacks **view** for that module. | Administrator: **Administration → Roles & permissions**, tick **view** for the module on that role. |
| "This period is locked. No entries can be added, changed or removed in it." | The month has been locked. | **Finance → Period lock** → **Unlock period**, or record the entry in the current month. |
| "Not enough stock for this line." | More was issued than is on hand. | Record a **New purchase**, correct the count with **Set stock**, or reduce the **Quantity**. |
| "Return rejected: …" | More was credited than was still returnable on that invoice. | Check the earlier credit notes raised against it. A credit may also not exceed the amount charged on the invoice. |
| "This backup was made by a newer version of the app." | The backup is from a later build. | Install the newer version, then restore. |
| "Database schema version N is newer than this build supports." | An older build was installed over a newer one. | Install the newer build again. To go back, also restore a backup taken before the update. |
| "Refusing to back up a corrupt database" | The live database failed its integrity check. | **Do not restore yet.** Export diagnostics and contact your supplier. |
| "The restore failed. Your existing data has not been changed." | The restore aborted before swapping the file. | Your data is intact. Try a different backup; contact your supplier if it persists. |
| Backup folder is empty | USB not plugged in, wrong folder, or no free space. | Plug the stick in; check **Backup folder** on the **Backup & restore** screen; click **Back up now** and read the message. |
| Backups are not running | **Daily automatic backup** off, or **Back up now** failing. | Check the switch on the **Backup & restore** screen; check free space and folder permissions. |
| App will not open | Startup failure, often a disk not ready. | Start it again. If it persists, export diagnostics if you can, or contact your supplier. Your data is almost certainly intact — the app stops before changing anything. |
| App is slow | Large backup running, or low free disk. | Normal during a backup. Below about 2 GB free, Windows slows everything down. |
| Startup is slow after an update | Schema migration on first run. | Normal once. The app will not start until the verified pre-migration backup has been written. |
| Printer produces nothing | Printer off, no paper, not the default. | Check the printer; use **Save as PDF** and print the PDF. Nothing is lost either way. |
| Screen shows **Something went wrong** | A renderer crash. | Press **Restart the screen**. A diagnostics file is on the Desktop; send it if it recurs. |
| Licence shows **Expired** | The key's expiry date has passed. | Ask your supplier for a new key. Data is never locked by an expired licence. |

### 15.2 Escalating

Send your supplier the diagnostics file from
[Section 11.2](#112-export-diagnostics) together with the exact message and the
app version. That is normally enough to diagnose anything without a site visit.