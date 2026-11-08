/**
 * Product and stock repository.
 *
 * Weighted average cost lives on the product row and is maintained by the
 * document repository whenever stock moves. This module reads it, and owns the
 * cases documents do not cover: opening stock, manual stock counts, catalogue
 * edits and the movement history.
 */

import type { SqliteDatabase } from "../../data/connection";
import { fromMilliQty, toMilliQty, stockValue } from "../../domain/costing";
import { todayIso } from "../../domain/dates";
import type {
  ProductDto,
  ProductListRequest,
  StockMovementDto,
  StockMovementRequest,
} from "../../shared/types";
import type { AuditActor } from "../audit-writer";
import { recordAudit } from "../audit-writer";
import { defaultLocationId } from "./ims/stock";

export class ProductError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProductError";
  }
}

interface ProductRow {
  readonly id: number;
  readonly sku: string;
  readonly barcode: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly category: string | null;
  readonly unit: string;
  readonly quantity_milli: number;
  readonly reorder_level_milli: number;
  readonly average_cost_fils: number;
  readonly sale_price_fils: number;
  readonly vat_treatment: "standard" | "zero" | "exempt";
  readonly is_service: number;
  readonly is_active: number;
}

/**
 * A product counts as low stock when it holds five units or fewer. The old
 * per-product reorder level is gone from the form, so the threshold is fixed;
 * the field stays on the row for existing data.
 */
export const LOW_STOCK_MILLI = 5_000;

export function mapProduct(
  row: ProductRow,
  history: { lastCostFils: number; lastSalePriceFils: number } = {
    lastCostFils: 0,
    lastSalePriceFils: 0,
  },
): ProductDto {
  const valueFils = stockValue({
    quantityMilli: row.quantity_milli,
    averageUnitCostFils: row.average_cost_fils,
  });

  return {
    id: row.id,
    sku: row.sku,
    barcode: row.barcode,
    name: row.name,
    description: row.description,
    category: row.category,
    unit: row.unit,
    quantityMilli: row.quantity_milli,
    reorderLevelMilli: row.reorder_level_milli,
    averageCostFils: row.average_cost_fils,
    salePriceFils: row.sale_price_fils,
    vatTreatment: row.vat_treatment,
    isActive: row.is_active === 1,
    stockValueFils: valueFils,
    isLowStock: row.quantity_milli <= LOW_STOCK_MILLI,
    lastCostFils: history.lastCostFils,
    lastSalePriceFils: history.lastSalePriceFils,
  };
}

/**
 * Last purchase cost and last sale price per product, derived from document
 * lines. Read-only values shown on the products list; the most recent
 * non-cancelled document of each kind wins, ties broken by id.
 */
export function productCostHistory(
  db: SqliteDatabase,
  productIds?: readonly number[],
): Map<number, { lastCostFils: number; lastSalePriceFils: number }> {
  const map = new Map<number, { lastCostFils: number; lastSalePriceFils: number }>();

  // A catalogue list only needs history for the rows it is about to return.
  // Without this filter the window function walks every line in the shop's
  // history, even when the screen asked for twenty-five products. The IDs are
  // chunked so a 1000-row page stays below SQLite's bound-variable ceiling.
  if (productIds !== undefined) {
    const unique = [...new Set(productIds)];
    for (let offset = 0; offset < unique.length; offset += 400) {
      collectProductCostHistory(db, unique.slice(offset, offset + 400), map);
    }
    return map;
  }

  collectProductCostHistory(db, undefined, map);
  return map;
}

