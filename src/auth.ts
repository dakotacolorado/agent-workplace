import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Caller } from "./contracts.ts";
import type { Tokens } from "./module.ts";

export const ADMIN_TOKEN_FILE = "admin-token";

/** The tables auth owns, applied as the `core` module's migrations. */
export const AUTH_MIGRATIONS = [
  "CREATE TABLE agent_tokens (hash TEXT PRIMARY KEY, agent_id TEXT NOT NULL, created_at TEXT NOT NULL); CREATE INDEX agent_tokens_agent ON agent_tokens (agent_id);",
];

const newToken = (prefix: string) => `${prefix}_${randomBytes(24).toString("base64url")}`;
const hash = (token: string) => createHash("sha256").update(token).digest();

/** The person's token, made on first start and kept in `<dir>/admin-token` (mode 600). */
export function adminToken(dir: string): string {
  const file = join(dir, ADMIN_TOKEN_FILE);
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const token = newToken("awp");
  writeFileSync(file, token + "\n", { mode: 0o600, flag: "wx" });
  return token;
}

export function agentTokens(db: DatabaseSync): Tokens & { agentOf(token: string): string | undefined } {
  const insert = db.prepare("INSERT INTO agent_tokens (hash, agent_id, created_at) VALUES (?, ?, ?)");
  const remove = db.prepare("DELETE FROM agent_tokens WHERE agent_id = ?");
  const find = db.prepare("SELECT agent_id FROM agent_tokens WHERE hash = ?");
  return {
    issue(agentId) {
      const token = newToken("awa");
      insert.run(hash(token).toString("hex"), agentId, new Date().toISOString());
      return token;
    },
    revoke(agentId) {
      remove.run(agentId);
    },
    agentOf(token) {
      const row = find.get(hash(token).toString("hex")) as { agent_id: string } | undefined;
      return row?.agent_id;
    },
  };
}

/** Who a bearer token is, or undefined for none or an unknown one. */
export function callerOf(header: string | undefined, admin: string, agentOf: (token: string) => string | undefined): Caller | undefined {
  const token = /^Bearer\s+(\S+)$/i.exec(header ?? "")?.[1];
  if (!token) return undefined;
  if (timingSafeEqual(hash(token), hash(admin))) return { kind: "person" };
  const agentId = agentOf(token);
  return agentId ? { kind: "agent", agentId } : undefined;
}
