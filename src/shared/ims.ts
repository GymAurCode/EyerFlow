/**
 * IMS operational shapes shared by the main process and the renderer.
 *
 * These describe the operational documents that sit around the existing
 * financial documents: requisitions, purchase orders, goods receipts,
 * quotations, sales orders, transfers, counts and returns, plus the masters and
 * analytics the IMS screens read.
 *
 * Money remains integer fils and quantities remain integer thousandths, the
 * same units the rest of the application uses. Nothing here is a floating
 * point amount.
 */

import type { VatTreatment } from "./types";

export const IMS_DOCUMENT_KINDS = [
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
] as const;

export type ImsDocumentKind = (typeof IMS_DOCUMENT_KINDS)[number];

export const IMS_DOCUMENT_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "rejected",
  "confirmed",
  "sent",
  "accepted",
  "partiallyReceived",
  "received",
  "partiallyFulfilled",
  "fulfilled",
  "inTransit",
  "completed",
  "counted",
  "posted",
  "closed",
  "cancelled",
] as const;

export type ImsDocumentStatus = (typeof IMS_DOCUMENT_STATUSES)[number];

export interface ImsLocationDto {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly type: "store" | "branch" | "warehouse" | "shop" | "quarantine" | "damaged" | "transit";
  readonly address: string | null;
  readonly isDefault: boolean;
  readonly isActive: boolean;
}

export interface SaveLocationRequest {
  readonly id?: number;
  readonly code: string;
  readonly name: string;
  readonly type: ImsLocationDto["type"];
  readonly address?: string | null;
  readonly isDefault?: boolean;
  readonly isActive?: boolean;
}

export interface ImsLineInput {
  readonly productId: number | null;
  readonly description: string;
  readonly quantityMilli: number;
  readonly unitCostFils?: number;
  readonly unitPriceFils?: number;
  readonly discountFils?: number;
  readonly vatTreatment?: VatTreatment;
  readonly batchNo?: string | null;
  readonly expiryDate?: string | null;
  readonly conditionNote?: string | null;
  readonly serials?: string | null;
  readonly sourceLineId?: number | null;
  /** Stock count lines: what the ledger said and what was physically found. */
  readonly expectedMilli?: number | null;
  readonly countedMilli?: number | null;
  /** Sales return lines: put the returned goods back on sale after inspection. */
  readonly restock?: boolean;
}

export interface ImsDocumentLineDto {
  readonly id: number;
  readonly lineNo: number;
  readonly productId: number | null;
  readonly productName: string | null;
  readonly sku: string | null;
  readonly description: string;
  readonly quantityMilli: number;
  readonly processedMilli: number;
  readonly outstandingMilli: number;
  readonly expectedMilli: number | null;
  readonly countedMilli: number | null;
  readonly varianceMilli: number | null;
  readonly unitCostFils: number;
  readonly unitPriceFils: number;
  readonly discountFils: number;
  readonly vatTreatment: VatTreatment;
  readonly vatFils: number;
  readonly lineTotalFils: number;
  readonly batchNo: string | null;
  readonly expiryDate: string | null;
  readonly conditionNote: string | null;
  readonly serials: string | null;
  readonly sourceLineId: number | null;
  readonly restock: boolean;
}

export interface ImsDocumentDto {
  readonly id: number;
  readonly kind: ImsDocumentKind;
  readonly number: string;
  readonly status: ImsDocumentStatus;
  readonly partyId: number | null;
  readonly partyName: string | null;
  readonly fromLocationId: number | null;
  readonly fromLocationName: string | null;
  readonly toLocationId: number | null;
  readonly toLocationName: string | null;
  readonly sourceId: number | null;
  readonly sourceNumber: string | null;
  readonly resultDocumentId: number | null;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly requiredDate: string | null;
  readonly reference: string | null;
  readonly notes: string | null;
  readonly reason: string | null;
  readonly totalFils: number;
  readonly vatFils: number;
  readonly discountFils: number;
  readonly createdBy: string | null;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly postedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines: readonly ImsDocumentLineDto[];
}

