/**
 * IMS operational documents and their workflows.
 *
 * A purchase order never moves stock. A goods receipt moves it exactly once,
 * on posting, with an idempotency key per line. A transfer moves stock between
 * locations without changing the total the company owns. A count posts only the
 * variance. Every transition is written in the caller's transaction and every
 * posting records who did it and when.
 */

import type { SqliteDatabase } from "../../../data/connection";
import { allocateFils, roundFils } from "../../../domain/money";
import type {
  ImsDocumentDto,
  ImsDocumentKind,
  ImsDocumentLineDto,
  ImsDocumentStatus,
  ImsLineInput,
  ImsListRequest,
  ImsTransitionAction,
  ReceiveTransferRequest,
  SaveImsDocumentRequest,
} from "../../../shared/ims";
import type { SaveDocumentRequest, VatTreatment } from "../../../shared/types";
import type { AuditActor } from "../../audit-writer";
import { recordAudit } from "../../audit-writer";
import * as documents from "../documents";
import {
  availableQuantity,
  defaultLocationId,
  getLocation,
  ImsStockError,
  postMovement,
  reclassifyStock,
  releaseReservations,
  reserveStock,
  type StockContext,
} from "./stock";

export class ImsOperationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ImsOperationError";
  }
}

export interface OperationContext {
  readonly db: SqliteDatabase;
  readonly actor: AuditActor;
  readonly nowIso: string;
  readonly nowDate: string;
  readonly fiscalYearStartMonth: number;
  readonly allowNegativeStock: boolean;
  readonly vatRate: number;
}

interface DocumentRow {
  readonly id: number;
  readonly kind: ImsDocumentKind;
  readonly number: string;
  readonly status: ImsDocumentStatus;
  readonly party_id: number | null;
  readonly party_name?: string | null;
  readonly from_location_id: number | null;
  readonly to_location_id: number | null;
  readonly source_id: number | null;
  readonly source_number?: string | null;
  readonly result_document_id: number | null;
  readonly issue_date: string;
  readonly due_date: string | null;
  readonly required_date: string | null;
  readonly reference: string | null;
  readonly notes: string | null;
  readonly reason: string | null;
  readonly total_fils: number;
  readonly vat_fils: number;
  readonly discount_fils: number;
  readonly created_by: string | null;
  readonly approved_by: string | null;
  readonly approved_at: string | null;
  readonly posted_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly from_location_name?: string | null;
  readonly to_location_name?: string | null;
}

interface LineRow {
  readonly id: number;
  readonly document_id: number;
  readonly source_line_id: number | null;
  readonly line_no: number;
  readonly product_id: number | null;
  readonly product_name?: string | null;
  readonly sku?: string | null;
  readonly description: string;
  readonly quantity_milli: number;
  readonly processed_milli: number;
  readonly expected_milli: number | null;
  readonly counted_milli: number | null;
  readonly unit_cost_fils: number;
  readonly unit_price_fils: number;
  readonly discount_fils: number;
  readonly vat_treatment: VatTreatment;
  readonly vat_fils: number;
  readonly line_total_fils: number;
  readonly batch_no: string | null;
  readonly expiry_date: string | null;
  readonly condition_note: string | null;
  readonly serials: string | null;
  readonly restock: number;
}

const KIND_PREFIX: Record<ImsDocumentKind, string> = {
  purchaseRequisition: "REQ",
  purchaseOrder: "PO",
  goodsReceipt: "GRN",
  supplierReturn: "SRT",
  salesQuotation: "QT",
  salesOrder: "SO",
  salesReturn: "SRN",
  stockTransfer: "TRF",
  stockCount: "CNT",
  purchaseAdjustment: "ADJ",
};

const DOCUMENT_SELECT = `
  SELECT d.*, p.name AS party_name, s.number AS source_number,
         fl.name AS from_location_name, tl.name AS to_location_name
    FROM ims_documents d
    LEFT JOIN parties p ON p.id = d.party_id
    LEFT JOIN ims_documents s ON s.id = d.source_id
    LEFT JOIN ims_locations fl ON fl.id = d.from_location_id
    LEFT JOIN ims_locations tl ON tl.id = d.to_location_id
`;

const LINE_SELECT = `
  SELECT l.*, p.name AS product_name, p.sku AS sku
    FROM ims_document_lines l
    LEFT JOIN products p ON p.id = l.product_id
`;

function nextNumber(db: SqliteDatabase, kind: ImsDocumentKind, date: string): string {
  const fiscalYear = Number.parseInt(date.slice(0, 4), 10);
  const sequenceKind = `ims:${kind}`;
  db.prepare(
    `INSERT INTO document_sequences (kind, fiscal_year, last_used)
     VALUES (?, ?, 0) ON CONFLICT (kind, fiscal_year) DO NOTHING`,
  ).run(sequenceKind, fiscalYear);
  db.prepare(
    "UPDATE document_sequences SET last_used = last_used + 1 WHERE kind = ? AND fiscal_year = ?",
  ).run(sequenceKind, fiscalYear);
  const row = db
    .prepare("SELECT last_used FROM document_sequences WHERE kind = ? AND fiscal_year = ?")
    .get(sequenceKind, fiscalYear) as { last_used: number };
  return `${KIND_PREFIX[kind]}-${String(fiscalYear)}-${String(row.last_used).padStart(4, "0")}`;
}

