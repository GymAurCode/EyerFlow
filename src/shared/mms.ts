/**
 * Manufacturing & Production Management System (MMS) shapes shared by the
 * main process and the renderer.
 *
 * MMS reuses the existing product master (`products`) and the authoritative
 * IMS stock engine (`postMovement`, `reserveStock`, `releaseReservations`).
 * Nothing here creates a duplicate product table or an independent stock
 * ledger. Money remains integer fils; quantities remain integer thousandths.
 */

export const MMS_DOCUMENT_STATUSES = [
  "planned",
  "confirmed",
  "released",
  "inProgress",
  "qualityReview",
  "completed",
  "closed",
  "hold",
  "cancelled",
] as const;

export type MmsDocumentStatus = (typeof MMS_DOCUMENT_STATUSES)[number];

export const MMS_WORK_ORDER_STATUSES = [
  "blocked",
  "ready",
  "inProgress",
  "paused",
  "completed",
  "hold",
  "cancelled",
] as const;

export type MmsWorkOrderStatus = (typeof MMS_WORK_ORDER_STATUSES)[number];

export const MMS_QUALITY_RESULTS = [
  "pending",
  "passed",
  "failed",
  "quarantined",
  "reworkRequired",
  "rejected",
  "released",
] as const;

export type MmsQualityResult = (typeof MMS_QUALITY_RESULTS)[number];

export const MMS_BOM_STATUSES = [
  "draft",
  "review",
  "approved",
  "superseded",
  "archived",
] as const;

export type MmsBomStatus = (typeof MMS_BOM_STATUSES)[number];

export const MMS_BOM_TYPES = [
  "assembly",
  "recipe",
  "subcontract",
  "multiLevel",
] as const;

export type MmsBomType = (typeof MMS_BOM_TYPES)[number];

export const MMS_SCRAP_TYPES = ["material", "process", "finishedProduct"] as const;
export type MmsScrapType = (typeof MMS_SCRAP_TYPES)[number];

export const MMS_ISSUE_TYPES = ["reservation", "issue", "return"] as const;
export type MmsIssueType = (typeof MMS_ISSUE_TYPES)[number];

export const MMS_COST_TYPES = [
  "material",
  "labor",
  "machine",
  "overhead",
  "subcontract",
  "rework",
  "scrap",
] as const;
export type MmsCostType = (typeof MMS_COST_TYPES)[number];

export const MMS_INSPECTION_TYPES = [
  "passFail",
  "numerical",
  "checklist",
  "visual",
  "evidence",
] as const;
export type MmsInspectionType = (typeof MMS_INSPECTION_TYPES)[number];

export const MMS_MAINTENANCE_STATUSES = [
  "open",
  "assigned",
  "inProgress",
  "resolved",
  "closed",
] as const;
export type MmsMaintenanceStatus = (typeof MMS_MAINTENANCE_STATUSES)[number];

export const MMS_MAINTENANCE_PRIORITIES = [
  "low",
  "normal",
  "high",
  "critical",
] as const;
export type MmsMaintenancePriority = (typeof MMS_MAINTENANCE_PRIORITIES)[number];

export const MMS_SUBCONTRACT_STATUSES = [
  "planned",
  "inProgress",
  "received",
  "completed",
  "cancelled",
] as const;
export type MmsSubcontractStatus = (typeof MMS_SUBCONTRACT_STATUSES)[number];

/* -------------------------------------------------------------------------- */
/* BOM                                                                        */
/* -------------------------------------------------------------------------- */

export interface BomComponentDto {
  readonly id: number;
  readonly bomId: number;
  readonly componentProductId: number;
  readonly componentSku: string;
  readonly componentName: string;
  readonly quantityPerUnit: number;
  readonly unit: string;
  readonly scrapPercent: number;
  readonly isOptional: boolean;
  readonly substitutionAllowed: boolean;
  readonly lineNo: number;
  readonly notes: string | null;
}

export interface BomDto {
  readonly id: number;
  readonly number: string;
  readonly productId: number;
  readonly productSku: string;
  readonly productName: string;
  readonly variantId: number | null;
  readonly variantLabel: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly bomType: MmsBomType;
  readonly baseOutputQuantity: number;
  readonly outputUnit: string;
  readonly expectedScrapPercent: number;
  readonly routingId: number | null;
  readonly routingName: string | null;
  readonly expectedProductionTimeMinutes: number | null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly status: MmsBomStatus;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly components: readonly BomComponentDto[];
}

