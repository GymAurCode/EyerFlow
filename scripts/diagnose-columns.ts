import { openInMemoryDatabase } from "../src/data/connection";
import { runMigrations } from "../src/data/migrator";
import { migrations } from "../src/data/migrations";

const db = openInMemoryDatabase();
runMigrations(db, migrations);

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'manufacturing%' ORDER BY name")
  .all() as { name: string }[];

for (const table of tables) {
  const columns = db.prepare(`PRAGMA table_info(${table.name})`).all() as { name: string }[];
  const names = columns.map((column) => column.name);
  console.log(
    `${names.includes("updated_at") ? "HAS updated_at" : "MISSING updated_at"}  ${table.name}  [${names.join(", ")}]`,
  );
}
