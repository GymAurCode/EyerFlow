import type { Migration } from "../migrator";
export const wmsIntegrationMigration: Migration = {
  version: 33,
  name: "033_warehouse_ledger_mapping_and_configuration",
  up(db) {
    db.exec(`
  CREATE VIEW wms_stock_movements AS SELECT id,product_id,document_id,document_line_id,movement_date,kind,quantity_milli,
    unit_cost_fils,cost_fils,fiscal_year,notes,
    COALESCE(location_id,(SELECT id FROM ims_locations WHERE is_default=1 ORDER BY id LIMIT 1)) location_id,
    source_kind,source_id,batch_no,serial_no,stock_status,idempotency_key FROM stock_movements;
  CREATE TABLE wms_config(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL);
  INSERT INTO wms_config VALUES('autoPutaway','1',datetime('now')),('pickFaceFirst','1',datetime('now'));
  CREATE TABLE wms_adoptions(
    id INTEGER PRIMARY KEY, movement_id INTEGER NOT NULL UNIQUE REFERENCES stock_movements(id),
    receiving_bin_id INTEGER NOT NULL REFERENCES wms_bins(id), created_at TEXT NOT NULL, created_by TEXT NOT NULL
  );
`);
  },
};