function collectProductCostHistory(
  db: SqliteDatabase,
  productIds: readonly number[] | undefined,
  map: Map<number, { lastCostFils: number; lastSalePriceFils: number }>,
): void {
  const filter =
    productIds === undefined
      ? ""
      : ` AND dl.product_id IN (${productIds.map(() => "?").join(",")})`;

  const rows = db
    .prepare(
      `SELECT product_id,
              MAX(CASE WHEN kind = 'purchaseInvoice' THEN unit_price_fils END) AS last_cost,
              MAX(CASE WHEN kind = 'invoice' THEN unit_price_fils END) AS last_sale
         FROM (
           SELECT dl.product_id, d.kind, dl.unit_price_fils,
                  ROW_NUMBER() OVER (
                    PARTITION BY dl.product_id, d.kind
                    ORDER BY d.issue_date DESC, d.id DESC, dl.line_no DESC, dl.id DESC
                  ) AS rn
             FROM document_lines dl
             JOIN documents d ON d.id = dl.document_id
            WHERE dl.product_id IS NOT NULL AND d.status <> 'cancelled'${filter}
         )
        WHERE rn = 1
        GROUP BY product_id`,
    )
    .all(...(productIds ?? [])) as {
    product_id: number;
    last_cost: number | null;
    last_sale: number | null;
  }[];

  for (const row of rows) {
    map.set(row.product_id, {
      lastCostFils: row.last_cost ?? 0,
      lastSalePriceFils: row.last_sale ?? 0,
    });
  }
}

export function listProducts(db: SqliteDatabase, request: ProductListRequest): ProductDto[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (request.search !== undefined && request.search.length > 0) {
    clauses.push("(name LIKE ? OR sku LIKE ? OR barcode LIKE ?)");
    const like = `%${request.search}%`;
    params.push(like, like, like);
  }
  if (request.category !== undefined && request.category.length > 0) {
    clauses.push("category = ?");
    params.push(request.category);
  }
  if (request.onlyActive === true) {
    clauses.push("is_active = 1");
  }
  if (request.onlyLowStock === true) {
    clauses.push("quantity_milli <= ?");
    params.push(LOW_STOCK_MILLI);
  }

  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const limit = request.limit ?? 1000;

  const rows = db
    .prepare(`SELECT * FROM products${where} ORDER BY name LIMIT ?`)
    .all(...params, limit) as ProductRow[];

  const history = productCostHistory(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => mapProduct(row, history.get(row.id)));
}

export function getProduct(db: SqliteDatabase, id: number): ProductDto {
  const row = db.prepare("SELECT * FROM products WHERE id = ?").get(id) as ProductRow | undefined;
  if (row === undefined) throw new ProductError(`Item ${String(id)} was not found.`);
  const history = productCostHistory(db, [id]).get(id) ?? {
    lastCostFils: 0,
    lastSalePriceFils: 0,
  };
  return mapProduct(row, history);
}

/** Newest products, for the dashboard's short "Recent Products" table. */
export function listRecentProducts(db: SqliteDatabase, limit = 6): ProductDto[] {
  const rows = db
    .prepare("SELECT * FROM products ORDER BY id DESC LIMIT ?")
    .all(limit) as ProductRow[];
  const history = productCostHistory(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => mapProduct(row, history.get(row.id)));
}

/** The first few items that need reordering, for the dashboard's status card. */
export function listLowStockProducts(db: SqliteDatabase, limit = 3): ProductDto[] {
  const rows = db
    .prepare("SELECT * FROM products WHERE quantity_milli <= ? ORDER BY name LIMIT ?")
    .all(LOW_STOCK_MILLI, limit) as ProductRow[];
  return rows.map((row) => mapProduct(row));
}

/** Resolve a scanned barcode or a typed SKU to a product. */
export function findByCode(db: SqliteDatabase, code: string): ProductDto | null {
  const trimmed = code.trim();
  if (trimmed.length === 0) return null;

  const row = db
    .prepare(
      "SELECT * FROM products WHERE barcode = ? OR sku = ? COLLATE NOCASE ORDER BY is_active DESC, id LIMIT 1",
    )
    .get(trimmed, trimmed) as ProductRow | undefined;

  return row === undefined ? null : mapProduct(row);
}

export interface SaveProductInput {
  readonly id?: number;
  readonly sku?: string;
  readonly barcode?: string | null;
  readonly name: string;
  readonly description?: string | null;
  readonly category?: string | null;
  readonly subcategory?: string | null;
  readonly brand?: string | null;
  readonly unit?: string;
  readonly purchaseUnit?: string | null;
  readonly salesUnit?: string | null;
  readonly packSizeMilli?: number;
  readonly productType?: "simple" | "variant" | "rawMaterial" | "finishedGood" | "semiFinished" | "service" | "bundle";
  readonly parentId?: number | null;
  readonly variantLabel?: string | null;
  readonly preferredSupplierId?: number | null;
  readonly reorderLevelMilli?: number;
  readonly averageCostFils?: number;
  readonly salePriceFils?: number;
  readonly vatTreatment?: "standard" | "zero" | "exempt";
  readonly isActive?: boolean;
  /** Opening stock in milli-units. Creates an "opening" movement. */
  readonly openingQuantityMilli?: number;
  readonly imagePath?: string | null;
}

