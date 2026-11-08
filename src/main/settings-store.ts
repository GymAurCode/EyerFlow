/**
 * Settings stored in the `settings` table.
 *
 * Backup settings live in settings.json (outside the database) so they survive
 * a database restore. Everything that describes the *business* - company name,
 * invoice wording, fiscal year, the donation rate and the partner split -
 * lives here, because those values must roll back with the data they describe.
 */

import type { SqliteDatabase } from "../data/connection";
import type { AppSettingsSnapshot, ThemePreference } from "../shared/ipc";
import { DEFAULT_THEME_ID, normaliseThemeId, type ThemeId } from "../shared/themes";

export const SETTING_KEYS = {
  theme: "theme",
  themePalette: "theme_palette",
  themeOnboardingComplete: "theme_onboarding_complete",
  companyName: "company_name",
  companyTrn: "company_trn",
  companyAddress: "company_address",
  companyPhone: "company_phone",
  companyEmail: "company_email",
  invoiceFooter: "invoice_footer",
  vendorName: "vendor_name",
  invoiceTerms: "invoice_terms",
  fiscalYearStartMonth: "fiscal_year_start_month",
  setupComplete: "setup_complete",
  donationRatePercent: "donation_rate_percent",
  logoPath: "logo_path",
  currency: "currency",
  vatRatePercent: "vat_rate_percent",
  allowNegativeStock: "allow_negative_stock",
} as const;

export const DEFAULT_SNAPSHOT: AppSettingsSnapshot = {
  theme: "light",
  themePalette: DEFAULT_THEME_ID,
  // A new install has not seen the first-login chooser yet.
  themeOnboardingComplete: false,
  companyName: "",
  companyTrn: "",
  companyAddress: "",
  companyPhone: "",
  companyEmail: "",
  companyLogoPath: "",
  // Derived at read time from `companyLogoPath` by `SettingsService`; a stored
  // snapshot has no file to read, so there is never an inline logo here.
  companyLogoDataUrl: null,
  invoiceFooter: "Thank you for your business.",
  vendorName: "Eyercall",
  invoiceTerms:
    "Goods once sold are not returnable unless defective. Warranty applies as per the manufacturer terms.",
  fiscalYearStartMonth: 1,
  backupDirectory: "",
  backupKeepCount: 30,
  dailyBackupEnabled: true,
  dailyBackupHour: 2,
  // Net profit -> 2% donation -> 98% split between the partners. The
  // donation is a percentage of net profit; each partner's own share lives
  // with the partner, and the two together must come to 98%.
  donationRatePercent: 2,
  currency: "PKR",
  vatRatePercent: 5,
  allowNegativeStock: false,
};

function readAll(db: SqliteDatabase): Map<string, string> {
  const rows = db.prepare("SELECT key, value FROM settings").all() as {
    key: string;
    value: string;
  }[];
  return new Map(rows.map((row) => [row.key, row.value]));
}

function asString(value: string | undefined, fallback: string): string {
  return value ?? fallback;
}

function asNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Read the stored theme preference.
 *
 * Anything unrecognised falls back to `system` rather than `light`: a value
 * written by a future version, or corrupted by hand, should follow the OS
 * instead of silently pinning the app to the light palette.
 */
function asThemePreference(value: string | undefined): ThemePreference {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : DEFAULT_SNAPSHOT.theme;
}

/**
 * Read the stored colour pack.
 *
 * An installation that predates the palette feature has no row at all, and a
 * row written by a newer build may name a pack this build does not ship. Both
 * land on Ocean Teal, which is exactly what those installations look like
 * today, so upgrading never changes a single pixel on its own.
 */
function asThemePalette(value: string | undefined): ThemeId {
  return value === undefined ? DEFAULT_THEME_ID : normaliseThemeId(value);
}

