/**
 * The authoritative IMS stock engine.
 *
 * Every operational workflow that changes stock posts through `postMovement`.
 * The existing invoice and purchase screens keep their own posting code for
 * compatibility, but they write the same `stock_movements` ledger, so there is
 * one balance and one history. Nothing in the IMS reads a cached location
 * balance: a location's quantity is always the sum of its movements.
 *
 * Quantities are integer thousandths and money is integer fils. No binary
 * floating point value is ever used as a stored business amount.
 */

import type { SqliteDatabase } from "../../../data/connection";
import type { ImsDocumentKind } from "../../../shared/ims";

export class ImsStockError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ImsStockError";
  }
}

export type MovementKind =
  | "receipt"
  | "issue"
  | "reversal"
  | "adjustmentIn"
  | "adjustmentOut"
  | "opening";

export type StockStatus = "available" | "quarantine" | "damaged" | "inTransit";

export interface StockContext {
  readonly db: SqliteDatabase;
  readonly actorName: string;
  readonly nowIso: string;
  readonly nowDate: string;
  readonly allowNegativeStock: boolean;
}

export interface PostMovementInput {
  readonly productId: number;
  readonly locationId?: number | null;
  readonly movementDate: string;
  readonly kind: MovementKind;
  readonly quantityMilli: number;
  readonly unitCostFils?: number;
  readonly documentId?: number | null;
  readonly sourceKind?: string | null;
  readonly sourceId?: number | null;
  readonly batchNo?: string | null;
  readonly serials?: readonly string[] | null;
  readonly serialStatus?: "inStock" | "sold" | "returned" | "quarantine" | "scrapped";
  readonly stockStatus?: StockStatus;
  readonly notes?: string | null;
  readonly idempotencyKey?: string | null;
  /**
   * False for a location move that does not change what the company owns:
   * a branch transfer, or quarantine being reclassified after inspection.
   */
  readonly affectProductTotal?: boolean;
  /** Overrides the configured negative-stock policy for this one posting. */
  readonly allowNegativeOverride?: boolean;
}

export interface PostedMovement {
  readonly id: number;
  readonly replayed: boolean;
}

interface ProductRow {
  readonly id: number;
  readonly name: string;
  readonly is_service: number;
  readonly quantity_milli: number;
  readonly average_cost_fils: number;
}

interface LocationRow {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly is_default: number;
}

export function defaultLocationId(db: SqliteDatabase): number {
  const row = db
    .prepare(
      "SELECT id FROM ims_locations WHERE is_active = 1 ORDER BY is_default DESC, id LIMIT 1",
    )
    .get() as { id: number } | undefined;
  if (row === undefined) throw new ImsStockError("No stock location is configured.");
  return row.id;
}

export function getLocation(db: SqliteDatabase, id: number): LocationRow {
  const row = db.prepare("SELECT * FROM ims_locations WHERE id = ?").get(id) as
    | LocationRow
    | undefined;
  if (row === undefined) throw new ImsStockError(`Stock location ${String(id)} was not found.`);
  return row;
}

/** The location a returned/damaged movement belongs in when none is named. */
function locationForStatus(
  db: SqliteDatabase,
  requested: number | null | undefined,
  status: StockStatus,
): number {
  if (requested !== null && requested !== undefined) return requested;
  if (status === "quarantine" || status === "damaged") {
    const row = db
      .prepare("SELECT id FROM ims_locations WHERE type = ? AND is_active = 1 ORDER BY id LIMIT 1")
      .get(status) as { id: number } | undefined;
    if (row !== undefined) return row.id;
  }
  return defaultLocationId(db);
}