function mapLine(row: LineRow): ImsDocumentLineDto {
  const variance =
    row.counted_milli === null || row.expected_milli === null
      ? null
      : row.counted_milli - row.expected_milli;
  return {
    id: row.id,
    lineNo: row.line_no,
    productId: row.product_id,
    productName: row.product_name ?? null,
    sku: row.sku ?? null,
    description: row.description,
    quantityMilli: row.quantity_milli,
    processedMilli: row.processed_milli,
    outstandingMilli: Math.max(0, row.quantity_milli - row.processed_milli),
    expectedMilli: row.expected_milli,
    countedMilli: row.counted_milli,
    varianceMilli: variance,
    unitCostFils: row.unit_cost_fils,
    unitPriceFils: row.unit_price_fils,
    discountFils: row.discount_fils,
    vatTreatment: row.vat_treatment,
    vatFils: row.vat_fils,
    lineTotalFils: row.line_total_fils,
    batchNo: row.batch_no,
    expiryDate: row.expiry_date,
    conditionNote: row.condition_note,
    serials: row.serials,
    sourceLineId: row.source_line_id,
    restock: row.restock === 1,
  };
}

function mapDocument(db: SqliteDatabase, row: DocumentRow): ImsDocumentDto {
  const lines = db
    .prepare(`${LINE_SELECT} WHERE l.document_id = ? ORDER BY l.line_no, l.id`)
    .all(row.id) as LineRow[];
  return {
    id: row.id,
    kind: row.kind,
    number: row.number,
    status: row.status,
    partyId: row.party_id,
    partyName: row.party_name ?? null,
    fromLocationId: row.from_location_id,
    fromLocationName: row.from_location_name ?? null,
    toLocationId: row.to_location_id,
    toLocationName: row.to_location_name ?? null,
    sourceId: row.source_id,
    sourceNumber: row.source_number ?? null,
    resultDocumentId: row.result_document_id,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    requiredDate: row.required_date,
    reference: row.reference,
    notes: row.notes,
    reason: row.reason,
    totalFils: row.total_fils,
    vatFils: row.vat_fils,
    discountFils: row.discount_fils,
    createdBy: row.created_by,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    postedAt: row.posted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines: lines.map(mapLine),
  };
}

