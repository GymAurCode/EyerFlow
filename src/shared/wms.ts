import { z } from "zod";

export const wmsKinds = [
  "asn",
  "receipt",
  "return",
  "transfer",
  "replenishment",
  "dispatch",
  "wave",
  "count",
  "task",
] as const;
export type WmsKind = (typeof wmsKinds)[number];
export type WmsRow = Record<string, string | number | null>;
const id = z.number().int().positive();
const text = z.string().trim().max(500);
export const wmsLineSchema = z.object({
  productId: id,
  quantityMilli: z.number().int().positive().max(1_000_000_000),
  binId: id,
  toBinId: id.nullable().optional(),
  batchNo: text.default(""),
  stockStatus: z.enum(["available", "quarantine", "damaged"]).default("available"),
  unitCostFils: z.number().int().nonnegative().default(0),
  handlingUnitId: id.nullable().optional(),
  countedMilli: z.number().int().nonnegative().nullable().optional(),
});
export type WmsLine = z.infer<typeof wmsLineSchema>;
export const wmsSaveSchema = z.object({
  id: id.optional(),
  revision: z.number().int().nonnegative().default(0),
  kind: z.enum(wmsKinds),
  warehouseId: id,
  reference: text.min(1),
  notes: text.default(""),
  sourceId: id.nullable().optional(),
  assignedTo: id.nullable().optional(),
  lines: z.array(wmsLineSchema).min(1).max(200),
  token: z.string().min(8).max(100),
});
export type WmsSave = z.infer<typeof wmsSaveSchema>;
export const wmsMasterSchema = z.object({
  entity: z.enum(["warehouse", "location", "dock", "appointment", "handlingUnit"]),
  id: id.optional(),
  code: text.min(1).max(80),
  name: text.min(1),
  warehouseId: id.nullable().optional(),
  parentId: id.nullable().optional(),
  imsLocationId: id.nullable().optional(),
  type: text.default("storage"),
  address: text.default(""),
  branch: text.default(""),
  manager: text.default(""),
  active: z.boolean().default(true),
  blocked: z.boolean().default(false),
  capacityMilli: z.number().int().positive().nullable().optional(),
  mixedSku: z.boolean().default(true),
  mixedLot: z.boolean().default(true),
  startsAt: z.iso.datetime().nullable().optional(),
  endsAt: z.iso.datetime().nullable().optional(),
  dockId: id.nullable().optional(),
  supplierId: id.nullable().optional(),
  carrier: text.default(""),
  vehicle: text.default(""),
  priority: z.enum(["normal", "high", "urgent"]).default("normal"),
});
export type WmsMaster = z.infer<typeof wmsMasterSchema>;
export const wmsCommandSchema = z.object({
  id,
  action: z.enum([
    "submit",
    "cancel",
    "post",
    "release",
    "start",
    "pick",
    "pack",
    "stage",
    "load",
    "handover",
    "approve",
    "arrive",
    "unload",
    "complete",
    "noShow",
  ]),
  revision: z.number().int().nonnegative(),
  entity: z.enum(["document", "appointment"]).default("document"),
  scan: text.default(""),
  reason: text.default(""),
});
export type WmsCommand = z.infer<typeof wmsCommandSchema>;
export interface WmsDocumentSnapshot {
  warehouses: WmsRow[];
  locations: WmsRow[];
  docks: WmsRow[];
  appointments: WmsRow[];
  handlingUnits: WmsRow[];
  products: WmsRow[];
  suppliers: WmsRow[];
  workers: WmsRow[];
  imsLocations: WmsRow[];
  sources: WmsRow[];
  documents: WmsRow[];
  stock: WmsRow[];
  movements: WmsRow[];
  reconciliation: WmsRow[];
  metrics: Record<string, number | null>;
}

