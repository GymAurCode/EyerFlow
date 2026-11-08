/**
 * Zod validation schemas for every IPC payload.
 *
 * The renderer is treated as untrusted: it can be driven by a bug, a scanner,
 * or a crafted request. Every value crossing the bridge is parsed here before
 * any SQL runs, so a malformed payload produces a typed `ApiError` naming the
 * field rather than a SQLite constraint error.
 */

import { z } from "zod";
import { THEME_IDS } from "./themes";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date format YYYY-MM-DD.")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "That date does not exist.");

const nullableText = (max: number) => z.string().max(max).nullable().optional();

const optionalIsoDate = isoDate.nullable().optional();

/** Empty is allowed; anything else has to look like an address. */
const optionalEmail = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => value === "" || z.string().email().safeParse(value).success, {
      message: "Enter a valid email address.",
    });

const quantityMilli = z
  .number()
  .int("Quantities are stored in thousandths: 1 unit = 1000.")
  .min(-1_000_000_000)
  .max(1_000_000_000);

const id = z.number().int().positive();

const documentKind = z.enum(["invoice", "purchaseInvoice", "stockAdjustment"]);

const vatTreatment = z.enum(["standard", "zero", "exempt", "outsideScope"]);

const partyKind = z.enum(["customer", "supplier", "both"]);

const limit = z.number().int().min(1).max(5000).optional();

/* -------------------------------------------------------------------------- */
/* auth                                                                       */
/* -------------------------------------------------------------------------- */

export const setupStatusSchema = z.object({});

export const setupSchema = z.object({
  companyName: z.string().trim().min(1).max(120),
  companyTrn: z.string().trim().max(32).default(""),
  companyAddress: z.string().trim().max(240).default(""),
  companyPhone: z.string().trim().max(40).default(""),
  fiscalYearStartMonth: z.number().int().min(1).max(12).default(1),
  adminUsername: z.string().trim().min(3).max(60),
  adminDisplayName: z.string().trim().min(1).max(120),
  adminPassword: z.string().min(8).max(200),
});

export const loginSchema = z.object({
  username: z.string().trim().min(1).max(60),
  password: z.string().min(1).max(200),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200),
});

/**
 * A forgotten password reset proved with an EyerCall recovery code.
 *
 * The code is deliberately only a string here: the accepted values live in the
 * main process, so a renderer or a devtools session cannot read them from the
 * shared bundle.
 */
export const recoverPasswordSchema = z.object({
  username: z.string().trim().min(1).max(60),
  secretCode: z.string().trim().min(1).max(60),
  newPassword: z.string().min(8).max(200),
});

export const profileGetSchema = z.object({});

/**
 * The signed-in user's own details.
 *
 * `avatarPath` is a bare file name, not a path: the main process checks it
 * against the names the avatar store generates, so a crafted value cannot reach
 * a file outside the avatars folder. Leaving it out means "keep the stored
 * picture"; passing "" means "go back to initials".
 */
export const profileUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  email: z
    .string()
    .trim()
    .max(254)
    .refine((value) => value === "" || z.string().email().safeParse(value).success, {
      message: "Enter a valid email address.",
    }),
  phone: z.string().trim().max(40),
  avatarPath: z
    .string()
    .trim()
    .max(40)
    .refine((value) => value === "" || /^\d+\.(png|jpe?g|webp)$/i.test(value), {
      message: "That profile picture could not be used.",
    })
    .optional(),
});

export const hasPermissionSchema = z.object({
  module: z.string().min(1).max(40),
  action: z.string().min(1).max(20),
});

export const licenseCheckSchema = z.object({});

export const licenseActivateSchema = z.object({
  key: z.string().min(1).max(4096),
});

export const licenseStatusSchema = z.object({});

/* -------------------------------------------------------------------------- */
/* registration                                                               */
/* -------------------------------------------------------------------------- */

export const registrationStatusSchema = z.object({});

const registrationAuthorisation = {
  username: z.string().trim().min(1).max(60),
  password: z.string().min(1).max(200),
};

export const registrationDetailsSchema = z.object(registrationAuthorisation);

export const registrationUpdateSchema = z.object({
  ...registrationAuthorisation,
  companyName: z.string().trim().min(1).max(120),
  companyTrn: z.string().trim().max(32).default(""),
  companyAddress: z.string().trim().max(240).default(""),
  companyPhone: z.string().trim().max(40).default(""),
  companyEmail: optionalEmail(160).default(""),
  ownerName: z.string().trim().min(1).max(120),
  ownerEmail: optionalEmail(254).default(""),
  ownerPhone: z.string().trim().max(40).default(""),
});

export const registrationCreateAccountSchema = z.object({
  authorizedUsername: z.string().trim().min(1).max(60),
  authorizedPassword: z.string().min(1).max(200),
  username: z.string().trim().min(3).max(60),
  displayName: z.string().trim().min(1).max(120),
  email: optionalEmail(254).default(""),
  phone: z.string().trim().max(40).default(""),
  password: z.string().min(8).max(200),
  role: z.enum(["Administrator", "Staff"]),
});

/* -------------------------------------------------------------------------- */
/* parties                                                                    */
/* -------------------------------------------------------------------------- */

export const partyListSchema = z.object({
  kind: partyKind.optional(),
  onlyActive: z.boolean().optional(),
  search: z.string().max(120).optional(),
  limit,
});

export const partyGetSchema = z.object({ id });
export const partyDeleteSchema = z.object({ id });

export const partySaveSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(120),
  kind: partyKind,
  phone: nullableText(40),
  email: nullableText(160),
  trn: nullableText(32),
  addressLine: nullableText(240),
  isActive: z.boolean().optional(),
});

