import type { Migration } from "../migrator";
export const wmsControlMigration: Migration = {
  version: 32,
  name: "032_warehouse_count_control",
  up(db) {
    db.exec(`
  CREATE TABLE wms_counts (
    id INTEGER PRIMARY KEY, ims_document_id INTEGER NOT NULL UNIQUE REFERENCES ims_documents(id),
    bin_id INTEGER NOT NULL REFERENCES wms_bins(id), product_id INTEGER NOT NULL REFERENCES products(id),
    expected_milli INTEGER NOT NULL, counted_milli INTEGER NOT NULL CHECK(counted_milli>=0),
    snapshot_movement_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'review' CHECK(status IN ('review','posted')),
    counted_by INTEGER, counted_by_name TEXT NOT NULL, approved_by INTEGER,
    reason TEXT NOT NULL, command_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, posted_at TEXT
  );
  CREATE INDEX wms_count_scope ON wms_counts(bin_id,product_id,status);
`);
  },
};
