/**
 * Read-only stock queries shared by the IMS dashboard, the stock screens and
 * the report centre.
 *
 * Every quantity here is the sum of `stock_movements`, never a cached number.
 * `products.quantity_milli` is still kept in step by the posting engine for the
 * screens that predate IMS, but a location balance only exists as a sum.
 */

import type { SqliteDatabase } from "../../../data/connection";
import type {
  BatchRow,
  ReplenishmentRow,
  ReservationRow,
  SerialRow,
  StockLocationRow,
  StockOverviewRequest,
  StockOverviewRow,
} from "../../../shared/ims";

interface ProductRow {
  readonly id: number;
  readonly sku: string;
  readonly name: string;
  readonly category: string | null;
  readonly brand: string | null;
  readonly unit: string;
  readonly quantity_milli: number;
  readonly average_cost_fils: number;
  readonly reorder_level_milli: number;
  readonly is_service: number;
  readonly is_active: number;
}

interface AggregateRow {
  readonly product_id: number;
  readonly available: number;
  readonly quarantine: number;
  readonly damaged: number;
  readonly in_transit: number;
  readonly reserved: number;
}

export function locationRows(db: SqliteDatabase): {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly is_default: number;
  readonly is_active: number;
}[] {
  return db
    .prepare("SELECT * FROM ims_locations ORDER BY is_default DESC, name")
    .all() as never;
}

function stockAggregates(
  db: SqliteDatabase,
  locationId?: number,
): Map<number, AggregateRow> {
  const locationClause =
    locationId === undefined
      ? ""
      : ` AND COALESCE(sm.location_id, (SELECT id FROM ims_locations WHERE is_default = 1 LIMIT 1)) = ?`;
  const params: number[] = locationId === undefined ? [] : [locationId];

  const rows = db
    .prepare(
      `SELECT sm.product_id,
              COALESCE(SUM(CASE WHEN sm.stock_status = 'available' THEN sm.quantity_milli END), 0) AS available,
              COALESCE(SUM(CASE WHEN sm.stock_status = 'quarantine' THEN sm.quantity_milli END), 0) AS quarantine,
              COALESCE(SUM(CASE WHEN sm.stock_status = 'damaged' THEN sm.quantity_milli END), 0) AS damaged,
              COALESCE(SUM(CASE WHEN sm.stock_status = 'inTransit' THEN sm.quantity_milli END), 0) AS in_transit
         FROM stock_movements sm
        WHERE 1 = 1${locationClause}
        GROUP BY sm.product_id`,
    )
    .all(...params) as {
    product_id: number;
    available: number;
    quarantine: number;
    damaged: number;
    in_transit: number;
  }[];

  const map = new Map<number, AggregateRow>();
  for (const row of rows) {
    map.set(row.product_id, { ...row, reserved: 0 });
  }

  const reservingClause =
    locationId === undefined ? "" : " AND (r.location_id IS NULL OR r.location_id = ?)";
  const reservations = db
    .prepare(
      `SELECT r.product_id, COALESCE(SUM(r.quantity_milli), 0) AS reserved
         FROM ims_reservations r
        WHERE r.status = 'active'${reservingClause}
        GROUP BY r.product_id`,
    )
    .all(...params) as { product_id: number; reserved: number }[];

  for (const row of reservations) {
    const current = map.get(row.product_id);
    if (current === undefined) {
      map.set(row.product_id, {
        product_id: row.product_id,
        available: 0,
        quarantine: 0,
        damaged: 0,
        in_transit: 0,
        reserved: row.reserved,
      });
    } else {
      map.set(row.product_id, { ...current, reserved: row.reserved });
    }
  }

  return map;
}

