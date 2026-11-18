import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { SkillFile } from "../contracts.ts";
import type { SkillKind, Sort } from "./domain.ts";

export const MIGRATIONS = [
  `CREATE TABLE skills (
    name TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'hard',
    protected INTEGER NOT NULL DEFAULT 0,
    max_chars INTEGER,
    window_size INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE TABLE skill_versions (
    skill TEXT NOT NULL,
    version INTEGER NOT NULL,
    files TEXT NOT NULL,
    description TEXT NOT NULL,
    note TEXT NOT NULL,
    judgment TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (skill, version)
  );
  CREATE TABLE skill_judgments (
    id TEXT PRIMARY KEY,
    skill TEXT NOT NULL,
    by TEXT NOT NULL,
    actor TEXT,
    state TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    changed INTEGER,
    reasoning TEXT NOT NULL,
    error TEXT,
    version INTEGER,
    review TEXT
  );
  CREATE INDEX skill_judgments_skill ON skill_judgments (skill, started_at);
  CREATE TABLE skill_feedback (
    id TEXT PRIMARY KEY,
    skill TEXT NOT NULL,
    version INTEGER NOT NULL,
    text TEXT NOT NULL,
    quote TEXT,
    evidence TEXT,
    what_changed TEXT,
    files TEXT NOT NULL,
    author TEXT NOT NULL,
    at TEXT NOT NULL,
    judgment TEXT,
    sort TEXT,
    sort_why TEXT,
    sorted_by TEXT
  );
  CREATE INDEX skill_feedback_skill ON skill_feedback (skill, at);
  CREATE TABLE skill_pending (
    judgment TEXT PRIMARY KEY,
    skill TEXT NOT NULL,
    version INTEGER NOT NULL,
    note TEXT NOT NULL,
    files TEXT NOT NULL,
    at TEXT NOT NULL,
    closed INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE skill_seeded (name TEXT PRIMARY KEY, at TEXT NOT NULL);`,
];

export interface SkillRow {
  name: string;
  version: number;
  kind: SkillKind;
  /** While set, a revision the judge makes from feedback waits for the person to approve or decline it. */
  protected: boolean;
  /** Its own cap on its text; null for the default. */
  maxChars: number | null;
  /** For a soft skill, how many of its latest reports a judgment sees; null for the default. */
  window: number | null;
  createdAt: string;
}

export interface Version {
  skill: string;
  version: number;
  files: SkillFile[];
  description: string;
  note: string;
  /** The judgment that made it. */
  judgment: string;
  at: string;
}

export interface Review {
  by: string;
  approved: boolean;
  reason: string;
  at: string;
}

/** One change, or decision not to change, to a skill: the judge's from feedback, the person's by hand, or a starter. */
export interface Judgment {
  id: string;
  skill: string;
  by: "judge" | "person" | "starter";
  /** Who made a person's or module's change. */
  actor: string | null;
  /** pending: a revision of a protected skill, held until the person approves or declines it. */
  state: "running" | "pending" | "done" | "failed";
  startedAt: string;
  finishedAt: string | null;
  changed: boolean | null;
  reasoning: string;
  error: string | null;
  /** The version it made, if any. */
  version: number | null;
  /** The person's decision on a held revision. */
  review: Review | null;
}

/** A report on a skill as recorded. */
export interface Report {
  id: string;
  skill: string;
  /** The version it was about; 0 for a skill that did not exist yet. */
  version: number;
  /** Anything else said: for a new skill what it is for, for a soft skill the observation. */
  text: string;
  quote: string | null;
  evidence: string | null;
  whatChanged: string | null;
  files: SkillFile[];
  author: string;
  at: string;
  /** The judgment that considered it; null while it waits. */
  judgment: string | null;
  sort: Sort | null;
  sortWhy: string | null;
  sortedBy: string | null;
}

export interface Pending {
  judgment: string;
  skill: string;
  /** The version it was made from: it can be kept only while the skill is still that version. */
  version: number;
  note: string;
  files: SkillFile[];
  at: string;
}

type Row = Record<string, SQLInputValue>;

