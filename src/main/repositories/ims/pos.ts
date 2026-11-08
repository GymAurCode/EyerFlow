/**
 * Point of sale: shifts, cash control and walk-up sales.
 *
 * A POS sale is an ordinary sales invoice. It is written through the document
 * repository, so the stock deduction, VAT, payment allocation and ledger
 * posting all happen exactly once. The client token on the invoice is what
 * makes a repeated register callback safe.
 */

import type { SqliteDatabase } from "../../../data/connection";
import { computeDocumentTotals } from "../../../domain/document";
import { todayIso } from "../../../domain/dates";
import type {
  CloseShiftRequest,
  OpenShiftRequest,
  PosHistoryRow,
  PosSaleRequest,
  PosSaleResult,
  PosShiftDto,
  PosStateDto,
} from "../../../shared/ims";
import type { SaveDocumentRequest } from "../../../shared/types";
import type { AuditActor } from "../../audit-writer";
import { recordAudit } from "../../audit-writer";
import { saveDocument } from "../documents";
import { defaultLocationId } from "./stock";

export class ImsPosError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ImsPosError";
  }
}

export interface PosContext {
  readonly db: SqliteDatabase;
  readonly actor: AuditActor;
  readonly nowIso: string;
  readonly nowDate: string;
  readonly fiscalYearStartMonth: number;
  readonly allowNegativeStock: boolean;
  readonly vatRate: number;
}

interface ShiftRow {
  readonly id: number;
  readonly register_name: string;
  readonly opened_by: string;
  readonly opening_float_fils: number;
  readonly closing_counted_fils: number | null;
  readonly expected_cash_fils: number | null;
  readonly variance_fils: number | null;
  readonly opened_at: string;
  readonly closed_at: string | null;
  readonly status: "open" | "closed";
  readonly notes: string | null;
}

function mapShift(row: ShiftRow): PosShiftDto {
  return {
    id: row.id,
    registerName: row.register_name,
    openedBy: row.opened_by,
    openingFloatFils: row.opening_float_fils,
    closingCountedFils: row.closing_counted_fils,
    expectedCashFils: row.expected_cash_fils,
    varianceFils: row.variance_fils,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    status: row.status,
    notes: row.notes,
  };
}

function openShiftRow(db: SqliteDatabase): ShiftRow | undefined {
  return db
    .prepare("SELECT * FROM ims_pos_shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1")
    .get() as ShiftRow | undefined;
}

function expectedCash(db: SqliteDatabase, shift: ShiftRow): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(ps.total_fils), 0) AS total
         FROM ims_pos_sales ps
         JOIN payments p ON p.party_id IS NOT NULL
        WHERE ps.shift_id = ?`,
    )
    .get(shift.id) as { total: number };
  const cash = db
    .prepare(
      `SELECT COALESCE(SUM(d.paid_fils), 0) AS total
         FROM ims_pos_sales ps JOIN documents d ON d.id = ps.document_id
        WHERE ps.shift_id = ?`,
    )
    .get(shift.id) as { total: number };
  // `total_fils` on ims_pos_sales is the sale value; cash tendered can exceed
  // it and change is handed back. The drawer therefore grows by paid amount.
  void row;
  return shift.opening_float_fils + cash.total;
}

export function posState(db: SqliteDatabase): PosStateDto {
  const shift = openShiftRow(db);
  const today = todayIso();
  const todaySales = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(ps.total_fils), 0) AS total
         FROM ims_pos_sales ps JOIN documents d ON d.id = ps.document_id
        WHERE d.issue_date = ?`,
    )
    .get(today) as { count: number; total: number };

  return {
    shift: shift === undefined ? null : mapShift(shift),
    canSell: shift !== undefined,
    todaySalesFils: todaySales.total,
    todaySalesCount: todaySales.count,
    heldSales: [],
  };
}

export function openShift(context: PosContext, request: OpenShiftRequest): PosStateDto {
  return context.db.transaction((): PosStateDto => {
    if (openShiftRow(context.db) !== undefined) {
      throw new ImsPosError("A register shift is already open. Close it before opening another.");
    }
    const info = context.db
      .prepare(
        `INSERT INTO ims_pos_shifts
           (register_name, opened_by, opening_float_fils, opened_at, status)
         VALUES (?, ?, ?, ?, 'open')`,
      )
      .run(request.registerName, context.actor.name, request.openingFloatFils, context.nowIso);

    recordAudit(
      context.db,
      context.actor,
      {
        module: "sales",
        action: "openShift",
        entityType: "imsPosShift",
        entityId: Number(info.lastInsertRowid),
        newValues: { registerName: request.registerName, openingFloatFils: request.openingFloatFils },
      },
      context.nowIso,
    );
    return posState(context.db);
  })();
}

export function closeShift(context: PosContext, request: CloseShiftRequest): PosStateDto {
  return context.db.transaction((): PosStateDto => {
    const shift = context.db
      .prepare("SELECT * FROM ims_pos_shifts WHERE id = ?")
      .get(request.id) as ShiftRow | undefined;
    if (shift === undefined) throw new ImsPosError("That register shift was not found.");
    if (shift.status === "closed") throw new ImsPosError("This shift is already closed.");

    const expected = expectedCash(context.db, shift);
    const variance = request.closingCountedFils - expected;
    context.db
      .prepare(
        `UPDATE ims_pos_shifts
            SET status = 'closed', closing_counted_fils = ?, expected_cash_fils = ?,
                variance_fils = ?, closed_at = ?, notes = ?
          WHERE id = ?`,
      )
      .run(
        request.closingCountedFils,
        expected,
        variance,
        context.nowIso,
        request.notes ?? null,
        request.id,
      );

    recordAudit(
      context.db,
      context.actor,
      {
        module: "sales",
        action: "closeShift",
        entityType: "imsPosShift",
        entityId: request.id,
        newValues: { expectedFils: expected, countedFils: request.closingCountedFils, varianceFils: variance },
      },
      context.nowIso,
    );

    return posState(context.db);
  })();
}

