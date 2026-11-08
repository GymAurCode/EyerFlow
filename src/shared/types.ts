/**
 * DTOs shared by the main process and the renderer.
 *
 * The set is deliberately small: invoices, purchases, products, parties,
 * expenses, payments, reports, users. Types for removed features are gone with
 * the features, so nothing here describes something that no longer exists.
 *
 * The Finance module's own types live in `./finance` and are re-exported here,
 * so a caller can reach every shared shape through one import.
 */

export type * from "./finance";
export type * from "./ims";
export type * from "./mms";

import type { PaymentPostingKind } from "./finance";

export interface PartyDto {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly kind: "customer" | "supplier" | "both";
  readonly phone: string | null;
  readonly email: string | null;
  readonly trn: string | null;
  readonly addressLine: string | null;
  readonly openingBalanceFils: number;
  readonly isActive: boolean;
  /** Unpaid amount, computed from documents minus payments. Never stored. */
  readonly balanceFils: number;
}

export interface PartyListRequest {
  readonly kind?: "customer" | "supplier" | "both";
  readonly onlyActive?: boolean;
  readonly search?: string;
  readonly limit?: number;
}

export type VatTreatment = "standard" | "zero" | "exempt" | "outsideScope";

export interface ProductDto {
  readonly id: number;
  readonly sku: string;
  readonly barcode: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly category: string | null;
  readonly unit: string;
  /** Current stock, in thousandths. Calculated from stock_movements. */
  readonly quantityMilli: number;
  readonly reorderLevelMilli: number;
  readonly averageCostFils: number;
  readonly salePriceFils: number;
  readonly vatTreatment: VatTreatment;
  readonly isActive: boolean;
  readonly stockValueFils: number;
  readonly isLowStock: boolean;
  /**
   * Cost of the most recent purchase of this product, per unit, in fils.
   * Read-only, derived from purchase document lines. 0 when never purchased.
   */
  readonly lastCostFils: number;
  /**
   * Price of the most recent sale of this product, per unit, in fils.
   * Read-only, derived from sales document lines. 0 when never sold.
   */
  readonly lastSalePriceFils: number;
}

export interface ProductListRequest {
  readonly search?: string;
  readonly category?: string;
  readonly onlyActive?: boolean;
  readonly onlyLowStock?: boolean;
  readonly limit?: number;
}

export type DocumentKind = "invoice" | "purchaseInvoice" | "stockAdjustment";

export type DocumentStatus = "draft" | "issued" | "partPaid" | "paid" | "cancelled";

export interface DocumentLineDto {
  readonly id: number;
  readonly lineNo: number;
  readonly productId: number | null;
  readonly description: string;
  readonly quantityMilli: number;
  readonly unitPriceFils: number;
  readonly netFils: number;
  readonly vatFils: number;
  readonly vatTreatment: VatTreatment;
  readonly unitCostFils: number;
  readonly costFils: number;
}

export interface DocumentDto {
  readonly id: number;
  readonly kind: DocumentKind;
  readonly number: string;
  readonly partyId: number | null;
  readonly partyName: string | null;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly status: DocumentStatus;
  readonly netFils: number;
  readonly vatFils: number;
  readonly grossFils: number;
  readonly discountFils: number;
  readonly paidFils: number;
  readonly outstandingFils: number;
  readonly costFils: number;
  readonly fiscalYear: number;
  readonly notes: string | null;
  readonly reason: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines: readonly DocumentLineDto[];
}

export interface DocumentListRequest {
  readonly kind?: DocumentKind;
  readonly partyId?: number;
  readonly status?: DocumentStatus;
  readonly fromDate?: string;
  readonly toDate?: string;
  readonly search?: string;
  readonly limit?: number;
}

/**
 * One line of an invoice register.
 *
 * A report needs the money on every invoice, not the invoices themselves: the
 * full document carries its lines, and reading those for every invoice in a
 * year turns one query per row into thousands of them.
 */
export interface DocumentRegisterRow {
  readonly id: number;
  readonly number: string;
  readonly issueDate: string;
  readonly partyName: string | null;
  readonly status: DocumentStatus;
  readonly netFils: number;
  readonly vatFils: number;
  readonly grossFils: number;
  readonly paidFils: number;
  readonly outstandingFils: number;
  readonly lineCount: number;
}

/** The filters an invoice register accepts. */
export interface DocumentRegisterRequest {
  readonly kind: "invoice" | "purchaseInvoice";
  readonly fromDate: string;
  readonly toDate: string;
  readonly status?: DocumentStatus | undefined;
  readonly partyId?: number | undefined;
  readonly search?: string | undefined;
}

