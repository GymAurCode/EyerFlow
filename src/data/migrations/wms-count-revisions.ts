import type { Migration } from "../migrator";
export const wmsCountRevisionsMigration: Migration = {
  version: 35,
  name: "035_warehouse_count_revisions_and_arrival",
  up(db) {
    db.exec(`
 ALTER TABLE wms_counts ADD COLUMN recount_of INTEGER REFERENCES wms_counts(id);
 ALTER TABLE wms_counts ADD COLUMN superseded_by INTEGER REFERENCES wms_counts(id);
 ALTER TABLE wms_appointments ADD COLUMN arrived_at TEXT;
`);
  },
};