export function listOperations(db: SqliteDatabase, request: ImsListRequest): ImsDocumentDto[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (request.kind !== undefined) {
    clauses.push("d.kind = ?");
    params.push(request.kind);
  }
  if (request.status !== undefined) {
    clauses.push("d.status = ?");
    params.push(request.status);
  }
  if (request.partyId !== undefined) {
    clauses.push("d.party_id = ?");
    params.push(request.partyId);
  }
  if (request.locationId !== undefined) {
    clauses.push("(d.from_location_id = ? OR d.to_location_id = ?)");
    params.push(request.locationId, request.locationId);
  }
  if (request.fromDate !== undefined) {
    clauses.push("d.issue_date >= ?");
    params.push(request.fromDate);
  }
  if (request.toDate !== undefined) {
    clauses.push("d.issue_date <= ?");
    params.push(request.toDate);
  }
  if (request.search !== undefined && request.search.trim() !== "") {
    const like = `%${request.search.trim()}%`;
    clauses.push("(d.number LIKE ? OR d.reference LIKE ? OR p.name LIKE ?)");
    params.push(like, like, like);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const limit = request.limit ?? 1000;
  const rows = db
    .prepare(`${DOCUMENT_SELECT}${where} ORDER BY d.issue_date DESC, d.id DESC LIMIT ?`)
    .all(...params, limit) as DocumentRow[];
  return rows.map((row) => mapDocument(db, row));
}

export function getOperation(db: SqliteDatabase, id: number): ImsDocumentDto {
  const row = db.prepare(`${DOCUMENT_SELECT} WHERE d.id = ?`).get(id) as DocumentRow | undefined;
  if (row === undefined) throw new ImsOperationError(`Document ${String(id)} was not found.`);
  return mapDocument(db, row);
}

interface Totals {
  readonly total: number;
  readonly vat: number;
  readonly discount: number;
  readonly lineTotals: readonly {
    readonly net: number;
    readonly vat: number;
    readonly total: number;
    readonly cost: number;
  }[];
}

function computeTotals(
  db: SqliteDatabase,
  kind: ImsDocumentKind,
  lines: readonly ImsLineInput[],
  documentDiscount: number,
  vatRate: number,
): Totals {
  if (kind === "stockCount") {
    return {
      total: 0,
      vat: 0,
      discount: 0,
      lineTotals: lines.map(() => ({ net: 0, vat: 0, total: 0, cost: 0 })),
    };
  }

  const priced = lines.map((line) => {
    const product =
      line.productId === null
        ? undefined
        : (db
            .prepare("SELECT average_cost_fils, is_service FROM products WHERE id = ?")
            .get(line.productId) as { average_cost_fils: number; is_service: number } | undefined);
    const quantity = Math.abs(line.quantityMilli);
    const price = line.unitPriceFils ?? line.unitCostFils ?? 0;
    const gross = roundFils((price * quantity) / 1000);
    const discount = Math.min(line.discountFils ?? 0, gross);
    const net = gross - discount;
    return {
      net,
      gross,
      discount,
      quantity,
      price,
      cost: product?.is_service === 1 ? 0 : (product?.average_cost_fils ?? line.unitCostFils ?? 0),
      treatment: line.vatTreatment ?? "standard",
    };
  });

  const netSum = priced.reduce((sum, line) => sum + line.net, 0);
  const cappedDiscount = Math.min(Math.max(0, documentDiscount), netSum);
  const allocations =
    cappedDiscount === 0
      ? priced.map(() => 0)
      : allocateFils(
          cappedDiscount,
          priced.map((line) => line.net),
        );

  let totalVat = 0;
  const lineTotals = priced.map((line, index) => {
    const net = Math.max(0, line.net - (allocations[index] ?? 0));
    const vat =
      line.treatment === "standard" ? roundFils(net * vatRate) : 0;
    totalVat += vat;
    return {
      net,
      vat,
      total: net + vat,
      cost: roundFils((line.cost * line.quantity) / 1000),
    };
  });

  return {
    total: lineTotals.reduce((sum, line) => sum + line.total, 0),
    vat: totalVat,
    discount: cappedDiscount,
    lineTotals,
  };
}

function insertLines(
  db: SqliteDatabase,
  documentId: number,
  kind: ImsDocumentKind,
  lines: readonly ImsLineInput[],
  totals: Totals,
): void {
  const statement = db.prepare(
    `INSERT INTO ims_document_lines
       (document_id, source_line_id, line_no, product_id, description, quantity_milli,
        processed_milli, expected_milli, counted_milli, unit_cost_fils, unit_price_fils,
        discount_fils, vat_treatment, vat_fils, line_total_fils, batch_no, expiry_date,
        condition_note, serials, restock)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  lines.forEach((line, index) => {
    const computed = totals.lineTotals[index];
    const expected =
      kind === "stockCount"
        ? (line.expectedMilli ??
          (line.productId === null
            ? 0
            : currentLocationOnHand(db, line.productId, null)))
        : (line.expectedMilli ?? null);
    statement.run(
      documentId,
      line.sourceLineId ?? null,
      index + 1,
      line.productId,
      line.description,
      line.quantityMilli,
      expected,
      line.countedMilli ?? null,
      line.unitCostFils ?? 0,
      line.unitPriceFils ?? line.unitCostFils ?? 0,
      line.discountFils ?? 0,
      line.vatTreatment ?? "standard",
      computed?.vat ?? 0,
      computed?.total ?? 0,
      line.batchNo ?? null,
      line.expiryDate ?? null,
      line.conditionNote ?? null,
      line.serials ?? null,
      line.restock === true ? 1 : 0,
    );
  });
}

function currentLocationOnHand(db: SqliteDatabase, productId: number, locationId: number | null): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(quantity_milli), 0) AS total
         FROM stock_movements
        WHERE product_id = ?
          AND COALESCE(location_id, (SELECT id FROM ims_locations WHERE is_default = 1 LIMIT 1)) = ?`,
    )
    .get(productId, locationId ?? defaultLocationId(db)) as { total: number };
  return row.total;
}

function loadForUpdate(db: SqliteDatabase, id: number): DocumentRow {
  const row = db.prepare("SELECT * FROM ims_documents WHERE id = ?").get(id) as
    | DocumentRow
    | undefined;
  if (row === undefined) throw new ImsOperationError(`Document ${String(id)} was not found.`);
  return row;
}

export function saveOperation(
  context: OperationContext,
  request: SaveImsDocumentRequest,
): ImsDocumentDto {
  const { db } = context;

  return db.transaction((): ImsDocumentDto => {
    const existing = request.id === undefined ? undefined : loadForUpdate(db, request.id);
    if (existing !== undefined && existing.status !== "draft" && existing.status !== "counted") {
      throw new ImsOperationError("Only a draft can be edited. Use the workflow actions instead.");
    }

    const location =
      request.fromLocationId ?? request.toLocationId ?? defaultLocationId(db);
    const totals = computeTotals(db, request.kind, request.lines, request.discountFils ?? 0, context.vatRate);

    let id: number;
    if (existing === undefined) {
      const number = nextNumber(db, request.kind, request.issueDate);
      const info = db
        .prepare(
          `INSERT INTO ims_documents
             (kind, number, status, party_id, from_location_id, to_location_id, source_id,
              issue_date, due_date, required_date, reference, notes, reason, total_fils,
              vat_fils, discount_fils, created_by, client_token, created_at, updated_at)
           VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          request.kind,
          number,
          request.partyId ?? null,
          request.kind === "stockCount" || request.kind === "purchaseAdjustment"
            ? location
            : (request.fromLocationId ?? (request.kind === "goodsReceipt" ? null : location)),
          request.kind === "stockCount" || request.kind === "purchaseAdjustment"
            ? location
            : (request.toLocationId ??
              (request.kind === "goodsReceipt" || request.kind === "salesReturn" || request.kind === "stockTransfer"
                ? location
                : null)),
          request.sourceId ?? null,
          request.issueDate,
          request.dueDate ?? null,
          request.requiredDate ?? null,
          request.reference ?? null,
          request.notes ?? null,
          request.reason ?? null,
          totals.total,
          totals.vat,
          totals.discount,
          context.actor.name,
          request.clientToken ?? null,
          context.nowIso,
          context.nowIso,
        );
      id = Number(info.lastInsertRowid);
    } else {
      id = existing.id;
      db.prepare(
        `UPDATE ims_documents
            SET party_id = ?, from_location_id = ?, to_location_id = ?, source_id = ?,
                issue_date = ?, due_date = ?, required_date = ?, reference = ?, notes = ?,
                reason = ?, total_fils = ?, vat_fils = ?, discount_fils = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        request.partyId ?? null,
        request.fromLocationId ?? null,
        request.toLocationId ?? null,
        request.sourceId ?? null,
        request.issueDate,
        request.dueDate ?? null,
        request.requiredDate ?? null,
        request.reference ?? null,
        request.notes ?? null,
        request.reason ?? null,
        totals.total,
        totals.vat,
        totals.discount,
        context.nowIso,
        id,
      );
      db.prepare("DELETE FROM ims_document_lines WHERE document_id = ?").run(id);
    }

    insertLines(db, id, request.kind, request.lines, totals);

    recordAudit(
      db,
      context.actor,
      {
        module: request.kind.startsWith("purchase") || request.kind === "supplierReturn" ? "purchases" : "inventory",
        action: existing === undefined ? "create" : "update",
        entityType: "imsDocument",
        entityId: id,
        newValues: { kind: request.kind, lines: request.lines.length, totalFils: totals.total },
      },
      context.nowIso,
    );

    return getOperation(db, id);
  })();
}

function stockContext(context: OperationContext): StockContext {
  return {
    db: context.db,
    actorName: context.actor.name,
    nowIso: context.nowIso,
    nowDate: context.nowDate,
    allowNegativeStock: context.allowNegativeStock,
  };
}

function setStatus(
  db: SqliteDatabase,
  id: number,
  status: ImsDocumentStatus,
  nowIso: string,
  extra: { readonly approvedBy?: string; readonly posted?: boolean } = {},
): void {
  db.prepare(
    `UPDATE ims_documents
        SET status = ?, updated_at = ?,
            approved_by = COALESCE(?, approved_by),
            approved_at = CASE WHEN ? IS NULL THEN approved_at ELSE ? END,
            posted_at = CASE WHEN ? = 1 THEN ? ELSE posted_at END
      WHERE id = ?`,
  ).run(
    status,
    nowIso,
    extra.approvedBy ?? null,
    extra.approvedBy ?? null,
    nowIso,
    extra.posted === true ? 1 : 0,
    nowIso,
    id,
  );
}

/** Post a goods receipt, update the purchase order and move stock once. */
function postGoodsReceipt(context: OperationContext, document: DocumentRow): void {
  const { db } = context;
  const lines = db
    .prepare("SELECT * FROM ims_document_lines WHERE document_id = ? ORDER BY line_no")
    .all(document.id) as LineRow[];

  if (lines.length === 0) throw new ImsOperationError("A receipt needs at least one line.");

  const locationId = document.to_location_id ?? defaultLocationId(db);
  const ctx = stockContext(context);

  let receivedAny = false;
  for (const line of lines) {
    if (line.product_id === null) continue;
    const quantity = line.quantity_milli;
    if (quantity <= 0) continue;

    if (line.source_line_id !== null) {
      const sourceLine = db
        .prepare("SELECT * FROM ims_document_lines WHERE id = ?")
        .get(line.source_line_id) as LineRow | undefined;
      if (sourceLine !== undefined) {
        const outstanding = sourceLine.quantity_milli - sourceLine.processed_milli;
        if (quantity > outstanding) {
          throw new ImsOperationError(
            `${line.product_name ?? "The item"}: receiving ${String(quantity / 1000)} would exceed the ` +
              `${String(outstanding / 1000)} still outstanding on the purchase order.`,
          );
        }
      }
    }

    postMovement(ctx, {
      productId: line.product_id,
      locationId,
      movementDate: document.issue_date,
      kind: "receipt",
      quantityMilli: quantity,
      unitCostFils: line.unit_cost_fils,
      sourceKind: "goodsReceipt",
      sourceId: document.id,
      batchNo: line.batch_no,
      serials: splitSerials(line.serials),
      serialStatus: "inStock",
      stockStatus: "available",
      notes: `Goods receipt ${document.number}`,
      idempotencyKey: `grn:${String(document.id)}:line:${String(line.id)}`,
    });

    db.prepare(
      "UPDATE ims_document_lines SET processed_milli = processed_milli + ? WHERE id = ?",
    ).run(quantity, line.id);

    if (line.source_line_id !== null) {
      db.prepare(
        "UPDATE ims_document_lines SET processed_milli = processed_milli + ? WHERE id = ?",
      ).run(quantity, line.source_line_id);
    }
    receivedAny = true;
  }

  if (!receivedAny) throw new ImsOperationError("Nothing on this receipt can be posted.");

  setStatus(db, document.id, "posted", context.nowIso, { posted: true });

  if (document.source_id !== null) {
    const source = loadForUpdate(db, document.source_id);
    if (source.kind === "purchaseOrder") {
      const outstanding = db
        .prepare(
          `SELECT COUNT(*) AS count FROM ims_document_lines
            WHERE document_id = ? AND processed_milli < quantity_milli`,
        )
        .get(source.id) as { count: number };
      setStatus(db, source.id, outstanding.count === 0 ? "received" : "partiallyReceived", context.nowIso);
    }
  }

  recordAudit(
    db,
    context.actor,
    {
      module: "purchases",
      action: "post",
      entityType: "imsDocument",
      entityId: document.id,
      newValues: { status: "posted", number: document.number },
    },
    context.nowIso,
  );
}

function splitSerials(value: string | null): readonly string[] {
  if (value === null || value.trim() === "") return [];
  return value.split(/[\n,;]+/).map((entry) => entry.trim()).filter((entry) => entry !== "");
}

function postSupplierReturn(context: OperationContext, document: DocumentRow): void {
  const { db } = context;
  const lines = db
    .prepare("SELECT * FROM ims_document_lines WHERE document_id = ? ORDER BY line_no")
    .all(document.id) as LineRow[];
  const locationId = document.from_location_id ?? defaultLocationId(db);
  const ctx = stockContext(context);

  for (const line of lines) {
    if (line.product_id === null || line.quantity_milli <= 0) continue;
    postMovement(ctx, {
      productId: line.product_id,
      locationId,
      movementDate: document.issue_date,
      kind: "issue",
      quantityMilli: -line.quantity_milli,
      unitCostFils: line.unit_cost_fils,
      sourceKind: "supplierReturn",
      sourceId: document.id,
      batchNo: line.batch_no,
      serials: splitSerials(line.serials),
      serialStatus: "returned",
      stockStatus: "available",
      notes: `Supplier return ${document.number}`,
      idempotencyKey: `srt:${String(document.id)}:line:${String(line.id)}`,
    });
    db.prepare("UPDATE ims_document_lines SET processed_milli = quantity_milli WHERE id = ?").run(line.id);
  }

  setStatus(db, document.id, "posted", context.nowIso, { posted: true });
}

function postSalesReturn(context: OperationContext, document: DocumentRow): void {
  const { db } = context;
  const lines = db
    .prepare("SELECT * FROM ims_document_lines WHERE document_id = ? ORDER BY line_no")
    .all(document.id) as LineRow[];
  const ctx = stockContext(context);

  for (const line of lines) {
    if (line.product_id === null || line.quantity_milli <= 0) continue;
    const restock = line.restock === 1;
    postMovement(ctx, {
      productId: line.product_id,
      locationId: document.to_location_id ?? defaultLocationId(db),
      movementDate: document.issue_date,
      kind: "receipt",
      quantityMilli: line.quantity_milli,
      unitCostFils: line.unit_cost_fils,
      sourceKind: "salesReturn",
      sourceId: document.id,
      batchNo: line.batch_no,
      serials: splitSerials(line.serials),
      serialStatus: restock ? "inStock" : "quarantine",
      stockStatus: restock ? "available" : "quarantine",
      notes: restock ? `Sales return ${document.number}` : `Sales return ${document.number} - quarantine`,
      idempotencyKey: `srn:${String(document.id)}:line:${String(line.id)}`,
    });
    db.prepare("UPDATE ims_document_lines SET processed_milli = quantity_milli WHERE id = ?").run(line.id);
  }

  setStatus(db, document.id, "posted", context.nowIso, { posted: true });
}

function postAdjustments(context: OperationContext, document: DocumentRow): void {
  const { db } = context;
  const lines = db
    .prepare("SELECT * FROM ims_document_lines WHERE document_id = ? ORDER BY line_no")
    .all(document.id) as LineRow[];
  const locationId = document.from_location_id ?? defaultLocationId(db);
  const ctx = stockContext(context);

  for (const line of lines) {
    if (line.product_id === null || line.quantity_milli === 0) continue;
    const increase = line.quantity_milli > 0;
    postMovement(ctx, {
      productId: line.product_id,
      locationId,
      movementDate: document.issue_date,
      kind: increase ? "adjustmentIn" : "adjustmentOut",
      quantityMilli: line.quantity_milli,
      unitCostFils: line.unit_cost_fils,
      sourceKind: "purchaseAdjustment",
      sourceId: document.id,
      stockStatus: "available",
      notes: document.reason ?? `Stock adjustment ${document.number}`,
      idempotencyKey: `adj:${String(document.id)}:line:${String(line.id)}`,
    });
    db.prepare("UPDATE ims_document_lines SET processed_milli = quantity_milli WHERE id = ?").run(line.id);
  }

  setStatus(db, document.id, "posted", context.nowIso, { posted: true });
}

function postStockCount(context: OperationContext, document: DocumentRow): void {
  const { db } = context;
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wms_counts'").get()) {
    const warehouseCount=db.prepare("SELECT approved_by FROM wms_counts WHERE ims_document_id=?").get(document.id) as {approved_by:number|null}|undefined;
    if(warehouseCount && warehouseCount.approved_by===null)throw new ImsOperationError("This warehouse count requires approval through WMS before posting.");
  }
  const lines = db
    .prepare("SELECT * FROM ims_document_lines WHERE document_id = ? ORDER BY line_no")
    .all(document.id) as LineRow[];
  const locationId = document.from_location_id ?? defaultLocationId(db);
  const ctx = stockContext(context);

  for (const line of lines) {
    if (line.product_id === null) continue;
    const expected = line.expected_milli ?? 0;
    const counted = line.counted_milli;
    if (counted === null) {
      throw new ImsOperationError(`Line ${String(line.line_no)} has no counted quantity.`);
    }
    const variance = counted - expected;
    if (variance === 0) continue;
    postMovement(ctx, {
      productId: line.product_id,
      locationId,
      movementDate: document.issue_date,
      kind: variance > 0 ? "adjustmentIn" : "adjustmentOut",
      quantityMilli: variance,
      unitCostFils: line.unit_cost_fils,
      sourceKind: "stockCount",
      sourceId: document.id,
      stockStatus: "available",
      notes: `Stock count ${document.number} (expected ${String(expected / 1000)}, counted ${String(counted / 1000)})`,
      idempotencyKey: `cnt:${String(document.id)}:line:${String(line.id)}`,
    });
    db.prepare("UPDATE ims_document_lines SET processed_milli = ? WHERE id = ?").run(variance, line.id);
  }

  setStatus(db, document.id, "posted", context.nowIso, { posted: true });
}

