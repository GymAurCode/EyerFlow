/**
 * The Finance module's data contract.
 *
 * Every figure the Finance screens show is an integer number of fils. The
 * conversion to a currency symbol happens in the renderer, in one place, so a
 * report cannot disagree with a card about the same number.
 *
 * The types here are deliberately plain: they are what crosses the bridge, so
 * they carry no behaviour and no database ids that the renderer has to guess
 * the meaning of.
 */

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

export type AccountSubtype =
  | "currentAsset"
  | "fixedAsset"
  | "contraAsset"
  | "currentLiability"
  | "longTermLiability"
  | "equity"
  | "operatingIncome"
  | "otherIncome"
  | "cogs"
  | "operatingExpense"
  | "otherExpense";

export type NormalBalance = "debit" | "credit";

/**
 * What a payment settles.
 *
 * "auto" is the ordinary case: money received from a customer settles what
 * they owe, money paid to a supplier settles what we owe. The other values
 * are for money that is genuinely something else - an advance paid before
 * there is an invoice, an operating expense, the owner's own money in or out,
 * a fixed asset, or income that is not trading.
 */
export type PaymentPostingKind =
  | "auto"
  | "customerAdvance"
  | "supplierAdvance"
  | "expense"
  | "ownerDrawing"
  | "ownerContribution"
  | "fixedAsset"
  | "otherIncome"
  | "otherExpense";

/**
 * The share a partner takes of the net profit unless they are told otherwise.
 *
 * Two partners at this share with the 2% donation come to exactly 100%, which
 * is the arrangement this business agreed.
 */
export const DEFAULT_PARTNER_SHARE_PERCENT = 49;

/** The reports that can be written out as a file. */
export type ExportDataset =
  | "chartOfAccounts"
  | "trialBalance"
  | "balanceSheet"
  | "profitAndLoss"
  | "cashFlow"
  | "generalLedger"
  | "journalRegister"
  | "receivableAging"
  | "payableAging"
  | "cashBook"
  | "expenseBreakdown"
  | "customerStatement"
  | "supplierStatement"
  | "periodComparison";