function nextSku(db: SqliteDatabase): string {
  const row = db
    .prepare(
      `SELECT sku FROM products WHERE sku LIKE 'ITM-%' ORDER BY LENGTH(sku) DESC, sku DESC LIMIT 1`,
    )
    .get() as { sku?: string } | undefined;

  const last = row?.sku === undefined ? 0 : Number.parseInt(row.sku.slice(4), 10);
  return `ITM-${String((Number.isFinite(last) ? last : 0) + 1).padStart(5, "0")}`;
}

function assertBarcodeFree(
  db: SqliteDatabase,
  barcode: string | null | undefined,
  exceptId: number | undefined,
): void {
  if (barcode === undefined || barcode === null || barcode.length === 0) return;

  const row = db
    .prepare("SELECT id, name FROM products WHERE barcode = ? AND id IS NOT ?")
    .get(barcode, exceptId ?? null) as { id?: number; name?: string } | undefined;

  if (row !== undefined) {
    throw new ProductError(`Barcode ${barcode} is already used by "${row.name ?? "another item"}".`);
  }
}

export function saveProduct(
  db: SqliteDatabase,
  actor: AuditActor,
  input: SaveProductInput,
  nowIso: string,
): ProductDto {
  return db.transaction((): ProductDto => {
    if (input.id !== undefined) {
      const before = db.prepare("SELECT * FROM products WHERE id = ?").get(input.id) as
        | Record<string, unknown>
        | undefined;
      if (before === undefined) throw new ProductError(`Item ${String(input.id)} was not found.`);

      assertBarcodeFree(db, input.barcode, input.id);

      db.prepare(
        `UPDATE products
            SET sku = COALESCE(?, sku),
                barcode = ?, name = ?, description = ?, category = ?, subcategory = ?,
                brand = ?, unit = COALESCE(?, unit), purchase_unit = ?, sales_unit = ?,
                pack_size_milli = COALESCE(?, pack_size_milli),
                product_type = COALESCE(?, product_type), parent_id = ?, variant_label = ?,
                preferred_supplier_id = ?, image_path = ?,
                reorder_level_milli = COALESCE(?, reorder_level_milli),
                average_cost_fils = COALESCE(?, average_cost_fils),
                sale_price_fils = COALESCE(?, sale_price_fils),
                vat_treatment = COALESCE(?, vat_treatment),
                is_active = COALESCE(?, is_active),
                updated_at = ?
          WHERE id = ?`,
      ).run(
        input.sku ?? null,
        input.barcode ?? null,
        input.name,
        input.description ?? null,
        input.category ?? null,
        input.subcategory ?? null,
        input.brand ?? null,
        input.unit ?? null,
        input.purchaseUnit ?? null,
        input.salesUnit ?? null,
        input.packSizeMilli ?? null,
        input.productType ?? null,
        input.parentId ?? null,
        input.variantLabel ?? null,
        input.preferredSupplierId ?? null,
        input.imagePath ?? null,
        input.reorderLevelMilli ?? null,
        input.averageCostFils ?? null,
        input.salePriceFils ?? null,
        input.vatTreatment ?? null,
        input.isActive === undefined ? null : input.isActive ? 1 : 0,
        nowIso,
        input.id,
      );

      recordAudit(
        db,
        actor,
        {
          module: "products",
          action: "update",
          entityType: "product",
          entityId: input.id,
          oldValues: before,
          newValues: input,
        },
        nowIso,
      );

      return getProduct(db, input.id);
    }

    assertBarcodeFree(db, input.barcode, undefined);

    const sku = input.sku !== undefined && input.sku.length > 0 ? input.sku : nextSku(db);

    const skuClash = db.prepare("SELECT id FROM products WHERE sku = ?").get(sku) as
      | { id?: number }
      | undefined;
    if (skuClash !== undefined) {
      throw new ProductError(`Item code ${sku} is already used. Choose another code.`);
    }

    const openingMilli = input.openingQuantityMilli ?? 0;
    const fiscalYear = Number.parseInt(nowIso.slice(0, 4), 10);
    const isService = input.productType === "service";

    const info = db
      .prepare(
        `INSERT INTO products
           (sku, barcode, name, description, category, subcategory, brand, unit,
            purchase_unit, sales_unit, pack_size_milli, product_type, parent_id,
            variant_label, preferred_supplier_id, image_path, quantity_milli,
            reorder_level_milli, average_cost_fils, sale_price_fils, vat_treatment,
            is_service, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sku,
        input.barcode ?? null,
        input.name,
        input.description ?? null,
        input.category ?? null,
        input.subcategory ?? null,
        input.brand ?? null,
        input.unit ?? "pcs",
        input.purchaseUnit ?? null,
        input.salesUnit ?? null,
        input.packSizeMilli ?? 1000,
        input.productType ?? "simple",
        input.parentId ?? null,
        input.variantLabel ?? null,
        input.preferredSupplierId ?? null,
        input.imagePath ?? null,
        openingMilli,
        input.reorderLevelMilli ?? 0,
        input.averageCostFils ?? 0,
        input.salePriceFils ?? 0,
        input.vatTreatment ?? "standard",
        isService ? 1 : 0,
        input.isActive === false ? 0 : 1,
        nowIso,
        nowIso,
      );

    const id = Number(info.lastInsertRowid);

    // Opening stock is a movement like any other, so the stock figure is the
    // sum of the movement ledger rather than a stored number. The opening
    // movement carries no cost: the form does not ask for one, and a product
    // bought later gets its "last cost" from that purchase.
    if (openingMilli !== 0) {
      db.prepare(
        `INSERT INTO stock_movements
           (product_id, document_id, document_line_id, movement_date, kind, quantity_milli,
            unit_cost_fils, cost_fils, fiscal_year, notes, location_id, stock_status)
         VALUES (?, NULL, NULL, ?, 'opening', ?, ?, ?, ?, 'Opening stock', ?, 'available')`,
      ).run(
        id,
        todayIso(),
        openingMilli,
        input.averageCostFils ?? 0,
        Math.round((openingMilli * (input.averageCostFils ?? 0)) / 1000),
        fiscalYear,
        defaultLocationId(db),
      );
    }

    recordAudit(
      db,
      actor,
      { module: "products", action: "create", entityType: "product", entityId: id, newValues: input },
      nowIso,
    );

    return getProduct(db, id);
  })();
}

/**
 * Correct the physical count.
 *
 * Written as a stock adjustment movement rather than a direct quantity update,
 * so the movement history explains where every quantity came from. This is the
 * single way stock is corrected by hand.
 */
export function setOpeningStock(
  db: SqliteDatabase,
  actor: AuditActor,
  input: { productId: number; quantityMilli: number; unitCostFils: number; notes?: string },
  nowIso: string,
): ProductDto {
  const date = todayIso();

  return db.transaction((): ProductDto => {
    const product = getProduct(db, input.productId);

    const delta = input.quantityMilli - product.quantityMilli;

    db.prepare(
      `INSERT INTO stock_movements
         (product_id, document_id, document_line_id, movement_date, kind, quantity_milli,
          unit_cost_fils, cost_fils, fiscal_year, notes, location_id, stock_status)
       VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'available')`,
    ).run(
      input.productId,
      date,
      delta >= 0 ? "adjustmentIn" : "adjustmentOut",
      delta,
      input.unitCostFils,
      Math.round((delta * input.unitCostFils) / 1000),
      Number.parseInt(date.slice(0, 4), 10),
      input.notes ?? "Stock count",
      defaultLocationId(db),
    );

    // A count sets the cost basis to the unit cost entered with it: no
    // weighted average is computed any more, the entered cost simply becomes
    // the product's reference cost.
    if (input.unitCostFils > 0) {
      db.prepare("UPDATE products SET average_cost_fils = ?, updated_at = ? WHERE id = ?").run(
        input.unitCostFils,
        nowIso,
        input.productId,
      );
    }

    recordAudit(
      db,
      actor,
      {
        module: "inventory",
        action: "adjust",
        entityType: "product",
        entityId: input.productId,
        oldValues: { quantityMilli: product.quantityMilli, averageCostFils: product.averageCostFils },
        newValues: { quantityMilli: input.quantityMilli, averageCostFils: input.unitCostFils },
      },
      nowIso,
    );

    return getProduct(db, input.productId);
  })();
}

export function listMovements(db: SqliteDatabase, request: StockMovementRequest): StockMovementDto[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (request.productId !== undefined) {
    clauses.push("sm.product_id = ?");
    params.push(request.productId);
  }
  if (request.fromDate !== undefined) {
    clauses.push("sm.movement_date >= ?");
    params.push(request.fromDate);
  }
  if (request.toDate !== undefined) {
    clauses.push("sm.movement_date <= ?");
    params.push(request.toDate);
  }
  if (request.kind !== undefined) {
    clauses.push("sm.kind = ?");
    params.push(request.kind);
  }

  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const limit = request.limit ?? 500;

  const rows = db
    .prepare(
      `SELECT sm.*, p.name AS product_name, d.number AS document_number
          FROM stock_movements sm
          JOIN products p ON p.id = sm.product_id
          LEFT JOIN documents d ON d.id = sm.document_id
          ${where}
         ORDER BY sm.movement_date DESC, sm.id DESC
         LIMIT ?`,
    )
    .all(...params, limit) as {
    id: number;
    product_id: number;
    product_name: string;
    document_number: string | null;
    movement_date: string;
    kind: StockMovementDto["kind"];
    quantity_milli: number;
    unit_cost_fils: number;
    cost_fils: number;
    notes: string | null;
  }[];

  return rows.map((row) => ({
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    documentNumber: row.document_number,
    movementDate: row.movement_date,
    kind: row.kind,
    quantityMilli: row.quantity_milli,
    unitCostFils: row.unit_cost_fils,
    costFils: row.cost_fils,
    notes: row.notes,
  }));
}

/** Distinct categories, for the products filter. */
export function listCategories(db: SqliteDatabase): string[] {
  const rows = db
    .prepare(
      "SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category <> '' ORDER BY category",
    )
    .all() as { category: string }[];
  return rows.map((row) => row.category);
}

/**
 * Delete a product that has never been used.
 *
 * A product with stock movements or invoice lines behind it cannot be removed:
 * the stock history and the invoices would point at nothing, and the stock
 * figures would no longer add up. The caller is told to deactivate the item
 * instead, which keeps it out of the pickers while leaving the history intact.
 */
export function deleteProduct(
  db: SqliteDatabase,
  actor: AuditActor,
  id: number,
  nowIso: string,
): void {
  db.transaction(() => {
    const row = db.prepare("SELECT id, name FROM products WHERE id = ?").get(id) as
      | { id: number; name: string }
      | undefined;

    if (row === undefined) throw new ProductError(`Item ${String(id)} was not found.`);

    const movements = db
      .prepare("SELECT COUNT(*) AS count FROM stock_movements WHERE product_id = ?")
      .get(id) as { count: number };

    const lines = db
      .prepare("SELECT COUNT(*) AS count FROM document_lines WHERE product_id = ?")
      .get(id) as { count: number };

    if (movements.count > 0 || lines.count > 0) {
      throw new ProductError(
        `"${row.name}" has stock history or invoices against it, so it cannot be deleted. ` +
          "Mark it inactive instead - it will disappear from the pickers and the history stays intact.",
      );
    }

    db.prepare("DELETE FROM products WHERE id = ?").run(id);

    recordAudit(
      db,
      actor,
      { module: "products", action: "delete", entityType: "product", entityId: id },
      nowIso,
    );
  })();
}

export function formatQuantity(milli: number): string {
  const units = fromMilliQty(milli);
  return Number.isInteger(units) ? String(units) : String(toMilliQty(units) / 1000);
}