const skillRow = (r: Row): SkillRow => ({
  name: r.name as string,
  version: r.version as number,
  kind: r.kind as SkillKind,
  protected: r.protected === 1,
  maxChars: (r.max_chars as number | null) ?? null,
  window: (r.window_size as number | null) ?? null,
  createdAt: r.created_at as string,
});
const versionRow = (r: Row): Version => ({
  skill: r.skill as string,
  version: r.version as number,
  files: JSON.parse(r.files as string),
  description: r.description as string,
  note: r.note as string,
  judgment: r.judgment as string,
  at: r.at as string,
});
const judgmentRow = (r: Row): Judgment => ({
  id: r.id as string,
  skill: r.skill as string,
  by: r.by as Judgment["by"],
  actor: r.actor as string | null,
  state: r.state as Judgment["state"],
  startedAt: r.started_at as string,
  finishedAt: r.finished_at as string | null,
  changed: r.changed === null ? null : r.changed === 1,
  reasoning: r.reasoning as string,
  error: r.error as string | null,
  version: r.version as number | null,
  review: r.review ? JSON.parse(r.review as string) : null,
});
const reportRow = (r: Row): Report => ({
  id: r.id as string,
  skill: r.skill as string,
  version: r.version as number,
  text: r.text as string,
  quote: r.quote as string | null,
  evidence: r.evidence as string | null,
  whatChanged: r.what_changed as string | null,
  files: JSON.parse(r.files as string),
  author: r.author as string,
  at: r.at as string,
  judgment: r.judgment as string | null,
  sort: r.sort as Sort | null,
  sortWhy: r.sort_why as string | null,
  sortedBy: r.sorted_by as string | null,
});
const pendingRow = (r: Row): Pending => ({
  judgment: r.judgment as string,
  skill: r.skill as string,
  version: r.version as number,
  note: r.note as string,
  files: JSON.parse(r.files as string),
  at: r.at as string,
});

/** The skills module's tables. */
export class Store {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private all = (sql: string, ...args: SQLInputValue[]) => this.db.prepare(sql).all(...args) as Row[];
  private one = (sql: string, ...args: SQLInputValue[]) => this.db.prepare(sql).get(...args) as Row | undefined;
  private run = (sql: string, ...args: SQLInputValue[]) => void this.db.prepare(sql).run(...args);

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // Skills and versions

  skills(): SkillRow[] {
    return this.all("SELECT * FROM skills ORDER BY name").map(skillRow);
  }
  skill(name: string): SkillRow | undefined {
    const r = this.one("SELECT * FROM skills WHERE name = ?", name);
    return r ? skillRow(r) : undefined;
  }
  putVersion(v: Version, createdAt: string): void {
    this.run("INSERT INTO skill_versions (skill, version, files, description, note, judgment, at) VALUES (?, ?, ?, ?, ?, ?, ?)", v.skill, v.version, JSON.stringify(v.files), v.description, v.note, v.judgment, v.at);
    this.run("INSERT INTO skills (name, version, created_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET version = excluded.version", v.skill, v.version, createdAt);
  }
  deleteSkill(name: string): void {
    this.run("DELETE FROM skills WHERE name = ?", name);
  }
  set(name: string, field: "kind" | "protected" | "max_chars" | "window_size", value: SQLInputValue): void {
    this.run(`UPDATE skills SET ${field} = ? WHERE name = ?`, value, name);
  }
  version(name: string, version: number): Version | undefined {
    const r = this.one("SELECT * FROM skill_versions WHERE skill = ? AND version = ?", name, version);
    return r ? versionRow(r) : undefined;
  }
  versions(name: string): Version[] {
    return this.all("SELECT * FROM skill_versions WHERE skill = ? ORDER BY version", name).map(versionRow);
  }
  /** The highest version a skill has had, kept after it is deleted so a skill made again goes on from it. */
  lastVersion(name: string): number {
    return (this.one("SELECT MAX(version) AS v FROM skill_versions WHERE skill = ?", name)?.v as number | null) ?? 0;
  }

  // Judgments

