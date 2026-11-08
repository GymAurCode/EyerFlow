import type { Migration } from "../migrator";
export const wmsReturnsMigration: Migration = {
  version: 34,
  name: "034_warehouse_returns_and_replenishment",
  up(db) {
    db.exec(`
 CREATE TABLE wms_returns (
   id INTEGER PRIMARY KEY, dispatch_line_id INTEGER NOT NULL REFERENCES wms_dispatch_lines(id),
   ims_document_id INTEGER NOT NULL UNIQUE REFERENCES ims_documents(id), bin_id INTEGER NOT NULL REFERENCES wms_bins(id),
   quantity_milli INTEGER NOT NULL CHECK(quantity_milli>0), sellable_milli INTEGER NOT NULL DEFAULT 0,
   status TEXT NOT NULL DEFAULT 'quarantine' CHECK(status IN ('quarantine','inspected')),
   condition_note TEXT NOT NULL, command_key TEXT NOT NULL UNIQUE, received_by TEXT NOT NULL, created_at TEXT NOT NULL,
   inspected_by TEXT, inspected_at TEXT
 );
 CREATE TABLE wms_replenishment_rules (
   id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id),
   source_bin_id INTEGER NOT NULL REFERENCES wms_bins(id), destination_bin_id INTEGER NOT NULL REFERENCES wms_bins(id),
   minimum_milli INTEGER NOT NULL CHECK(minimum_milli>=0), target_milli INTEGER NOT NULL CHECK(target_milli>minimum_milli),
   active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), UNIQUE(product_id,destination_bin_id)
 );
 ALTER TABLE wms_tasks ADD COLUMN replenishment_rule_id INTEGER REFERENCES wms_replenishment_rules(id);
`);
  },
};
