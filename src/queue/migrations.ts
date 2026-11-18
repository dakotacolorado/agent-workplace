/** Applied in order, each once; append, never edit. */
export const MIGRATIONS = [
  `CREATE TABLE queue_entries (
     task_id TEXT PRIMARY KEY, position REAL NOT NULL, role TEXT NOT NULL, state TEXT NOT NULL,
     note TEXT, queued_by TEXT NOT NULL, agent_name TEXT, queued_at TEXT NOT NULL, started_at TEXT);
   CREATE TABLE queue_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
];