/* -------------------------------------------------------------------------- */
/* products                                                                   */
/* -------------------------------------------------------------------------- */

export const productListSchema = z.object({
  search: z.string().max(120).optional(),
  category: z.string().max(60).optional(),
  onlyActive: z.boolean().optional(),
  onlyLowStock: z.boolean().optional(),
  limit,
});

export const productGetSchema = z.object({ id });
export const productDeleteSchema = z.object({ id });

export const productSaveSchema = z.object({
  id: id.optional(),
  sku: z.string().trim().max(40).optional(),
  barcode: nullableText(60),
  name: z.string().trim().min(1).max(200),
  description: nullableText(500),
  category: nullableText(60),
  unit: z.string().trim().max(20).optional(),
  reorderLevelMilli: quantityMilli.default(0),
  salePriceFils: z.number().int().min(0).max(1_000_000_000).default(0),
  vatTreatment: vatTreatment.optional(),
  isActive: z.boolean().optional(),
  openingQuantityMilli: quantityMilli.default(0),
});

export const openStockSchema = z.object({
  productId: id,
  quantityMilli,
  unitCostFils: z.number().int().min(0).max(1_000_000_000),
  notes: z.string().max(240).optional(),
});

export const stockMovementListSchema = z.object({
  productId: id.optional(),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
  kind: z.enum(["receipt", "issue", "reversal", "adjustmentIn", "adjustmentOut"]).optional(),
  limit,
});

/* -------------------------------------------------------------------------- */
/* documents                                                                  */
/* -------------------------------------------------------------------------- */

export const documentListSchema = z.object({
  kind: documentKind.optional(),
  partyId: id.optional(),
  status: z.enum(["draft", "issued", "partPaid", "paid", "cancelled"]).optional(),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
  search: z.string().max(120).optional(),
  limit,
});

export const documentGetSchema = z.object({ id });

export const documentSaveSchema = z.object({
  id: id.optional(),
  kind: documentKind,
  partyId: id.nullable(),
  issueDate: isoDate,
  dueDate: isoDate.nullable().optional(),
  status: z.enum(["draft", "issued"]),
  notes: nullableText(1000),
  paidAmountFils: z.number().int().min(0).max(1_000_000_000).default(0),
  discountFils: z.number().int().min(0).max(1_000_000_000).default(0),
  lines: z
    .array(
      z.object({
        productId: id.nullable(),
        description: z.string().trim().min(1).max(240),
        quantityMilli,
        unitPriceFils: z.number().int().min(0).max(1_000_000_000),
        vatTreatment: vatTreatment.default("standard"),
        unitCostFils: z.number().int().min(0).max(1_000_000_000).optional(),
      }),
    )
    .min(1, "A document needs at least one line."),
});

export const documentCancelSchema = z.object({
  id,
  reason: z.string().trim().min(1).max(240),
});

export const documentDeleteSchema = z.object({ id });

export const numberPreviewSchema = z.object({
  kind: z.enum(["invoice", "purchaseInvoice"]),
});

/* -------------------------------------------------------------------------- */
/* payments                                                                   */
/* -------------------------------------------------------------------------- */

export const paymentListSchema = z.object({
  direction: z.enum(["inbound", "outbound"]).optional(),
  partyId: id.optional(),
  documentId: id.optional(),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
  limit,
});

export const paymentSaveSchema = z.object({
  direction: z.enum(["inbound", "outbound"]),
  partyId: id,
  paymentDate: isoDate,
  method: z.enum(["cash", "bank", "card"]).default("cash"),
  amountFils: z.number().int().positive().max(1_000_000_000),
  reference: nullableText(120),
  notes: nullableText(500),
  allocations: z
    .array(z.object({ documentId: id, amountFils: z.number().int().positive() }))
    .optional(),
});

export const paymentDeleteSchema = z.object({ id });

/* -------------------------------------------------------------------------- */
/* expenses                                                                   */
/* -------------------------------------------------------------------------- */

export const expenseListSchema = z.object({
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
  category: z.string().max(60).optional(),
  search: z.string().max(120).optional(),
  limit,
});

export const expenseSaveSchema = z.object({
  id: id.optional(),
  expenseDate: isoDate,
  category: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(240),
  amountFils: z.number().int().positive().max(1_000_000_000),
  vatFils: z.number().int().min(0).max(1_000_000_000).default(0),
  paymentMethod: z.enum(["cash", "bank", "card"]).default("cash"),
  reference: nullableText(120),
  notes: nullableText(500),
  /** The Chart of Accounts account to charge the expense to. */
  accountCode: z.string().trim().max(20).nullable().optional(),
  /** How much was paid now. The rest is a liability until it is settled. */
  paidFils: z.number().int().min(0).max(1_000_000_000).optional(),
});

export const expenseDeleteSchema = z.object({ id });

/* -------------------------------------------------------------------------- */
/* partners                                                                   */
/* -------------------------------------------------------------------------- */

export const partnerListSchema = z.object({});

export const partnerTransactionsSchema = z.object({
  limit: z.number().int().min(1).max(1000).optional(),
});

export const partnerSaveSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(120),
  sharePercent: z.number().min(0).max(100),
  isActive: z.boolean().optional(),
});

/* -------------------------------------------------------------------------- */
/* users                                                                      */
/* -------------------------------------------------------------------------- */

export const userListSchema = z.object({});

export const userSaveSchema = z.object({
  id: id.optional(),
  username: z.string().trim().min(3).max(60),
  displayName: z.string().trim().min(1).max(120),
  roleId: id.nullable(),
  isActive: z.boolean().optional(),
  password: z.string().min(8).max(200).optional(),
  mustChangePassword: z.boolean().optional(),
});