function walkInCustomer(db: SqliteDatabase, nowIso: string): number {
  const existing = db
    .prepare("SELECT id FROM parties WHERE code = 'WALKIN' OR name = 'Walk-in customer' ORDER BY id LIMIT 1")
    .get() as { id: number } | undefined;
  if (existing !== undefined) return existing.id;

  const info = db
    .prepare(
      `INSERT INTO parties (code, name, kind, opening_balance, is_active, created_at, updated_at)
       VALUES ('WALKIN', 'Walk-in customer', 'customer', 0, 1, ?, ?)`,
    )
    .run(nowIso, nowIso);
  return Number(info.lastInsertRowid);
}

export function completeSale(context: PosContext, request: PosSaleRequest): PosSaleResult {
  const { db } = context;

  return db.transaction((): PosSaleResult => {
    const replay = db
      .prepare(
        `SELECT d.id, d.number, d.gross_fils, ps.tendered_fils, ps.change_fils
           FROM documents d JOIN ims_pos_sales ps ON ps.document_id = d.id
          WHERE d.client_token = ?`,
      )
      .get(request.clientToken) as
      | { id: number; number: string; gross_fils: number; tendered_fils: number; change_fils: number }
      | undefined;
    if (replay !== undefined) {
      return {
        documentId: replay.id,
        number: replay.number,
        totalFils: replay.gross_fils,
        tenderedFils: replay.tendered_fils,
        changeFils: replay.change_fils,
        replayed: true,
      };
    }

    const shift = db.prepare("SELECT * FROM ims_pos_shifts WHERE id = ?").get(request.shiftId) as
      | ShiftRow
      | undefined;
    if (shift === undefined) throw new ImsPosError("Open a register shift before selling.");
    if (shift.status !== "open") throw new ImsPosError("This register shift is closed.");

    if (request.lines.length === 0) throw new ImsPosError("Add at least one item to the sale.");

    const lineDiscount = request.lines.reduce((sum, line) => sum + (line.discountFils ?? 0), 0);
    const discountFils = (request.discountFils ?? 0) + lineDiscount;
    const totals = computeDocumentTotals(
      request.lines.map((line) => ({
        description: line.description,
        quantityMilli: line.quantityMilli,
        unitPriceFils: line.unitPriceFils,
        vatTreatment: line.vatTreatment ?? "standard",
      })),
      { invoiceDiscountFils: discountFils, vatRate: context.vatRate },
    );

    if (request.tenderedFils < totals.totalFils) {
      throw new ImsPosError(
        `The amount tendered is less than the sale total. Total: ${String(totals.totalFils)} fils.`,
      );
    }

    const customerId = request.customerId ?? walkInCustomer(db, context.nowIso);
    const saveRequest: SaveDocumentRequest = {
      kind: "invoice",
      partyId: customerId,
      issueDate: context.nowDate,
      status: "issued",
      notes: request.notes ?? `POS sale - ${shift.register_name}`,
      clientToken: request.clientToken,
      locationId: defaultLocationId(db),
      discountFils,
      paidAmountFils: totals.totalFils,
      lines: request.lines.map((line) => ({
        productId: line.productId,
        description: line.description,
        quantityMilli: line.quantityMilli,
        unitPriceFils: line.unitPriceFils,
        vatTreatment: line.vatTreatment ?? "standard",
      })),
    };

    const document = saveDocument(
      {
        db,
        actor: context.actor,
        fiscalYearStartMonth: context.fiscalYearStartMonth,
        nowIso: context.nowIso,
        nowDate: context.nowDate,
        allowNegativeStock: context.allowNegativeStock,
        vatRate: context.vatRate,
      },
      saveRequest,
    );

    const changeFils = request.tenderedFils - document.grossFils;
    db.prepare(
      `INSERT INTO ims_pos_sales
         (client_token, shift_id, document_id, total_fils, tendered_fils, change_fils, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      request.clientToken,
      request.shiftId,
      document.id,
      document.grossFils,
      request.tenderedFils,
      changeFils,
      context.nowIso,
    );

    recordAudit(
      db,
      context.actor,
      {
        module: "sales",
        action: "posSale",
        entityType: "document",
        entityId: document.id,
        newValues: {
          number: document.number,
          totalFils: document.grossFils,
          tenderedFils: request.tenderedFils,
          method: request.paymentMethod,
        },
      },
      context.nowIso,
    );

    return {
      documentId: document.id,
      number: document.number,
      totalFils: document.grossFils,
      tenderedFils: request.tenderedFils,
      changeFils,
      replayed: false,
    };
  })();
}

export function posHistory(db: SqliteDatabase, limit = 100): PosHistoryRow[] {
  const rows = db
    .prepare(
      `SELECT d.id, d.number, d.issue_date, p.name AS party_name, d.gross_fils,
              d.paid_fils, ps.shift_id, ps.created_at
         FROM ims_pos_sales ps
         JOIN documents d ON d.id = ps.document_id
         LEFT JOIN parties p ON p.id = d.party_id
        ORDER BY ps.created_at DESC LIMIT ?`,
    )
    .all(limit) as {
    id: number;
    number: string;
    issue_date: string;
    party_name: string | null;
    gross_fils: number;
    paid_fils: number;
    shift_id: number;
    created_at: string;
  }[];

  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    issueDate: row.issue_date,
    partyName: row.party_name,
    totalFils: row.gross_fils,
    paidFils: row.paid_fils,
    method: "cash",
    shiftId: row.shift_id,
    createdAt: row.created_at,
  }));
}
