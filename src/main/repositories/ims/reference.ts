/**
 * IMS reference data, product detail, pricing and configuration.
 *
 * These are the small masters a shop edits from the screens: locations,
 * brands, units, categories, price lists and the operational settings. The
 * product detail read is the one place the product page assembles its stock,
 * movement, pricing and supplier history.
 */

import type { SqliteDatabase } from "../../../data/connection";
import type {
  BrandDto,
  CategoryDto,
  ImsConfigDto,
  ImsConfigPatch,
  ImsLocationDto,
  ImsReferenceDto,
  PriceListItemDto,
  PriceListDto,
  ProductDetailDto,
  ResolvedPriceDto,
  SaveLocationRequest,
  SavePriceItemRequest,
  SavePriceListRequest,
  SaveVariantRequest,
  UnitDto,
  VariantRow,
  VariantListRequest,
} from "../../../shared/ims";
import type { VatTreatment } from "../../../shared/types";
import { recordAudit, type AuditActor } from "../../audit-writer";
import { postMovement, defaultLocationId, type StockContext } from "./stock";
import {
  listBatches,
  listSerials,
  locationRows,
  productLocationRows,
} from "./queries";

export class ImsReferenceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ImsReferenceError";
  }
}

const BOOL_KEYS = new Set([
  "requireBatchOnReceipt",
  "requireSerialOnReceipt",
  "allowQuarantineRestock",
  "salesApprovalRequired",
  "allowBackorder",
]);

const INT_KEYS = new Set([
  "purchaseApprovalThresholdFils",
  "returnPolicyDays",
  "defaultLocationId",
]);

export function readConfig(db: SqliteDatabase): ImsConfigDto {
  const rows = db.prepare("SELECT key, value FROM ims_config").all() as {
    key: string;
    value: string;
  }[];
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const bool = (key: string, fallback: boolean): boolean => {
    const value = values.get(key);
    if (value === undefined) return fallback;
    return value === "1" || value.toLowerCase() === "true";
  };
  const int = (key: string, fallback: number): number => {
    const value = Number.parseInt(values.get(key) ?? "", 10);
    return Number.isFinite(value) ? value : fallback;
  };
  const text = (key: string, fallback: string): string => values.get(key) ?? fallback;

  return {
    negativeStockPolicy: text("negativeStockPolicy", "block") === "allow" ? "allow" : "block",
    valuationMethod:
      text("valuationMethod", "lastCost") === "weightedAverage"
        ? "weightedAverage"
        : text("valuationMethod", "lastCost") === "fifo"
          ? "fifo"
          : "lastCost",
    barcodePrefix: text("barcodePrefix", "EY"),
    skuPrefix: text("skuPrefix", "ITM"),
    purchaseApprovalThresholdFils: int("purchaseApprovalThresholdFils", 0),
    salesDiscountLimitPercent: Number(values.get("salesDiscountLimitPercent") ?? 100),
    returnPolicyDays: int("returnPolicyDays", 30),
    requireBatchOnReceipt: bool("requireBatchOnReceipt", false),
    requireSerialOnReceipt: bool("requireSerialOnReceipt", false),
    allowQuarantineRestock: bool("allowQuarantineRestock", false),
    defaultLocationId: int("defaultLocationId", defaultLocationId(db)),
    salesApprovalRequired: bool("salesApprovalRequired", false),
    allowBackorder: bool("allowBackorder", false),
  };
}