export interface AccountDto {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly subtype: AccountSubtype | null;
  readonly parentId: number | null;
  readonly parentCode: string | null;
  readonly normalBalance: NormalBalance;
  /** A system account is one the postings depend on. It may be renamed, not retyped. */
  readonly isSystem: boolean;
  readonly isActive: boolean;
  readonly description: string | null;
  /** Current balance, in the account's own normal balance. */
  readonly balanceFils: number;
  /** How many ledger lines name this account. */
  readonly usageCount: number;
  /** When the account row was created, and when it was last changed. */
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveAccountRequest {
  readonly id?: number | undefined;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly subtype?: AccountSubtype | null | undefined;
  readonly parentId?: number | null | undefined;
  readonly normalBalance?: NormalBalance | undefined;
  readonly description?: string | null | undefined;
  readonly isActive?: boolean | undefined;
}

/* -------------------------------------------------------------------------- */
/* journal                                                                     */
/* -------------------------------------------------------------------------- */

export type JournalSource =
  | "purchase"
  | "sale"
  | "payment"
  | "expense"
  | "manual"
  | "transfer"
  | "opening"
  | "reversal"
  | "adjustment";

export type JournalStatus = "draft" | "posted" | "reversed";

export interface JournalEntryRowDto {
  readonly id: number;
  readonly entryNo: string;
  readonly entryDate: string;
  readonly reference: string | null;
  readonly description: string;
  readonly source: JournalSource;
  readonly status: JournalStatus;
  readonly totalDebitFils: number;
  readonly totalCreditFils: number;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly reversesEntryId: number | null;
  readonly reversedByEntryId: number | null;
}

export interface JournalLineDto {
  readonly lineNo: number;
  readonly accountId: number;
  readonly accountCode: string;
  readonly accountName: string;
  readonly description: string | null;
  readonly debitFils: number;
  readonly creditFils: number;
  readonly partyId: number | null;
  readonly partyName: string | null;
  readonly documentId: number | null;
  readonly documentNumber: string | null;
}

export interface JournalEntryDetailDto extends JournalEntryRowDto {
  readonly sourceKey: string | null;
  readonly lines: readonly JournalLineDto[];
}

export interface SaveJournalLineRequest {
  readonly accountCode: string;
  readonly debitFils: number;
  readonly creditFils: number;
  readonly description?: string | null | undefined;
}

export interface SaveJournalEntryRequest {
  readonly id?: number | undefined;
  readonly entryDate: string;
  readonly description: string;
  readonly reference?: string | null | undefined;
  readonly lines: readonly SaveJournalLineRequest[];
  /** Post the entry straight away, rather than saving it as a draft. */
  readonly postNow?: boolean | undefined;
}

/* -------------------------------------------------------------------------- */
/* reports                                                                     */
/* -------------------------------------------------------------------------- */

export interface LedgerLineDto {
  /** The journal line itself, which is what identifies a row in the ledger. */
  readonly lineId: number;
  readonly entryId: number;
  readonly entryNo: string;
  readonly entryDate: string;
  readonly reference: string | null;
  readonly description: string | null;
  readonly source: JournalSource;
  /**
   * Whether the entry is posted or has been reversed.
   *
   * Both appear in the ledger: a reversed entry is still part of the history,
   * and the reversal beside it is what cancels it. Showing which is which is
   * what lets a reader see that a correction was made rather than guess at it.
   */
  readonly status: JournalStatus;
  readonly debitFils: number;
  readonly creditFils: number;
  readonly runningBalanceFils: number;
  readonly documentId: number | null;
  readonly documentNumber: string | null;
  readonly partyName: string | null;
}

export interface GeneralLedgerDto {
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly normalBalance: NormalBalance;
  readonly fromDate: string;
  readonly toDate: string;
  readonly openingBalanceFils: number;
  readonly rows: readonly LedgerLineDto[];
  readonly totalDebitFils: number;
  readonly totalCreditFils: number;
  readonly closingBalanceFils: number;
}

export interface TrialBalanceRowDto {
  readonly accountId: number;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly subtype: AccountSubtype | null;
  readonly normalBalance: NormalBalance;
  readonly openingDebitFils: number;
  readonly openingCreditFils: number;
  readonly periodDebitFils: number;
  readonly periodCreditFils: number;
  readonly closingDebitFils: number;
  readonly closingCreditFils: number;
}

export interface TrialBalanceDto {
  readonly fromDate: string;
  readonly toDate: string;
  readonly rows: readonly TrialBalanceRowDto[];
  readonly totalOpeningDebitFils: number;
  readonly totalOpeningCreditFils: number;
  readonly totalPeriodDebitFils: number;
  readonly totalPeriodCreditFils: number;
  readonly totalClosingDebitFils: number;
  readonly totalClosingCreditFils: number;
  readonly isBalanced: boolean;
  readonly differenceFils: number;
}

export interface ReportLineDto {
  readonly code: string;
  readonly name: string;
  readonly amountFils: number;
}

export interface ReportSectionDto {
  readonly heading: string;
  readonly lines: readonly ReportLineDto[];
  readonly totalFils: number;
}

export interface BalanceSheetDto {
  readonly asOfDate: string;
  readonly assets: ReportSectionDto;
  readonly liabilities: ReportSectionDto;
  readonly equity: ReportSectionDto;
  readonly currentPeriodEarningsFils: number;
  readonly liabilitiesAndEquityFils: number;
  readonly isBalanced: boolean;
  readonly differenceFils: number;
}

export interface ProfitLossDto {
  readonly fromDate: string;
  readonly toDate: string;
  readonly grossSalesFils: number;
  readonly salesReturnsFils: number;
  readonly netSalesFils: number;
  readonly costOfGoodsSoldFils: number;
  readonly grossProfitFils: number;
  readonly grossMarginPercent: number;
  readonly operatingExpensesFils: number;
  readonly otherIncomeFils: number;
  readonly netProfitFils: number;
  readonly expenseLines: readonly ReportLineDto[];
  readonly otherIncomeLines: readonly ReportLineDto[];
}

export type CashFlowSectionDto = ReportSectionDto;

export interface CashFlowDto {
  readonly fromDate: string;
  readonly toDate: string;
  readonly openingCashFils: number;
  readonly operating: CashFlowSectionDto;
  readonly investing: CashFlowSectionDto;
  readonly financing: CashFlowSectionDto;
  readonly netMovementFils: number;
  readonly closingCashFils: number;
  readonly totalReceivedFils: number;
  readonly totalPaidFils: number;
}

export type AgingBucket = "notDue" | "d1_30" | "d31_60" | "d61_90" | "d90plus";

export interface AgingRowDto {
  readonly documentId: number;
  readonly documentNumber: string;
  readonly partyId: number;
  readonly partyName: string;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly totalFils: number;
  readonly paidFils: number;
  readonly outstandingFils: number;
  readonly daysOverdue: number;
  readonly bucket: AgingBucket;
}

export interface AgingDto {
  readonly asOfDate: string;
  readonly side: "receivable" | "payable";
  readonly rows: readonly AgingRowDto[];
  readonly buckets: readonly { readonly key: AgingBucket; readonly label: string; readonly amountFils: number }[];
  readonly totalOutstandingFils: number;
  readonly totalOverdueFils: number;
}

export type PartyLedgerKind = "customer" | "supplier";

export interface PartyStatementRowDto {
  readonly entryId: number;
  readonly entryNo: string;
  readonly entryDate: string;
  readonly reference: string | null;
  readonly documentNumber: string | null;
  readonly kind: "invoice" | "receipt" | "payment" | "adjustment";
  readonly description: string;
  readonly debitFils: number;
  readonly creditFils: number;
  readonly runningBalanceFils: number;
  readonly isSettled: boolean | null;
  readonly dueDate: string | null;
  readonly documentId: number | null;
}

export interface PartyStatementDto {
  readonly partyId: number;
  readonly partyName: string;
  readonly kind: PartyLedgerKind;
  readonly fromDate: string;
  readonly toDate: string;
  readonly openingBalanceFils: number;
  readonly rows: readonly PartyStatementRowDto[];
  readonly totalDebitFils: number;
  readonly totalCreditFils: number;
  readonly closingBalanceFils: number;
  readonly overdueFils: number;
}

export interface PartyBalanceDto {
  readonly partyId: number;
  readonly partyName: string;
  readonly kind: PartyLedgerKind;
  readonly outstandingFils: number;
  readonly overdueFils: number;
  readonly invoiceCount: number;
  readonly lastTransactionDate: string | null;
}

/* -------------------------------------------------------------------------- */
/* dashboard                                                                   */
/* -------------------------------------------------------------------------- */

export interface FinanceMetricDto {
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  readonly amountFils: number;
  /** Change against the previous period, as a fraction. Null when unknown. */
  readonly delta: number | null;
  /** "balance" for a point-in-time figure, "period" for a figure over time. */
  readonly kind: "balance" | "period";
}

export interface SeriesPointDto {
  readonly key: string;
  readonly label: string;
  readonly revenueFils: number;
  readonly expenseFils: number;
  readonly costFils: number;
  readonly grossProfitFils: number;
  readonly netProfitFils: number;
  readonly receivedFils: number;
  readonly paidFils: number;
}

export interface ReconciliationDto {
  readonly asOfDate: string;
  readonly receivableControlFils: number;
  readonly receivableFromPartiesFils: number;
  readonly receivableMatches: boolean;
  readonly payableControlFils: number;
  readonly payableFromPartiesFils: number;
  readonly payableMatches: boolean;
}

export interface FinanceOverviewDto {
  readonly asOfDate: string;
  readonly fromDate: string;
  readonly toDate: string;
  readonly previousFromDate: string;
  readonly previousToDate: string;
  readonly metrics: readonly FinanceMetricDto[];
  readonly reconciliation: ReconciliationDto;
  readonly expenseBreakdown: readonly ReportLineDto[];
  readonly series: readonly SeriesPointDto[];
  readonly cashFlow: CashFlowDto;
  readonly receivableAging: AgingDto;
  readonly payableAging: AgingDto;
  readonly inventoryValueFils: number;
}

export interface CashBookRowDto {
  readonly entryId: number;
  readonly entryNo: string;
  readonly entryDate: string;
  readonly description: string;
  readonly reference: string | null;
  readonly receiptFils: number;
  readonly paymentFils: number;
  readonly balanceFils: number;
}

export interface CashBookDto {
  readonly accountCode: string;
  readonly accountName: string;
  readonly fromDate: string;
  readonly toDate: string;
  readonly openingBalanceFils: number;
  readonly rows: readonly CashBookRowDto[];
  readonly totalReceiptsFils: number;
  readonly totalPaymentsFils: number;
  readonly closingBalanceFils: number;
}

export interface PeriodComparisonDto {
  readonly fromDate: string;
  readonly toDate: string;
  readonly previousFromDate: string;
  readonly previousToDate: string;
  readonly rows: readonly {
    readonly label: string;
    readonly currentFils: number;
    readonly previousFils: number;
    readonly changeFils: number;
    readonly changePercent: number | null;
  }[];
}

/* -------------------------------------------------------------------------- */
/* settings                                                                    */
/* -------------------------------------------------------------------------- */

export interface AccountingPeriodDto {
  readonly id: number;
  readonly name: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: "open" | "closed";
  readonly closedAt: string | null;
}

export interface SaveAccountingPeriodRequest {
  readonly id?: number | undefined;
  readonly name: string;
  readonly startDate: string;
  readonly endDate: string;
}

export interface OpeningBalanceRequest {
  readonly entryDate: string;
  readonly balances: readonly {
    readonly accountCode: string;
    readonly debitFils: number;
    readonly creditFils: number;
  }[];
}

/**
 * What the existing data looks like to the accounting engine.
 *
 * Reported honestly rather than fixed silently: a shop that traded before the
 * Finance module existed has documents, payments and expenses that carry no
 * journal entry, and the count of each is exactly what the back-fill needs to
 * know.
 */
export interface MigrationAuditDto {
  readonly hasAccountingHistory: boolean;
  readonly documentsWithoutEntry: number;
  readonly paymentsWithoutEntry: number;
  readonly expensesWithoutEntry: number;
  readonly documentsWithEntry: number;
  readonly paymentsWithEntry: number;
  readonly expensesWithEntry: number;
  /** Records that cannot be posted accurately and need a decision. */
  readonly unmigratable: readonly { readonly kind: string; readonly reference: string; readonly reason: string }[];
  readonly stockValueFils: number;
  readonly inventoryAccountFils: number;
  readonly inventoryMatches: boolean;
}