export interface SaveBomRequest {
  readonly id?: number;
  readonly number?: string;
  readonly productId: number;
  readonly variantId?: number | null;
  readonly name: string;
  readonly description?: string | null;
  readonly bomType?: MmsBomType;
  readonly baseOutputQuantity?: number;
  readonly outputUnit?: string;
  readonly expectedScrapPercent?: number;
  readonly routingId?: number | null;
  readonly expectedProductionTimeMinutes?: number | null;
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string | null;
  readonly status?: MmsBomStatus;
}

export interface SaveBomComponentRequest {
  readonly id?: number;
  readonly bomId: number;
  readonly componentProductId: number;
  readonly quantityPerUnit: number;
  readonly unit?: string;
  readonly scrapPercent?: number;
  readonly isOptional?: boolean;
  readonly substitutionAllowed?: boolean;
  readonly lineNo?: number;
  readonly notes?: string | null;
}

export interface BomVersionDto {
  readonly id: number;
  readonly bomId: number;
  readonly versionNumber: number;
  readonly snapshotJson: string;
  readonly createdAt: string;
}

export interface BomListRequest {
  readonly productId?: number;
  readonly status?: MmsBomStatus;
  readonly bomType?: MmsBomType;
  readonly search?: string;
  readonly limit?: number;
}

/* -------------------------------------------------------------------------- */
/* Routing                                                                    */
/* -------------------------------------------------------------------------- */

export interface RouteOperationDto {
  readonly id: number;
  readonly routeId: number;
  readonly operationCode: string;
  readonly name: string;
  readonly description: string | null;
  readonly sequence: number;
  readonly prerequisiteOpId: number | null;
  readonly prerequisiteName: string | null;
  readonly workCenterId: number | null;
  readonly workCenterName: string | null;
  readonly setupTimeMinutes: number;
  readonly cycleTimeMinutes: number;
  readonly expectedOutputQty: number;
  readonly laborRequired: number;
  readonly costRateFilsPerHour: number;
  readonly qualityCheckpoint: boolean;
  readonly workInstructions: string | null;
}

export interface RouteDto {
  readonly id: number;
  readonly number: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: MmsBomStatus;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly operations: readonly RouteOperationDto[];
}

export interface SaveRouteRequest {
  readonly id?: number;
  readonly number?: string;
  readonly name: string;
  readonly description?: string | null;
  readonly status?: MmsBomStatus;
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string | null;
}

export interface SaveRouteOperationRequest {
  readonly id?: number;
  readonly routeId: number;
  readonly operationCode: string;
  readonly name: string;
  readonly description?: string | null;
  readonly sequence?: number;
  readonly prerequisiteOpId?: number | null;
  readonly workCenterId?: number | null;
  readonly setupTimeMinutes?: number;
  readonly cycleTimeMinutes?: number;
  readonly expectedOutputQty?: number;
  readonly laborRequired?: number;
  readonly costRateFilsPerHour?: number;
  readonly qualityCheckpoint?: boolean;
  readonly workInstructions?: string | null;
}

export interface RouteListRequest {
  readonly status?: MmsBomStatus;
  readonly search?: string;
  readonly limit?: number;
}

/* -------------------------------------------------------------------------- */
/* Work centers                                                               */
/* -------------------------------------------------------------------------- */

