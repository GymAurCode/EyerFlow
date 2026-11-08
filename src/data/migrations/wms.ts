import type { Migration } from '../migrator';
export const wmsMigration: Migration = { version: 29, name: '029_warehouse_execution', up(db) {
  db.exec(`
    CREATE TABLE wms_warehouses (
      id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      ims_location_id INTEGER NOT NULL UNIQUE REFERENCES ims_locations(id),
      address TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL DEFAULT '', manager TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE wms_locations (
      id INTEGER PRIMARY KEY, warehouse_id INTEGER NOT NULL REFERENCES wms_warehouses(id),
      parent_id INTEGER REFERENCES wms_locations(id), code TEXT NOT NULL, name TEXT NOT NULL,
      type TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, blocked INTEGER NOT NULL DEFAULT 0,
      capacity_milli INTEGER CHECK(capacity_milli>0), mixed_sku INTEGER NOT NULL DEFAULT 1,
      mixed_lot INTEGER NOT NULL DEFAULT 1, UNIQUE(warehouse_id,code)
    );
    CREATE TABLE wms_docks (
      id INTEGER PRIMARY KEY, warehouse_id INTEGER NOT NULL REFERENCES wms_warehouses(id),
      code TEXT NOT NULL, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, UNIQUE(warehouse_id,code)
    );
    CREATE TABLE wms_appointments (
      id INTEGER PRIMARY KEY, warehouse_id INTEGER NOT NULL REFERENCES wms_warehouses(id),
      code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, dock_id INTEGER NOT NULL REFERENCES wms_docks(id),
      supplier_id INTEGER REFERENCES parties(id), starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
      carrier TEXT NOT NULL DEFAULT '', vehicle TEXT NOT NULL DEFAULT '', priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'scheduled', revision INTEGER NOT NULL DEFAULT 0,
      actual_start TEXT, actual_end TEXT
    );
    CREATE INDEX idx_wms_appointment_dock ON wms_appointments(dock_id,starts_at,ends_at);
    CREATE TABLE wms_handling_units (
      id INTEGER PRIMARY KEY, warehouse_id INTEGER NOT NULL REFERENCES wms_warehouses(id),
      code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, parent_id INTEGER REFERENCES wms_handling_units(id),
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE wms_documents (
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL, warehouse_id INTEGER NOT NULL REFERENCES wms_warehouses(id),
      reference TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', source_id INTEGER REFERENCES ims_documents(id),
      assigned_to INTEGER REFERENCES users(id), status TEXT NOT NULL DEFAULT 'draft',
      revision INTEGER NOT NULL DEFAULT 0, token TEXT NOT NULL UNIQUE,
      created_by INTEGER, approved_by INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(kind,warehouse_id,reference)
    );
    CREATE TABLE wms_lines (
      id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES wms_documents(id),
      product_id INTEGER NOT NULL REFERENCES products(id), quantity_milli INTEGER NOT NULL CHECK(quantity_milli>0),
      bin_id INTEGER NOT NULL REFERENCES wms_locations(id), to_bin_id INTEGER REFERENCES wms_locations(id),
      batch_no TEXT NOT NULL DEFAULT '', stock_status TEXT NOT NULL, unit_cost_fils INTEGER NOT NULL DEFAULT 0,
      handling_unit_id INTEGER REFERENCES wms_handling_units(id), counted_milli INTEGER CHECK(counted_milli>=0)
    );
    CREATE TABLE wms_bin_movements (
      id INTEGER PRIMARY KEY, warehouse_id INTEGER NOT NULL REFERENCES wms_warehouses(id),
      bin_id INTEGER NOT NULL REFERENCES wms_locations(id), product_id INTEGER NOT NULL REFERENCES products(id),
      batch_no TEXT NOT NULL DEFAULT '', stock_status TEXT NOT NULL, quantity_milli INTEGER NOT NULL,
      handling_unit_id INTEGER REFERENCES wms_handling_units(id), document_id INTEGER REFERENCES wms_documents(id),
      event_key TEXT NOT NULL UNIQUE, actor_name TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX idx_wms_bin_balance ON wms_bin_movements(bin_id,product_id,stock_status,batch_no);
    CREATE INDEX idx_wms_documents_queue ON wms_documents(warehouse_id,kind,status);
    CREATE TABLE wms_events (
      id INTEGER PRIMARY KEY, document_id INTEGER REFERENCES wms_documents(id), action TEXT NOT NULL,
      actor_id INTEGER, actor_name TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
  `);
} };