export interface DocumentLineInput {
  readonly productId: number | null;
  readonly description: string;
  readonly quantityMilli: number;
  readonly unitPriceFils: number;
  readonly vatTreatment: VatTreatment;
  /**
   * Cost per unit for this line, in fils. For purchases this is the buyer's
   * cost; for sales it is the cost entered at the time of sale (cost_at_sale),
   * which is what profit and COGS reports use. A line with no product (a typed
   * service line) is priced as given.
   */
  readonly unitCostFils?: number;
}

export interface SaveDocumentRequest {
  readonly id?: number;
  readonly kind: DocumentKind;
  readonly partyId: number | null;
  readonly issueDate: string;
  readonly dueDate?: string | null;
  readonly status: DocumentStatus;
  readonly notes?: string | null;
  readonly lines: readonly DocumentLineInput[];
  /** Amount paid at the time of the sale or purchase, in fils. */
  readonly paidAmountFils?: number;
  /** Document-level discount in fils, subtracted before VAT. */
  readonly discountFils?: number;
  /**
   * Idempotency token. Retrying a save with the same token returns the
   * document that was already created instead of posting stock twice.
   */
  readonly clientToken?: string | null;
  /** The location a sale or purchase lands in. Defaults to MAIN. */
  readonly locationId?: number | null;
}

/* -------------------------------------------------------------------------- */
/* payments                                                                   */
/* -------------------------------------------------------------------------- */

export interface PaymentAllocationDto {
  readonly documentId: number;
  readonly documentNumber: string;
  readonly amountFils: number;
}

export type PaymentMethod = "cash" | "bank" | "card";

