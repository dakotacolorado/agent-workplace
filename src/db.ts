import { DatabaseSync } from "node:sqlite";

/** Opens the database and applies each module's migrations not yet applied, each in its own transaction. */
export function openDb(file: string, migrations: Record<string, string[]>): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS migrations (module TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (module, version))");
  const applied = db.prepare("SELECT 1 FROM migrations WHERE module = ? AND version = ?");
  const record = db.prepare("INSERT INTO migrations (module, version, applied_at) VALUES (?, ?, ?)");
  for (const [module, scripts] of Object.entries(migrations)) {
    scripts.forEach((sql, i) => {
      if (applied.get(module, i + 1)) return;
      db.exec("BEGIN");
      try {
        db.exec(sql);
        record.run(module, i + 1, new Date().toISOString());
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw new Error(`migration ${module} ${i + 1} failed: ${(err as Error).message}`);
      }
    });
  }
  return db;
}