export function onHandAt(
  db: SqliteDatabase,
  productId: number,
  locationId?: number | null,
  status?: StockStatus,
): number {
  const clauses = ["product_id = ?"];
  const params: (string | number)[] = [productId];
  if (locationId !== null && locationId !== undefined) {
    clauses.push("COALESCE(location_id, (SELECT id FROM ims_locations WHERE is_default = 1 LIMIT 1)) = ?");
    params.push(locationId);
  }
  if (status !== undefined) {
    clauses.push("stock_status = ?");
    params.push(status);
  }
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(quantity_milli), 0) AS total FROM stock_movements WHERE ${clauses.join(" AND ")}`,
    )
    .get(...params) as { total: number };
  return row.total;
}

/** Physical quantity that can be sold: everything except quarantine, damaged and in transit. */
export function sellableOnHand(
  db: SqliteDatabase,
  productId: number,
  locationId?: number | null,
): number {
  const locationClause =
    locationId === null || locationId === undefined
      ? ""
      : " AND COALESCE(location_id, (SELECT id FROM ims_locations WHERE is_default = 1 LIMIT 1)) = ?";
  const params: number[] = [productId];
  if (locationClause !== "") params.push(locationId as number);

  const row = db
    .prepare(
      `SELECT COALESCE(SUM(quantity_milli), 0) AS total
         FROM stock_movements
        WHERE product_id = ? AND stock_status = 'available'${locationClause}`,
    )
    .get(...params) as { total: number };
  return row.total;
}

export function reservedQuantity(
  db: SqliteDatabase,
  productId: number,
  locationId?: number | null,
  exceptSource?: { readonly kind: string; readonly id: number },
): number {
  const clauses = ["product_id = ?", "status = 'active'"];
  const params: (string | number)[] = [productId];
  if (locationId !== null && locationId !== undefined) {
    clauses.push("(location_id IS NULL OR location_id = ?)");
    params.push(locationId);
  }
  if (exceptSource !== undefined) {
    clauses.push("NOT (source_kind = ? AND source_id = ?)");
    params.push(exceptSource.kind, exceptSource.id);
  }
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(quantity_milli), 0) AS total FROM ims_reservations WHERE ${clauses.join(" AND ")}`,
    )
    .get(...params) as { total: number };
  return row.total;
}

export function availableQuantity(
  db: SqliteDatabase,
  productId: number,
  locationId?: number | null,
  exceptSource?: { readonly kind: string; readonly id: number },
): number {
  return sellableOnHand(db, productId, locationId) - reservedQuantity(db, productId, locationId, exceptSource);
}

/**
 * Post one movement and update the product total when the company's ownership
 * changes. The caller owns the transaction; idempotency is enforced by the
 * unique index on `idempotency_key` and checked first so a retry returns the
 * original row rather than raising a constraint error.
 */