// Execution commands use the shared IMS ledger at each bin location. The
// document contracts above remain available for existing document integrations.
const quantity = z.number().int().positive().max(1_000_000_000_000);
export const warehouseSchema = z.object({
  id: id.optional(),
  code: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(1).max(160),
  address: z.string().max(500).default(""),
  site: z.string().max(160).default(""),
  active: z.boolean().default(true),
});
export const binSchema = z.object({
  id: id.optional(),
  warehouseId: id,
  code: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9_/-]+$/),
  zone: z.string().trim().max(40).default(""),
  aisle: z.string().trim().max(40).default(""),
  rack: z.string().trim().max(40).default(""),
  shelf: z.string().trim().max(40).default(""),
  type: z.enum([
    "receiving",
    "storage",
    "pickFace",
    "packing",
    "dispatch",
    "quarantine",
    "returns",
  ]),
  capacityMilli: quantity.nullable().default(null),
  mixedSku: z.boolean().default(true),
  blocked: z.boolean().default(false),
  active: z.boolean().default(true),
});
export const inboundSchema = z.object({
  warehouseId: id,
  reference: z.string().trim().min(1).max(200),
  lines: z
    .array(z.object({ productId: id, quantityMilli: quantity }))
    .min(1)
    .max(500),
});
export const receiptSchema = z.object({
  lineId: id,
  binId: id,
  quantityMilli: quantity,
  damagedMilli: z.number().int().nonnegative().default(0),
  commandKey: z.string().uuid(),
});
export const taskCompleteSchema = z.object({
  id,
  destinationBinId: id,
  sourceScan: z.string().min(1).max(100),
  productScan: z.string().min(1).max(160),
  destinationScan: z.string().min(1).max(100),
  quantityMilli: quantity,
  commandKey: z.string().uuid(),
});
export const moveSchema = z.object({
  sourceBinId: id,
  destinationBinId: id,
  productId: id,
  quantityMilli: quantity,
});
export type WarehouseInput = z.input<typeof warehouseSchema>;
export type BinInput = z.input<typeof binSchema>;
export type InboundInput = z.infer<typeof inboundSchema>;
export type ReceiptInput = z.input<typeof receiptSchema>;
export type CompleteTaskInput = z.infer<typeof taskCompleteSchema>;
export interface Warehouse {
  id: number;
  code: string;
  name: string;
  address: string;
  site: string;
  active: number;
}
export interface Bin {
  id: number;
  warehouse_id: number;
  location_id: number;
  code: string;
  zone: string;
  aisle: string;
  rack: string;
  shelf: string;
  type: string;
  capacity_milli: number | null;
  mixed_sku: number;
  blocked: number;
  active: number;
  quantity_milli: number;
}
export interface Position {
  warehouse: string;
  bin: string;
  bin_id: number;
  location_id: number;
  product_id: number;
  sku: string;
  name: string;
  stock_status: string;
  batch_no: string | null;
  quantity_milli: number;
}
export interface InboundLine {
  id: number;
  inbound_id: number;
  product_id: number;
  sku: string;
  name: string;
  expected_milli: number;
  received_milli: number;
}
export interface Inbound {
  id: number;
  number: string;
  warehouse_id: number;
  reference: string;
  status: string;
  created_at: string;
  lines: InboundLine[];
}
export interface WarehouseTask {
  id: number;
  type: string;
  product_id: number;
  sku: string;
  name: string;
  source_bin_id: number;
  destination_bin_id: number | null;
  source: string;
  destination: string | null;
  quantity_milli: number;
  actual_milli: number;
  status: string;
  assigned_to: number | null;
  created_at: string;
  completed_at: string | null;
  dispatch_line_id: number | null;
  replenishment_rule_id: number | null;
}
export interface WmsSnapshot {
  warehouses: Warehouse[];
  bins: Bin[];
  positions: Position[];
  inbounds: Inbound[];
  tasks: WarehouseTask[];
  products: { id: number; sku: string | null; name: string }[];
  unassigned: {
    location_id: number | null;
    product_id: number;
    sku: string;
    quantity_milli: number;
  }[];
  reconciliation: { product_id: number; sku: string; cached_milli: number; ledger_milli: number }[];
  generatedAt: string;
  dispatches: Dispatch[];
  cartons: Carton[];
  counts: CycleCount[];
  settings: WmsSettings;
  adoptableReceipts: {
    id: number;
    product_id: number;
    sku: string;
    source_kind: string;
    source_id: number | null;
    quantity_milli: number;
    location_id: number;
  }[];
  returns: WarehouseReturn[];
  replenishmentRules: ReplenishmentRule[];
  docks: Dock[];
  appointments: Appointment[];
  suppliers: { id: number; name: string }[];
  workers: { id: number; display_name: string }[];
}
export const dispatchSchema = z.object({
  warehouseId: id,
  recipient: z.string().trim().min(1).max(200),
  reference: z.string().trim().min(1).max(200),
  requiredDate: z.iso.date(),
  commandKey: z.string().uuid(),
  lines: z
    .array(z.object({ productId: id, quantityMilli: quantity }))
    .min(1)
    .max(200),
});
export const cartonSchema = z.object({
  dispatchId: id,
  code: z.string().trim().min(1).max(80),
  weightGrams: z.number().int().positive(),
  commandKey: z.string().uuid(),
  lines: z
    .array(
      z.object({ lineId: id, quantityMilli: quantity, productScan: z.string().min(1).max(160) }),
    )
    .min(1)
    .max(200),
});
export interface DispatchLine {
  id: number;
  dispatch_id: number;
  product_id: number;
  sku: string;
  quantity_milli: number;
  picked_milli: number;
  packed_milli: number;
}
export interface Dispatch {
  id: number;
  number: string;
  warehouse_id: number;
  recipient: string;
  reference: string;
  required_date: string;
  status: string;
  created_at: string;
  handed_over_at: string | null;
  lines: DispatchLine[];
}
export interface Carton {
  id: number;
  dispatch_id: number;
  code: string;
  weight_grams: number;
  status: string;
  quantity_milli: number;
}
export type DispatchInput = z.infer<typeof dispatchSchema>;
export type CartonInput = z.infer<typeof cartonSchema>;
export const countSchema = z.object({
  binId: id,
  productId: id,
  countedMilli: z.number().int().nonnegative().max(1_000_000_000_000),
  binScan: z.string().min(1),
  productScan: z.string().min(1),
  reason: z.string().trim().min(1).max(500),
  commandKey: z.string().uuid(),
  recountOfId: id.optional(),
});
export type CountInput = z.infer<typeof countSchema>;
export interface CycleCount {
  id: number;
  ims_document_id: number;
  bin_id: number;
  product_id: number;
  sku: string;
  bin: string;
  expected_milli: number;
  counted_milli: number;
  status: string;
  counted_by: number | null;
  counted_by_name: string;
  created_at: string;
  recount_of: number | null;
  superseded_by: number | null;
}
export interface WmsSettings {
  autoPutaway: boolean;
  pickFaceFirst: boolean;
}
export const wmsSettingsSchema = z.object({ autoPutaway: z.boolean(), pickFaceFirst: z.boolean() });
export const reportSchema = z.object({
  report: z.enum(["stock", "receiving", "movements", "tasks", "dispatch", "counts", "exceptions"]),
  warehouseId: id.optional(),
  fromDate: z.iso.date().optional(),
  toDate: z.iso.date().optional(),
  limit: z.number().int().min(1).max(5000).default(1000),
});
export type WmsReportRequest = z.input<typeof reportSchema>;
export interface WmsReport {
  columns: string[];
  rows: Record<string, string | number | null>[];
  generatedAt: string;
  cutoff: string;
  limit: number;
}
export const returnSchema = z.object({
  dispatchLineId: id,
  binId: id,
  quantityMilli: quantity,
  productScan: z.string().min(1),
  condition: z.string().trim().min(1).max(500),
  commandKey: z.string().uuid(),
});
export type ReturnInput = z.infer<typeof returnSchema>;
export interface WarehouseReturn {
  id: number;
  dispatch_line_id: number;
  ims_document_id: number;
  bin_id: number;
  sku: string;
  quantity_milli: number;
  sellable_milli: number;
  status: string;
  condition_note: string;
  created_at: string;
}
export const replenishmentSchema = z.object({
  id: id.optional(),
  productId: id,
  sourceBinId: id,
  destinationBinId: id,
  minimumMilli: z.number().int().nonnegative(),
  targetMilli: quantity,
  active: z.boolean().default(true),
});
export type ReplenishmentInput = z.input<typeof replenishmentSchema>;
export interface ReplenishmentRule {
  id: number;
  product_id: number;
  sku: string;
  source_bin_id: number;
  destination_bin_id: number;
  minimum_milli: number;
  target_milli: number;
  active: number;
  source: string;
  destination: string;
}
export const dockSchema = z.object({
  id: id.optional(),
  warehouseId: id,
  code: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(160),
  active: z.boolean().default(true),
});
export const appointmentSchema = z.object({
  id: id.optional(),
  revision: z.number().int().nonnegative().default(0),
  warehouseId: id,
  code: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(160),
  dockId: id,
  supplierId: id.nullable().default(null),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  carrier: z.string().trim().max(160).default(""),
  vehicle: z.string().trim().max(100).default(""),
  priority: z.enum(["normal", "high", "urgent"]).default("normal"),
});
export type DockInput = z.input<typeof dockSchema>;
export type AppointmentInput = z.input<typeof appointmentSchema>;
export interface Dock {
  id: number;
  warehouse_id: number;
  code: string;
  name: string;
  active: number;
}
export interface Appointment {
  id: number;
  warehouse_id: number;
  code: string;
  name: string;
  dock_id: number;
  supplier_id: number | null;
  starts_at: string;
  ends_at: string;
  carrier: string;
  vehicle: string;
  priority: string;
  status: string;
  revision: number;
  arrived_at: string | null;
  actual_start: string | null;
  actual_end: string | null;
}