function confirmSalesOrder(context: OperationContext, document: DocumentRow): void {
  const { db } = context;
  const lines = db
    .prepare("SELECT * FROM ims_document_lines WHERE document_id = ? ORDER BY line_no")
    .all(document.id) as LineRow[];
  releaseReservations(db, "salesOrder", document.id, "released", context.nowIso);

  const backorder = db
    .prepare("SELECT value FROM ims_config WHERE key = 'allowBackorder'")
    .get() as { value: string } | undefined;
  const allowBackorder = backorder?.value === '1';

  for (const line of lines) {
    if (line.product_id === null || line.quantity_milli <= 0) continue;
    try {
      reserveStock(
        db,
        context.actor.name,
        {
          productId: line.product_id,
          locationId: document.from_location_id,
          quantityMilli: line.quantity_milli,
          sourceKind: "salesOrder",
          sourceId: document.id,
          notes: `Reserved for ${document.number}`,
        },
        context.nowIso,
      );
    } catch (error) {
      if (!allowBackorder) throw error;
    }
  }
  setStatus(db, document.id, "confirmed", context.nowIso);
}

function fulfilSalesOrder(context: OperationContext, document: DocumentRow): void {
  const { db } = context;
  const existingResult = db
    .prepare("SELECT result_document_id FROM ims_documents WHERE id = ?")
    .get(document.id) as { result_document_id: number | null } | undefined;
  if (existingResult?.result_document_id !== null && existingResult?.result_document_id !== undefined) {
    return;
  }

  const lines = db
    .prepare("SELECT * FROM ims_document_lines WHERE document_id = ? ORDER BY line_no")
    .all(document.id) as LineRow[];

  releaseReservations(db, "salesOrder", document.id, "released", context.nowIso);

  const request: SaveDocumentRequest = {
    kind: "invoice",
    partyId: document.party_id,
    issueDate: context.nowDate,
    dueDate: document.due_date,
    status: "issued",
    notes: `Sales order ${document.number}`,
    clientToken: `ims-so-${String(document.id)}`,
    locationId: document.from_location_id,
    lines: lines
      .filter((line) => line.quantity_milli > 0)
      .map((line) => ({
        productId: line.product_id,
        description: line.description,
        quantityMilli: line.quantity_milli,
        unitPriceFils: line.unit_price_fils,
        vatTreatment: line.vat_treatment,
        unitCostFils: line.unit_cost_fils,
      })),
  };

  const invoice = documents.saveDocument(
    {
      db,
      actor: context.actor,
      fiscalYearStartMonth: context.fiscalYearStartMonth,
      nowIso: context.nowIso,
      nowDate: context.nowDate,
      allowNegativeStock: context.allowNegativeStock,
      vatRate: context.vatRate,
    },
    request,
  );

  db.prepare(
    "UPDATE ims_documents SET result_document_id = ?, status = 'fulfilled', posted_at = ?, updated_at = ? WHERE id = ?",
  ).run(invoice.id, context.nowIso, context.nowIso, document.id);
}

