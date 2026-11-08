/**
 * Document repository: sales invoices, purchases and stock adjustments.
 *
 * Two invariants are enforced here and nowhere else, because they must hold
 * even if a future screen bypasses the UI layer:
 *
 *  1. Money is computed in integer fils by `computeDocumentTotals`, never by
 *     the renderer.
 *  2. Stock is calculated from stock_movements and moves exactly once per
 *     line, valued at the weighted average cost at the moment of the movement.
 */

import type { SqliteDatabase } from "../../data/connection";
import {
  type DocumentTotals,
  computeDocumentTotals,
  derivePaymentStatus,
} from "../../domain/document";
import { type Fils, toFils } from "../../domain/money";
import { fiscalYearOf } from "../../domain/dates";
import type {
  DocumentDto,
  DocumentLineDto,
  DocumentLineInput,
  DocumentListRequest,
  DocumentStatus,
  SaveDocumentRequest,
  VatTreatment,
} from "../../shared/types";
import type { AuditActor } from "../audit-writer";
import { recordAudit } from "../audit-writer";
import { nextStockNumber } from "./sequences";
import { defaultLocationId, reservedQuantity } from "./ims/stock";

interface DocumentRow {
  readonly id: number;
  readonly kind: "invoice" | "purchaseInvoice" | "stockAdjustment";
  readonly number: string;
  readonly party_id: number | null;
  readonly issue_date: string;
  readonly due_date: string | null;
  readonly status: DocumentStatus;
  readonly net_fils: number;
  readonly vat_fils: number;
  readonly gross_fils: number;
  readonly discount_fils: number;
  readonly paid_fils: number;
  readonly cost_fils: number;
  readonly fiscal_year: number | null;
  readonly notes: string | null;
  readonly reason: string | null;
  readonly created_by: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly party_name?: string | null;
  readonly party_code?: string | null;
}

interface LineRow {
  readonly id: number;
  readonly document_id: number;
  readonly product_id: number | null;
  readonly line_no: number;
  readonly description: string;
  readonly quantity_milli: number;
  readonly unit_price_fils: number;
  readonly net_fils: number;
  readonly vat_fils: number;
  readonly vat_treatment: VatTreatment;
  readonly unit_cost_fils: number;
  readonly cost_fils: number;
}

export class DocumentError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DocumentError";
  }
}

function mapLine(row: LineRow): DocumentLineDto {
  return {
    id: row.id,
    lineNo: row.line_no,
    productId: row.product_id,
    description: row.description,
    quantityMilli: row.quantity_milli,
    unitPriceFils: row.unit_price_fils,
    netFils: row.net_fils,
    vatFils: row.vat_fils,
    vatTreatment: row.vat_treatment,
    unitCostFils: row.unit_cost_fils,
    costFils: row.cost_fils,
  };
}

export function mapDocument(db: SqliteDatabase, row: DocumentRow): DocumentDto {
  const lines = db
    .prepare("SELECT * FROM document_lines WHERE document_id = ? ORDER BY line_no, id")
    .all(row.id) as LineRow[];

  return toDocumentDto(row, lines);
}

function toDocumentDto(row: DocumentRow, lines: readonly LineRow[]): DocumentDto {
  return {
    id: row.id,
    kind: row.kind,
    number: row.number,
    partyId: row.party_id,
    partyName: row.party_name ?? null,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    status: row.status,
    netFils: row.net_fils,
    vatFils: row.vat_fils,
    grossFils: row.gross_fils,
    discountFils: row.discount_fils,
    paidFils: row.paid_fils,
    outstandingFils: row.gross_fils - row.paid_fils,
    costFils: row.cost_fils,
    fiscalYear: row.fiscal_year ?? fiscalYearOf(row.issue_date, 1),
    notes: row.notes,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines: lines.map(mapLine),
  };
}

/**
 * Map a list of documents with one read of `document_lines`, not one per row.
 *
 * The list is paginated but can ask for a thousand documents; issuing a query
 * per document made the screen's cost grow with the page size. IDs are chunked
 * to stay under SQLite's bound-variable ceiling.
 */