export const resetPasswordSchema = z.object({
  id,
  newPassword: z.string().min(8).max(200),
  mustChangePassword: z.boolean().optional(),
});

/* -------------------------------------------------------------------------- */
/* settings                                                                   */
/* -------------------------------------------------------------------------- */

export const settingsGetSchema = z.object({});

export const settingsUpdateSchema = z
  .object({
    theme: z.enum(["light", "dark", "system"]).optional(),
    /**
     * The colour pack, validated against the shipped catalogue.
     *
     * This schema is `.strict()`, so a field it does not list is rejected
     * outright. That is deliberate: an unknown pack is a client bug, and
     * silently storing it would leave the window on whatever colours the
     * stylesheet fell back to.
     */
    themePalette: z.enum(THEME_IDS).optional(),
    /** Set once the first-login theme chooser has been dealt with. */
    themeOnboardingComplete: z.boolean().optional(),
    companyName: z.string().trim().max(120).optional(),
    companyTrn: z.string().trim().max(32).optional(),
    companyAddress: z.string().trim().max(240).optional(),
    companyPhone: z.string().trim().max(40).optional(),
    companyEmail: z.string().trim().max(160).optional(),
    companyLogoPath: z.string().trim().max(1024).optional(),
    invoiceFooter: z.string().trim().max(500).optional(),
    vendorName: z.string().trim().max(80).optional(),
    invoiceTerms: z.string().trim().max(800).optional(),
    fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
    /**
     * The application trades in Pakistani Rupees only. The field is still
     * accepted so a client that sends it is not rejected outright, but only
     * "PKR" passes: any other currency is a mistake, and silently keeping the
     * old one would hide it.
     */
    currency: z.literal("PKR").optional(),
    backupDirectory: z.string().trim().max(1024).optional(),
    backupKeepCount: z.number().int().min(1).max(3650).optional(),
    dailyBackupEnabled: z.boolean().optional(),
    dailyBackupHour: z.number().int().min(0).max(23).optional(),
    donationRatePercent: z.number().min(0).max(50).optional(),
    vatRatePercent: z.number().min(0).max(100).optional(),
    allowNegativeStock: z.boolean().optional(),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* reports and dashboard                                                      */
/* -------------------------------------------------------------------------- */

export const dashboardSchema = z.object({
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
  previousFromDate: isoDate.optional(),
  previousToDate: isoDate.optional(),
  includeInventory: z.boolean().optional(),
});

export const pnlSchema = z.object({ fromDate: isoDate, toDate: isoDate });

export const partnerSplitSchema = z.object({ fromDate: isoDate, toDate: isoDate });

export const stockValuationSchema = z.object({});

export const documentRegisterSchema = z.object({
  kind: z.enum(["invoice", "purchaseInvoice"]),
  fromDate: isoDate,
  toDate: isoDate,
  status: z.enum(["draft", "issued", "partPaid", "paid", "cancelled"]).optional(),
  partyId: z.number().int().positive().optional(),
  search: z.string().max(120).optional(),
});

export const exportSchema = z.object({
  dataset: z.enum(["profitAndLoss", "partnerSplit", "sales", "stock"]),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
});

/* -------------------------------------------------------------------------- */
/* finance                                                                     */
/* -------------------------------------------------------------------------- */

const accountType = z.enum(["asset", "liability", "equity", "income", "expense"]);

const accountSubtype = z.enum([
  "currentAsset",
  "fixedAsset",
  "contraAsset",
  "currentLiability",
  "longTermLiability",
  "equity",
  "operatingIncome",
  "otherIncome",
  "cogs",
  "operatingExpense",
  "otherExpense",
]);

export const financeOverviewSchema = z.object({
  fromDate: isoDate,
  toDate: isoDate,
  asOfDate: isoDate,
  previousFromDate: isoDate,
  previousToDate: isoDate,
  granularity: z.enum(["day", "week", "month", "quarter", "year"]).optional(),
});

export const financeChartSchema = z.object({});

export const financeAccountSaveSchema = z.object({
  id: id.optional(),
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(120),
  type: accountType,
  subtype: accountSubtype.nullable().optional(),
  parentId: id.nullable().optional(),
  normalBalance: z.enum(["debit", "credit"]).optional(),
  description: nullableText(500),
  isActive: z.boolean().optional(),
});

export const financeAccountIdSchema = z.object({ id });

export const financeAccountActiveSchema = z.object({ id, isActive: z.boolean() });

export const financeGeneralLedgerSchema = z.object({
  code: z.string().trim().min(1).max(20),
  fromDate: isoDate,
  toDate: isoDate,
});

export const financeJournalListSchema = z.object({
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
  source: z
    .enum([
      "purchase",
      "sale",
      "payment",
      "expense",
      "manual",
      "transfer",
      "opening",
      "reversal",
      "adjustment",
    ])
    .optional(),
  status: z.enum(["draft", "posted", "reversed"]).optional(),
  search: z.string().max(120).optional(),
  accountCode: z.string().max(20).optional(),
  limit,
});

export const financeJournalGetSchema = z.object({ id });

export const financeJournalSaveSchema = z.object({
  id: id.optional(),
  entryDate: isoDate,
  description: z.string().trim().min(1).max(500),
  reference: nullableText(120),
  postNow: z.boolean().optional(),
  lines: z
    .array(
      z.object({
        accountCode: z.string().trim().min(1).max(20),
        debitFils: z.number().int().min(0).max(1_000_000_000_000),
        creditFils: z.number().int().min(0).max(1_000_000_000_000),
        description: nullableText(240),
      }),
    )
    .min(2, "A journal entry needs at least two lines."),
});

export const financeJournalReverseSchema = z.object({
  id,
  reason: z.string().trim().min(1).max(240),
});

export const financeTrialBalanceSchema = z.object({ fromDate: isoDate, toDate: isoDate });

export const financeBalanceSheetSchema = z.object({ asOfDate: isoDate });

export const financePnlSchema = z.object({ fromDate: isoDate, toDate: isoDate });

export const financeCashFlowSchema = z.object({ fromDate: isoDate, toDate: isoDate });

export const financeAgingSchema = z.object({
  asOfDate: isoDate,
  side: z.enum(["receivable", "payable"]),
});

export const financePartyStatementSchema = z.object({
  partyId: id,
  kind: z.enum(["customer", "supplier"]),
  fromDate: isoDate,
  toDate: isoDate,
});

export const financePartyBalancesSchema = z.object({
  kind: z.enum(["customer", "supplier"]),
  asOfDate: isoDate,
});

export const financeCashBookSchema = z.object({
  accountCode: z.string().trim().min(1).max(20),
  fromDate: isoDate,
  toDate: isoDate,
});

export const financePeriodComparisonSchema = z.object({
  fromDate: isoDate,
  toDate: isoDate,
  previousFromDate: isoDate,
  previousToDate: isoDate,
});

export const financeExportSchema = z.object({
  dataset: z.enum([
    "chartOfAccounts",
    "trialBalance",
    "balanceSheet",
    "profitAndLoss",
    "cashFlow",
    "generalLedger",
    "journalRegister",
    "receivableAging",
    "payableAging",
    "cashBook",
    "expenseBreakdown",
    "customerStatement",
    "supplierStatement",
    "periodComparison",
  ]),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
  accountCode: z.string().max(20).optional(),
  partyId: id.optional(),
  partyKind: z.enum(["customer", "supplier"]).optional(),
});

export const financeTransferSchema = z.object({
  transferDate: isoDate,
  fromAccountCode: z.string().trim().min(1).max(20),
  toAccountCode: z.string().trim().min(1).max(20),
  amountFils: z.number().int().positive().max(1_000_000_000_000),
  reference: nullableText(120),
});

export const financeRecordPaymentSchema = z.object({
  direction: z.enum(["inbound", "outbound"]),
  partyId: id,
  paymentDate: isoDate,
  method: z.enum(["cash", "bank", "card"]).default("cash"),
  amountFils: z.number().int().positive().max(1_000_000_000_000),
  reference: nullableText(120),
  notes: nullableText(500),
  allocations: z
    .array(z.object({ documentId: id, amountFils: z.number().int().positive() }))
    .optional(),
  postingKind: z
    .enum([
      "auto",
      "customerAdvance",
      "supplierAdvance",
      "expense",
      "ownerDrawing",
      "ownerContribution",
      "fixedAsset",
      "otherIncome",
      "otherExpense",
    ])
    .optional(),
  cashAccountCode: z.string().max(20).optional(),
  expenseAccountCode: z.string().max(20).optional(),
});

export const financePeriodSaveSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(120),
  startDate: isoDate,
  endDate: isoDate,
});