function dispatchTransfer(context: OperationContext, document: DocumentRow): void {
  const { db } = context;
  if (document.from_location_id === null || document.to_location_id === null) {
    throw new ImsOperationError("A transfer needs a source and a destination location.");
  }
  if (document.from_location_id === document.to_location_id) {
    throw new ImsOperationError("The source and destination must be different locations.");
  }
  const lines = db
    .prepare("SELECT * FROM ims_document_lines WHERE document_id = ? ORDER BY line_no")
    .all(document.id) as LineRow[];
  const ctx = stockContext(context);

  for (const line of lines) {
    if (line.product_id === null || line.quantity_milli <= 0) continue;
    // The company still owns the goods, so the product total does not change.
    postMovement(ctx, {
      productId: line.product_id,
      locationId: document.from_location_id,
      movementDate: document.issue_date,
      kind: "issue",
      quantityMilli: -line.quantity_milli,
      unitCostFils: line.unit_cost_fils,
      sourceKind: "stockTransfer",
      sourceId: document.id,
      stockStatus: "available",
      notes: `Transfer ${document.number} dispatched`,
      affectProductTotal: false,
      idempotencyKey: `trf:${String(document.id)}:line:${String(line.id)}:out`,
    });
    postMovement(ctx, {
      productId: line.product_id,
      locationId: document.to_location_id,
      movementDate: document.issue_date,
      kind: "receipt",
      quantityMilli: line.quantity_milli,
      unitCostFils: line.unit_cost_fils,
      sourceKind: "stockTransfer",
      sourceId: document.id,
      stockStatus: "inTransit",
      notes: `Transfer ${document.number} in transit`,
      affectProductTotal: false,
      idempotencyKey: `trf:${String(document.id)}:line:${String(line.id)}:transit`,
    });
  }

  setStatus(db, document.id, "inTransit", context.nowIso);
}