export interface WorkCenterDto {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly plant: string | null;
  readonly type: string;
  readonly capacity: number;
  readonly capacityUnit: string;
  readonly operatingSchedule: string | null;
  readonly shiftId: number | null;
  readonly hourlyOperatingCostFils: number;
  readonly availabilityPct: number;
  readonly efficiencyPct: number;
  readonly maintenanceStatus: string;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveWorkCenterRequest {
  readonly id?: number;
  readonly code: string;
  readonly name: string;
  readonly plant?: string | null;
  readonly type?: string;
  readonly capacity?: number;
  readonly capacityUnit?: string;
  readonly operatingSchedule?: string | null;
  readonly shiftId?: number | null;
  readonly hourlyOperatingCostFils?: number;
  readonly availabilityPct?: number;
  readonly efficiencyPct?: number;
  readonly maintenanceStatus?: string;
  readonly isActive?: boolean;
}

export interface WorkCenterListRequest {
  readonly isActive?: boolean;
  readonly search?: string;
  readonly limit?: number;
}

/* -------------------------------------------------------------------------- */
/* Equipment                                                                  */
/* -------------------------------------------------------------------------- */

export interface EquipmentDto {
  readonly id: number;
  readonly machineCode: string;
  readonly name: string;
  readonly workCenterId: number | null;
  readonly workCenterName: string | null;
  readonly status: string;
  readonly capacity: number | null;
  readonly setupTimeMinutes: number;
  readonly operatingRateFilsPerHour: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveEquipmentRequest {
  readonly id?: number;
  readonly machineCode: string;
  readonly name: string;
  readonly workCenterId?: number | null;
  readonly status?: string;
  readonly capacity?: number | null;
  readonly setupTimeMinutes?: number;
  readonly operatingRateFilsPerHour?: number;
}

export interface EquipmentListRequest {
  readonly workCenterId?: number;
  readonly status?: string;
  readonly search?: string;
  readonly limit?: number;
}

/* -------------------------------------------------------------------------- */
/* Manufacturing Orders                                                       */
/* -------------------------------------------------------------------------- */

export interface MoComponentDto {
  readonly id: number;
  readonly moId: number;
  readonly componentProductId: number;
  readonly componentSku: string;
  readonly componentName: string;
  readonly requiredQuantity: number;
  readonly issuedQuantity: number;
  readonly consumedQuantity: number;
  readonly unit: string;
  readonly sourceBomLineId: number | null;
  readonly lineNo: number;
  readonly notes: string | null;
}

export interface ManufacturingOrderDto {
  readonly planningLocationId?: number | null;
  readonly id: number;
  readonly number: string;
  readonly productId: number;
  readonly productSku: string;
  readonly productName: string;
  readonly variantId: number | null;
  readonly variantLabel: string | null;
  readonly bomId: number;
  readonly bomNumber: string;
  readonly bomVersionId: number | null;
  readonly routeId: number | null;
  readonly routeNumber: string | null;
  readonly plannedQuantity: number;
  readonly actualQuantity: number;
  readonly acceptedQuantity: number;
  readonly rejectedQuantity: number;
  readonly unit: string;
  readonly plannedStart: string | null;
  readonly plannedFinish: string | null;
  readonly actualStart: string | null;
  readonly actualFinish: string | null;
  readonly plant: string | null;
  readonly sourceDemand: string | null;
  readonly priority: number;
  readonly status: MmsDocumentStatus;
  readonly plannedCostFils: number;
  readonly actualCostFils: number;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly components: readonly MoComponentDto[];
}

export interface SaveManufacturingOrderRequest {
  readonly id?: number;
  readonly number?: string;
  readonly productId: number;
  readonly variantId?: number | null;
  readonly bomId: number;
  readonly routeId?: number | null;
  readonly plannedQuantity: number;
  readonly unit?: string;
  readonly plannedStart?: string | null;
  readonly plannedFinish?: string | null;
  readonly plant?: string | null;
  readonly sourceDemand?: string | null;
  readonly priority?: number;
  readonly status?: MmsDocumentStatus;
}

export interface MoListRequest {
  readonly productId?: number;
  readonly status?: MmsDocumentStatus;
  readonly plant?: string;
  readonly fromDate?: string;
  readonly toDate?: string;
  readonly search?: string;
  readonly limit?: number;
}

/* -------------------------------------------------------------------------- */
/* Work orders                                                                */
/* -------------------------------------------------------------------------- */

export interface WorkOrderDto {
  readonly id: number;
  readonly moId: number;
  readonly moNumber: string;
  readonly routeOperationId: number;
  readonly operationCode: string;
  readonly operationName: string;
  readonly workCenterId: number | null;
  readonly workCenterName: string | null;
  readonly operatorId: number | null;
  readonly operatorName: string | null;
  readonly plannedQuantity: number;
  readonly actualQuantity: number;
  readonly acceptedQuantity: number;
  readonly rejectedQuantity: number;
  readonly expectedDurationMinutes: number;
  readonly actualDurationMinutes: number;
  readonly status: MmsWorkOrderStatus;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly plannedStart: string | null;
  readonly plannedFinish: string | null;
  readonly notes: string | null;
}

export interface SaveWorkOrderRequest {
  readonly id?: number;
  readonly moId: number;
  readonly routeOperationId: number;
  readonly workCenterId?: number | null;
  readonly operatorId?: number | null;
  readonly plannedQuantity?: number;
  readonly status?: MmsWorkOrderStatus;
  readonly notes?: string | null;
}

export interface WorkOrderListRequest {
  readonly moId?: number;
  readonly workCenterId?: number;
  readonly status?: MmsWorkOrderStatus;
  readonly operatorId?: number;
  readonly limit?: number;
}

/* -------------------------------------------------------------------------- */
/* Job time logs                                                              */
/* -------------------------------------------------------------------------- */

export interface JobTimeLogDto {
  readonly id: number;
  readonly workOrderId: number;
  readonly operatorId: number | null;
  readonly operatorName: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly durationMinutes: number;
  readonly downtimeMinutes: number;
  readonly downtimeReason: string | null;
  readonly createdAt: string;
}

export interface SaveJobTimeLogRequest {
  readonly workOrderId: number;
  readonly operatorId?: number | null;
  readonly startedAt: string;
  readonly endedAt?: string | null;
  readonly downtimeMinutes?: number;
  readonly downtimeReason?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Material issues & consumption                                              */
/* -------------------------------------------------------------------------- */

export interface MaterialIssueDto {
  readonly id: number;
  readonly moId: number;
  readonly moNumber: string;
  readonly workOrderId: number | null;
  readonly componentProductId: number;
  readonly componentSku: string;
  readonly componentName: string;
  readonly quantityMilli: number;
  readonly unit: string;
  readonly issueType: MmsIssueType;
  readonly fromLocationId: number | null;
  readonly toLocationId: number | null;
  readonly stockMovementId: number | null;
  readonly idempotencyKey: string | null;
  readonly createdAt: string;
  readonly createdBy: string | null;
}

export interface SaveMaterialIssueRequest {
  readonly moId: number;
  readonly workOrderId?: number | null;
  readonly componentProductId: number;
  readonly quantityMilli: number;
  readonly issueType?: MmsIssueType;
  readonly fromLocationId?: number | null;
  readonly toLocationId?: number | null;
  readonly idempotencyKey?: string | null;
}

export interface ConsumptionRecordDto {
  readonly id: number;
  readonly moId: number;
  readonly moNumber: string;
  readonly workOrderId: number | null;
  readonly componentProductId: number;
  readonly componentSku: string;
  readonly componentName: string;
  readonly quantityMilli: number;
  readonly unitCostFils: number;
  readonly costFils: number;
  readonly stockMovementId: number | null;
  readonly batchNo: string | null;
  readonly serialNo: string | null;
  readonly consumedAt: string;
  readonly consumedBy: string | null;
  readonly notes: string | null;
}

export interface SaveConsumptionRecordRequest {
  readonly moId: number;
  readonly workOrderId?: number | null;
  readonly componentProductId: number;
  readonly quantityMilli: number;
  readonly unitCostFils?: number;
  readonly batchNo?: string | null;
  readonly serialNo?: string | null;
  readonly notes?: string | null;
}

export interface MaterialIssueListRequest {
  readonly moId?: number;
  readonly workOrderId?: number;
  readonly productId?: number;
  readonly issueType?: MmsIssueType;
  readonly limit?: number;
}

/* -------------------------------------------------------------------------- */
/* WIP                                                                        */
/* -------------------------------------------------------------------------- */

export interface WipRecordDto {
  readonly id: number;
  readonly moId: number;
  readonly moNumber: string;
  readonly workOrderId: number | null;
  readonly productId: number;
  readonly productSku: string;
  readonly productName: string;
  readonly quantityMilli: number;
  readonly stage: string;
  readonly workCenterId: number | null;
  readonly workCenterName: string | null;
  readonly materialCostFils: number;
  readonly laborCostFils: number;
  readonly machineCostFils: number;
  readonly overheadCostFils: number;
  readonly updatedAt: string;
}

export interface WipListRequest {
  readonly moId?: number;
  readonly productId?: number;
  readonly stage?: string;
  readonly limit?: number;
}

/* -------------------------------------------------------------------------- */
/* Quality control                                                            */
/* -------------------------------------------------------------------------- */

export interface QualityCheckDto {
  readonly id: number;
  readonly moId: number;
  readonly moNumber: string;
  readonly workOrderId: number | null;
  readonly checkpoint: string;
  readonly inspectionType: MmsInspectionType;
  readonly result: MmsQualityResult;
  readonly measuredValue: string | null;
  readonly toleranceMin: string | null;
  readonly toleranceMax: string | null;
  readonly inspectorId: number | null;
  readonly inspectorName: string | null;
  readonly inspectedAt: string | null;
  readonly notes: string | null;
  readonly evidenceRef: string | null;
}

export interface SaveQualityCheckRequest {
  readonly moId: number;
  readonly workOrderId?: number | null;
  readonly checkpoint: string;
  readonly inspectionType?: MmsInspectionType;
  readonly result?: MmsQualityResult;
  readonly measuredValue?: string | null;
  readonly toleranceMin?: string | null;
  readonly toleranceMax?: string | null;
  readonly inspectorId?: number | null;
  readonly notes?: string | null;
  readonly evidenceRef?: string | null;
}

export interface QualityCheckListRequest {
  readonly moId?: number;
  readonly workOrderId?: number;
  readonly result?: MmsQualityResult;
  readonly limit?: number;
}

/* -------------------------------------------------------------------------- */
/* Scrap                                                                      */
/* -------------------------------------------------------------------------- */

export interface ScrapDto {
  readonly id: number;
  readonly moId: number;
  readonly moNumber: string;
  readonly workOrderId: number | null;
  readonly productId: number;
  readonly productSku: string;
  readonly productName: string;
  readonly quantityMilli: number;
  readonly scrapType: MmsScrapType;
  readonly scrapReason: string | null;
  readonly costFils: number;
  readonly workCenterId: number | null;
  readonly workCenterName: string | null;
  readonly stockMovementId: number | null;
  readonly createdAt: string;
  readonly createdBy: string | null;
}

export interface SaveScrapRequest {
  readonly moId: number;
  readonly workOrderId?: number | null;
  readonly productId: number;
  readonly quantityMilli: number;
  readonly scrapType?: MmsScrapType;
  readonly scrapReason?: string | null;
  readonly workCenterId?: number | null;
}

export interface ScrapListRequest {
  readonly moId?: number;
  readonly productId?: number;
  readonly scrapType?: MmsScrapType;
  readonly limit?: number;
}

/* -------------------------------------------------------------------------- */
/* Rework                                                                     */
/* -------------------------------------------------------------------------- */

export interface ReworkDto {
  readonly id: number;
  readonly moId: number;
  readonly moNumber: string;
  readonly workOrderId: number | null;
  readonly outputProductId: number;
  readonly outputProductSku: string;
  readonly outputProductName: string;
  readonly quantityMilli: number;
  readonly reason: string | null;
  readonly extraMaterialCostFils: number;
  readonly extraLaborCostFils: number;
  readonly status: string;
  readonly reinspectionResult: string | null;
  readonly createdAt: string;
  readonly createdBy: string | null;
}

export interface SaveReworkRequest {
  readonly moId: number;
  readonly workOrderId?: number | null;
  readonly outputProductId: number;
  readonly quantityMilli: number;
  readonly reason?: string | null;
  readonly status?: string;
  readonly extraMaterialCostFils?: number;
  readonly extraLaborCostFils?: number;
  readonly reinspectionResult?: string | null;
}

export interface ReworkListRequest {
  readonly moId?: number;
  readonly status?: string;
  readonly limit?: number;
}

/* -------------------------------------------------------------------------- */
/* Finished goods receipts                                                    */
/* -------------------------------------------------------------------------- */

export interface FinishedReceiptDto {
  readonly id: number;
  readonly moId: number;
  readonly moNumber: string;
  readonly workOrderId: number | null;
  readonly productId: number;
  readonly productSku: string;
  readonly productName: string;
  readonly quantityMilli: number;
  readonly acceptedQty: number;
  readonly rejectedQty: number;
  readonly batchNo: string | null;
  readonly serialNo: string | null;
  readonly locationId: number | null;
  readonly unitCostFils: number;
  readonly totalCostFils: number;
  readonly stockMovementId: number | null;
  readonly idempotencyKey: string | null;
  readonly receivedAt: string;
  readonly receivedBy: string | null;
  readonly notes: string | null;
}

export interface SaveFinishedReceiptRequest {
  readonly moId: number;
  readonly workOrderId?: number | null;
  readonly quantityMilli: number;
  readonly batchNo?: string | null;
  readonly serialNo?: string | null;
  readonly locationId?: number | null;
  readonly idempotencyKey?: string | null;
  readonly notes?: string | null;
}

export interface FinishedReceiptListRequest {
  readonly moId?: number;
  readonly productId?: number;
  readonly limit?: number;
}

/* -------------------------------------------------------------------------- */
/* Costing                                                                    */
/* -------------------------------------------------------------------------- */

export interface CostRecordDto {
  readonly id: number;
  readonly moId: number;
  readonly moNumber: string;
  readonly costType: MmsCostType;
  readonly amountFils: number;
  readonly quantityBasis: number | null;
  readonly recordedAt: string;
  readonly recordedBy: string | null;
  readonly notes: string | null;
}

export interface SaveCostRecordRequest {
  readonly moId: number;
  readonly costType: MmsCostType;
  readonly amountFils: number;
  readonly quantityBasis?: number | null;
  readonly notes?: string | null;
}

export interface MoCostSummaryDto {
  readonly moId: number;
  readonly moNumber: string;
  readonly productName: string;
  readonly plannedQuantity: number;
  readonly acceptedQuantity: number;
  readonly materialCostFils: number;
  readonly laborCostFils: number;
  readonly machineCostFils: number;
  readonly overheadCostFils: number;
  readonly subcontractCostFils: number;
  readonly reworkCostFils: number;
  readonly scrapCostFils: number;
  readonly totalCostFils: number;
  readonly unitCostFils: number;
  readonly plannedCostFils: number;
  readonly costVarianceFils: number;
}

export interface MoCostListRequest {
  readonly moId?: number;
  readonly productId?: number;
  readonly limit?: number;
}

/* -------------------------------------------------------------------------- */
/* Genealogy / traceability                                                   */
/* -------------------------------------------------------------------------- */

export interface GenealogyLinkDto {
  readonly id: number;
  readonly moId: number;
  readonly moNumber: string;
  readonly finishedLot: string | null;
  readonly componentProductId: number;
  readonly componentSku: string;
  readonly componentName: string;
  readonly componentLot: string | null;
  readonly componentQtyMilli: number;
  readonly workOrderId: number | null;
  readonly operatorId: number | null;
  readonly operatorName: string | null;
  readonly machineId: number | null;
  readonly machineName: string | null;
  readonly createdAt: string;
}

export interface GenealogyListRequest {
  readonly moId?: number;
  readonly productId?: number;
  readonly limit?: number;
}

/* -------------------------------------------------------------------------- */
/| MRP                                                                        */
/* -------------------------------------------------------------------------- */

export interface MrpRequirementDto {
  readonly productUnit: string;
  readonly scheduledReceipts: number;
  readonly reservedQuantity: number;
  readonly safetyStock: number;
  readonly requestedSupply: number;
  readonly suggestedQuantity: number;
  readonly plannedReleaseDate: string | null;
  readonly sourceMoIds: readonly number[];
  readonly bomId: number | null;
  readonly requisitionId: number | null;
  readonly generatedMoId: number | null;
  readonly id: number;
  readonly mrpRunId: number;
  readonly productId: number;
  readonly productSku: string;
  readonly productName: string;
  readonly grossRequirement: number;
  readonly availableSupply: number;
  readonly netRequirement: number;
  readonly shortageQty: number;
  readonly requiredByDate: string | null;
  readonly suggestedAction: string | null;
  readonly sourceMoId: number | null;
  readonly sourceMoNumber: string | null;
  readonly createdAt: string;
}

export interface MrpRunDto {
  readonly fromDate: string;
  readonly toDate: string;
  readonly plant: string | null;
  readonly sourceMoIds: readonly number[];
  readonly id: number;
  readonly runKey: string;
  readonly runDate: string;
  readonly locationId: number | null;
  readonly status: string;
  readonly requirements: readonly MrpRequirementDto[];
}

export interface MrpRunRequest {
  readonly locationId?: number | null;
  readonly moIds?: readonly number[];
  readonly plant?: string | null;
  readonly fromDate?: string;
  readonly toDate?: string;
}

export interface MrpRequirementListRequest {
  readonly mrpRunId?: number;
  readonly productId?: number;
  readonly shortageOnly?: boolean;
  readonly limit?: number;
}

/* -------------------------------------------------------------------------- */
/| MPS                                                                        */
/* -------------------------------------------------------------------------- */

export interface MpsPlanDto {
  readonly productUnit: string;
  readonly periodEnd: string;
  readonly horizon: "daily" | "weekly" | "monthly";
  readonly status: "draft" | "approved" | "converted";
  readonly locationId: number | null;
  readonly bomId: number | null;
  readonly plannedProduction: number;
  readonly scheduledReceipts: number;
  readonly recommendedProduction: number;
  readonly revision: number;
  readonly buckets: readonly MpsBucketDto[];
  readonly id: number;
  readonly planKey: string;
  readonly bucketDate: string;
  readonly productId: number;
  readonly productSku: string;
  readonly productName: string;
  readonly plannedDemand: number;
  readonly confirmedDemand: number;
  readonly forecastDemand: number;
  readonly openingStock: number;
  readonly projectedStock: number;
  readonly safetyStock: number;
  readonly expectedProduction: number;
  readonly expectedShortage: number;
  readonly createdAt: string;
}

export interface MpsBucketDto {
  readonly id: number;
  readonly bucketDate: string;
  readonly endDate: string;
  readonly openingStock: number;
  readonly forecastDemand: number;
  readonly confirmedDemand: number;
  readonly demand: number;
  readonly scheduledReceipts: number;
  readonly plannedProduction: number;
  readonly projectedStock: number;
  readonly shortage: number;
  readonly recommendedProduction: number;
  readonly generatedMoId: number | null;
}

export interface SaveMpsPlanRequest {
  readonly id?: number;
  readonly revision?: number;
  readonly productId: number;
  readonly bomId: number;
  readonly locationId?: number | null;
  readonly fromDate: string;
  readonly toDate: string;
  readonly horizon: "daily" | "weekly" | "monthly";
  readonly forecastDemand: number;
  readonly confirmedDemand: number;
  readonly plannedProduction: number;
  readonly safetyStock: number;
}

export interface PlanningHistoryDto {
  readonly id: number;
  readonly revision: number;
  readonly operation: string;
  readonly snapshotJson: string;
  readonly actorName: string;
  readonly createdAt: string;
}

export interface MpsPlanListRequest {
  readonly productId?: number;
  readonly fromDate?: string;
  readonly toDate?: string;
  readonly limit?: number;
}

/* -------------------------------------------------------------------------- */
/* Maintenance                                                                */
/* -------------------------------------------------------------------------- */

export interface MaintenanceRequestDto {
  readonly id: number;
  readonly machineId: number | null;
  readonly machineName: string | null;
  readonly workCenterId: number | null;
  readonly workCenterName: string | null;
  readonly title: string;
  readonly reason: string | null;
  readonly priority: MmsMaintenancePriority;
  readonly status: MmsMaintenanceStatus;
  readonly reporterId: number | null;
  readonly reporterName: string | null;
  readonly assignedTo: number | null;
  readonly assignedName: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly resolutionNotes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveMaintenanceRequestRequest {
  readonly machineId?: number | null;
  readonly workCenterId?: number | null;
  readonly title: string;
  readonly reason?: string | null;
  readonly priority?: MmsMaintenancePriority;
  readonly status?: MmsMaintenanceStatus;
  readonly assignedTo?: number | null;
  readonly resolutionNotes?: string | null;
}

export interface MaintenanceRequestListRequest {
  readonly status?: MmsMaintenanceStatus;
  readonly machineId?: number;
  readonly workCenterId?: number;
  readonly priority?: MmsMaintenancePriority;
  readonly limit?: number;
}

/* -------------------------------------------------------------------------- */
/* Subcontracting                                                             */
/* -------------------------------------------------------------------------- */

export interface SubcontractOrderDto {
  readonly id: number;
  readonly number: string;
  readonly subcontractorId: number;
  readonly subcontractorName: string;
  readonly productId: number;
  readonly productSku: string;
  readonly productName: string;
  readonly quantityMilli: number;
  readonly processingCostFils: number;
  readonly plannedDelivery: string | null;
  readonly status: MmsSubcontractStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveSubcontractOrderRequest {
  readonly id?: number;
  readonly number?: string;
  readonly subcontractorId: number;
  readonly productId: number;
  readonly quantityMilli: number;
  readonly processingCostFils?: number;
  readonly plannedDelivery?: string | null;
  readonly status?: MmsSubcontractStatus;
}

export interface SubcontractOrderListRequest {
  readonly subcontractorId?: number;
  readonly status?: MmsSubcontractStatus;
  readonly limit?: number;
}

/* -------------------------------------------------------------------------- */
/* MMS config                                                                 */
/* -------------------------------------------------------------------------- */

export interface MmsConfigDto {
  readonly negativeStockPolicy: "block" | "allow";
  readonly defaultCostingMethod: "standard" | "weightedAverage" | "fifo";
  readonly allowBackflush: boolean;
  readonly requireQCBeforeReceipt: boolean;
  readonly scrapAllowancePercent: number;
  readonly overheadRateFilsPerHour: number;
  readonly autoCreateWorkOrders: boolean;
}

export interface MmsConfigPatch {
  readonly negativeStockPolicy?: "block" | "allow";
  readonly defaultCostingMethod?: "standard" | "weightedAverage" | "fifo";
  readonly allowBackflush?: boolean;
  readonly requireQCBeforeReceipt?: boolean;
  readonly scrapAllowancePercent?: number;
  readonly overheadRateFilsPerHour?: number;
  readonly autoCreateWorkOrders?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Dashboard & reports                                                        */
/* -------------------------------------------------------------------------- */

export interface MmsDashboardRequest {
  readonly fromDate?: string;
  readonly toDate?: string;
  readonly productId?: number;
  readonly workCenterId?: number;
}

export interface MmsDashboardDto {
  readonly totalMo: number;
  readonly plannedMo: number;
  readonly activeMo: number;
  readonly completedMo: number;
  readonly delayedMo: number;
  readonly pendingWorkOrders: number;
  readonly producedUnits: number;
  readonly rejectedUnits: number;
  readonly materialShortageCount: number;
  readonly wipValueFils: number;
  readonly plannedCostFils: number;
  readonly actualCostFils: number;
  readonly productionYieldPct: number;
  readonly workCenterUtilizationPct: number;
  readonly moByStatus: readonly { readonly status: string; readonly count: number }[];
  readonly dailyOutput: readonly { readonly date: string; readonly qty: number }[];
  readonly materialConsumption: readonly { readonly date: string; readonly qtyMilli: number }[];
  readonly productionCosts: readonly { readonly date: string; readonly costFils: number }[];
  readonly scrapTrend: readonly { readonly date: string; readonly qtyMilli: number }[];
  readonly qualityPassFail: readonly { readonly result: string; readonly count: number }[];
  readonly workCenterUtilization: readonly {
    readonly workCenter: string;
    readonly utilizationPct: number;
  }[];
  readonly ordersNeedingAttention: readonly {
    readonly id: number;
    readonly number: string;
    readonly productName: string;
    readonly status: string;
    readonly issue: string;
  }[];
  readonly materialShortages: readonly {
    readonly productId: number;
    readonly sku: string;
    readonly name: string;
    readonly required: number;
    readonly available: number;
    readonly shortage: number;
  }[];
  readonly pendingApprovals: readonly {
    readonly id: number;
    readonly number: string;
    readonly type: string;
    readonly partyName: string | null;
  }[];
  readonly delayedWorkOrders: readonly {
    readonly id: number;
    readonly moNumber: string;
    readonly operationName: string;
    readonly workCenter: string | null;
  }[];
  readonly qualityFailures: readonly {
    readonly id: number;
    readonly moNumber: string;
    readonly checkpoint: string;
    readonly result: string;
  }[];
  readonly recentActivity: readonly {
    readonly id: number;
    readonly occurredAt: string;
    readonly actorName: string;
    readonly action: string;
    readonly module: string;
  }[];
  readonly generatedAtIso: string;
}

export interface MmsReportColumn {
  readonly id: string;
  readonly label: string;
  readonly align?: "start" | "end" | "center";
  readonly type?: "text" | "number" | "money" | "quantity" | "date";
}

export interface MmsReportDto {
  readonly report: string;
  readonly title: string;
  readonly period: { readonly fromDate: string; readonly toDate: string };
  readonly columns: readonly MmsReportColumn[];
  readonly rows: readonly Readonly<Record<string, string | number | null>>[];
  readonly totals: Readonly<Record<string, number>>;
  readonly generatedAtIso: string;
  readonly timezone: string;
}

export interface MmsReportRequest {
  readonly report: string;
  readonly fromDate?: string;
  readonly toDate?: string;
  readonly productId?: number;
  readonly workCenterId?: number;
  readonly moId?: number;
  readonly status?: string;
  readonly search?: string;
  readonly limit?: number;
}

export type MmsReportId =
  | "moSummary"
  | "plannedVsActual"
  | "outputByProduct"
  | "outputByWorkCenter"
  | "moStatus"
  | "delayedMo"
  | "workOrderPerformance"
  | "materialRequirements"
  | "materialConsumption"
  | "materialUsageVariance"
  | "rawMaterialShortage"
  | "productionCostSummary"
  | "plannedVsActualCost"
  | "costPerFinishedUnit"
  | "wip"
  | "wipAging"
  | "productionYield"
  | "scrap"
  | "rework"
  | "qualityPassFail"
  | "machineDowntime"
  | "workCenterUtilization"
  | "oee"
  | "subcontractProduction"
  | "batchGenealogy"
  | "finishedGoodsHistory";

export interface MmsReportTitle {
  readonly id: MmsReportId;
  readonly title: string;
  readonly group: string;
}

/* -------------------------------------------------------------------------- */
/* Shared stock snapshot (read-only, mirrors IMS)                             */
/* -------------------------------------------------------------------------- */

export interface StockSnapshotDto {
  readonly productId: number;
  readonly sku: string;
  readonly name: string;
  readonly onHandMilli: number;
  readonly reservedMilli: number;
  readonly availableMilli: number;
  readonly valueFils: number;
}