export function postMovement(context: StockContext, input: PostMovementInput): PostedMovement {
  const { db } = context;

  if (input.idempotencyKey !== undefined && input.idempotencyKey !== null) {
    const existing = db
      .prepare("SELECT id FROM stock_movements WHERE idempotency_key = ?")
      .get(input.idempotencyKey) as { id: number } | undefined;
    if (existing !== undefined) return { id: existing.id, replayed: true };
  }

  const product = db.prepare("SELECT * FROM products WHERE id = ?").get(input.productId) as
    | ProductRow
    | undefined;
  if (product === undefined) {
    throw new ImsStockError(`Product ${String(input.productId)} was not found.`);
  }

  const quantity = Math.trunc(input.quantityMilli);
  if (quantity === 0) {
    throw new ImsStockError("A stock movement cannot be for zero quantity.");
  }

  const status: StockStatus = input.stockStatus ?? "available";
  const locationId = locationForStatus(db, input.locationId, status);
  const unitCost =
    input.unitCostFils === undefined || input.unitCostFils < 0
      ? product.average_cost_fils
      : Math.trunc(input.unitCostFils);
  const costFils = Math.round((quantity * unitCost) / 1000);
  const affects = input.affectProductTotal !== false;
  const allowNegative = input.allowNegativeOverride ?? context.allowNegativeStock;

  const isOutbound = quantity < 0 && affects;
  if (isOutbound && !allowNegative) {
    const available = availableQuantity(db, input.productId, locationId);
    if (available + quantity < 0) {
      throw new ImsStockError(
        `Not enough available stock for "${product.name}". Available: ${formatQuantity(available)}, ` +
          `needed: ${formatQuantity(Math.abs(quantity))}.`,
      );
    }
  }

  if (product.is_service === 1 && affects) {
    // A service has no physical stock. Recording a movement for it would
    // create a negative balance that no receipt could ever clear.
    return { id: 0, replayed: false };
  }

  const info = db
    .prepare(
      `INSERT INTO stock_movements
         (product_id, document_id, document_line_id, movement_date, kind, quantity_milli,
          unit_cost_fils, cost_fils, fiscal_year, notes, location_id, source_kind, source_id,
          batch_no, serial_no, stock_status, idempotency_key)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      input.productId,
      input.documentId ?? null,
      input.movementDate,
      input.kind,
      quantity,
      unitCost,
      costFils,
      Number.parseInt(input.movementDate.slice(0, 4), 10),
      input.notes ?? null,
      locationId,
      input.sourceKind ?? null,
      input.sourceId ?? null,
      input.batchNo ?? null,
      status,
      input.idempotencyKey ?? null,
    );

  if (affects) {
    // A receipt's cost becomes the reference cost, matching the existing
    // purchase behaviour. An issue never rewrites the cost of stock on hand.
    if (quantity > 0 && input.unitCostFils !== undefined && input.unitCostFils > 0) {
      db.prepare(
        `UPDATE products
            SET quantity_milli = quantity_milli + ?, average_cost_fils = ?, updated_at = ?
          WHERE id = ?`,
      ).run(quantity, unitCost, context.nowIso, input.productId);
    } else {
      db.prepare("UPDATE products SET quantity_milli = quantity_milli + ? WHERE id = ?").run(
        quantity,
        input.productId,
      );
    }
  }

  if (input.batchNo !== undefined && input.batchNo !== null && input.batchNo.trim() !== "") {
    db.prepare(
      `INSERT INTO ims_batches (product_id, batch_no, notes, created_at)
       VALUES (?, ?, NULL, ?)
       ON CONFLICT (product_id, batch_no) DO NOTHING`,
    ).run(input.productId, input.batchNo.trim(), context.nowIso);
  }

  if (input.serials !== undefined && input.serials !== null) {
    for (const raw of input.serials) {
      const serial = raw.trim();
      if (serial === "") continue;
      const existing = db
        .prepare("SELECT id, status FROM ims_serials WHERE serial_number = ?")
        .get(serial) as { id: number; status: string } | undefined;

      if (quantity > 0) {
        if (existing !== undefined && existing.status !== "returned" && existing.status !== "quarantine") {
          throw new ImsStockError(
            `Serial number ${serial} is already recorded as ${existing.status}.`,
          );
        }
        if (existing === undefined) {
          db.prepare(
            `INSERT INTO ims_serials
               (product_id, serial_number, location_id, status, source_kind, source_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            input.productId,
            serial,
            locationId,
            input.serialStatus ?? (status === "quarantine" ? "quarantine" : "inStock"),
            input.sourceKind ?? null,
            input.sourceId ?? null,
            context.nowIso,
            context.nowIso,
          );
        } else {
          db.prepare(
            `UPDATE ims_serials
                SET status = ?, location_id = ?, source_kind = ?, source_id = ?, updated_at = ?
              WHERE id = ?`,
          ).run(
            input.serialStatus ?? "inStock",
            locationId,
            input.sourceKind ?? null,
            input.sourceId ?? null,
            context.nowIso,
            existing.id,
          );
        }
      } else if (existing !== undefined) {
        db.prepare(
          "UPDATE ims_serials SET status = ?, source_kind = ?, source_id = ?, updated_at = ? WHERE id = ?",
        ).run(
          input.serialStatus ?? "sold",
          input.sourceKind ?? null,
          input.sourceId ?? null,
          context.nowIso,
          existing.id,
        );
      }
    }
  }

  return { id: Number(info.lastInsertRowid), replayed: false };
}