/** Snapshot with the file-backed backup settings merged in from the caller. */
export function loadSnapshot(
  db: SqliteDatabase,
  fileSettings: Pick<
    AppSettingsSnapshot,
    "backupDirectory" | "backupKeepCount" | "dailyBackupEnabled" | "dailyBackupHour"
  >,
): AppSettingsSnapshot {
  const raw = readAll(db);

  return {
    theme: asThemePreference(raw.get(SETTING_KEYS.theme)),
    themePalette: asThemePalette(raw.get(SETTING_KEYS.themePalette)),
    themeOnboardingComplete: raw.get(SETTING_KEYS.themeOnboardingComplete) === "1",
    companyName: asString(raw.get(SETTING_KEYS.companyName), DEFAULT_SNAPSHOT.companyName),
    companyTrn: asString(raw.get(SETTING_KEYS.companyTrn), DEFAULT_SNAPSHOT.companyTrn),
    companyAddress: asString(raw.get(SETTING_KEYS.companyAddress), DEFAULT_SNAPSHOT.companyAddress),
    companyPhone: asString(raw.get(SETTING_KEYS.companyPhone), DEFAULT_SNAPSHOT.companyPhone),
    companyEmail: asString(raw.get(SETTING_KEYS.companyEmail), DEFAULT_SNAPSHOT.companyEmail),
    companyLogoPath: asString(
      raw.get(SETTING_KEYS.logoPath),
      DEFAULT_SNAPSHOT.companyLogoPath,
    ),
    companyLogoDataUrl: null,
    invoiceFooter: asString(raw.get(SETTING_KEYS.invoiceFooter), DEFAULT_SNAPSHOT.invoiceFooter),
    vendorName: asString(raw.get(SETTING_KEYS.vendorName), DEFAULT_SNAPSHOT.vendorName),
    invoiceTerms: asString(raw.get(SETTING_KEYS.invoiceTerms), DEFAULT_SNAPSHOT.invoiceTerms),
    fiscalYearStartMonth: Math.min(
      Math.max(
        asNumber(raw.get(SETTING_KEYS.fiscalYearStartMonth), DEFAULT_SNAPSHOT.fiscalYearStartMonth),
        1,
      ),
      12,
    ),
    backupDirectory: fileSettings.backupDirectory,
    backupKeepCount: fileSettings.backupKeepCount,
    dailyBackupEnabled: fileSettings.dailyBackupEnabled,
    dailyBackupHour: fileSettings.dailyBackupHour,
    donationRatePercent: Math.min(
      Math.max(
        asNumber(raw.get(SETTING_KEYS.donationRatePercent), DEFAULT_SNAPSHOT.donationRatePercent),
        0,
      ),
      50,
    ),
    // The application trades in Pakistani Rupees and nothing else. An
    // installation that recorded a different label keeps its amounts exactly
    // as they are - the figures are plain integers and carry no currency of
    // their own - and is relabelled.
    currency: "PKR",
    vatRatePercent: Math.min(
      Math.max(asNumber(raw.get(SETTING_KEYS.vatRatePercent), DEFAULT_SNAPSHOT.vatRatePercent), 0),
      100,
    ),
    allowNegativeStock: asString(raw.get(SETTING_KEYS.allowNegativeStock), "0") === "1",
  };
}

const WRITABLE: readonly (keyof AppSettingsSnapshot)[] = [
  "theme",
  "themePalette",
  "themeOnboardingComplete",
  "companyName",
  "companyTrn",
  "companyAddress",
  "companyPhone",
  "companyEmail",
  "companyLogoPath",
  "invoiceFooter",
  "vendorName",
  "invoiceTerms",
  "fiscalYearStartMonth",
  "donationRatePercent",
  "vatRatePercent",
  "allowNegativeStock",
];

export function settingKeyFor(field: keyof AppSettingsSnapshot): string | null {
  switch (field) {
    case "theme":
      return SETTING_KEYS.theme;
    case "themePalette":
      return SETTING_KEYS.themePalette;
    case "themeOnboardingComplete":
      return SETTING_KEYS.themeOnboardingComplete;
    case "companyName":
      return SETTING_KEYS.companyName;
    case "companyTrn":
      return SETTING_KEYS.companyTrn;
    case "companyAddress":
      return SETTING_KEYS.companyAddress;
    case "companyPhone":
      return SETTING_KEYS.companyPhone;
    case "companyEmail":
      return SETTING_KEYS.companyEmail;
    case "companyLogoPath":
      return SETTING_KEYS.logoPath;
    case "invoiceFooter":
      return SETTING_KEYS.invoiceFooter;
    case "vendorName":
      return SETTING_KEYS.vendorName;
    case "invoiceTerms":
      return SETTING_KEYS.invoiceTerms;
    case "fiscalYearStartMonth":
      return SETTING_KEYS.fiscalYearStartMonth;
    case "donationRatePercent":
      return SETTING_KEYS.donationRatePercent;
    case "vatRatePercent":
      return SETTING_KEYS.vatRatePercent;
    case "allowNegativeStock":
      return SETTING_KEYS.allowNegativeStock;
    default:
      return null;
  }
}

export function writeSetting(db: SqliteDatabase, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}

export function isWritableField(field: keyof AppSettingsSnapshot): boolean {
  return WRITABLE.includes(field);
}

export function getSetting(db: SqliteDatabase, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function isSetupCompleteFlag(db: SqliteDatabase): boolean {
  return getSetting(db, SETTING_KEYS.setupComplete) === "1";
}
