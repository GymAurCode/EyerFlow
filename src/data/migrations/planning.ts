import type { Migration } from "../migrator";

export const planningMigration: Migration = {
  version: 28,
  name: "028_manufacturing_planning_workflows",
  up: (db) => {
    // The IMS document service already writes this field for every line.
    if (
      !(db.prepare("PRAGMA table_info(ims_document_lines)").all() as { name: string }[]).some(
        (c) => c.name === "restock",
      )
    )
      db.exec(
        "ALTER TABLE ims_document_lines ADD COLUMN restock INTEGER NOT NULL DEFAULT 1 CHECK(restock IN (0,1))",
      );
    db.exec(`
    ALTER TABLE manufacturing_orders ADD COLUMN planning_location_id INTEGER REFERENCES ims_locations(id);
    ALTER TABLE manufacturing_mps_plans ADD COLUMN period_end TEXT;
    ALTER TABLE manufacturing_mps_plans ADD COLUMN horizon TEXT NOT NULL DEFAULT 'daily';
    ALTER TABLE manufacturing_mps_plans ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';
    ALTER TABLE manufacturing_mps_plans ADD COLUMN location_id INTEGER REFERENCES ims_locations(id);
    ALTER TABLE manufacturing_mps_plans ADD COLUMN bom_id INTEGER REFERENCES manufacturing_boms(id);
    ALTER TABLE manufacturing_mps_plans ADD COLUMN planned_production INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE manufacturing_mps_plans ADD COLUMN scheduled_receipts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE manufacturing_mps_plans ADD COLUMN recommended_production INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE manufacturing_mps_plans ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE manufacturing_mps_plans ADD COLUMN updated_at TEXT;
    CREATE TABLE manufacturing_mps_buckets (
      id INTEGER PRIMARY KEY, plan_id INTEGER NOT NULL REFERENCES manufacturing_mps_plans(id),
      bucket_date TEXT NOT NULL, end_date TEXT NOT NULL, opening_stock INTEGER NOT NULL,
      forecast_demand INTEGER NOT NULL, confirmed_demand INTEGER NOT NULL, demand INTEGER NOT NULL,
      scheduled_receipts INTEGER NOT NULL, planned_production INTEGER NOT NULL,
      projected_stock INTEGER NOT NULL, shortage INTEGER NOT NULL, recommended_production INTEGER NOT NULL,
      generated_mo_id INTEGER REFERENCES manufacturing_orders(id), UNIQUE(plan_id,bucket_date)
    );
    CREATE TABLE manufacturing_mps_history (
      id INTEGER PRIMARY KEY, plan_id INTEGER NOT NULL REFERENCES manufacturing_mps_plans(id),
      revision INTEGER NOT NULL, operation TEXT NOT NULL, snapshot_json TEXT NOT NULL,
      actor_name TEXT NOT NULL, created_at TEXT NOT NULL
    );
    ALTER TABLE manufacturing_mrp_runs ADD COLUMN from_date TEXT;
    ALTER TABLE manufacturing_mrp_runs ADD COLUMN to_date TEXT;
    ALTER TABLE manufacturing_mrp_runs ADD COLUMN plant TEXT;
    ALTER TABLE manufacturing_mrp_runs ADD COLUMN source_mo_ids TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE manufacturing_mrp_runs ADD COLUMN scope_key TEXT;
    ALTER TABLE manufacturing_mrp_runs ADD COLUMN input_fingerprint TEXT;
    ALTER TABLE manufacturing_mrp_requirements ADD COLUMN scheduled_receipts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE manufacturing_mrp_requirements ADD COLUMN reserved_quantity INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE manufacturing_mrp_requirements ADD COLUMN safety_stock INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE manufacturing_mrp_requirements ADD COLUMN requested_supply INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE manufacturing_mrp_requirements ADD COLUMN suggested_quantity INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE manufacturing_mrp_requirements ADD COLUMN planned_release_date TEXT;
    ALTER TABLE manufacturing_mrp_requirements ADD COLUMN source_mo_ids TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE manufacturing_mrp_requirements ADD COLUMN bom_id INTEGER REFERENCES manufacturing_boms(id);
    ALTER TABLE manufacturing_mrp_requirements ADD COLUMN requisition_id INTEGER REFERENCES ims_documents(id);
    ALTER TABLE manufacturing_mrp_requirements ADD COLUMN generated_mo_id INTEGER REFERENCES manufacturing_orders(id);
    CREATE INDEX idx_mps_history_plan ON manufacturing_mps_history(plan_id,id);
    CREATE INDEX idx_mrp_scope ON manufacturing_mrp_runs(scope_key,id);
  `);
  },
};