export interface PaymentDto {
  readonly id: number;
  readonly receiptNumber: string | null;
  readonly direction: "inbound" | "outbound";
  readonly partyId: number;
  readonly partyName: string;
  readonly paymentDate: string;
  readonly method: PaymentMethod;
  readonly amountFils: number;
  readonly reference: string | null;
  readonly notes: string | null;
  readonly allocations: readonly PaymentAllocationDto[];
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export interface PaymentListRequest {
  readonly direction?: "inbound" | "outbound";
  readonly partyId?: number;
  /** Only the payments set against this invoice. */
  readonly documentId?: number;
  readonly fromDate?: string;
  readonly toDate?: string;
  readonly limit?: number;
}

export interface SavePaymentRequest {
  readonly direction: "inbound" | "outbound";
  readonly partyId: number;
  readonly paymentDate: string;
  readonly method: PaymentMethod;
  readonly amountFils: number;
  readonly reference?: string | null;
  readonly notes?: string | null;
  /**
   * Invoices to pay. When omitted the amount is spread over the party's oldest
   * unpaid invoices, which is what the "Receive payment" button does.
   */
  readonly allocations?: readonly { readonly documentId: number; readonly amountFils: number }[];
  /**
   * What the money settles, when it is not settling an invoice.
   *
   * "auto" - the default - settles the party's control account: a customer's
   * money reduces what they owe, a supplier's reduces what we owe. The other
   * values are for money that is genuinely something else: an advance, an
   * expense, the owner's own money, a fixed asset.
   */
  readonly postingKind?: PaymentPostingKind | undefined;
  /** Which cash or bank ledger the money lands in. */
  readonly cashAccountCode?: string | undefined;
  /** The account an expense-type payment is charged to. */
  readonly expenseAccountCode?: string | undefined;
}

/* -------------------------------------------------------------------------- */
/* expenses                                                                   */
/* -------------------------------------------------------------------------- */

export interface ExpenseDto {
  readonly id: number;
  readonly expenseDate: string;
  readonly category: string;
  readonly description: string;
  readonly amountFils: number;
  readonly vatFils: number;
  readonly paymentMethod: PaymentMethod;
  readonly reference: string | null;
  readonly notes: string | null;
  /** The Chart of Accounts account the expense is charged to, when one is named. */
  readonly accountCode: string | null;
  /** How much of the expense has been paid. The rest is a liability. */
  readonly paidFils: number;
}

export interface ExpenseListRequest {
  readonly fromDate?: string;
  readonly toDate?: string;
  readonly category?: string;
  readonly search?: string;
  readonly limit?: number;
}

export interface SaveExpenseRequest {
  readonly id?: number;
  readonly expenseDate: string;
  readonly category: string;
  readonly description: string;
  readonly amountFils: number;
  readonly vatFils?: number;
  readonly paymentMethod?: PaymentMethod;
  readonly reference?: string | null;
  readonly notes?: string | null;
  /**
   * The Chart of Accounts account to charge. Left out, the expense is
   * posted to the account its category maps to.
   */
  readonly accountCode?: string | null;
  /**
   * How much was paid at the time. The unpaid part is credited to a
   * liability, so an expense that is still owed is still an expense.
   */
  readonly paidFils?: number;
}

/* -------------------------------------------------------------------------- */
/* stock                                                                      */
/* -------------------------------------------------------------------------- */

export interface StockMovementDto {
  readonly id: number;
  readonly productId: number;
  readonly productName: string;
  readonly documentNumber: string | null;
  readonly movementDate: string;
  readonly kind: "receipt" | "issue" | "reversal" | "adjustmentIn" | "adjustmentOut" | "opening";
  readonly quantityMilli: number;
  readonly unitCostFils: number;
  readonly costFils: number;
  readonly notes: string | null;
}

export interface StockMovementRequest {
  readonly productId?: number;
  readonly fromDate?: string;
  readonly toDate?: string;
  readonly kind?: StockMovementDto["kind"];
  readonly limit?: number;
}

export interface StockValuationRow {
  readonly productId: number;
  readonly sku: string;
  readonly name: string;
  readonly category: string | null;
  readonly quantityMilli: number;
  readonly averageCostFils: number;
  readonly valueFils: number;
}

/* -------------------------------------------------------------------------- */
/* reports                                                                    */
/* -------------------------------------------------------------------------- */

export interface DashboardInventoryCategoryDto {
  readonly name: string;
  readonly count: number;
  readonly valueFils: number;
}

export interface DashboardInventoryDto {
  readonly productCount: number;
  readonly totalQuantityMilli: number;
  readonly stockedCount: number;
  readonly totalStockValueFils: number;
  readonly units: readonly string[];
  readonly recentProducts: readonly ProductDto[];
  readonly lowStockProducts: readonly ProductDto[];
  readonly categories: readonly DashboardInventoryCategoryDto[];
}

export interface DashboardDto {
  readonly salesFils: number;
  readonly previousSalesFils: number;
  readonly purchasesFils: number;
  readonly expensesFils: number;
  readonly netProfitFils: number;
  readonly receivablesFils: number;
  readonly payablesFils: number;
  readonly lowStockCount: number;
  readonly salesVsExpenses: readonly {
    readonly month: string;
    readonly salesFils: number;
    readonly expenseFils: number;
  }[];
  readonly topProducts: readonly {
    readonly name: string;
    readonly qtyMilli: number;
    readonly netFils: number;
  }[];
  readonly inventory: DashboardInventoryDto;
  readonly generatedAtIso: string;
}

export interface ProfitAndLossDto {
  readonly fromDate: string;
  readonly toDate: string;
  readonly revenueFils: number;
  readonly netSalesFils: number;
  readonly costOfGoodsFils: number;
  readonly grossProfitFils: number;
  readonly grossMarginPercent: number;
  readonly operatingExpensesFils: number;
  readonly netProfitFils: number;
  readonly expensesByCategory: readonly {
    readonly category: string;
    readonly amountFils: number;
  }[];
}

/**
 * Partner split for a period.
 *
 * Net profit -> donation -> the remainder split between the two partners by
 * the percentages configured in Settings. Every figure is integer fils and the
 * parts always sum back to the whole.
 */
export interface PartnerSplitDto {
  readonly fromDate: string;
  readonly toDate: string;
  readonly netProfitFils: number;
  readonly donationRatePercent: number;
  readonly donationFils: number;
  readonly distributableFils: number;
  readonly partners: readonly {
    readonly partnerId: number;
    readonly name: string;
    readonly sharePercent: number;
    readonly amountFils: number;
  }[];
  /**
   * Why the split could not be worked out, when the partnership's shares and
   * the donation do not come to 100%. Null when the split is sound.
   */
  readonly configurationError: string | null;
}

export interface PartnerDto {
  readonly id: number;
  readonly name: string;
  readonly sharePercent: number;
  readonly isActive: boolean;
}

/**
 * One line of the partnership's own ledger.
 *
 * The records that show what was actually allocated: a partner's share of the
 * profit, the part of the donation that partner bore, and the money brought in
 * or taken out.
 */
export interface PartnerTransactionDto {
  readonly id: number;
  readonly partnerId: number;
  readonly partnerName: string;
  readonly txnDate: string;
  readonly kind: "capital" | "drawing" | "profit" | "donation";
  readonly amountFils: number;
  readonly periodRef: string | null;
  readonly notes: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

/* -------------------------------------------------------------------------- */
/* users and session                                                          */
/* -------------------------------------------------------------------------- */

export interface UserDto {
  readonly id: number;
  readonly username: string;
  readonly displayName: string;
  readonly roleId: number | null;
  readonly roleName: string | null;
  readonly mustChangePassword: boolean;
  readonly isActive: boolean;
  readonly lastLoginAt: string | null;
}

export interface SaveUserRequest {
  readonly id?: number;
  readonly username: string;
  readonly displayName: string;
  readonly roleId: number | null;
  readonly isActive?: boolean;
  readonly password?: string;
  readonly mustChangePassword?: boolean;
}

export interface SessionUser {
  readonly id: number;
  readonly username: string;
  readonly displayName: string;
  readonly roleId: number | null;
  readonly roleName: string | null;
  readonly mustChangePassword: boolean;
  /** Optional contact details. Null on accounts that never set them. */
  readonly email: string | null;
  readonly phone: string | null;
  /**
   * The user's picture as a data URL, derived from the file in the avatars
   * folder at read time and never stored in the database. Null means "no
   * picture", and the UI falls back to initials.
   */
  readonly avatarDataUrl: string | null;
  readonly createdAt: string | null;
  readonly lastLoginAt: string | null;
  readonly permissions: readonly { readonly module: string; readonly action: string }[];
}

/** The signed-in user's own profile, as the profile page edits it. */
export interface ProfileDto {
  readonly id: number;
  readonly username: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly avatarDataUrl: string | null;
  readonly roleName: string | null;
  readonly createdAt: string | null;
  readonly lastLoginAt: string | null;
  /** Business name from settings, read-only on the profile page. */
  readonly companyName: string;
}

/**
 * Fields a user may change about themselves.
 *
 * There is no `id` and no `username`. The target is always the session user, so
 * a renderer cannot aim an update at somebody else's row, and the login name
 * stays the login name.
 */
export interface UpdateProfileRequest {
  readonly displayName: string;
  readonly email: string;
  readonly phone: string;
  /**
   * The picture to use, as a file name.
   *
   * Omit it to keep whatever is already stored, pass "" to go back to the
   * initials avatar, or pass one of the names the avatar store produced. There
   * is no "unset" spelling: an absent field means "not changing this".
   */
  readonly avatarPath?: string | undefined;
}

/* -------------------------------------------------------------------------- */
/* registration                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What the login screen may know about registration before anybody proves who
 * they are.
 *
 * Deliberately tiny: the administrator's login name and display name are
 * already visible on a single-user shop computer, and nothing else here is
 * secret. The machine fingerprint and the licence key are never part of this
 * shape.
 */
export interface RegistrationStatus {
  readonly setupComplete: boolean;
  readonly administratorUsername: string | null;
  readonly administratorName: string | null;
}

/** Local proof that the caller is an administrator: no renderer-held id. */
export interface RegistrationAuthorisation {
  readonly username: string;
  readonly password: string;
}

/**
 * The registration details an administrator may edit.
 *
 * The password that authorised the read is intentionally absent. It is proof
 * for the main process, not part of the stored registration.
 *
 * `licensedClientName` is read-only on purpose: it is signed inside the
 * licence payload. Changing it would invalidate the key, so an edit never
 * touches it and the screen shows why.
 */
export interface RegistrationDetails {
  readonly username: string;
  readonly companyName: string;
  readonly companyTrn: string;
  readonly companyAddress: string;
  readonly companyPhone: string;
  readonly companyEmail: string;
  readonly ownerName: string;
  readonly ownerEmail: string;
  readonly ownerPhone: string;
  readonly licensedClientName: string;
  readonly edition: string;
  readonly expiresAt: string | null;
}

/** Fields written back to the existing registration record. */
export interface RegistrationUpdateRequest extends RegistrationAuthorisation {
  readonly companyName: string;
  readonly companyTrn: string;
  readonly companyAddress: string;
  readonly companyPhone: string;
  readonly companyEmail: string;
  readonly ownerName: string;
  readonly ownerEmail: string;
  readonly ownerPhone: string;
}

export type RegistrationAccountRole = "Administrator" | "Staff";

/**
 * A new local account authorised by an existing administrator.
 *
 * This creates a user row only. It never issues a licence key and never
 * replaces the authorising account, because the installation already supports
 * more than one account over one business database.
 */
export interface RegistrationCreateAccountRequest {
  readonly authorizedUsername: string;
  readonly authorizedPassword: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string;
  readonly phone: string;
  readonly password: string;
  readonly role: RegistrationAccountRole;
}

export interface LoginRequest {
  readonly username: string;
  readonly password: string;
}

/**
 * A forgotten-password reset proved with a recovery code issued by EyerCall.
 *
 * The codes are checked in the main process and are never part of this shape,
 * so the renderer cannot learn them from an RPC response.
 */
export interface RecoverPasswordRequest {
  readonly username: string;
  readonly secretCode: string;
  readonly newPassword: string;
}

export interface LoginResponse {
  readonly user: SessionUser;
  readonly isSetupComplete: boolean;
}

export interface SetupRequest {
  readonly companyName: string;
  readonly companyTrn: string;
  readonly companyAddress: string;
  readonly companyPhone: string;
  readonly fiscalYearStartMonth: number;
  readonly adminUsername: string;
  readonly adminDisplayName: string;
  readonly adminPassword: string;
}