function receiveTransfer(
  context: OperationContext,
  document: DocumentRow,
  request: ReceiveTransferRequest,
): void {
  const { db } = context;
  if (document.to_location_id === null) {
    throw new ImsOperationError("The transfer has no destination location.");
  }
  const ctx = stockContext(context);
  let remaining = false;

  for (const received of request.lines) {
    const line = db
      .prepare("SELECT * FROM ims_document_lines WHERE id = ? AND document_id = ?")
      .get(received.lineId, document.id) as LineRow | undefined;
    if (line === undefined || line.product_id === null) continue;
    const outstanding = line.quantity_milli - line.processed_milli;
    const quantity = Math.min(received.quantityMilli, outstanding);
    if (quantity <= 0) continue;

    reclassifyStock(ctx, {
      productId: line.product_id,
      locationId: document.to_location_id,
      quantityMilli: quantity,
      fromStatus: "inTransit",
      toStatus: "available",
      movementDate: context.nowDate,
      sourceKind: "stockTransfer",
      sourceId: document.id,
      notes: `Transfer ${document.number} received`,
      idempotencyKey: `trf:${String(document.id)}:line:${String(line.id)}:received:${String(line.processed_milli)}:${String(quantity)}`,
    });
    db.prepare("UPDATE ims_document_lines SET processed_milli = processed_milli + ? WHERE id = ?").run(
      quantity,
      line.id,
    );
    if (line.processed_milli + quantity < line.quantity_milli) remaining = true;
  }

  const outstanding = db
    .prepare(
      `SELECT COUNT(*) AS count FROM ims_document_lines
        WHERE document_id = ? AND processed_milli < quantity_milli`,
    )
    .get(document.id) as { count: number };
  setStatus(db, document.id, outstanding.count > 0 ? "inTransit" : "completed", context.nowIso);
  if (remaining && outstanding.count === 0) {
    setStatus(db, document.id, "completed", context.nowIso);
  }
}