export interface SaveImsDocumentRequest {
  readonly id?: number;
  readonly kind: ImsDocumentKind;
  readonly partyId?: number | null;
  readonly fromLocationId?: number | null;
  readonly toLocationId?: number | null;
  readonly sourceId?: number | null;
  readonly issueDate: string;
  readonly dueDate?: string | null;
  readonly requiredDate?: string | null;
  readonly reference?: string | null;
  readonly notes?: string | null;
  readonly reason?: string | null;
  readonly discountFils?: number;
  readonly clientToken?: string | null;
  readonly lines: readonly ImsLineInput[];
}

export interface ImsListRequest {
  readonly kind?: ImsDocumentKind;
  readonly status?: ImsDocumentStatus;
  readonly partyId?: number;
  readonly locationId?: number;
  readonly fromDate?: string;
  readonly toDate?: string;
  readonly search?: string;
  readonly limit?: number;
}

export type ImsTransitionAction =
  | "submit"
  | "approve"
  | "reject"
  | "cancel"
  | "close"
  | "confirm"
  | "dispatch"
  | "receive"
  | "post"
  | "fulfil";

export interface ImsTransitionRequest {
  readonly id: number;
  readonly action: ImsTransitionAction;
  readonly reason?: string | null;
  /** Where a receipt or a return lands. Defaults to the document's location. */
  readonly locationId?: number | null;
}

export interface ImsConvertRequest {
  readonly id: number;
  readonly targetKind: ImsDocumentKind;
  readonly clientToken?: string | null;
}

export interface ReceiveTransferRequest {
  readonly id: number;
  readonly lines: readonly { readonly lineId: number; readonly quantityMilli: number }[];
}

/* ------------------------------------------------------------------------- */
/* stock                                                                     */
/* ------------------------------------------------------------------------- */

export interface StockLocationRow {
  readonly locationId: number;
  readonly locationCode: string;
  readonly locationName: string;
  readonly locationType: string;
  readonly onHandMilli: number;
  readonly reservedMilli: number;
  readonly availableMilli: number;
  readonly inTransitMilli: number;
  readonly quarantineMilli: number;
  readonly damagedMilli: number;
  readonly valueFils: number;
}

export interface StockOverviewRow {
  readonly productId: number;
  readonly sku: string;
  readonly name: string;
  readonly category: string | null;
  readonly brand: string | null;
  readonly unit: string;
  readonly onHandMilli: number;
  readonly reservedMilli: number;
  readonly availableMilli: number;
  readonly incomingMilli: number;
  readonly outgoingMilli: number;
  readonly inTransitMilli: number;
  readonly quarantineMilli: number;
  readonly damagedMilli: number;
  readonly averageCostFils: number;
  readonly valueFils: number;
  readonly reorderPointMilli: number;
  readonly isLow: boolean;
  readonly isOut: boolean;
  readonly locations: readonly StockLocationRow[];
}

export interface StockOverviewRequest {
  readonly search?: string;
  readonly category?: string;
  readonly locationId?: number;
  readonly onlyLow?: boolean;
  readonly onlyOut?: boolean;
  readonly limit?: number;
}

export interface BatchRow {
  readonly id: number;
  readonly productId: number;
  readonly productName: string;
  readonly sku: string;
  readonly batchNo: string;
  readonly lotNo: string | null;
  readonly manufacturedOn: string | null;
  readonly expiryDate: string | null;
  readonly quantityMilli: number;
  readonly valueFils: number;
  readonly daysToExpiry: number | null;
  readonly expired: boolean;
}

export interface SerialRow {
  readonly id: number;
  readonly productId: number;
  readonly productName: string;
  readonly serialNumber: string;
  readonly status: "inStock" | "sold" | "returned" | "quarantine" | "scrapped";
  readonly locationName: string | null;
  readonly sourceKind: string | null;
  readonly sourceNumber: string | null;
  readonly updatedAt: string;
}