export const financePeriodIdSchema = z.object({ id });

export const financeOpeningBalancesSchema = z.object({
  entryDate: isoDate,
  balances: z
    .array(
      z.object({
        accountCode: z.string().trim().min(1).max(20),
        debitFils: z.number().int().min(0).max(1_000_000_000_000),
        creditFils: z.number().int().min(0).max(1_000_000_000_000),
      }),
    )
    .min(1),
});

export const financeMigrationAuditSchema = z.object({});

export const financeBackfillSchema = z.object({ confirm: z.boolean() });

/* -------------------------------------------------------------------------- */
/* non-RPC channels                                                           */
/* -------------------------------------------------------------------------- */
export const backupVerifySchema = z.string().min(1).max(1024);

export const backupRestoreSchema = z.object({
  path: z.string().min(1).max(1024),
  confirmation: z.string().min(1).max(40),
});

export const printHtmlSchema = z.object({
  html: z.string().min(1).max(8_000_000),
  options: z.object({
    silent: z.boolean(),
    paperSize: z.enum(["A4", "A5", "Letter"]),
    landscape: z.boolean(),
    copies: z.number().int().min(1).max(50),
    footerLabel: z.string().max(160).optional(),
  }),
});

export const savePdfSchema = z.object({
  html: z.string().min(1).max(8_000_000),
  suggestedName: z.string().min(1).max(160),
  footerLabel: z.string().max(160).optional(),
});

export const openExternalSchema = z.object({ url: z.string().min(1).max(2048) });

/* -------------------------------------------------------------------------- */
/* IMS (restored)                                                             */
/* -------------------------------------------------------------------------- */

export const imsGetSchema = z.object({ id });

export const imsDashboardSchema = z.object({
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
  locationId: id.optional(),
  category: z.string().max(60).optional(),
});

export const imsReportSchema = z.object({
  report: z.string(),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
  locationId: id.optional(),
  category: z.string().max(60).optional(),
  partyId: id.optional(),
  status: z.string().max(40).optional(),
  search: z.string().max(120).optional(),
});

export const imsConfigUpdateSchema = z.object({
  negativeStockPolicy: z.enum(["block", "allow"]).optional(),
  valuationMethod: z.enum(["lastCost", "weightedAverage", "fifo"]).optional(),
  barcodePrefix: z.string().trim().max(8).optional(),
  skuPrefix: z.string().trim().max(8).optional(),
  purchaseApprovalThresholdFils: z.number().int().min(0).max(1_000_000_000).optional(),
  salesDiscountLimitPercent: z.number().min(0).max(100).optional(),
  returnPolicyDays: z.number().int().min(0).max(3650).optional(),
  requireBatchOnReceipt: z.boolean().optional(),
  requireSerialOnReceipt: z.boolean().optional(),
  allowQuarantineRestock: z.boolean().optional(),
  defaultLocationId: id.nullable().optional(),
  salesApprovalRequired: z.boolean().optional(),
  allowBackflush: z.boolean().optional(),
});