export function updateConfig(
  db: SqliteDatabase,
  actor: AuditActor,
  patch: ImsConfigPatch,
  nowIso: string,
): ImsConfigDto {
  return db.transaction((): ImsConfigDto => {
    if (patch.defaultLocationId !== undefined && patch.defaultLocationId !== null) {
      const location = db
        .prepare("SELECT id FROM ims_locations WHERE id = ? AND is_active = 1")
        .get(patch.defaultLocationId);
      if (location === undefined) {
        throw new ImsReferenceError("The default stock location was not found.");
      }
    }

    const statement = db.prepare(
      `INSERT INTO ims_config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      const stored = typeof value === "boolean" ? (value ? "1" : "0") : String(value ?? "");
      if (BOOL_KEYS.has(key) && typeof value !== "boolean") continue;
      if (INT_KEYS.has(key) && value !== null && typeof value !== "number") continue;
      statement.run(key, stored, nowIso);
    }

    if (patch.defaultLocationId !== undefined && patch.defaultLocationId !== null) {
      db.prepare("UPDATE ims_locations SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END").run(
        patch.defaultLocationId,
      );
    }

    recordAudit(
      db,
      actor,
      {
        module: "settings",
        action: "update",
        entityType: "imsConfig",
        entityId: "ims",
        newValues: patch,
      },
      nowIso,
    );

    return readConfig(db);
  })();
}

export function listLocations(db: SqliteDatabase): ImsLocationDto[] {
  return locationRows(db).map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type as ImsLocationDto["type"],
    address: null,
    isDefault: row.is_default === 1,
    isActive: row.is_active === 1,
  }));
}

export function saveLocation(
  db: SqliteDatabase,
  actor: AuditActor,
  input: SaveLocationRequest,
  nowIso: string,
): ImsLocationDto[] {
  db.transaction(() => {
    if (input.id === undefined) {
      const info = db
        .prepare(
          `INSERT INTO ims_locations (code, name, type, address, is_default, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.code.toUpperCase(),
          input.name,
          input.type,
          input.address ?? null,
          input.isDefault === true ? 1 : 0,
          input.isActive === false ? 0 : 1,
          nowIso,
          nowIso,
        );
      if (input.isDefault === true) {
        const id = Number(info.lastInsertRowid);
        db.prepare("UPDATE ims_locations SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END").run(id);
      }
    } else {
      db.prepare(
        `UPDATE ims_locations SET code = ?, name = ?, type = ?, address = ?, is_active = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        input.code.toUpperCase(),
        input.name,
        input.type,
        input.address ?? null,
        input.isActive === false ? 0 : 1,
        nowIso,
        input.id,
      );
      if (input.isDefault === true) {
        db.prepare("UPDATE ims_locations SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END").run(
          input.id,
        );
      }
    }

    recordAudit(
      db,
      actor,
      {
        module: "settings",
        action: input.id === undefined ? "create" : "update",
        entityType: "imsLocation",
        entityId: input.id ?? input.code,
        newValues: input,
      },
      nowIso,
    );
  })();
  return listLocations(db);
}

export function listBrands(db: SqliteDatabase): BrandDto[] {
  const rows = db
    .prepare(
      `SELECT b.id, b.name, b.is_active,
              (SELECT COUNT(*) FROM products p WHERE p.brand = b.name) AS product_count
         FROM ims_brands b ORDER BY b.name`,
    )
    .all() as { id: number; name: string; is_active: number; product_count: number }[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    isActive: row.is_active === 1,
    productCount: row.product_count,
  }));
}

export function saveBrand(
  db: SqliteDatabase,
  actor: AuditActor,
  input: { id?: number; name: string; isActive?: boolean },
  nowIso: string,
): BrandDto {
  return db.transaction((): BrandDto => {
    if (input.id === undefined) {
      const info = db
        .prepare("INSERT INTO ims_brands (name, is_active, created_at) VALUES (?, ?, ?)")
        .run(input.name, input.isActive === false ? 0 : 1, nowIso);
      const id = Number(info.lastInsertRowid);
      return listBrands(db).find((brand) => brand.id === id) as BrandDto;
    }
    db.prepare("UPDATE ims_brands SET name = ?, is_active = ? WHERE id = ?").run(
      input.name,
      input.isActive === false ? 0 : 1,
      input.id,
    );
    recordAudit(
      db,
      actor,
      { module: "products", action: "update", entityType: "imsBrand", entityId: input.id },
      nowIso,
    );
    return listBrands(db).find((brand) => brand.id === input.id) as BrandDto;
  })();
}

export function listUnits(db: SqliteDatabase): UnitDto[] {
  const rows = db
    .prepare(
      `SELECT u.id, u.code, u.name, u.base_code, u.factor_milli, u.is_active,
              (SELECT COUNT(*) FROM products p WHERE p.unit = u.code) AS product_count
         FROM ims_units u ORDER BY u.name`,
    )
    .all() as {
    id: number;
    code: string;
    name: string;
    base_code: string | null;
    factor_milli: number;
    is_active: number;
    product_count: number;
  }[];
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    baseCode: row.base_code,
    factorMilli: row.factor_milli,
    isActive: row.is_active === 1,
    productCount: row.product_count,
  }));
}

export function saveUnit(
  db: SqliteDatabase,
  actor: AuditActor,
  input: {
    id?: number;
    code: string;
    name: string;
    baseCode?: string | null;
    factorMilli: number;
    isActive?: boolean;
  },
  nowIso: string,
): UnitDto {
  return db.transaction((): UnitDto => {
    let id = input.id;
    if (id === undefined) {
      const info = db
        .prepare(
          "INSERT INTO ims_units (code, name, base_code, factor_milli, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.code.toLowerCase(),
          input.name,
          input.baseCode ?? null,
          input.factorMilli,
          input.isActive === false ? 0 : 1,
          nowIso,
        );
      id = Number(info.lastInsertRowid);
    } else {
      db.prepare(
        "UPDATE ims_units SET code = ?, name = ?, base_code = ?, factor_milli = ?, is_active = ? WHERE id = ?",
      ).run(
        input.code.toLowerCase(),
        input.name,
        input.baseCode ?? null,
        input.factorMilli,
        input.isActive === false ? 0 : 1,
        id,
      );
    }
    recordAudit(
      db,
      actor,
      { module: "products", action: input.id === undefined ? "create" : "update", entityType: "imsUnit", entityId: id },
      nowIso,
    );
    return listUnits(db).find((unit) => unit.id === id) as UnitDto;
  })();
}

export function listCategories(db: SqliteDatabase): CategoryDto[] {
  const rows = db
    .prepare(
      `SELECT COALESCE(NULLIF(category, ''), 'Uncategorised') AS name,
              COUNT(*) AS product_count,
              COALESCE(SUM(ROUND(quantity_milli * average_cost_fils / 1000.0)), 0) AS value
         FROM products WHERE is_service = 0
        GROUP BY COALESCE(NULLIF(category, ''), 'Uncategorised')
        ORDER BY name`,
    )
    .all() as { name: string; product_count: number; value: number }[];
  return rows.map((row) => ({
    name: row.name,
    productCount: row.product_count,
    valueFils: Math.round(row.value),
  }));
}

export function renameCategory(
  db: SqliteDatabase,
  actor: AuditActor,
  from: string,
  to: string,
  nowIso: string,
): CategoryDto[] {
  const result = db
    .prepare("UPDATE products SET category = ?, updated_at = ? WHERE category = ?")
    .run(to, nowIso, from);
  if (result.changes === 0) throw new ImsReferenceError(`No products are in "${from}".`);
  recordAudit(
    db,
    actor,
    {
      module: "products",
      action: "update",
      entityType: "productCategory",
      entityId: from,
      oldValues: { category: from },
      newValues: { category: to },
    },
    nowIso,
  );
  return listCategories(db);
}

export function listPriceLists(db: SqliteDatabase): PriceListDto[] {
  const rows = db
    .prepare(
      `SELECT pl.*, p.name AS party_name,
              (SELECT COUNT(*) FROM ims_price_list_items i WHERE i.price_list_id = pl.id) AS item_count
         FROM ims_price_lists pl LEFT JOIN parties p ON p.id = pl.party_id
        ORDER BY pl.kind, pl.name`,
    )
    .all() as {
    id: number;
    name: string;
    kind: PriceListDto["kind"];
    party_id: number | null;
    party_name: string | null;
    is_active: number;
    item_count: number;
  }[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    partyId: row.party_id,
    partyName: row.party_name,
    isActive: row.is_active === 1,
    itemCount: row.item_count,
  }));
}

export function savePriceList(
  db: SqliteDatabase,
  actor: AuditActor,
  input: SavePriceListRequest,
  nowIso: string,
): PriceListDto[] {
  db.transaction(() => {
    if (input.id === undefined) {
      db.prepare(
        `INSERT INTO ims_price_lists (name, kind, party_id, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(input.name, input.kind, input.partyId ?? null, input.isActive === false ? 0 : 1, nowIso, nowIso);
    } else {
      db.prepare(
        "UPDATE ims_price_lists SET name = ?, kind = ?, party_id = ?, is_active = ?, updated_at = ? WHERE id = ?",
      ).run(
        input.name,
        input.kind,
        input.partyId ?? null,
        input.isActive === false ? 0 : 1,
        nowIso,
        input.id,
      );
    }
    recordAudit(
      db,
      actor,
      {
        module: "products",
        action: input.id === undefined ? "create" : "update",
        entityType: "imsPriceList",
        entityId: input.id ?? input.name,
      },
      nowIso,
    );
  })();
  return listPriceLists(db);
}

export function listPriceItems(db: SqliteDatabase, priceListId: number): PriceListItemDto[] {
  const rows = db
    .prepare(
      `SELECT i.*, p.name AS product_name, p.sku
         FROM ims_price_list_items i JOIN products p ON p.id = i.product_id
        WHERE i.price_list_id = ? ORDER BY p.name`,
    )
    .all(priceListId) as {
    id: number;
    price_list_id: number;
    product_id: number;
    product_name: string;
    sku: string;
    price_fils: number;
    min_quantity_milli: number;
    discount_limit_percent: number;
    effective_from: string | null;
    effective_to: string | null;
  }[];
  return rows.map((row) => ({
    id: row.id,
    priceListId: row.price_list_id,
    productId: row.product_id,
    productName: row.product_name,
    sku: row.sku,
    priceFils: row.price_fils,
    minQuantityMilli: row.min_quantity_milli,
    discountLimitPercent: row.discount_limit_percent,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  }));
}

export function savePriceItem(
  db: SqliteDatabase,
  actor: AuditActor,
  input: SavePriceItemRequest,
  nowIso: string,
): PriceListItemDto[] {
  db.transaction(() => {
    if (input.id === undefined) {
      db.prepare(
        `INSERT INTO ims_price_list_items
           (price_list_id, product_id, price_fils, min_quantity_milli, discount_limit_percent,
            effective_from, effective_to)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.priceListId,
        input.productId,
        input.priceFils,
        input.minQuantityMilli ?? 1000,
        input.discountLimitPercent ?? 0,
        input.effectiveFrom ?? null,
        input.effectiveTo ?? null,
      );
    } else {
      db.prepare(
        `UPDATE ims_price_list_items
            SET price_fils = ?, min_quantity_milli = ?, discount_limit_percent = ?,
                effective_from = ?, effective_to = ?
          WHERE id = ?`,
      ).run(
        input.priceFils,
        input.minQuantityMilli ?? 1000,
        input.discountLimitPercent ?? 0,
        input.effectiveFrom ?? null,
        input.effectiveTo ?? null,
        input.id,
      );
    }
    recordAudit(
      db,
      actor,
      { module: "products", action: input.id === undefined ? "create" : "update", entityType: "imsPriceItem", entityId: input.id ?? input.productId },
      nowIso,
    );
  })();
  return listPriceItems(db, input.priceListId);
}

export function deletePriceItem(
  db: SqliteDatabase,
  actor: AuditActor,
  id: number,
  nowIso: string,
): { ok: true } {
  const row = db.prepare("SELECT price_list_id FROM ims_price_list_items WHERE id = ?").get(id) as
    | { price_list_id: number }
    | undefined;
  if (row === undefined) throw new ImsReferenceError("That price was not found.");
  db.prepare("DELETE FROM ims_price_list_items WHERE id = ?").run(id);
  recordAudit(
    db,
    actor,
    { module: "products", action: "delete", entityType: "imsPriceItem", entityId: id },
    nowIso,
  );
  return { ok: true };
}

export function resolvePrice(
  db: SqliteDatabase,
  input: { productId: number; partyId?: number | null; quantityMilli?: number; date?: string },
): ResolvedPriceDto {
  const quantity = input.quantityMilli ?? 1000;
  const date = input.date ?? new Date().toISOString().slice(0, 10);

  const listIds: number[] = [];
  if (input.partyId !== undefined && input.partyId !== null) {
    const customerList = db
      .prepare("SELECT id FROM ims_price_lists WHERE party_id = ? AND is_active = 1 LIMIT 1")
      .get(input.partyId) as { id: number } | undefined;
    if (customerList !== undefined) listIds.push(customerList.id);
  }

  const defaultList = db
    .prepare("SELECT id, name FROM ims_price_lists WHERE kind = 'retail' AND is_active = 1 ORDER BY id LIMIT 1")
    .get() as { id: number; name: string } | undefined;
  if (defaultList !== undefined) listIds.push(defaultList.id);

  for (const listId of listIds) {
    const item = db
      .prepare(
        `SELECT i.*, pl.name FROM ims_price_list_items i
           JOIN ims_price_lists pl ON pl.id = i.price_list_id
          WHERE i.price_list_id = ? AND i.product_id = ?
            AND i.min_quantity_milli <= ?
            AND (i.effective_from IS NULL OR i.effective_from <= ?)
            AND (i.effective_to IS NULL OR i.effective_to >= ?)
          ORDER BY i.min_quantity_milli DESC, i.id DESC LIMIT 1`,
      )
      .get(listId, input.productId, quantity, date, date) as
      | {
          price_fils: number;
          price_list_id: number;
          name: string;
          min_quantity_milli: number;
          discount_limit_percent: number;
        }
      | undefined;
    if (item !== undefined) {
      return {
        productId: input.productId,
        priceFils: item.price_fils,
        priceListId: item.price_list_id,
        priceListName: item.name,
        minQuantityMilli: item.min_quantity_milli,
        discountLimitPercent: item.discount_limit_percent,
        source: "priceList",
      };
    }
  }

  const product = db.prepare("SELECT sale_price_fils FROM products WHERE id = ?").get(input.productId) as
    | { sale_price_fils: number }
    | undefined;
  if (product === undefined) throw new ImsReferenceError("That product was not found.");
  return {
    productId: input.productId,
    priceFils: product.sale_price_fils,
    priceListId: null,
    priceListName: null,
    minQuantityMilli: 1000,
    discountLimitPercent: 0,
    source: "product",
  };
}

export function referenceData(db: SqliteDatabase): ImsReferenceDto {
  return {
    locations: listLocations(db),
    brands: listBrands(db),
    units: listUnits(db),
    categories: listCategories(db),
    priceLists: listPriceLists(db),
    config: readConfig(db),
  };
}

/* -------------------------------------------------------------------------- */
/* product detail and variants                                                */
/* -------------------------------------------------------------------------- */

interface DetailProductRow {
  readonly id: number;
  readonly sku: string;
  readonly barcode: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly category: string | null;
  readonly subcategory: string | null;
  readonly brand: string | null;
  readonly unit: string;
  readonly purchase_unit: string | null;
  readonly sales_unit: string | null;
  readonly pack_size_milli: number;
  readonly product_type: string;
  readonly parent_id: number | null;
  readonly variant_label: string | null;
  readonly quantity_milli: number;
  readonly reorder_level_milli: number;
  readonly average_cost_fils: number;
  readonly sale_price_fils: number;
  readonly vat_treatment: VatTreatment;
  readonly is_active: number;
  readonly preferred_supplier_id: number | null;
  readonly preferred_supplier_name: string | null;
}

export function productDetail(db: SqliteDatabase, id: number): ProductDetailDto {
  const product = db
    .prepare(
      `SELECT p.*, s.name AS preferred_supplier_name
         FROM products p LEFT JOIN parties s ON s.id = p.preferred_supplier_id
        WHERE p.id = ?`,
    )
    .get(id) as DetailProductRow | undefined;
  if (product === undefined) throw new ImsReferenceError(`Item ${String(id)} was not found.`);

  const variants = db
    .prepare(
      `SELECT id, sku, name, variant_label, quantity_milli, sale_price_fils, is_active
         FROM products WHERE parent_id = ? ORDER BY variant_label, name`,
    )
    .all(id) as {
    id: number;
    sku: string;
    name: string;
    variant_label: string | null;
    quantity_milli: number;
    sale_price_fils: number;
    is_active: number;
  }[];

  const pricing = db
    .prepare(
      `SELECT pl.name AS price_list_name, i.price_fils, i.min_quantity_milli,
              i.effective_from, i.effective_to
         FROM ims_price_list_items i JOIN ims_price_lists pl ON pl.id = i.price_list_id
        WHERE i.product_id = ? ORDER BY pl.name, i.min_quantity_milli`,
    )
    .all(id) as {
    price_list_name: string;
    price_fils: number;
    min_quantity_milli: number;
    effective_from: string | null;
    effective_to: string | null;
  }[];

  const purchases = db
    .prepare(
      `SELECT d.id, d.number, d.issue_date, pa.name AS party_name,
              dl.quantity_milli, dl.unit_price_fils
         FROM document_lines dl JOIN documents d ON d.id = dl.document_id
         LEFT JOIN parties pa ON pa.id = d.party_id
        WHERE dl.product_id = ? AND d.kind = 'purchaseInvoice' AND d.status <> 'cancelled'
        ORDER BY d.issue_date DESC, d.id DESC LIMIT 20`,
    )
    .all(id) as {
    id: number;
    number: string;
    issue_date: string;
    party_name: string | null;
    quantity_milli: number;
    unit_price_fils: number;
  }[];

  const sales = db
    .prepare(
      `SELECT d.id, d.number, d.issue_date, pa.name AS party_name,
              dl.quantity_milli, dl.unit_price_fils
         FROM document_lines dl JOIN documents d ON d.id = dl.document_id
         LEFT JOIN parties pa ON pa.id = d.party_id
        WHERE dl.product_id = ? AND d.kind = 'invoice' AND d.status <> 'cancelled'
        ORDER BY d.issue_date DESC, d.id DESC LIMIT 20`,
    )
    .all(id) as {
    id: number;
    number: string;
    issue_date: string;
    party_name: string | null;
    quantity_milli: number;
    unit_price_fils: number;
  }[];

  const suppliers = db
    .prepare(
      `SELECT pa.id, pa.name, MAX(d.issue_date) AS last_purchase_date,
              (SELECT dl2.unit_price_fils FROM document_lines dl2
                 JOIN documents d2 ON d2.id = dl2.document_id
                WHERE dl2.product_id = ? AND d2.party_id = pa.id AND d2.kind = 'purchaseInvoice'
                ORDER BY d2.issue_date DESC, d2.id DESC LIMIT 1) AS last_cost
         FROM parties pa
         JOIN documents d ON d.party_id = pa.id
         JOIN document_lines dl ON dl.document_id = d.id AND dl.product_id = ?
        WHERE d.kind = 'purchaseInvoice' AND d.status <> 'cancelled'
        GROUP BY pa.id
        ORDER BY last_purchase_date DESC`,
    )
    .all(id, id) as { id: number; name: string; last_purchase_date: string; last_cost: number | null }[];

  const movements = db
    .prepare(
      `SELECT sm.id, sm.movement_date, sm.kind, sm.quantity_milli, sm.unit_cost_fils,
              sm.cost_fils, l.name AS location_name, sm.source_kind, sm.batch_no, sm.notes,
              COALESCE(ims.number, d.number) AS source_number
         FROM stock_movements sm
         LEFT JOIN ims_locations l ON l.id = sm.location_id
         LEFT JOIN documents d ON d.id = sm.document_id
         LEFT JOIN ims_documents ims ON ims.id = sm.source_id AND ims.kind = sm.source_kind
        WHERE sm.product_id = ?
        ORDER BY sm.movement_date DESC, sm.id DESC LIMIT 50`,
    )
    .all(id) as {
    id: number;
    movement_date: string;
    kind: string;
    quantity_milli: number;
    unit_cost_fils: number;
    cost_fils: number;
    location_name: string | null;
    source_kind: string | null;
    batch_no: string | null;
    notes: string | null;
    source_number: string | null;
  }[];

  const activity = db
    .prepare(
      `SELECT occurred_at, actor_name, action, module FROM audit_log
        WHERE entity_type IN ('product','imsDocument','document') AND entity_id = ?
        ORDER BY occurred_at DESC LIMIT 20`,
    )
    .all(String(id)) as { occurred_at: string; actor_name: string; action: string; module: string }[];

  return {
    product: {
      id: product.id,
      sku: product.sku,
      barcode: product.barcode,
      name: product.name,
      description: product.description,
      category: product.category,
      subcategory: product.subcategory,
      brand: product.brand,
      unit: product.unit,
      purchaseUnit: product.purchase_unit,
      salesUnit: product.sales_unit,
      packSizeMilli: product.pack_size_milli,
      productType: product.product_type,
      parentId: product.parent_id,
      variantLabel: product.variant_label,
      quantityMilli: product.quantity_milli,
      reorderLevelMilli: product.reorder_level_milli,
      averageCostFils: product.average_cost_fils,
      salePriceFils: product.sale_price_fils,
      vatTreatment: product.vat_treatment,
      isActive: product.is_active === 1,
      preferredSupplierId: product.preferred_supplier_id,
      preferredSupplierName: product.preferred_supplier_name,
    },
    variants: variants.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      name: variant.name,
      variantLabel: variant.variant_label,
      quantityMilli: variant.quantity_milli,
      salePriceFils: variant.sale_price_fils,
      isActive: variant.is_active === 1,
    })),
    stockByLocation: productLocationRows(db, id),
    pricing: pricing.map((row) => ({
      priceListName: row.price_list_name,
      priceFils: row.price_fils,
      minQuantityMilli: row.min_quantity_milli,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
    })),
    purchases: purchases.map((row) => ({
      id: row.id,
      number: row.number,
      issueDate: row.issue_date,
      partyName: row.party_name,
      quantityMilli: row.quantity_milli,
      unitPriceFils: row.unit_price_fils,
    })),
    sales: sales.map((row) => ({
      id: row.id,
      number: row.number,
      issueDate: row.issue_date,
      partyName: row.party_name,
      quantityMilli: row.quantity_milli,
      unitPriceFils: row.unit_price_fils,
    })),
    suppliers: suppliers.map((row) => ({
      id: row.id,
      name: row.name,
      lastCostFils: row.last_cost ?? 0,
      lastPurchaseDate: row.last_purchase_date,
    })),
    movements: movements.map((row) => ({
      id: row.id,
      movementDate: row.movement_date,
      kind: row.kind,
      quantityMilli: row.quantity_milli,
      unitCostFils: row.unit_cost_fils,
      costFils: row.cost_fils,
      locationName: row.location_name,
      sourceKind: row.source_kind,
      sourceNumber: row.source_number,
      batchNo: row.batch_no,
      notes: row.notes,
    })),
    batches: listBatches(db, { search: product.sku, limit: 100 }).filter(
      (batch) => batch.productId === id,
    ),
    serials: listSerials(db, { search: product.sku, limit: 100 }).filter(
      (serial) => serial.productId === id,
    ),
    activity: activity.map((row) => ({
      occurredAt: row.occurred_at,
      actorName: row.actor_name,
      action: row.action,
      module: row.module,
    })),
  };
}

export function listVariants(
  db: SqliteDatabase,
  request: VariantListRequest,
): VariantRow[] {
  const clauses: string[] = ["p.product_type = 'variant'"];
  const params: (string | number)[] = [];
  if (request.parentId !== undefined) {
    clauses.push("p.parent_id = ?");
    params.push(request.parentId);
  }
  if (request.search !== undefined && request.search.trim() !== "") {
    clauses.push("(p.name LIKE ? OR p.sku LIKE ? OR p.variant_label LIKE ?)");
    const like = `%${request.search.trim()}%`;
    params.push(like, like, like);
  }
  const rows = db
    .prepare(
      `SELECT p.id, p.parent_id, parent.name AS parent_name, p.sku, p.name,
              p.variant_label, p.barcode, p.quantity_milli, p.sale_price_fils, p.is_active
         FROM products p LEFT JOIN products parent ON parent.id = p.parent_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY parent.name, p.variant_label, p.name LIMIT ?`,
    )
    .all(...params, request.limit ?? 500) as {
    id: number;
    parent_id: number | null;
    parent_name: string | null;
    sku: string;
    name: string;
    variant_label: string | null;
    barcode: string | null;
    quantity_milli: number;
    sale_price_fils: number;
    is_active: number;
  }[];
  return rows.map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    parentName: row.parent_name,
    sku: row.sku,
    name: row.name,
    variantLabel: row.variant_label,
    barcode: row.barcode,
    quantityMilli: row.quantity_milli,
    salePriceFils: row.sale_price_fils,
    isActive: row.is_active === 1,
  }));
}

export function saveVariant(
  db: SqliteDatabase,
  actor: AuditActor,
  input: SaveVariantRequest,
  nowIso: string,
  allowNegativeStock = false,
): VariantRow {
  return db.transaction((): VariantRow => {
    const parent = db.prepare("SELECT * FROM products WHERE id = ?").get(input.parentId) as
      | DetailProductRow
      | undefined;
    if (parent === undefined) throw new ImsReferenceError("The parent product was not found.");

    let id = input.id;
    if (id === undefined) {
      const sku =
        input.sku !== undefined && input.sku.length > 0
          ? input.sku
          : nextVariantSku(db, parent.sku, input.variantLabel);
      const clash = db.prepare("SELECT id FROM products WHERE sku = ?").get(sku);
      if (clash !== undefined) throw new ImsReferenceError(`Item code ${sku} is already used.`);

      const info = db
        .prepare(
          `INSERT INTO products
             (sku, barcode, name, description, category, subcategory, brand, unit,
              quantity_milli, reorder_level_milli, average_cost_fils, sale_price_fils,
              vat_treatment, is_service, is_active, created_at, updated_at,
              product_type, parent_id, variant_label, purchase_unit, sales_unit,
              pack_size_milli, preferred_supplier_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, ?, ?, ?, 'variant', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sku,
          input.barcode ?? null,
          input.name ?? `${parent.name} - ${input.variantLabel}`,
          parent.description,
          parent.category,
          parent.subcategory,
          parent.brand,
          parent.unit,
          parent.reorder_level_milli,
          parent.average_cost_fils,
          input.salePriceFils ?? parent.sale_price_fils,
          parent.vat_treatment,
          input.isActive === false ? 0 : 1,
          nowIso,
          nowIso,
          parent.id,
          input.variantLabel,
          parent.purchase_unit,
          parent.sales_unit,
          parent.pack_size_milli,
          parent.preferred_supplier_id,
        );
      id = Number(info.lastInsertRowid);

      const opening = input.openingQuantityMilli ?? 0;
      if (opening !== 0) {
        const context: StockContext = {
          db,
          actorName: actor.name,
          nowIso,
          nowDate: nowIso.slice(0, 10),
          allowNegativeStock,
        };
        postMovement(context, {
          productId: id,
          movementDate: nowIso.slice(0, 10),
          kind: "opening",
          quantityMilli: opening,
          unitCostFils: parent.average_cost_fils,
          notes: `Opening stock for ${input.variantLabel}`,
          idempotencyKey: `variant-opening:${String(id)}`,
        });
      }
    } else {
      db.prepare(
        `UPDATE products SET name = COALESCE(?, name), variant_label = ?, barcode = ?,
                sale_price_fils = COALESCE(?, sale_price_fils),
                is_active = COALESCE(?, is_active), updated_at = ?
          WHERE id = ? AND parent_id = ?`,
      ).run(
        input.name ?? null,
        input.variantLabel,
        input.barcode ?? null,
        input.salePriceFils ?? null,
        input.isActive === undefined ? null : input.isActive ? 1 : 0,
        nowIso,
        id,
        input.parentId,
      );
    }

    recordAudit(
      db,
      actor,
      {
        module: "products",
        action: input.id === undefined ? "create" : "update",
        entityType: "product",
        entityId: id,
        newValues: input,
      },
      nowIso,
    );

    const row = listVariants(db, { parentId: input.parentId, limit: 1000 }).find(
      (variant) => variant.id === id,
    );
    if (row === undefined) throw new ImsReferenceError("The variant could not be read back.");
    return row;
  })();
}

function nextVariantSku(db: SqliteDatabase, parentSku: string, label: string): string {
  const suffix = label
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 12);
  const base = `${parentSku}-${suffix === "" ? "VAR" : suffix}`;
  let candidate = base;
  let counter = 2;
  while (db.prepare("SELECT id FROM products WHERE sku = ?").get(candidate) !== undefined) {
    candidate = `${base}-${String(counter)}`;
    counter += 1;
  }
  return candidate;
}