export interface ReservationRow {
  readonly id: number;
  readonly productId: number;
  readonly productName: string;
  readonly locationName: string | null;
  readonly quantityMilli: number;
  readonly sourceKind: string;
  readonly sourceId: number;
  readonly sourceNumber: string | null;
  readonly status: "active" | "released" | "consumed";
  readonly notes: string | null;
  readonly createdAt: string;
}

/* ------------------------------------------------------------------------- */
/* pricing and replenishment                                                 */
/* ------------------------------------------------------------------------- */

export interface PriceListDto {
  readonly id: number;
  readonly name: string;
  readonly kind: "retail" | "wholesale" | "customer";
  readonly partyId: number | null;
  readonly partyName: string | null;
  readonly isActive: boolean;
  readonly itemCount: number;
}

export interface PriceListItemDto {
  readonly id: number;
  readonly priceListId: number;
  readonly productId: number;
  readonly productName: string;
  readonly sku: string;
  readonly priceFils: number;
  readonly minQuantityMilli: number;
  readonly discountLimitPercent: number;
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
}

export interface SavePriceListRequest {
  readonly id?: number;
  readonly name: string;
  readonly kind: PriceListDto["kind"];
  readonly partyId?: number | null;
  readonly isActive?: boolean;
}

export interface SavePriceItemRequest {
  readonly id?: number;
  readonly priceListId: number;
  readonly productId: number;
  readonly priceFils: number;
  readonly minQuantityMilli?: number;
  readonly discountLimitPercent?: number;
  readonly effectiveFrom?: string | null;
  readonly effectiveTo?: string | null;
}

export interface ResolvedPriceDto {
  readonly productId: number;
  readonly priceFils: number;
  readonly priceListId: number | null;
  readonly priceListName: string | null;
  readonly minQuantityMilli: number;
  readonly discountLimitPercent: number;
  readonly source: "priceList" | "product";
}

export interface ReplenishmentRow {
  readonly productId: number;
  readonly sku: string;
  readonly name: string;
  readonly supplierId: number | null;
  readonly supplierName: string | null;
  readonly leadTimeDays: number;
  readonly onHandMilli: number;
  readonly reservedMilli: number;
  readonly eligibleMilli: number;
  readonly incomingMilli: number;
  readonly reorderPointMilli: number;
  readonly minimumMilli: number;
  readonly maximumMilli: number;
  readonly safetyMilli: number;
  readonly suggestedMilli: number;
  readonly lastCostFils: number;
  readonly suggestedValueFils: number;
  readonly reason: "belowReorder" | "belowSafety" | "belowMinimum";
}

/* ------------------------------------------------------------------------- */
/* dashboard and reports                                                     */
/* ------------------------------------------------------------------------- */

export interface ImsDashboardRequest {
  readonly fromDate?: string;
  readonly toDate?: string;
  readonly locationId?: number;
  readonly category?: string;
}