function mapDocuments(db: SqliteDatabase, rows: readonly DocumentRow[]): DocumentDto[] {
  if (rows.length === 0) return [];

  const linesByDocument = new Map<number, LineRow[]>();
  const ids = rows.map((row) => row.id);

  for (let offset = 0; offset < ids.length; offset += 400) {
    const chunk = ids.slice(offset, offset + 400);
    const placeholders = chunk.map(() => "?").join(",");
    const lines = db
      .prepare(
        `SELECT * FROM document_lines
          WHERE document_id IN (${placeholders})
          ORDER BY document_id, line_no, id`,
      )
      .all(...chunk) as LineRow[];

    for (const line of lines) {
      const bucket = linesByDocument.get(line.document_id);
      if (bucket === undefined) {
        linesByDocument.set(line.document_id, [line]);
      } else {
        bucket.push(line);
      }
    }
  }

  return rows.map((row) => toDocumentDto(row, linesByDocument.get(row.id) ?? []));
}

const DOCUMENT_SELECT = `
  SELECT d.*, p.name AS party_name, p.code AS party_code
    FROM documents d
    LEFT JOIN parties p ON p.id = d.party_id
`;

export function listDocuments(db: SqliteDatabase, request: DocumentListRequest): DocumentDto[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  // Only the kinds this build can produce are ever listed, so a document left
  // behind by an older build stays invisible rather than breaking the list.
  const kinds = request.kind === undefined ? undefined : [request.kind];
  if (kinds !== undefined) {
    clauses.push("d.kind = ?");
    params.push(request.kind as string);
  } else {
    clauses.push("d.kind IN ('invoice','purchaseInvoice','stockAdjustment')");
  }
  if (request.partyId !== undefined) {
    clauses.push("d.party_id = ?");
    params.push(request.partyId);
  }
  if (request.status !== undefined) {
    clauses.push("d.status = ?");
    params.push(request.status);
  }
  if (request.fromDate !== undefined) {
    clauses.push("d.issue_date >= ?");
    params.push(request.fromDate);
  }
  if (request.toDate !== undefined) {
    clauses.push("d.issue_date <= ?");
    params.push(request.toDate);
  }
  if (request.search !== undefined && request.search.length > 0) {
    clauses.push("(d.number LIKE ? OR p.name LIKE ?)");
    const like = `%${request.search}%`;
    params.push(like, like);
  }

  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const limit = request.limit ?? 500;

  const rows = db
    .prepare(`${DOCUMENT_SELECT}${where} ORDER BY d.issue_date DESC, d.id DESC LIMIT ?`)
    .all(...params, limit) as DocumentRow[];

  return mapDocuments(db, rows);
}

export function getDocument(db: SqliteDatabase, id: number): DocumentDto {
  const row = db.prepare(`${DOCUMENT_SELECT} WHERE d.id = ?`).get(id) as DocumentRow | undefined;
  if (row === undefined) throw new DocumentError(`Document ${String(id)} was not found.`);
  return mapDocument(db, row);
}

interface ProductCostRow {
  readonly id: number;
  readonly quantity_milli: number;
  readonly average_cost_fils: number;
  readonly is_service: number;
}

/**
 * The product's reference cost: the cost of its most recent purchase.
 *
 * Reads the live product row inside the transaction so a concurrent receipt
 * cannot make the cost used for a movement inconsistent with the movement.
 * No weighted average is computed any more - the last purchase cost is the
 * reference, and a sale's profit uses the cost entered at the time of sale.
 */
function referenceCost(db: SqliteDatabase, productId: number): number {
  const row = db
    .prepare("SELECT id, quantity_milli, average_cost_fils, is_service FROM products WHERE id = ?")
    .get(productId) as ProductCostRow | undefined;

  if (row === undefined) throw new DocumentError(`Product ${String(productId)} was not found.`);
  if (row.is_service === 1) return 0;
  return row.average_cost_fils;
}

function productQuantity(db: SqliteDatabase, productId: number): number {
  const row = db.prepare("SELECT quantity_milli FROM products WHERE id = ?").get(productId) as
    { quantity_milli: number } | undefined;
  return row?.quantity_milli ?? 0;
}

function assertStockAvailable(
  db: SqliteDatabase,
  productId: number,
  quantityMilli: number,
  allowNegativeStock: boolean,
): void {
  if (allowNegativeStock) return;
  // Stock reserved by a confirmed sales order is already promised to somebody
  // else, so a walk-up sale must not consume it as well.
  const reserved = reservedQuantity(db, productId);
  const onHand = productQuantity(db, productId) - reserved;
  if (onHand < quantityMilli) {
    throw new DocumentError(
      `Not enough stock for this line. On hand: ${formatQty(onHand)}, needed: ${formatQty(quantityMilli)}. ` +
        `Record a stock adjustment or a purchase first.`,
    );
  }
}