/** Reserve stock for a confirmed order. Returns what was actually reserved. */
export function reserveStock(
  db: SqliteDatabase,
  actorName: string,
  input: {
    readonly productId: number;
    readonly locationId?: number | null;
    readonly quantityMilli: number;
    readonly sourceKind: ImsDocumentKind | "wmsPick";
    readonly sourceId: number;
    readonly notes?: string | null;
  },
  nowIso: string,
): number {
  if (input.quantityMilli <= 0) return 0;
  const available = availableQuantity(db, input.productId, input.locationId);
  if (available < input.quantityMilli) {
    throw new ImsStockError(
      `Not enough available stock to reserve. Available: ${formatQuantity(available)}, ` +
        `requested: ${formatQuantity(input.quantityMilli)}.`,
    );
  }
  db.prepare(
    `INSERT INTO ims_reservations
       (product_id, location_id, quantity_milli, source_kind, source_id, status, notes, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
  ).run(
    input.productId,
    input.locationId ?? null,
    input.quantityMilli,
    input.sourceKind,
    input.sourceId,
    input.notes ?? null,
    actorName,
    nowIso,
  );
  return input.quantityMilli;
}

export function releaseReservations(
  db: SqliteDatabase,
  sourceKind: string,
  sourceId: number,
  status: "released" | "consumed",
  nowIso: string,
): void {
  db.prepare(
    `UPDATE ims_reservations
        SET status = ?, released_at = ?
      WHERE source_kind = ? AND source_id = ? AND status = 'active'`,
  ).run(status, nowIso, sourceKind, sourceId);
}

/** Move quantity between stock statuses without changing what the company owns. */
export function reclassifyStock(
  context: StockContext,
  input: {
    readonly productId: number;
    readonly locationId: number;
    readonly quantityMilli: number;
    readonly fromStatus: StockStatus;
    readonly toStatus: StockStatus;
    readonly movementDate: string;
    readonly sourceKind: string;
    readonly sourceId: number;
    readonly notes?: string | null;
    readonly toLocationId?: number | null;
    readonly idempotencyKey?: string | null;
  },
): void {
  if (input.quantityMilli <= 0) return;
  postMovement(context, {
    productId: input.productId,
    locationId: input.locationId,
    movementDate: input.movementDate,
    kind: "issue",
    quantityMilli: -input.quantityMilli,
    stockStatus: input.fromStatus,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    notes: input.notes ?? `Reclassified from ${input.fromStatus}`,
    affectProductTotal: false,
    idempotencyKey:
      input.idempotencyKey === undefined || input.idempotencyKey === null
        ? null
        : `${input.idempotencyKey}:out`,
    allowNegativeOverride: true,
  });
  postMovement(context, {
    productId: input.productId,
    locationId: input.toLocationId ?? input.locationId,
    movementDate: input.movementDate,
    kind: "receipt",
    quantityMilli: input.quantityMilli,
    stockStatus: input.toStatus,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    notes: input.notes ?? `Reclassified to ${input.toStatus}`,
    affectProductTotal: false,
    idempotencyKey:
      input.idempotencyKey === undefined || input.idempotencyKey === null
        ? null
        : `${input.idempotencyKey}:in`,
    allowNegativeOverride: true,
  });
}

export function formatQuantity(milli: number): string {
  const units = milli / 1000;
  return Number.isInteger(units) ? String(units) : units.toFixed(3).replace(/0+$/, "");
}

export function isLocationSellable(type: string): boolean {
  return type !== "quarantine" && type !== "damaged" && type !== "transit";
}