export interface ImsDashboardDto {
  readonly period: { readonly fromDate: string; readonly toDate: string };
  readonly kpis: {
    readonly activeProducts: number;
    readonly skus: number;
    readonly onHandMilli: number;
    readonly availableMilli: number;
    readonly reservedMilli: number;
    readonly valuationFils: number;
    readonly lowStockCount: number;
    readonly outOfStockCount: number;
    readonly pendingPurchaseOrders: number;
    readonly pendingGoodsReceipts: number;
    readonly salesFils: number;
    readonly purchasesFils: number;
  };
  readonly inventoryValueSeries: readonly { readonly date: string; readonly valueFils: number }[];
  readonly stockFlowSeries: readonly {
    readonly date: string;
    readonly inMilli: number;
    readonly outMilli: number;
  }[];
  readonly categoryMix: readonly {
    readonly name: string;
    readonly count: number;
    readonly valueFils: number;
  }[];
  readonly purchaseSalesSeries: readonly {
    readonly month: string;
    readonly salesFils: number;
    readonly purchasesFils: number;
  }[];
  readonly fastMoving: readonly {
    readonly productId: number;
    readonly name: string;
    readonly quantityMilli: number;
    readonly valueFils: number;
  }[];
  readonly slowMoving: readonly {
    readonly productId: number;
    readonly name: string;
    readonly quantityMilli: number;
    readonly valueFils: number;
    readonly lastSoldOn: string | null;
  }[];
  readonly lowStockTrend: readonly { readonly date: string; readonly count: number }[];
  readonly stockStatusMix: readonly {
    readonly status: string;
    readonly count: number;
    readonly valueFils: number;
  }[];
  readonly lowStock: readonly {
    readonly productId: number;
    readonly name: string;
    readonly sku: string;
    readonly onHandMilli: number;
    readonly reorderPointMilli: number;
  }[];
  readonly recentMovements: readonly {
    readonly id: number;
    readonly movementDate: string;
    readonly productName: string;
    readonly kind: string;
    readonly quantityMilli: number;
    readonly locationName: string | null;
    readonly sourceNumber: string | null;
  }[];
  readonly pendingApprovals: readonly {
    readonly id: number;
    readonly number: string;
    readonly kind: string;
    readonly partyName: string | null;
    readonly totalFils: number;
    readonly issueDate: string;
  }[];
  readonly pendingReceipts: readonly {
    readonly id: number;
    readonly number: string;
    readonly partyName: string | null;
    readonly dueDate: string | null;
    readonly outstandingLines: number;
  }[];
  readonly recentSales: readonly {
    readonly id: number;
    readonly number: string;
    readonly partyName: string | null;
    readonly issueDate: string;
    readonly totalFils: number;
  }[];
  readonly replenishment: readonly ReplenishmentRow[];
  readonly exceptions: readonly {
    readonly kind: string;
    readonly message: string;
    readonly severity: "warning" | "danger";
  }[];
  readonly generatedAtIso: string;
}

export type ImsReportId =
  | "currentStock"
  | "availableStock"
  | "stockByLocation"
  | "stockValuation"
  | "stockLedger"
  | "stockMovement"
  | "stockAging"
  | "slowMoving"
  | "deadStock"
  | "lowStock"
  | "outOfStock"
  | "reorderCandidates"
  | "stockAdjustments"
  | "stockCounts"
  | "batchTrace"
  | "expiry"
  | "purchaseSummary"
  | "purchaseOrderStatus"
  | "purchaseReceipts"
  | "pendingReceipts"
  | "supplierPurchaseHistory"
  | "supplierPerformance"
  | "supplierReturns"
  | "purchasePriceVariance"
  | "salesSummary"
  | "salesByProduct"
  | "salesByCustomer"
  | "salesByCategory"
  | "posSales"
  | "salesReturns"
  | "discounts"
  | "cogsMargin"
  | "customerBalances"
  | "expenseSummary"
  | "expenseByCategory"
  | "paymentCollection"
  | "supplierPayments"
  | "outstandingBalances";

export interface ImsReportRequest {
  readonly report: ImsReportId;
  readonly fromDate?: string;
  readonly toDate?: string;
  readonly locationId?: number;
  readonly category?: string;
  readonly partyId?: number;
  readonly status?: string;
  readonly search?: string;
}

export interface ImsReportColumn {
  readonly id: string;
  readonly label: string;
  readonly align?: "start" | "end" | "center";
  readonly type?: "text" | "number" | "money" | "quantity" | "date";
}

export interface ImsReportDto {
  readonly report: ImsReportId;
  readonly title: string;
  readonly period: { readonly fromDate: string; readonly toDate: string };
  readonly columns: readonly ImsReportColumn[];
  readonly rows: readonly Readonly<Record<string, string | number | null>>[];
  readonly totals: Readonly<Record<string, number>>;
  readonly generatedAtIso: string;
  readonly timezone: string;
}

/* ------------------------------------------------------------------------- */
/* POS                                                                       */
/* ------------------------------------------------------------------------- */