export const imsLocationSaveSchema = z.object({
  id: id.optional(),
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(120),
  type: z.enum(["store", "branch", "warehouse", "shop", "quarantine", "damaged", "transit"]),
  address: nullableText(240),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const imsBrandSaveSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(60),
  isActive: z.boolean().optional(),
});

export const imsUnitSaveSchema = z.object({
  id: id.optional(),
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(60),
  baseCode: nullableText(20),
  factorMilli: z.number().int().min(1).max(1_000_000_000),
  isActive: z.boolean().optional(),
});

export const imsCategoryRenameSchema = z.object({
  from: z.string().trim().min(1).max(60),
  to: z.string().trim().min(1).max(60),
});

export const imsPriceListSaveSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["retail", "wholesale", "customer"]),
  partyId: id.nullable().optional(),
  isActive: z.boolean().optional(),
});

export const imsPriceItemSaveSchema = z.object({
  id: id.optional(),
  priceListId: id,
  productId: id,
  priceFils: z.number().int().min(0).max(1_000_000_000),
  minQuantityMilli: z.number().int().min(1).max(1_000_000_000).optional(),
  discountLimitPercent: z.number().min(0).max(100).optional(),
  effectiveFrom: optionalIsoDate,
  effectiveTo: optionalIsoDate,
});

export const imsPriceItemDeleteSchema = z.object({ id });

export const imsPriceItemsListSchema = z.object({ priceListId: id });

export const imsResolvePriceSchema = z.object({
  productId: id,
  partyId: id.nullable().optional(),
  quantityMilli: z.number().int().positive().max(1_000_000_000).optional(),
  date: isoDate.optional(),
});

export const imsReplenishmentSchema = z.object({
  locationId: id.optional(),
  supplierId: id.optional(),
  limit,
});

export const imsReplenishmentConvertSchema = z.object({
  productIds: z.array(id).min(1),
  supplierId: id.nullable().optional(),
  locationId: id.optional(),
});

export const imsPosOpenSchema = z.object({
  registerName: z.string().trim().min(1).max(80),
  openingFloatFils: z.number().int().min(0).max(1_000_000_000),
});

export const imsPosCloseSchema = z.object({
  id,
  closingCountedFils: z.number().int().min(0).max(1_000_000_000),
  notes: nullableText(500),
});

export const imsPosSaleSchema = z.object({
  clientToken: z.string().trim().min(8).max(80),
  shiftId: id,
  customerId: id.nullable().optional(),
  lines: z
    .array(
      z.object({
        productId: id,
        description: z.string().trim().min(1).max(240),
        quantityMilli: z.number().int().positive().max(1_000_000_000),
        unitPriceFils: z.number().int().min(0).max(1_000_000_000),
        discountFils: z.number().int().min(0).max(1_000_000_000).optional(),
        vatTreatment: vatTreatment.optional(),
      }),
    )
    .min(1),
  discountFils: z.number().int().min(0).max(1_000_000_000).optional(),
  paymentMethod: z.enum(["cash", "bank", "card"]),
  tenderedFils: z.number().int().min(0).max(1_000_000_000),
  notes: nullableText(500),
  complete: z.boolean().optional(),
});

export const imsPosStateSchema = z.object({});
export const imsPosHistorySchema = z.object({ limit: z.number().int().min(1).max(500).optional() });

export const imsProductDetailSchema = z.object({ id });

export const imsVariantListSchema = z.object({
  parentId: id.optional(),
  search: z.string().max(120).optional(),
  limit,
});

export const imsVariantSaveSchema = z.object({
  parentId: id,
  id: id.optional(),
  name: z.string().trim().max(200).optional(),
  variantLabel: z.string().trim().min(1).max(120),
  sku: z.string().trim().max(40).optional(),
  barcode: nullableText(60),
  salePriceFils: z.number().int().min(0).max(1_000_000_000).optional(),
  openingQuantityMilli: quantityMilli.optional(),
  isActive: z.boolean().optional(),
});

export const imsSaveSchema = z.object({
  id: id.optional(),
  kind: z.enum([
    "purchaseRequisition",
    "purchaseOrder",
    "goodsReceipt",
    "supplierReturn",
    "salesQuotation",
    "salesOrder",
    "salesReturn",
    "stockTransfer",
    "stockCount",
    "purchaseAdjustment",
  ]),
  partyId: id.nullable().optional(),
  fromLocationId: id.nullable().optional(),
  toLocationId: id.nullable().optional(),
  sourceId: id.nullable().optional(),
  issueDate: isoDate,
  dueDate: optionalIsoDate,
  requiredDate: optionalIsoDate,
  reference: nullableText(120),
  notes: nullableText(1000),
  reason: nullableText(500),
  discountFils: z.number().int().min(0).max(1_000_000_000).optional(),
  clientToken: z.string().trim().min(8).max(80).nullable().optional(),
  lines: z.array(
    z.object({
      productId: id.nullable(),
      description: z.string().trim().min(1).max(240),
      quantityMilli: quantityMilli,
      unitCostFils: z.number().int().min(0).max(1_000_000_000).optional(),
      unitPriceFils: z.number().int().min(0).max(1_000_000_000).optional(),
      discountFils: z.number().int().min(0).max(1_000_000_000).optional(),
      vatTreatment: vatTreatment.optional(),
      batchNo: nullableText(80),
      expiryDate: optionalIsoDate,
      conditionNote: nullableText(240),
      serials: nullableText(4000),
      sourceLineId: id.nullable().optional(),
      expectedMilli: quantityMilli.nullable().optional(),
      countedMilli: quantityMilli.nullable().optional(),
      restock: z.boolean().optional(),
    }),
  ),
});