export function transitionOperation(
  context: OperationContext,
  id: number,
  action: ImsTransitionAction,
  reason?: string | null,
  locationId?: number | null,
): ImsDocumentDto {
  const { db } = context;

  return db.transaction((): ImsDocumentDto => {
    const document = loadForUpdate(db, id);
    const status = document.status;

    if (status === "cancelled") {
      throw new ImsOperationError("This document is already cancelled.");
    }

    switch (action) {
      case "submit": {
        if (status !== "draft") throw new ImsOperationError("Only a draft can be submitted.");
        setStatus(db, id, "submitted", context.nowIso);
        break;
      }
      case "approve": {
        if (!["draft", "submitted", "counted"].includes(status)) {
          throw new ImsOperationError("This document cannot be approved in its current state.");
        }
        setStatus(db, id, "approved", context.nowIso, { approvedBy: context.actor.name });
        break;
      }
      case "reject": {
        if (!["submitted", "draft"].includes(status)) {
          throw new ImsOperationError("Only a submitted document can be rejected.");
        }
        setStatus(db, id, "rejected", context.nowIso);
        db.prepare("UPDATE ims_documents SET reason = ? WHERE id = ?").run(reason ?? null, id);
        break;
      }
      case "confirm": {
        if (document.kind !== "salesOrder") {
          throw new ImsOperationError("Only a sales order can be confirmed.");
        }
        if (!["draft", "submitted", "approved"].includes(status)) {
          throw new ImsOperationError("This sales order cannot be confirmed in its current state.");
        }
        confirmSalesOrder(context, document);
        break;
      }
      case "dispatch": {
        if (document.kind !== "stockTransfer") {
          throw new ImsOperationError("Only a stock transfer can be dispatched.");
        }
        if (!["draft", "approved"].includes(status)) {
          throw new ImsOperationError("Only a draft or approved transfer can be dispatched.");
        }
        dispatchTransfer(context, document);
        break;
      }
      case "receive": {
        if (document.kind !== "stockTransfer") {
          throw new ImsOperationError("Only a stock transfer can be received.");
        }
        if (status !== "inTransit") {
          throw new ImsOperationError("This transfer is not in transit.");
        }
        setStatus(db, id, "completed", context.nowIso);
        break;
      }
      case "post": {
        if (status === "posted") return getOperation(db, id);
        if (document.kind === "goodsReceipt") {
          if (!["draft", "submitted", "approved"].includes(status)) {
            throw new ImsOperationError("This receipt cannot be posted in its current state.");
          }
          postGoodsReceipt(context, document);
        } else if (document.kind === "supplierReturn") {
          if (!["draft", "approved"].includes(status)) {
            throw new ImsOperationError("This return cannot be posted in its current state.");
          }
          postSupplierReturn(context, document);
        } else if (document.kind === "salesReturn") {
          if (!["draft", "approved"].includes(status)) {
            throw new ImsOperationError("This return cannot be posted in its current state.");
          }
          postSalesReturn(context, document);
        } else if (document.kind === "purchaseAdjustment") {
          if (!["draft", "approved"].includes(status)) {
            throw new ImsOperationError("This adjustment cannot be posted in its current state.");
          }
          postAdjustments(context, document);
        } else if (document.kind === "stockCount") {
          if (!["draft", "counted", "approved"].includes(status)) {
            throw new ImsOperationError("This count cannot be posted in its current state.");
          }
          postStockCount(context, document);
        } else {
          throw new ImsOperationError("This document type has no stock posting.");
        }
        break;
      }
      case "fulfil": {
        if (document.kind !== "salesOrder") {
          throw new ImsOperationError("Only a sales order can be fulfilled.");
        }
        if (!["confirmed", "partiallyFulfilled"].includes(status)) {
          throw new ImsOperationError("Confirm the sales order before fulfilling it.");
        }
        fulfilSalesOrder(context, document);
        break;
      }
      case "close": {
        if (!["received", "partiallyReceived", "approved", "posted"].includes(status)) {
          throw new ImsOperationError("This document cannot be closed in its current state.");
        }
        setStatus(db, id, "closed", context.nowIso);
        break;
      }
      case "cancel": {
        if (status === "posted") {
          throw new ImsOperationError(
            "A posted document must be corrected with a return or an adjustment, not cancelled.",
          );
        }
        if (document.kind === "stockTransfer" && status === "inTransit") {
          throw new ImsOperationError("A transfer in transit cannot be cancelled; receive it first.");
        }
        if (document.kind === "salesOrder") {
          releaseReservations(db, "salesOrder", id, "released", context.nowIso);
        }
        if (document.kind === "purchaseOrder" && status !== "draft") {
          const received = db
            .prepare(
              "SELECT COALESCE(SUM(processed_milli), 0) AS total FROM ims_document_lines WHERE document_id = ?",
            )
            .get(id) as { total: number };
          if (received.total > 0) {
            throw new ImsOperationError("A purchase order with receipts cannot be cancelled.");
          }
        }
        db.prepare("UPDATE ims_documents SET reason = ? WHERE id = ?").run(reason ?? null, id);
        setStatus(db, id, "cancelled", context.nowIso);
        break;
      }
      default:
        throw new ImsOperationError("That action is not supported for this document.");
    }

    recordAudit(
      db,
      context.actor,
      {
        module: "inventory",
        action,
        entityType: "imsDocument",
        entityId: id,
        oldValues: { status },
        newValues: { status: getOperation(db, id).status, reason: reason ?? null },
      },
      context.nowIso,
    );

    return getOperation(db, id);
  })();
}

export function receiveTransferOperation(
  context: OperationContext,
  request: ReceiveTransferRequest,
): ImsDocumentDto {
  return context.db.transaction((): ImsDocumentDto => {
    const document = loadForUpdate(context.db, request.id);
    if (document.kind !== "stockTransfer" || document.status !== "inTransit") {
      throw new ImsOperationError("This transfer is not ready to receive.");
    }
    receiveTransfer(context, document, request);
    return getOperation(context.db, request.id);
  })();
}