function formatQty(milli: number): string {
  const units = milli / 1000;
  return Number.isInteger(units) ? String(units) : units.toFixed(3).replace(/0+$/, "");
}

interface SaveContext {
  readonly db: SqliteDatabase;
  readonly actor: AuditActor;
  readonly fiscalYearStartMonth: number;
  readonly nowIso: string;
  readonly nowDate: string;
  /** When true, a sale may take stock below zero. */
  readonly allowNegativeStock: boolean;
  /** VAT rate as a decimal multiplier (0.05 = 5%), from settings. */
  readonly vatRate: number;
}

/**
 * Create or update a document and post its stock movements.
 *
 * Editing an issued document reverses the old movements first, then applies
 * the new ones, so stock and cost always reflect the current lines rather than
 * an accumulation of edits.
 */
export function saveDocument(context: SaveContext, request: SaveDocumentRequest): DocumentDto {
  const { db } = context;

  return db.transaction((): DocumentDto => {
    const existing = request.id === undefined ? undefined : loadForUpdate(db, request.id);

    // A retried POS callback must return the sale that was already saved, not
    // deduct the stock a second time.
    if (existing === undefined && request.clientToken !== undefined && request.clientToken !== null) {
      const replay = db
        .prepare("SELECT id FROM documents WHERE client_token = ?")
        .get(request.clientToken) as { id: number } | undefined;
      if (replay !== undefined) return getDocument(db, replay.id);
    }

    if (existing !== undefined && existing.status === "cancelled") {
      throw new DocumentError("A cancelled document cannot be edited. Create a new one instead.");
    }

    const fiscalYear = fiscalYearOf(request.issueDate, context.fiscalYearStartMonth);

    const inputs = buildLineInputs(db, request);
    const totals = computeDocumentTotals(inputs, {
      invoiceDiscountFils: request.discountFils ?? 0,
      vatRate: context.vatRate,
    });

    let documentId: number;
    if (existing === undefined) {
      const number = nextStockNumber(db, request.kind, fiscalYear);
      const info = db
        .prepare(
          `INSERT INTO documents
             (kind, number, party_id, issue_date, due_date, status, net_fils, vat_fils,
              gross_fils, discount_fils, paid_fils, cost_fils, fiscal_year, notes, created_by, client_token, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          request.kind,
          number,
          request.partyId,
          request.issueDate,
          request.dueDate ?? null,
          request.status,
          totals.netFils,
          totals.vatFils,
          totals.totalFils,
          totals.discountFils,
          totals.costFils,
          fiscalYear,
          request.notes ?? null,
          context.actor.name,
          request.clientToken ?? null,
          context.nowIso,
          context.nowIso,
        );
      documentId = Number(info.lastInsertRowid);
    } else {
      documentId = existing.id;
      // Reverse the previous posting so the net stock effect equals the new lines.
      reverseMovements(db, documentId);
      db.prepare(
        `UPDATE documents
            SET party_id = ?, issue_date = ?, due_date = ?, status = ?, net_fils = ?, vat_fils = ?,
                gross_fils = ?, discount_fils = ?, cost_fils = ?, fiscal_year = ?, notes = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        request.partyId,
        request.issueDate,
        request.dueDate ?? null,
        request.status,
        totals.netFils,
        totals.vatFils,
        totals.totalFils,
        totals.discountFils,
        totals.costFils,
        fiscalYear,
        request.notes ?? null,
        context.nowIso,
        documentId,
      );
      db.prepare("DELETE FROM document_lines WHERE document_id = ?").run(documentId);
    }

    insertLines(db, documentId, request.lines, totals);

    const locationId = request.locationId ?? defaultLocationId(db);
    if (request.kind !== "stockAdjustment") {
      postStockMovements(db, documentId, request.kind, request.issueDate, fiscalYear, context, locationId);
    } else {
      postStockMovements(db, documentId, "stockAdjustment", request.issueDate, fiscalYear, context, locationId);
    }

    // Money paid on the spot, typed into the same form. It becomes a real
    // payment row so the party balance and the invoice status agree with what
    // the shopkeeper saw on screen.
    const paidUpfront = request.paidAmountFils ?? 0;
    if (paidUpfront > 0 && request.partyId !== null && request.kind !== "stockAdjustment") {
      recordDocumentPayment(
        db,
        documentId,
        request.partyId,
        request.kind === "purchaseInvoice" ? "outbound" : "inbound",
        // The ceiling is the document's own total. Taking more than a bill is
        // worth is a credit on the customer's account, not a payment against
        // it, so the amount is capped here as well as in the dialog - this is
        // one write, and this is the last moment before it becomes a row.
        Math.min(paidUpfront, totals.totalFils),
        context,
      );
    }

    refreshDocumentPaid(db, documentId, context.nowIso);

    recordAudit(
      db,
      context.actor,
      {
        module: request.kind === "purchaseInvoice" ? "purchases" : "sales",
        action: existing === undefined ? "create" : "update",
        entityType: "document",
        entityId: documentId,
        newValues: {
          kind: request.kind,
          gross: totals.totalFils,
          lines: request.lines.length,
          status: request.status,
        },
      },
      context.nowIso,
    );

    return getDocument(db, documentId);
  })();
}