export const imsTransitionSchema = z.object({
  id,
  action: z.enum([
    "submit",
    "approve",
    "reject",
    "cancel",
    "close",
    "confirm",
    "dispatch",
    "receive",
    "post",
    "fulfil",
  ]),
  reason: nullableText(500),
  locationId: id.nullable().optional(),
});

export const imsConvertSchema = z.object({
  id,
  targetKind: z.enum([
    "purchaseRequisition",
    "purchaseOrder",
    "goodsReceipt",
    "supplierReturn",
    "salesQuotation",
    "salesOrder",
    "salesReturn",
    "stockTransfer",
    "stockCount",
    "purchaseAdjustment",
  ]),
  clientToken: z.string().trim().min(8).max(80).nullable().optional(),
});

export const imsReceiveTransferSchema = z.object({
  id,
  lines: z
    .array(
      z.object({
        lineId: id,
        quantityMilli: z.number().int().positive().max(1_000_000_000),
      }),
    )
    .min(1),
});

export const imsStockOverviewSchema = z.object({
  search: z.string().max(120).optional(),
  category: z.string().max(60).optional(),
  locationId: id.optional(),
  onlyLow: z.boolean().optional(),
  onlyOut: z.boolean().optional(),
  limit,
});

export const imsStockListSchema = z.object({
  productId: id.optional(),
  search: z.string().max(120).optional(),
  expiringDays: z.number().int().min(0).max(3650).optional(),
  limit,
});

export const imsReservationListSchema = z.object({
  productId: id.optional(),
  status: z.enum(["active", "released", "consumed"]).optional(),
  limit,
});

export const imsReleaseReservationSchema = z.object({ id });

export const imsListSchema = z.object({
  kind: z.enum([
    "purchaseRequisition",
    "purchaseOrder",
    "goodsReceipt",
    "supplierReturn",
    "salesQuotation",
    "salesOrder",
    "salesReturn",
    "stockTransfer",
    "stockCount",
    "purchaseAdjustment",
  ]).optional(),
  status: z.string().optional(),
  partyId: id.optional(),
  locationId: id.optional(),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
  search: z.string().max(120).optional(),
  limit,
});

/* -------------------------------------------------------------------------- */
/* MMS                                                                        */
/* -------------------------------------------------------------------------- */

export const mmsBomType = z.enum([
  "assembly",
  "recipe",
  "subcontract",
  "multiLevel",
]);

export const mmsBomStatus = z.enum([
  "draft",
  "review",
  "approved",
  "superseded",
  "archived",
]);

export const mmsSaveBomSchema = z.object({
  id: id.optional(),
  number: z.string().trim().max(40).optional(),
  productId: id,
  variantId: id.nullable().optional(),
  name: z.string().trim().min(1).max(200),
  description: nullableText(500),
  bomType: mmsBomType.optional(),
  baseOutputQuantity: quantityMilli.optional(),
  outputUnit: z.string().trim().max(20).optional(),
  expectedScrapPercent: z.number().min(0).max(100).optional(),
  routingId: id.nullable().optional(),
  expectedProductionTimeMinutes: z.number().int().min(0).optional(),
  effectiveFrom: isoDate.optional(),
  effectiveTo: isoDate.nullable().optional(),
  status: mmsBomStatus.optional(),
});

export const mmsSaveBomComponentSchema = z.object({
  id: id.optional(),
  bomId: id,
  componentProductId: id,
  quantityPerUnit: quantityMilli.positive(),
  unit: z.string().trim().max(20).optional(),
  scrapPercent: z.number().min(0).max(100).optional(),
  isOptional: z.boolean().optional(),
  substitutionAllowed: z.boolean().optional(),
  lineNo: z.number().int().positive().optional(),
  notes: nullableText(500),
});

export const mmsBomListSchema = z.object({
  productId: id.optional(),
  status: mmsBomStatus.optional(),
  bomType: mmsBomType.optional(),
  search: z.string().max(120).optional(),
  limit,
});

export const mmsSaveRouteSchema = z.object({
  id: id.optional(),
  number: z.string().trim().max(40).optional(),
  name: z.string().trim().min(1).max(200),
  description: nullableText(500),
  status: mmsBomStatus.optional(),
  effectiveFrom: isoDate.optional(),
  effectiveTo: isoDate.nullable().optional(),
});

export const mmsSaveRouteOperationSchema = z.object({
  id: id.optional(),
  routeId: id,
  operationCode: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  description: nullableText(500),
  sequence: z.number().int().positive().optional(),
  prerequisiteOpId: id.nullable().optional(),
  workCenterId: id.nullable().optional(),
  setupTimeMinutes: z.number().int().min(0).optional(),
  cycleTimeMinutes: z.number().int().min(0).optional(),
  expectedOutputQty: quantityMilli.optional(),
  laborRequired: z.number().int().min(1).optional(),
  costRateFilsPerHour: z.number().int().min(0).optional(),
  qualityCheckpoint: z.boolean().optional(),
  workInstructions: nullableText(2000),
});

export const mmsRouteListSchema = z.object({
  status: mmsBomStatus.optional(),
  search: z.string().max(120).optional(),
  limit,
});

export const mmsSaveWorkCenterSchema = z.object({
  id: id.optional(),
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  plant: nullableText(120),
  type: z.string().trim().max(40).optional(),
  capacity: z.number().int().positive().optional(),
  capacityUnit: z.string().trim().max(40).optional(),
  operatingSchedule: nullableText(500),
  shiftId: id.nullable().optional(),
  hourlyOperatingCostFils: z.number().int().min(0).optional(),
  availabilityPct: z.number().min(0).max(100).optional(),
  efficiencyPct: z.number().min(0).max(100).optional(),
  maintenanceStatus: z.string().max(40).optional(),
  isActive: z.boolean().optional(),
});