/**
 * Turn an approved requisition into a purchase order, or an accepted quotation
 * into a sales order. The source document keeps its own number and history.
 */
export function convertOperation(
  context: OperationContext,
  id: number,
  targetKind: ImsDocumentKind,
  clientToken?: string | null,
): ImsDocumentDto {
  const { db } = context;

  return db.transaction((): ImsDocumentDto => {
    const source = loadForUpdate(db, id);
    const valid =
      (source.kind === "purchaseRequisition" && targetKind === "purchaseOrder") ||
      (source.kind === "salesQuotation" && targetKind === "salesOrder");
    if (!valid) {
      throw new ImsOperationError("That conversion is not allowed.");
    }
    if (!["approved", "accepted", "sent", "submitted"].includes(source.status)) {
      throw new ImsOperationError("Approve the source document before converting it.");
    }

    const lines = db
      .prepare("SELECT * FROM ims_document_lines WHERE document_id = ? ORDER BY line_no")
      .all(id) as LineRow[];
    const location =
      source.to_location_id ?? source.from_location_id ?? defaultLocationId(db);
    const info = db
      .prepare(
        `INSERT INTO ims_documents
           (kind, number, status, party_id, from_location_id, to_location_id, source_id,
            issue_date, due_date, required_date, reference, notes, total_fils, vat_fils,
            discount_fils, created_by, client_token, created_at, updated_at)
         VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        targetKind,
        nextNumber(db, targetKind, context.nowDate),
        source.party_id,
        targetKind === "purchaseOrder" ? location : source.from_location_id,
        targetKind === "purchaseOrder" ? source.to_location_id : location,
        source.id,
        context.nowDate,
        source.due_date,
        source.required_date,
        source.reference,
        source.notes,
        source.total_fils,
        source.vat_fils,
        source.discount_fils,
        context.actor.name,
        clientToken ?? null,
        context.nowIso,
        context.nowIso,
      );
    const newId = Number(info.lastInsertRowid);

    const insert = db.prepare(
      `INSERT INTO ims_document_lines
         (document_id, source_line_id, line_no, product_id, description, quantity_milli,
          processed_milli, expected_milli, counted_milli, unit_cost_fils, unit_price_fils,
          discount_fils, vat_treatment, vat_fils, line_total_fils, batch_no, expiry_date,
          condition_note, serials, restock)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const line of lines) {
      insert.run(
        newId,
        line.id,
        line.line_no,
        line.product_id,
        line.description,
        line.quantity_milli,
        line.unit_cost_fils,
        line.unit_price_fils,
        line.discount_fils,
        line.vat_treatment,
        line.vat_fils,
        line.line_total_fils,
        line.batch_no,
        line.expiry_date,
        line.condition_note,
        line.serials,
        line.restock,
      );
    }

    setStatus(db, id, "closed", context.nowIso);
    db.prepare("UPDATE ims_documents SET reference = ? WHERE id = ?").run(
      getOperation(db, newId).number,
      id,
    );

    recordAudit(
      db,
      context.actor,
      {
        module: "inventory",
        action: "convert",
        entityType: "imsDocument",
        entityId: newId,
        newValues: { source: source.number, targetKind },
      },
      context.nowIso,
    );

    return getOperation(db, newId);
  })();
}

export function createRequisitionForProducts(
  context: OperationContext,
  input: {
    readonly productIds: readonly number[];
    readonly supplierId: number | null;
    readonly locationId: number | null;
  },
): ImsDocumentDto {
  const { db } = context;
  const lines: ImsLineInput[] = [];
  const select = db.prepare(
    `SELECT p.id, p.name, p.average_cost_fils, r.reorder_point_milli, r.maximum_milli,
            r.safety_milli
       FROM products p
       LEFT JOIN ims_reorder_rules r ON r.product_id = p.id
      WHERE p.id = ?`,
  );
  for (const productId of input.productIds) {
    const row = select.get(productId) as
      | {
          id: number;
          name: string;
          average_cost_fils: number;
          reorder_point_milli: number | null;
          maximum_milli: number | null;
          safety_milli: number | null;
        }
      | undefined;
    if (row === undefined) continue;
    const onHand = currentLocationOnHand(db, row.id, input.locationId);
    const target = Math.max(row.maximum_milli ?? 0, row.reorder_point_milli ?? 0, row.safety_milli ?? 0);
    const suggested = Math.max(0, target - onHand);
    if (suggested <= 0) continue;
    lines.push({
      productId: row.id,
      description: row.name,
      quantityMilli: suggested,
      unitCostFils: row.average_cost_fils,
      unitPriceFils: row.average_cost_fils,
      vatTreatment: "standard",
    });
  }

  if (lines.length === 0) {
    throw new ImsOperationError("There is nothing to replenish for the selected products.");
  }

  return saveOperation(context, {
    kind: "purchaseRequisition",
    partyId: input.supplierId,
    fromLocationId: input.locationId,
    issueDate: context.nowDate,
    requiredDate: context.nowDate,
    notes: "Created from replenishment suggestions",
    lines,
  });
}

/** A location's current quantity, exported for the overview and reports. */
export function locationOnHand(
  db: SqliteDatabase,
  productId: number,
  locationId: number,
): number {
  return currentLocationOnHand(db, productId, locationId);
}

/** Kept here so callers do not need to import the stock module for a check. */
export function assertPositiveLocation(db: SqliteDatabase, locationId: number): void {
  getLocation(db, locationId);
}

export function availableAt(
  db: SqliteDatabase,
  productId: number,
  locationId?: number | null,
): number {
  return availableQuantity(db, productId, locationId);
}

/** Re-exported so operation failures share one error vocabulary. */
export { ImsStockError };