export interface PosShiftDto {
  readonly id: number;
  readonly registerName: string;
  readonly openedBy: string;
  readonly openingFloatFils: number;
  readonly closingCountedFils: number | null;
  readonly expectedCashFils: number | null;
  readonly varianceFils: number | null;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly status: "open" | "closed";
  readonly notes: string | null;
}

export interface PosStateDto {
  readonly shift: PosShiftDto | null;
  readonly canSell: boolean;
  readonly todaySalesFils: number;
  readonly todaySalesCount: number;
  readonly heldSales: readonly {
    readonly id: number;
    readonly clientToken: string;
    readonly customerName: string | null;
    readonly itemCount: number;
    readonly totalFils: number;
    readonly createdAt: string;
  }[];
}

export interface PosSaleLine {
  readonly productId: number;
  readonly description: string;
  readonly quantityMilli: number;
  readonly unitPriceFils: number;
  readonly discountFils?: number;
  readonly vatTreatment?: VatTreatment;
}

export interface PosSaleRequest {
  readonly clientToken: string;
  readonly shiftId: number;
  readonly customerId?: number | null;
  readonly lines: readonly PosSaleLine[];
  readonly discountFils?: number;
  readonly paymentMethod: "cash" | "bank" | "card";
  readonly tenderedFils: number;
  readonly notes?: string | null;
  /** Actually complete the sale. False parks it for later. */
  readonly complete?: boolean;
}

export interface PosSaleResult {
  readonly documentId: number;
  readonly number: string;
  readonly totalFils: number;
  readonly tenderedFils: number;
  readonly changeFils: number;
  readonly replayed: boolean;
}

export interface PosHistoryRow {
  readonly id: number;
  readonly number: string;
  readonly issueDate: string;
  readonly partyName: string | null;
  readonly totalFils: number;
  readonly paidFils: number;
  readonly method: string;
  readonly shiftId: number | null;
  readonly createdAt: string;
}

export interface OpenShiftRequest {
  readonly registerName: string;
  readonly openingFloatFils: number;
}

export interface CloseShiftRequest {
  readonly id: number;
  readonly closingCountedFils: number;
  readonly notes?: string | null;
}

/* ------------------------------------------------------------------------- */
/* configuration                                                             */
/* ------------------------------------------------------------------------- */

export interface ImsConfigDto {
  readonly negativeStockPolicy: "block" | "allow";
  readonly valuationMethod: "lastCost" | "weightedAverage" | "fifo";
  readonly barcodePrefix: string;
  readonly skuPrefix: string;
  readonly purchaseApprovalThresholdFils: number;
  readonly salesDiscountLimitPercent: number;
  readonly returnPolicyDays: number;
  readonly requireBatchOnReceipt: boolean;
  readonly requireSerialOnReceipt: boolean;
  readonly allowQuarantineRestock: boolean;
  readonly defaultLocationId: number | null;
  readonly salesApprovalRequired: boolean;
  readonly allowBackorder: boolean;
}

export interface ImsConfigPatch {
  readonly negativeStockPolicy?: "block" | "allow";
  readonly valuationMethod?: "lastCost" | "weightedAverage" | "fifo";
  readonly barcodePrefix?: string;
  readonly skuPrefix?: string;
  readonly purchaseApprovalThresholdFils?: number;
  readonly salesDiscountLimitPercent?: number;
  readonly returnPolicyDays?: number;
  readonly requireBatchOnReceipt?: boolean;
  readonly requireSerialOnReceipt?: boolean;
  readonly allowQuarantineRestock?: boolean;
  readonly defaultLocationId?: number | null;
  readonly salesApprovalRequired?: boolean;
  readonly allowBackorder?: boolean;
}

/* ------------------------------------------------------------------------- */
/* reference data and product detail                                         */
/* ------------------------------------------------------------------------- */

export interface BrandDto {
  readonly id: number;
  readonly name: string;
  readonly isActive: boolean;
  readonly productCount: number;
}

