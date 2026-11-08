import type { Migration } from "../migrator";
export const wmsOutboundMigration: Migration = {
  version: 31,
  name: "031_warehouse_outbound_execution",
  up(db) {
    db.exec(`
    CREATE TABLE wms_dispatches (
      id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, command_key TEXT NOT NULL UNIQUE,
      warehouse_id INTEGER NOT NULL REFERENCES wms_warehouses(id), recipient TEXT NOT NULL,
      reference TEXT NOT NULL, required_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','released','picked','packed','staged','loaded','handedOver','cancelled')),
      created_at TEXT NOT NULL, created_by TEXT NOT NULL, handed_over_at TEXT,
      carrier TEXT, vehicle TEXT, acknowledgement TEXT
    );
    CREATE TABLE wms_dispatch_lines (
      id INTEGER PRIMARY KEY, dispatch_id INTEGER NOT NULL REFERENCES wms_dispatches(id),
      product_id INTEGER NOT NULL REFERENCES products(id), quantity_milli INTEGER NOT NULL CHECK(quantity_milli>0),
      UNIQUE(dispatch_id,product_id)
    );
    ALTER TABLE wms_tasks ADD COLUMN dispatch_line_id INTEGER REFERENCES wms_dispatch_lines(id);
    CREATE INDEX wms_task_dispatch ON wms_tasks(dispatch_line_id,status);
    CREATE TABLE wms_cartons (
      id INTEGER PRIMARY KEY, dispatch_id INTEGER NOT NULL REFERENCES wms_dispatches(id), code TEXT NOT NULL UNIQUE,
      command_key TEXT NOT NULL UNIQUE, weight_grams INTEGER NOT NULL CHECK(weight_grams>0),
      status TEXT NOT NULL DEFAULT 'closed' CHECK(status IN ('closed','staged','loaded')),
      created_at TEXT NOT NULL, created_by TEXT NOT NULL
    );
    CREATE TABLE wms_carton_lines (
      id INTEGER PRIMARY KEY, carton_id INTEGER NOT NULL REFERENCES wms_cartons(id),
      dispatch_line_id INTEGER NOT NULL REFERENCES wms_dispatch_lines(id), quantity_milli INTEGER NOT NULL CHECK(quantity_milli>0),
      UNIQUE(carton_id,dispatch_line_id)
    );
    CREATE TABLE wms_exceptions (
      id INTEGER PRIMARY KEY, task_id INTEGER REFERENCES wms_tasks(id), operation TEXT NOT NULL,
      reason TEXT NOT NULL, created_at TEXT NOT NULL, actor_name TEXT NOT NULL
    );
  `);
  },
};