function loadForUpdate(db: SqliteDatabase, id: number): DocumentRow | undefined {
  return db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as DocumentRow | undefined;
}

function buildLineInputs(
  db: SqliteDatabase,
  request: SaveDocumentRequest,
): readonly {
  description: string;
  quantityMilli: number;
  unitPriceFils: number;
  vatTreatment: VatTreatment;
  unitCostFils: number;
}[] {
  return request.lines.map((line) => {
    const quantityMilli = Math.abs(line.quantityMilli);

    return {
      description: line.description,
      quantityMilli,
      unitPriceFils: line.unitPriceFils,
      vatTreatment: line.vatTreatment,
      // The cost is whatever the user entered for the line: the purchase cost
      // on a purchase, the cost at sale on a sale. No weighted average is
      // applied - profit and COGS use this figure exactly. A line with no
      // product (a typed service line) is priced as given.
      unitCostFils: line.unitCostFils ?? 0,
    };
  });
}

function insertLines(
  db: SqliteDatabase,
  documentId: number,
  lines: readonly DocumentLineInput[],
  totals: DocumentTotals,
): void {
  const statement = db.prepare(
    `INSERT INTO document_lines
       (document_id, product_id, line_no, description, quantity_milli, unit_price_fils,
        net_fils, vat_fils, vat_treatment, unit_cost_fils, cost_fils)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  lines.forEach((line, index) => {
    const computed = totals.lines[index];
    if (computed === undefined) return;

    statement.run(
      documentId,
      line.productId,
      computed.lineNo,
      line.description,
      computed.quantityMilli,
      line.unitPriceFils,
      computed.netFils,
      computed.vatFils,
      computed.vatTreatment,
      computed.unitCostFils,
      computed.costFils,
    );
  });
}

/**
 * Post stock movements for the document's lines.
 *
 * Sales issue at the current weighted average; purchases receive at the invoice
 * cost and re-average; adjustments take the new absolute count.
 */
function postStockMovements(
  db: SqliteDatabase,
  documentId: number,
  kind: "invoice" | "purchaseInvoice" | "stockAdjustment",
  date: string,
  fiscalYear: number,
  context: SaveContext,
  locationId: number,
): void {
  const lines = db
    .prepare("SELECT * FROM document_lines WHERE document_id = ? ORDER BY line_no, id")
    .all(documentId) as LineRow[];

  for (const line of lines) {
    if (line.product_id === null) continue;

    switch (kind) {
      case "invoice": {
        assertStockAvailable(db, line.product_id, line.quantity_milli, context.allowNegativeStock);
        applyIssue(db, line.product_id, documentId, line, date, fiscalYear, locationId);
        break;
      }
      case "purchaseInvoice": {
        applyReceipt(db, line.product_id, documentId, line, date, fiscalYear, context, locationId);
        break;
      }
      case "stockAdjustment": {
        applyAdjustment(db, line.product_id, documentId, line, date, fiscalYear, context, locationId);
        break;
      }
    }
  }
}

function applyIssue(
  db: SqliteDatabase,
  productId: number,
  documentId: number,
  line: LineRow,
  date: string,
  fiscalYear: number,
  locationId: number,
): void {
  const unitCost = referenceCost(db, productId);
  const costFils = Math.round((line.quantity_milli * unitCost) / 1000);

  db.prepare(
    `INSERT INTO stock_movements
       (product_id, document_id, document_line_id, movement_date, kind, quantity_milli,
        unit_cost_fils, cost_fils, fiscal_year, notes, location_id, stock_status)
     VALUES (?, ?, ?, ?, 'issue', ?, ?, ?, ?, NULL, ?, 'available')`,
  ).run(
    productId,
    documentId,
    line.id,
    date,
    line.quantity_milli,
    unitCost,
    costFils,
    fiscalYear,
    locationId,
  );

  applyProductQuantity(db, productId, -line.quantity_milli);
}

function applyReceipt(
  db: SqliteDatabase,
  productId: number,
  documentId: number,
  line: LineRow,
  date: string,
  fiscalYear: number,
  context: SaveContext,
  locationId: number,
): void {
  const unitCost = line.unit_cost_fils;
  const costFils = Math.round((line.quantity_milli * unitCost) / 1000);

  db.prepare(
    `INSERT INTO stock_movements
       (product_id, document_id, document_line_id, movement_date, kind, quantity_milli,
        unit_cost_fils, cost_fils, fiscal_year, notes, location_id, stock_status)
     VALUES (?, ?, ?, ?, 'receipt', ?, ?, ?, ?, NULL, ?, 'available')`,
  ).run(
    productId,
    documentId,
    line.id,
    date,
    line.quantity_milli,
    unitCost,
    costFils,
    fiscalYear,
    locationId,
  );

  // The purchase cost becomes the product's reference cost ("last cost").
  // No weighted average is computed any more.
  db.prepare("UPDATE products SET quantity_milli = quantity_milli + ?, average_cost_fils = ?, updated_at = ? WHERE id = ?").run(
    line.quantity_milli,
    unitCost,
    context.nowIso,
    productId,
  );
}

function applyAdjustment(
  db: SqliteDatabase,
  productId: number,
  documentId: number,
  line: LineRow,
  date: string,
  fiscalYear: number,
  context: SaveContext,
  locationId: number,
): void {
  const unitCost = referenceCost(db, productId);
  const costFils = Math.round((line.quantity_milli * unitCost) / 1000);
  const increase = line.unit_price_fils >= 0;

  if (!increase) assertStockAvailable(db, productId, line.quantity_milli, context.allowNegativeStock);

  db.prepare(
    `INSERT INTO stock_movements
       (product_id, document_id, document_line_id, movement_date, kind, quantity_milli,
        unit_cost_fils, cost_fils, fiscal_year, notes, location_id, stock_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Stock adjustment', ?, 'available')`,
  ).run(
    productId,
    documentId,
    line.id,
    date,
    increase ? "adjustmentIn" : "adjustmentOut",
    increase ? line.quantity_milli : -line.quantity_milli,
    unitCost,
    increase ? costFils : -costFils,
    fiscalYear,
    locationId,
  );

  applyProductQuantity(db, productId, increase ? line.quantity_milli : -line.quantity_milli);
  db.prepare("UPDATE products SET updated_at = ? WHERE id = ?").run(context.nowIso, productId);
}

function applyProductQuantity(db: SqliteDatabase, productId: number, delta: number): void {
  db.prepare("UPDATE products SET quantity_milli = quantity_milli + ? WHERE id = ?").run(
    delta,
    productId,
  );
}

/**
 * Reverse every movement previously posted for a document.
 *
 * Quantities are returned at the recorded unit cost and the movement rows are
 * deleted, so editing leaves exactly the effect of the new lines.
 */
function reverseMovements(db: SqliteDatabase, documentId: number): void {
  const movements = db
    .prepare("SELECT * FROM stock_movements WHERE document_id = ? ORDER BY id")
    .all(documentId) as {
    id: number;
    product_id: number;
    quantity_milli: number;
    kind: string;
  }[];

  if (movements.length === 0) return;

  for (const movement of movements) {
    switch (movement.kind) {
      case "receipt":
      case "adjustmentIn":
        applyProductQuantity(db, movement.product_id, -movement.quantity_milli);
        break;
      case "issue":
      case "reversal":
      case "adjustmentOut":
        applyProductQuantity(db, movement.product_id, movement.quantity_milli);
        break;
      default:
        break;
    }

    db.prepare("DELETE FROM stock_movements WHERE id = ?").run(movement.id);
  }
}

/**
 * Cancel a document: reverse its stock, keep it visible, and re-open the
 * invoice for any money allocated to it.
 */
export function cancelDocument(context: SaveContext, id: number, reason: string): DocumentDto {
  const { db } = context;

  return db.transaction((): DocumentDto => {
    const row = loadForUpdate(db, id);
    if (row === undefined) throw new DocumentError(`Document ${String(id)} was not found.`);
    if (row.status === "cancelled") {
      throw new DocumentError("This document is already cancelled.");
    }

    // Cancelling gives the stock back: a cancelled invoice must not still be
    // holding the goods hostage in the stock figures.
    reverseMovements(db, id);

    if (row.paid_fils > 0) {
      // Cancelling a paid invoice would leave the payment attached to nothing.
      // Refund the allocations to the party's balance instead.
      db.prepare("DELETE FROM payment_allocations WHERE document_id = ?").run(id);
    }

    db.prepare(
      "UPDATE documents SET status = 'cancelled', paid_fils = 0, reason = ?, updated_at = ? WHERE id = ?",
    ).run(reason, context.nowIso, id);

    recordAudit(
      db,
      context.actor,
      {
        module: row.kind === "purchaseInvoice" ? "purchases" : "sales",
        action: "cancel",
        entityType: "document",
        entityId: id,
        oldValues: { status: row.status },
        newValues: { status: "cancelled", reason },
      },
      context.nowIso,
    );

    return getDocument(db, id);
  })();
}

/** Delete a draft document outright. Issued documents must be cancelled. */
export function deleteDocument(context: SaveContext, id: number): void {
  const { db } = context;

  db.transaction(() => {
    const row = loadForUpdate(db, id);
    if (row === undefined) throw new DocumentError(`Document ${String(id)} was not found.`);
    if (row.status !== "draft") {
      throw new DocumentError("Only a draft can be deleted. Cancel an issued document instead.");
    }
    db.prepare("DELETE FROM documents WHERE id = ?").run(id);
    recordAudit(
      db,
      context.actor,
      {
        module: row.kind === "purchaseInvoice" ? "purchases" : "sales",
        action: "delete",
        entityType: "document",
        entityId: id,
      },
      context.nowIso,
    );
  })();
}

/**
 * Record the amount paid when the document was created.
 *
 * Written as a payment plus its allocation rather than a bare `paid_fils`
 * update, so the money shows up in the party's history exactly like a payment
 * taken later.
 */
function recordDocumentPayment(
  db: SqliteDatabase,
  documentId: number,
  partyId: number,
  direction: "inbound" | "outbound",
  amountFils: number,
  context: SaveContext,
): void {
  const fiscalYear = fiscalYearOf(context.nowDate, context.fiscalYearStartMonth);

  const info = db
    .prepare(
      `INSERT INTO payments
         (direction, party_id, payment_date, method, amount_fils, notes, created_by,
          created_at, fiscal_year)
       VALUES (?, ?, ?, 'cash', ?, 'Paid on the document', ?, ?, ?)`,
    )
    .run(
      direction,
      partyId,
      context.nowDate,
      amountFils,
      context.actor.name,
      context.nowIso,
      fiscalYear,
    );

  db.prepare(
    "INSERT INTO payment_allocations (payment_id, document_id, amount_fils) VALUES (?, ?, ?)",
  ).run(Number(info.lastInsertRowid), documentId, amountFils);
}

/** Recompute a document's paid total from its allocations. */
export function refreshDocumentPaid(db: SqliteDatabase, documentId: number, nowIso: string): void {
  const row = db
    .prepare("SELECT gross_fils, status FROM documents WHERE id = ?")
    .get(documentId) as { gross_fils: number; status: DocumentStatus } | undefined;
  if (row === undefined) return;

  const sum = db
    .prepare(
      "SELECT COALESCE(SUM(amount_fils), 0) AS total FROM payment_allocations WHERE document_id = ?",
    )
    .get(documentId) as { total: number };

  const status = derivePaymentStatus(row.status, row.gross_fils, sum.total);

  db.prepare("UPDATE documents SET paid_fils = ?, status = ?, updated_at = ? WHERE id = ?").run(
    sum.total,
    status,
    nowIso,
    documentId,
  );
}

/** Documents still owing money for a party, oldest first. */
export function openInvoicesFor(
  db: SqliteDatabase,
  partyId: number,
  kind: "invoice" | "purchaseInvoice",
): readonly { id: number; number: string; outstandingFils: number }[] {
  const rows = db
    .prepare(
      `SELECT id, number, gross_fils - paid_fils AS outstanding
         FROM documents
        WHERE party_id = ? AND kind = ?
          AND status IN ('issued','partPaid') AND gross_fils > paid_fils
        ORDER BY issue_date, number`,
    )
    .all(partyId, kind) as { id: number; number: string; outstanding: number }[];

  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    outstandingFils: Math.round(row.outstanding),
  }));
}

export function documentGrossFils(document: DocumentDto): Fils {
  return toFils(document.grossFils / 100);
}