export interface UnitDto {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly baseCode: string | null;
  readonly factorMilli: number;
  readonly isActive: boolean;
  readonly productCount: number;
}

export interface CategoryDto {
  readonly name: string;
  readonly productCount: number;
  readonly valueFils: number;
}

export interface ImsReferenceDto {
  readonly locations: readonly ImsLocationDto[];
  readonly brands: readonly BrandDto[];
  readonly units: readonly UnitDto[];
  readonly categories: readonly CategoryDto[];
  readonly priceLists: readonly PriceListDto[];
  readonly config: ImsConfigDto;
}

export interface ProductDetailDto {
  readonly product: {
    readonly id: number;
    readonly sku: string;
    readonly barcode: string | null;
    readonly name: string;
    readonly description: string | null;
    readonly category: string | null;
    readonly subcategory: string | null;
    readonly brand: string | null;
    readonly unit: string;
    readonly purchaseUnit: string | null;
    readonly salesUnit: string | null;
    readonly packSizeMilli: number;
    readonly productType: string;
    readonly parentId: number | null;
    readonly variantLabel: string | null;
    readonly quantityMilli: number;
    readonly reorderLevelMilli: number;
    readonly averageCostFils: number;
    readonly salePriceFils: number;
    readonly vatTreatment: VatTreatment;
    readonly isActive: boolean;
    readonly preferredSupplierId: number | null;
    readonly preferredSupplierName: string | null;
  };
  readonly variants: readonly {
    readonly id: number;
    readonly sku: string;
    readonly name: string;
    readonly variantLabel: string | null;
    readonly quantityMilli: number;
    readonly salePriceFils: number;
    readonly isActive: boolean;
  }[];
  readonly stockByLocation: readonly StockLocationRow[];
  readonly pricing: readonly {
    readonly priceListName: string;
    readonly priceFils: number;
    readonly minQuantityMilli: number;
    readonly effectiveFrom: string | null;
    readonly effectiveTo: string | null;
  }[];
  readonly purchases: readonly {
    readonly id: number;
    readonly number: string;
    readonly issueDate: string;
    readonly partyName: string | null;
    readonly quantityMilli: number;
    readonly unitPriceFils: number;
  }[];
  readonly sales: readonly {
    readonly id: number;
    readonly number: string;
    readonly issueDate: string;
    readonly partyName: string | null;
    readonly quantityMilli: number;
    readonly unitPriceFils: number;
  }[];
  readonly suppliers: readonly {
    readonly id: number;
    readonly name: string;
    readonly lastCostFils: number;
    readonly lastPurchaseDate: string;
  }[];
  readonly movements: readonly {
    readonly id: number;
    readonly movementDate: string;
    readonly kind: string;
    readonly quantityMilli: number;
    readonly unitCostFils: number;
    readonly costFils: number;
    readonly locationName: string | null;
    readonly sourceKind: string | null;
    readonly sourceNumber: string | null;
    readonly batchNo: string | null;
    readonly notes: string | null;
  }[];
  readonly batches: readonly BatchRow[];
  readonly serials: readonly SerialRow[];
  readonly activity: readonly {
    readonly occurredAt: string;
    readonly actorName: string;
    readonly action: string;
    readonly module: string;
  }[];
}

export interface VariantListRequest {
  readonly parentId?: number;
  readonly search?: string;
  readonly limit?: number;
}

export interface VariantRow {
  readonly id: number;
  readonly parentId: number | null;
  readonly parentName: string | null;
  readonly sku: string;
  readonly name: string;
  readonly variantLabel: string | null;
  readonly barcode: string | null;
  readonly quantityMilli: number;
  readonly salePriceFils: number;
  readonly isActive: boolean;
}

export interface SaveVariantRequest {
  readonly parentId: number;
  readonly id?: number;
  readonly name?: string;
  readonly variantLabel: string;
  readonly sku?: string;
  readonly barcode?: string | null;
  readonly salePriceFils?: number;
  readonly openingQuantityMilli?: number;
  readonly isActive?: boolean;
}