export const mmsWorkCenterListSchema = z.object({
  isActive: z.boolean().optional(),
  search: z.string().max(120).optional(),
  limit,
});

export const mmsSaveEquipmentSchema = z.object({
  id: id.optional(),
  machineCode: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  workCenterId: id.nullable().optional(),
  status: z.string().max(40).optional(),
  capacity: z.number().int().positive().nullable().optional(),
  setupTimeMinutes: z.number().int().min(0).optional(),
  operatingRateFilsPerHour: z.number().int().min(0).optional(),
});

export const mmsEquipmentListSchema = z.object({
  workCenterId: id.optional(),
  status: z.string().max(40).optional(),
  search: z.string().max(120).optional(),
  limit,
});

export const mmsMoStatus = z.enum([
  "planned",
  "confirmed",
  "released",
  "inProgress",
  "qualityReview",
  "completed",
  "closed",
  "hold",
  "cancelled",
]);

export const mmsSaveManufacturingOrderSchema = z.object({
  id: id.optional(),
  number: z.string().trim().max(40).optional(),
  productId: id,
  variantId: id.nullable().optional(),
  bomId: id,
  routeId: id.nullable().optional(),
  plannedQuantity: quantityMilli.positive(),
  unit: z.string().trim().max(20).optional(),
  plannedStart: isoDate.nullable().optional(),
  plannedFinish: isoDate.nullable().optional(),
  plant: nullableText(120),
  sourceDemand: nullableText(200),
  priority: z.number().int().min(0).optional(),
  status: mmsMoStatus.optional(),
});

export const mmsMoListSchema = z.object({
  productId: id.optional(),
  status: mmsMoStatus.optional(),
  plant: z.string().max(120).optional(),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
  search: z.string().max(120).optional(),
  limit,
});

export const mmsWorkOrderStatus = z.enum([
  "blocked",
  "ready",
  "inProgress",
  "paused",
  "completed",
  "hold",
  "cancelled",
]);

export const mmsSaveWorkOrderSchema = z.object({
  id: id.optional(),
  moId: id,
  routeOperationId: id,
  workCenterId: id.nullable().optional(),
  operatorId: id.nullable().optional(),
  plannedQuantity: quantityMilli.optional(),
  status: mmsWorkOrderStatus.optional(),
  notes: nullableText(500),
});

export const mmsWorkOrderListSchema = z.object({
  moId: id.optional(),
  workCenterId: id.optional(),
  status: mmsWorkOrderStatus.optional(),
  operatorId: id.optional(),
  limit,
});

export const mmsSaveJobTimeLogSchema = z.object({
  workOrderId: id,
  operatorId: id.nullable().optional(),
  startedAt: isoDate,
  endedAt: isoDate.nullable().optional(),
  downtimeMinutes: z.number().int().min(0).optional(),
  downtimeReason: nullableText(240),
});

export const mmsIssueType = z.enum(["reservation", "issue", "return"]);

export const mmsSaveMaterialIssueSchema = z.object({
  moId: id,
  workOrderId: id.nullable().optional(),
  componentProductId: id,
  quantityMilli: quantityMilli.positive(),
  issueType: mmsIssueType.optional(),
  fromLocationId: id.nullable().optional(),
  toLocationId: id.nullable().optional(),
  idempotencyKey: z.string().trim().min(8).max(80).optional(),
});

export const mmsSaveConsumptionRecordSchema = z.object({
  moId: id,
  workOrderId: id.nullable().optional(),
  componentProductId: id,
  quantityMilli: quantityMilli.positive(),
  unitCostFils: z.number().int().min(0).optional(),
  batchNo: nullableText(80),
  serialNo: nullableText(80),
  notes: nullableText(500),
});

export const mmsMaterialIssueListSchema = z.object({
  moId: id.optional(),
  workOrderId: id.optional(),
  productId: id.optional(),
  issueType: mmsIssueType.optional(),
  limit,
});

export const mmsWipListSchema = z.object({
  moId: id.optional(),
  productId: id.optional(),
  stage: z.string().max(120).optional(),
  limit,
});

export const mmsInspectionType = z.enum([
  "passFail",
  "numerical",
  "checklist",
  "visual",
  "evidence",
]);

export const mmsQualityResult = z.enum([
  "pending",
  "passed",
  "failed",
  "quarantined",
  "reworkRequired",
  "rejected",
  "released",
]);

export const mmsSaveQualityCheckSchema = z.object({
  moId: id,
  workOrderId: id.nullable().optional(),
  checkpoint: z.string().trim().min(1).max(200),
  inspectionType: mmsInspectionType.optional(),
  result: mmsQualityResult.optional(),
  measuredValue: nullableText(200),
  toleranceMin: nullableText(200),
  toleranceMax: nullableText(200),
  notes: nullableText(500),
  evidenceRef: nullableText(200),
});

export const mmsQualityCheckListSchema = z.object({
  moId: id.optional(),
  workOrderId: id.optional(),
  result: mmsQualityResult.optional(),
  limit,
});

export const mmsScrapType = z.enum(["material", "process", "finishedProduct"]);

export const mmsSaveScrapSchema = z.object({
  moId: id,
  workOrderId: id.nullable().optional(),
  productId: id,
  quantityMilli: quantityMilli.positive(),
  scrapType: mmsScrapType.optional(),
  scrapReason: nullableText(500),
  workCenterId: id.nullable().optional(),
});

