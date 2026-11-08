import type { Migration } from "../migrator";

/** Add execution structures without changing or discarding migration 29 data. */
export const wmsExecutionMigration: Migration = {
  version: 30,
  name: "030_warehouse_execution_compatibility",
  up(db) {
    db.exec(`
      ALTER TABLE wms_warehouses ADD COLUMN site TEXT NOT NULL DEFAULT '';
      UPDATE wms_warehouses SET site=branch;
      CREATE TABLE wms_bins (
        id INTEGER PRIMARY KEY, warehouse_id INTEGER NOT NULL REFERENCES wms_warehouses(id),
        location_id INTEGER NOT NULL UNIQUE REFERENCES ims_locations(id),
        code TEXT NOT NULL UNIQUE, zone TEXT NOT NULL DEFAULT '', aisle TEXT NOT NULL DEFAULT '',
        rack TEXT NOT NULL DEFAULT '', shelf TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL CHECK(type IN ('receiving','storage','pickFace','packing','dispatch','quarantine','returns')),
        capacity_milli INTEGER CHECK(capacity_milli IS NULL OR capacity_milli>0),
        mixed_sku INTEGER NOT NULL DEFAULT 1 CHECK(mixed_sku IN (0,1)),
        blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)),
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
      );
      CREATE INDEX wms_bins_warehouse ON wms_bins(warehouse_id,type);
      CREATE TABLE wms_inbounds (
        id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE,
        warehouse_id INTEGER NOT NULL REFERENCES wms_warehouses(id), reference TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'expected' CHECK(status IN ('expected','arrived','partiallyReceived','received','cancelled')),
        created_at TEXT NOT NULL, created_by TEXT NOT NULL
      );
      CREATE TABLE wms_inbound_lines (
        id INTEGER PRIMARY KEY, inbound_id INTEGER NOT NULL REFERENCES wms_inbounds(id),
        product_id INTEGER NOT NULL REFERENCES products(id), expected_milli INTEGER NOT NULL CHECK(expected_milli>0),
        received_milli INTEGER NOT NULL DEFAULT 0 CHECK(received_milli>=0), UNIQUE(inbound_id,product_id)
      );
      CREATE TABLE wms_receipts (
        id INTEGER PRIMARY KEY, command_key TEXT NOT NULL UNIQUE,
        inbound_line_id INTEGER NOT NULL REFERENCES wms_inbound_lines(id),
        bin_id INTEGER NOT NULL REFERENCES wms_bins(id), quantity_milli INTEGER NOT NULL CHECK(quantity_milli>0),
        damaged_milli INTEGER NOT NULL CHECK(damaged_milli>=0 AND damaged_milli<=quantity_milli),
        created_at TEXT NOT NULL, created_by TEXT NOT NULL
      );
      CREATE TABLE wms_tasks (
        id INTEGER PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('putaway','move','replenish','pick')),
        product_id INTEGER NOT NULL REFERENCES products(id), source_bin_id INTEGER NOT NULL REFERENCES wms_bins(id),
        destination_bin_id INTEGER REFERENCES wms_bins(id), quantity_milli INTEGER NOT NULL CHECK(quantity_milli>0),
        actual_milli INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created','assigned','started','completed','cancelled')),
        assigned_to INTEGER REFERENCES users(id), receipt_id INTEGER REFERENCES wms_receipts(id),
        created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, completion_key TEXT UNIQUE
      );
      CREATE INDEX wms_tasks_open ON wms_tasks(status,source_bin_id,product_id);
      INSERT OR IGNORE INTO role_permissions(role_id,module,action)
      SELECT r.id,'warehouse',a.action FROM roles r CROSS JOIN
      (SELECT 'view' action UNION ALL SELECT 'create' UNION ALL SELECT 'edit'
       UNION ALL SELECT 'cancel' UNION ALL SELECT 'export') a WHERE r.name='Administrator';
    `);
  },
};
