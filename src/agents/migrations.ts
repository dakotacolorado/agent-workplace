/** The agents module's tables. Appended to, never edited once merged. */
export const MIGRATIONS = [
  `CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    role TEXT,
    task TEXT,
    brief TEXT NOT NULL,
    capability INTEGER NOT NULL,
    status TEXT NOT NULL,
    said_in_turn INTEGER NOT NULL DEFAULT 0,
    in_turn INTEGER NOT NULL DEFAULT 0,
    headline TEXT,
    title TEXT,
    claude_session TEXT,
    limited_until TEXT,
    closed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE agent_sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    claude_session TEXT NOT NULL,
    model TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    end_reason TEXT,
    turns INTEGER NOT NULL DEFAULT 0,
    tokens TEXT NOT NULL,
    cost_usd REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX agent_sessions_agent ON agent_sessions (agent_id, started_at);
  CREATE TABLE agent_lines (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    session_id TEXT,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    sender TEXT,
    text TEXT NOT NULL
  );
  CREATE INDEX agent_lines_agent ON agent_lines (agent_id, seq);
  CREATE TABLE agent_requests (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`,
];