function openQuantity(
  db: SqliteDatabase,
  kind: string,
  statuses: readonly string[],
  direction: "in" | "out",
): Map<number, number> {
  const placeholders = statuses.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT l.product_id,
              COALESCE(SUM(l.quantity_milli - l.processed_milli), 0) AS outstanding
         FROM ims_document_lines l
         JOIN ims_documents d ON d.id = l.document_id
        WHERE d.kind = ? AND d.status IN (${placeholders}) AND l.product_id IS NOT NULL
        GROUP BY l.product_id`,
    )
    .all(kind, ...statuses) as { product_id: number; outstanding: number }[];
  const map = new Map<number, number>();
  for (const row of rows) {
    map.set(row.product_id, direction === "in" ? row.outstanding : row.outstanding);
  }
  return map;
}

function reorderPoints(db: SqliteDatabase): Map<number, { minimum: number; maximum: number; safety: number }> {
  const rows = db
    .prepare("SELECT product_id, minimum_milli, maximum_milli, safety_milli FROM ims_reorder_rules")
    .all() as {
    product_id: number;
    minimum_milli: number;
    maximum_milli: number;
    safety_milli: number;
  }[];
  return new Map(
    rows.map((row) => [
      row.product_id,
      { minimum: row.minimum_milli, maximum: row.maximum_milli, safety: row.safety_milli },
    ]),
  );
}

export function stockOverview(db: SqliteDatabase, request: StockOverviewRequest): StockOverviewRow[] {
  const clauses: string[] = ["p.is_service = 0"];
  const params: (string | number)[] = [];

  if (request.search !== undefined && request.search.trim() !== "") {
    clauses.push("(p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ? OR p.brand LIKE ?)");
    const like = `%${request.search.trim()}%`;
    params.push(like, like, like, like);
  }
  if (request.category !== undefined && request.category !== "") {
    clauses.push("p.category = ?");
    params.push(request.category);
  }
  const where = ` WHERE ${clauses.join(" AND ")}`;
  const limit = request.limit ?? 500;

  const products = db
    .prepare(`SELECT p.* FROM products p${where} ORDER BY p.name LIMIT ?`)
    .all(...params, limit) as ProductRow[];

  const aggregates = stockAggregates(db, request.locationId);
  const incoming = openQuantity(
    db,
    "purchaseOrder",
    ["approved", "sent", "partiallyReceived"],
    "in",
  );
  const outgoing = openQuantity(
    db,
    "salesOrder",
    ["confirmed", "partiallyFulfilled"],
    "out",
  );
  const rules = reorderPoints(db);
  const locations = locationRows(db);

  const rows: StockOverviewRow[] = [];
  for (const product of products) {
    const aggregate = aggregates.get(product.id);
    const available = aggregate?.available ?? 0;
    const quarantine = aggregate?.quarantine ?? 0;
    const damaged = aggregate?.damaged ?? 0;
    const inTransit = aggregate?.in_transit ?? 0;
    const reserved = aggregate?.reserved ?? 0;
    const onHand = available + quarantine + damaged;
    const rule = rules.get(product.id);
    const reorderPoint = product.reorder_level_milli;
    const isOut = available <= 0;
    const isLow = !isOut && available <= Math.max(reorderPoint, rule?.minimum ?? 0, 0);

    if (request.onlyLow === true && !isLow) continue;
    if (request.onlyOut === true && !isOut) continue;

    rows.push({
      productId: product.id,
      sku: product.sku,
      name: product.name,
      category: product.category,
      brand: product.brand,
      unit: product.unit,
      onHandMilli: onHand,
      reservedMilli: reserved,
      availableMilli: available - reserved,
      incomingMilli: incoming.get(product.id) ?? 0,
      outgoingMilli: outgoing.get(product.id) ?? 0,
      inTransitMilli: inTransit,
      quarantineMilli: quarantine,
      damagedMilli: damaged,
      averageCostFils: product.average_cost_fils,
      valueFils: Math.round((onHand * product.average_cost_fils) / 1000),
      reorderPointMilli: reorderPoint,
      isLow,
      isOut,
      locations:
        request.locationId === undefined
          ? productLocationRows(db, product.id, locations)
          : [],
    });
  }

  return rows;
}

export function productLocationRows(
  db: SqliteDatabase,
  productId: number,
  locations = locationRows(db),
): StockLocationRow[] {
  const aggregated = db
    .prepare(
      `SELECT COALESCE(sm.location_id, (SELECT id FROM ims_locations WHERE is_default = 1 LIMIT 1)) AS location_id,
              COALESCE(SUM(CASE WHEN sm.stock_status = 'available' THEN sm.quantity_milli END), 0) AS available,
              COALESCE(SUM(CASE WHEN sm.stock_status = 'quarantine' THEN sm.quantity_milli END), 0) AS quarantine,
              COALESCE(SUM(CASE WHEN sm.stock_status = 'damaged' THEN sm.quantity_milli END), 0) AS damaged,
              COALESCE(SUM(CASE WHEN sm.stock_status = 'inTransit' THEN sm.quantity_milli END), 0) AS in_transit
         FROM stock_movements sm
        WHERE sm.product_id = ?
        GROUP BY location_id`,
    )
    .all(productId) as {
    location_id: number;
    available: number;
    quarantine: number;
    damaged: number;
    in_transit: number;
  }[];

  const byLocation = new Map(aggregated.map((row) => [row.location_id, row]));

  const reserved = db
    .prepare(
      `SELECT location_id, COALESCE(SUM(quantity_milli), 0) AS total
         FROM ims_reservations
        WHERE product_id = ? AND status = 'active'
        GROUP BY location_id`,
    )
    .all(productId) as { location_id: number | null; total: number }[];
  const reservedByLocation = new Map(reserved.map((row) => [row.location_id, row.total]));
  const reservedAny = reservedByLocation.get(null) ?? 0;

  const product = db
    .prepare("SELECT average_cost_fils FROM products WHERE id = ?")
    .get(productId) as { average_cost_fils: number } | undefined;
  const cost = product?.average_cost_fils ?? 0;

  const rows: StockLocationRow[] = [];
  for (const location of locations) {
    const row = byLocation.get(location.id);
    const available = row?.available ?? 0;
    const quarantine = row?.quarantine ?? 0;
    const damaged = row?.damaged ?? 0;
    const inTransit = row?.in_transit ?? 0;
    const onHand = available + quarantine + damaged;
    if (onHand === 0 && inTransit === 0) continue;
    const locationReserved = reservedByLocation.get(location.id) ?? 0;
    rows.push({
      locationId: location.id,
      locationCode: location.code,
      locationName: location.name,
      locationType: location.type,
      onHandMilli: onHand,
      reservedMilli: locationReserved + (location.is_default === 1 ? reservedAny : 0),
      availableMilli:
        available - locationReserved - (location.is_default === 1 ? reservedAny : 0),
      inTransitMilli: inTransit,
      quarantineMilli: quarantine,
      damagedMilli: damaged,
      valueFils: Math.round((onHand * cost) / 1000),
    });
  }
  return rows;
}

export function listBatches(
  db: SqliteDatabase,
  request: { search?: string; expiringDays?: number; limit?: number },
  today = new Date(),
): BatchRow[] {
  const clauses: string[] = ["1 = 1"];
  const params: (string | number)[] = [];
  if (request.search !== undefined && request.search.trim() !== "") {
    clauses.push("(p.name LIKE ? OR p.sku LIKE ? OR b.batch_no LIKE ?)");
    const like = `%${request.search.trim()}%`;
    params.push(like, like, like);
  }
  if (request.expiringDays !== undefined) {
    const until = new Date(today);
    until.setDate(until.getDate() + request.expiringDays);
    clauses.push("b.expiry_date IS NOT NULL AND b.expiry_date <= ?");
    params.push(until.toISOString().slice(0, 10));
  }

  const rows = db
    .prepare(
      `SELECT b.*, p.name AS product_name, p.sku AS sku, p.average_cost_fils,
              COALESCE((
                SELECT SUM(sm.quantity_milli) FROM stock_movements sm
                 WHERE sm.product_id = b.product_id AND sm.batch_no = b.batch_no
                   AND sm.stock_status <> 'inTransit'
              ), 0) AS quantity_milli
         FROM ims_batches b
         JOIN products p ON p.id = b.product_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY b.expiry_date IS NULL, b.expiry_date, p.name
        LIMIT ?`,
    )
    .all(...params, request.limit ?? 500) as {
    id: number;
    product_id: number;
    product_name: string;
    sku: string;
    batch_no: string;
    lot_no: string | null;
    manufactured_on: string | null;
    expiry_date: string | null;
    quantity_milli: number;
    average_cost_fils: number;
  }[];

  const todayMs = Date.parse(today.toISOString().slice(0, 10));
  return rows.map((row) => {
    const daysToExpiry =
      row.expiry_date === null
        ? null
        : Math.round((Date.parse(row.expiry_date) - todayMs) / 86_400_000);
    return {
      id: row.id,
      productId: row.product_id,
      productName: row.product_name,
      sku: row.sku,
      batchNo: row.batch_no,
      lotNo: row.lot_no,
      manufacturedOn: row.manufactured_on,
      expiryDate: row.expiry_date,
      quantityMilli: row.quantity_milli,
      valueFils: Math.round((row.quantity_milli * row.average_cost_fils) / 1000),
      daysToExpiry,
      expired: daysToExpiry !== null && daysToExpiry < 0,
    };
  });
}

export function listSerials(db: SqliteDatabase, request: { search?: string; limit?: number }): SerialRow[] {
  const clauses: string[] = ["1 = 1"];
  const params: (string | number)[] = [];
  if (request.search !== undefined && request.search.trim() !== "") {
    clauses.push("(p.name LIKE ? OR s.serial_number LIKE ?)");
    const like = `%${request.search.trim()}%`;
    params.push(like, like);
  }
  const rows = db
    .prepare(
      `SELECT s.*, p.name AS product_name, l.name AS location_name,
              d.number AS source_number
         FROM ims_serials s
         JOIN products p ON p.id = s.product_id
         LEFT JOIN ims_locations l ON l.id = s.location_id
         LEFT JOIN ims_documents d ON d.kind = s.source_kind AND d.id = s.source_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY s.updated_at DESC
        LIMIT ?`,
    )
    .all(...params, request.limit ?? 500) as {
    id: number;
    product_id: number;
    product_name: string;
    serial_number: string;
    status: SerialRow["status"];
    location_name: string | null;
    source_kind: string | null;
    source_number: string | null;
    updated_at: string;
  }[];

  return rows.map((row) => ({
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    serialNumber: row.serial_number,
    status: row.status,
    locationName: row.location_name,
    sourceKind: row.source_kind,
    sourceNumber: row.source_number,
    updatedAt: row.updated_at,
  }));
}

export function listReservations(
  db: SqliteDatabase,
  request: { productId?: number; status?: ReservationRow["status"]; limit?: number },
): ReservationRow[] {
  const clauses: string[] = ["1 = 1"];
  const params: (string | number)[] = [];
  if (request.productId !== undefined) {
    clauses.push("r.product_id = ?");
    params.push(request.productId);
  }
  if (request.status !== undefined) {
    clauses.push("r.status = ?");
    params.push(request.status);
  }
  const rows = db
    .prepare(
      `SELECT r.*, p.name AS product_name, l.name AS location_name, d.number AS source_number
         FROM ims_reservations r
         JOIN products p ON p.id = r.product_id
         LEFT JOIN ims_locations l ON l.id = r.location_id
         LEFT JOIN ims_documents d ON d.id = r.source_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY r.created_at DESC
        LIMIT ?`,
    )
    .all(...params, request.limit ?? 500) as {
    id: number;
    product_id: number;
    product_name: string;
    location_name: string | null;
    quantity_milli: number;
    source_kind: string;
    source_id: number;
    source_number: string | null;
    status: ReservationRow["status"];
    notes: string | null;
    created_at: string;
  }[];

  return rows.map((row) => ({
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    locationName: row.location_name,
    quantityMilli: row.quantity_milli,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    sourceNumber: row.source_number,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
  }));
}

export function replenishmentRows(
  db: SqliteDatabase,
  request: { locationId?: number; supplierId?: number; limit?: number },
): ReplenishmentRow[] {
  const overview = stockOverview(db, {
    ...(request.locationId !== undefined ? { locationId: request.locationId } : {}),
    limit: request.limit ?? 1000,
  });

  const rules = db
    .prepare(
      `SELECT r.*, p.preferred_supplier_id, p.average_cost_fils, p.name AS product_name
         FROM ims_reorder_rules r
         JOIN products p ON p.id = r.product_id`,
    )
    .all() as {
    product_id: number;
    lead_time_days: number;
    preferred_supplier_id: number | null;
    average_cost_fils: number;
    name: string;
    reorder_point_milli: number;
    minimum_milli: number;
    maximum_milli: number;
    safety_milli: number;
  }[];
  const byProduct = new Map(rules.map((row) => [row.product_id, row]));

  const preferred = db
    .prepare(
      `SELECT p.id AS product_id, p.preferred_supplier_id, s.name AS supplier_name
         FROM products p
         LEFT JOIN parties s ON s.id = p.preferred_supplier_id`,
    )
    .all() as { product_id: number; preferred_supplier_id: number | null; supplier_name: string | null }[];
  const supplierByProduct = new Map(
    preferred.map((row) => [
      row.product_id,
      { id: row.preferred_supplier_id, name: row.supplier_name },
    ]),
  );

  const rows: ReplenishmentRow[] = [];
  for (const stock of overview) {
    const rule = byProduct.get(stock.productId);
    const supplier = supplierByProduct.get(stock.productId);
    const supplierId = rule?.preferred_supplier_id ?? supplier?.id ?? null;
    if (request.supplierId !== undefined && supplierId !== request.supplierId) continue;

    const eligible = stock.onHandMilli - stock.reservedMilli;
    const reorderPoint = rule?.reorder_point_milli ?? stock.reorderPointMilli;
    const minimum = rule?.minimum_milli ?? 0;
    const maximum = rule?.maximum_milli ?? Math.max(reorderPoint * 2, 0);
    const safety = rule?.safety_milli ?? 0;

    let reason: ReplenishmentRow["reason"] | null = null;
    if (eligible < minimum) reason = "belowMinimum";
    else if (eligible < safety) reason = "belowSafety";
    else if (eligible <= reorderPoint) reason = "belowReorder";
    if (reason === null) continue;

    const target = Math.max(maximum, reorderPoint + safety);
    // Incoming purchase orders already on the way reduce what still needs ordering.
    const suggestedMilli = Math.max(0, target - eligible - stock.incomingMilli);

    rows.push({
      productId: stock.productId,
      sku: stock.sku,
      name: stock.name,
      supplierId,
      supplierName: supplier?.name ?? null,
      leadTimeDays: rule?.lead_time_days ?? 0,
      onHandMilli: stock.onHandMilli,
      reservedMilli: stock.reservedMilli,
      eligibleMilli: eligible,
      incomingMilli: stock.incomingMilli,
      reorderPointMilli: reorderPoint,
      minimumMilli: minimum,
      maximumMilli: maximum,
      safetyMilli: safety,
      suggestedMilli,
      lastCostFils: stock.averageCostFils,
      suggestedValueFils: Math.round((suggestedMilli * stock.averageCostFils) / 1000),
      reason,
    });
  }

  rows.sort((a, b) => a.eligibleMilli - b.eligibleMilli);
  return rows.slice(0, request.limit ?? 500);
}