export const mmsScrapListSchema = z.object({
  moId: id.optional(),
  productId: id.optional(),
  scrapType: mmsScrapType.optional(),
  limit,
});

export const mmsSaveReworkSchema = z.object({
  moId: id,
  workOrderId: id.nullable().optional(),
  outputProductId: id,
  quantityMilli: quantityMilli.positive(),
  reason: nullableText(500),
  status: z.string().max(40).optional(),
});

export const mmsReworkListSchema = z.object({
  moId: id.optional(),
  status: z.string().max(40).optional(),
  limit,
});

export const mmsSaveFinishedReceiptSchema = z.object({
  moId: id,
  workOrderId: id.nullable().optional(),
  quantityMilli: quantityMilli.positive(),
  batchNo: nullableText(80),
  serialNo: nullableText(80),
  locationId: id.nullable().optional(),
  idempotencyKey: z.string().trim().min(8).max(80).optional(),
});

export const mmsFinishedReceiptListSchema = z.object({
  moId: id.optional(),
  productId: id.optional(),
  limit,
});

export const mmsCostType = z.enum([
  "material",
  "labor",
  "machine",
  "overhead",
  "subcontract",
  "rework",
  "scrap",
]);

export const mmsSaveCostRecordSchema = z.object({
  moId: id,
  costType: mmsCostType,
  amountFils: z.number().int().min(0),
  quantityBasis: z.number().int().positive().nullable().optional(),
  notes: nullableText(500),
});

export const mmsCostListSchema = z.object({
  moId: id.optional(),
  productId: id.optional(),
  limit,
});

export const mmsGenealogyListSchema = z.object({
  moId: id.optional(),
  productId: id.optional(),
  limit,
});

export const mmsMrpRunRequest = z.object({
  locationId: id.nullable().optional(),
  moIds: z.array(id).max(200).optional(), plant: nullableText(120),
  fromDate: isoDate.optional(), toDate: isoDate.optional(),
}).strict().refine(r => !r.fromDate || !r.toDate || r.fromDate <= r.toDate, "The start date must precede the end date.");

export const mmsPlanningIdSchema = z.object({id}).strict();
export const mmsMrpConvertSchema = z.object({ id, requirementIds: z.array(id).min(1).max(1000).optional() }).strict();

export const mmsMrpRequirementListSchema = z.object({
  mrpRunId: id.optional(),
  productId: id.optional(),
  shortageOnly: z.boolean().optional(),
  limit,
});

export const mmsMpsPlanListSchema = z.object({
  productId: id.optional(),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
  limit,
});

export const mmsSaveMpsPlanSchema = z.object({
  id: id.optional(), revision: z.number().int().nonnegative().optional(), productId: id, bomId: id,
  locationId: id.nullable().optional(), fromDate: isoDate, toDate: isoDate,
  horizon: z.enum(["daily", "weekly", "monthly"]),
  forecastDemand: quantityMilli.nonnegative(), confirmedDemand: quantityMilli.nonnegative(),
  plannedProduction: quantityMilli.nonnegative(), safetyStock: quantityMilli.nonnegative(),
}).strict().refine(r => r.fromDate <= r.toDate, "The start date must precede the end date.");

export const mmsMaintenanceStatus = z.enum([
  "open",
  "assigned",
  "inProgress",
  "resolved",
  "closed",
]);

export const mmsMaintenancePriority = z.enum([
  "low",
  "normal",
  "high",
  "critical",
]);

export const mmsSaveMaintenanceRequestSchema = z.object({
  machineId: id.nullable().optional(),
  workCenterId: id.nullable().optional(),
  title: z.string().trim().min(1).max(200),
  reason: nullableText(500),
  priority: mmsMaintenancePriority.optional(),
  status: mmsMaintenanceStatus.optional(),
  assignedTo: id.nullable().optional(),
  resolutionNotes: nullableText(500),
});

export const mmsMaintenanceRequestListSchema = z.object({
  status: mmsMaintenanceStatus.optional(),
  machineId: id.optional(),
  workCenterId: id.optional(),
  priority: mmsMaintenancePriority.optional(),
  limit,
});

export const mmsSubcontractStatus = z.enum([
  "planned",
  "inProgress",
  "received",
  "completed",
  "cancelled",
]);

export const mmsSaveSubcontractOrderSchema = z.object({
  id: id.optional(),
  number: z.string().trim().max(40).optional(),
  subcontractorId: id,
  productId: id,
  quantityMilli: quantityMilli.positive(),
  processingCostFils: z.number().int().min(0).optional(),
  plannedDelivery: isoDate.nullable().optional(),
  status: mmsSubcontractStatus.optional(),
});

export const mmsSubcontractOrderListSchema = z.object({
  subcontractorId: id.optional(),
  status: mmsSubcontractStatus.optional(),
  limit,
});

export const mmsConfigUpdateSchema = z.object({
  negativeStockPolicy: z.enum(["block", "allow"]).optional(),
  defaultCostingMethod: z.enum(["standard", "weightedAverage", "fifo"]).optional(),
  allowBackflush: z.boolean().optional(),
  requireQCBeforeReceipt: z.boolean().optional(),
  scrapAllowancePercent: z.number().min(0).max(100).optional(),
  overheadRateFilsPerHour: z.number().int().min(0).optional(),
  autoCreateWorkOrders: z.boolean().optional(),
});

export const mmsDashboardRequest = z.object({
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
  productId: id.optional(),
  workCenterId: id.optional(),
});

export const mmsReportRequest = z.object({
  report: z.string(),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
  productId: id.optional(),
  workCenterId: id.optional(),
  moId: id.optional(),
  status: z.string().max(40).optional(),
  search: z.string().max(120).optional(),
  limit,
});