  putJudgment(j: Judgment): void {
    this.run(
      `INSERT INTO skill_judgments (id, skill, by, actor, state, started_at, finished_at, changed, reasoning, error, version, review) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET state = excluded.state, finished_at = excluded.finished_at, changed = excluded.changed, reasoning = excluded.reasoning, error = excluded.error, version = excluded.version, review = excluded.review`,
      j.id, j.skill, j.by, j.actor, j.state, j.startedAt, j.finishedAt, j.changed === null ? null : j.changed ? 1 : 0, j.reasoning, j.error, j.version, j.review ? JSON.stringify(j.review) : null,
    );
  }
  judgment(id: string): Judgment | undefined {
    const r = this.one("SELECT * FROM skill_judgments WHERE id = ?", id);
    return r ? judgmentRow(r) : undefined;
  }
  /** A skill's judgments, newest first. */
  judgments(name: string, limit = 1000): Judgment[] {
    return this.all("SELECT * FROM skill_judgments WHERE skill = ? ORDER BY started_at DESC, rowid DESC LIMIT ?", name, limit).map(judgmentRow);
  }
  /** Judgments a stopped app left running: they never finish now. */
  failAbandoned(at: string): void {
    this.run("UPDATE skill_judgments SET state = 'failed', finished_at = ?, error = 'the app stopped while judging' WHERE state = 'running'", at);
  }

  // Feedback

  addReport(f: Report): void {
    this.run(
      "INSERT INTO skill_feedback (id, skill, version, text, quote, evidence, what_changed, files, author, at, judgment, sort, sort_why, sorted_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      f.id, f.skill, f.version, f.text, f.quote, f.evidence, f.whatChanged, JSON.stringify(f.files), f.author, f.at, f.judgment, f.sort, f.sortWhy, f.sortedBy,
    );
  }
  report(id: string): Report | undefined {
    const r = this.one("SELECT * FROM skill_feedback WHERE id = ?", id);
    return r ? reportRow(r) : undefined;
  }
  /** A skill's feedback, newest first. */
  reports(name: string, limit = 1000): Report[] {
    return this.all("SELECT * FROM skill_feedback WHERE skill = ? ORDER BY at DESC, rowid DESC LIMIT ?", name, limit).map(reportRow);
  }
  /** Feedback no judgment has considered, oldest first. */
  waiting(name?: string): Report[] {
    return (name === undefined
      ? this.all("SELECT * FROM skill_feedback WHERE judgment IS NULL ORDER BY at, rowid")
      : this.all("SELECT * FROM skill_feedback WHERE judgment IS NULL AND skill = ? ORDER BY at, rowid", name)
    ).map(reportRow);
  }
  /** A soft skill's window: its latest reports, oldest first. */
  window(name: string, size: number): Report[] {
    return this.all("SELECT * FROM skill_feedback WHERE skill = ? ORDER BY at DESC, rowid DESC LIMIT ?", name, size).map(reportRow).reverse();
  }
  /** The reports a judgment decided. */
  reportsOf(judgment: string): Report[] {
    return this.all("SELECT * FROM skill_feedback WHERE judgment = ? OR sorted_by = ? ORDER BY at, rowid", judgment, judgment).map(reportRow);
  }
  consider(ids: string[], judgment: string): void {
    for (const id of ids) this.run("UPDATE skill_feedback SET judgment = ? WHERE id = ? AND judgment IS NULL", judgment, id);
  }
  sortReport(id: string, sort: Sort, why: string, judgment: string): void {
    this.run("UPDATE skill_feedback SET sort = ?, sort_why = ?, sorted_by = ? WHERE id = ?", sort, why, judgment, id);
  }

  // Held revisions

  addPending(p: Pending): void {
    this.run("INSERT INTO skill_pending (judgment, skill, version, note, files, at) VALUES (?, ?, ?, ?, ?, ?)", p.judgment, p.skill, p.version, p.note, JSON.stringify(p.files), p.at);
  }
  pending(name: string): Pending | undefined {
    const r = this.one("SELECT * FROM skill_pending WHERE skill = ? AND closed = 0", name);
    return r ? pendingRow(r) : undefined;
  }
  closePending(judgment: string): void {
    this.run("UPDATE skill_pending SET closed = 1 WHERE judgment = ?", judgment);
  }

  // Seeding

  seeded(name: string): boolean {
    return this.one("SELECT 1 FROM skill_seeded WHERE name = ?", name) !== undefined;
  }
  markSeeded(name: string, at: string): void {
    this.run("INSERT OR IGNORE INTO skill_seeded (name, at) VALUES (?, ?)", name, at);
  }
}
