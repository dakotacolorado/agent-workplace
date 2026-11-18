import type { Skill, SkillFile } from "../contracts.ts";
import {
  applyEdits,
  applyFiles,
  body,
  checkName,
  checkSkill,
  DEFAULT_MAX_CHARS,
  DEFAULT_WINDOW,
  descriptionOf,
  HARD_JUDGE,
  isJudgeSkill,
  JUDGE_AUTHOR,
  JUDGMENT_ATTEMPTS,
  MAX_EVIDENCE,
  MIN_QUOTE,
  newId,
  now,
  PRECEDENT,
  quoted,
  Refusal,
  sameFiles,
  SKILL_FILE,
  SOFT_JUDGE,
  textSize,
  WRITING_SKILL,
  type SkillKind,
  type Sort,
} from "./domain.ts";
import type { Case, Decision, Judge } from "./judge.ts";
import type { Starter } from "./starters.ts";
import type { Judgment, Pending, Report, SkillRow, Store, Version } from "./store.ts";

export interface Summary {
  name: string;
  description: string;
  version: number;
  kind: SkillKind;
  protected: boolean;
  /** Characters of text, all files together, and the cap on it. */
  chars: number;
  limit: number;
  /** Feedback no judgment has considered yet. */
  waiting: number;
  /** Whether a revision waits for the person's approval. */
  pending: boolean;
  updatedAt: string;
}

/** What an agent or the person sends about a skill. */
export interface FeedbackInput {
  skill: string;
  quote?: string;
  evidence?: string;
  whatChanged?: string;
  text?: string;
  files?: SkillFile[];
}

/** What happens next to a report, so its sender is told the truth. */
export type Next = "judging" | "soft" | "protected" | "person" | "off";

export interface LibraryOptions {
  maxChars?: number;
  log?: (line: string) => void;
}

/** The skills, the feedback on them, and the judge that turns one into the next version of the other. */
export class Library {
  private store: Store;
  private judge: Judge | null;
  readonly maxChars: number;
  private log: (line: string) => void;
  private running = new Map<string, Promise<void>>();
  private dirty = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(store: Store, judge: Judge | null, opts: LibraryOptions = {}) {
    this.store = store;
    this.judge = judge;
    this.maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
    this.log = opts.log ?? (() => {});
  }

  /** Marks judgments a stopped app left running as failed, and judges what waits. */
  start(): void {
    this.store.failAbandoned(now());
    for (const name of new Set(this.store.waiting().map((f) => f.skill))) this.schedule(name);
  }

  /** One write at a time, so each version is made from the version it read. */
  private exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  /** Adds each starter this library has never held; one the person deleted stays deleted. Returns the names added. */
  seed(starters: Starter[]): Promise<string[]> {
    return this.exclusive(() => this.seedNow(starters));
  }

  /** `seed` at once, for the app's first start, before anything else can write. */
  seedNow(starters: Starter[]): string[] {
    {
      const added: string[] = [];
      for (const s of starters) {
        checkName(s.name);
        if (this.store.seeded(s.name) || this.store.skill(s.name)) {
          this.store.markSeeded(s.name, now());
          continue;
        }
        checkSkill(s.name, s.files, this.maxChars);
        const j = this.started(s.name, "starter");
        j.reasoning = "A starter skill that ships with agent-workplace.";
        j.version = this.commit(s.name, s.files, "Shipped with agent-workplace", j);
        this.finish(j, true, []);
        this.store.markSeeded(s.name, now());
        added.push(s.name);
      }
      return added;
    }
  }

  // Reading

  private summary(s: SkillRow): Summary {
    const v = this.store.version(s.name, s.version)!;
    return {
      name: s.name,
      description: v.description,
      version: s.version,
      kind: s.kind,
      protected: s.protected,
      chars: textSize(v.files),
      limit: this.limit(s.name),
      waiting: this.store.waiting(s.name).length,
      pending: this.store.pending(s.name) !== undefined,
      updatedAt: v.at,
    };
  }

  list(): Summary[] {
    return this.store.skills().map((s) => this.summary(s));
  }

  /** Skills whose name or description hold any word of `query`, best match first. */
  search(query: string, limit = 10): Summary[] {
    const words = query.toLowerCase().split(/[\s/,-]+/).filter(Boolean);
    if (!words.length) return [];
    return this.list()
      .map((s) => {
        const name = s.name.toLowerCase();
        const description = s.description.toLowerCase();
        return { s, score: words.reduce((n, w) => n + (name.includes(w) ? 3 : 0) + (description.includes(w) ? 1 : 0), 0) };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name))
      .slice(0, limit)
      .map((x) => x.s);
  }

  row(name: string): SkillRow {
    const s = this.store.skill(name);
    if (!s) throw new Refusal(`no skill is named ${name}`, 404);
    return s;
  }

  /** A skill at its latest version, or at `version`; undefined if it has none. */
  get(name: string, version?: number): (Skill & { kind: SkillKind; protected: boolean }) | undefined {
    const s = this.store.skill(name);
    if (!s) return undefined;
    const v = this.store.version(name, version ?? s.version);
    if (!v) return undefined;
    return { name, description: v.description, version: v.version, files: v.files, updatedAt: v.at, kind: s.kind, protected: s.protected };
  }

  private current(name: string): SkillFile[] {
    const s = this.store.skill(name);
    return s ? this.store.version(name, s.version)!.files : [];
  }

  /** A skill's versions, each with the judgment that made it, and every judgment with the reports it decided; newest first. */
  history(name: string): { versions: (Omit<Version, "files" | "judgment"> & { judgment: Judgment | undefined })[]; judgments: (Judgment & { reports: Report[] })[] } {
    if (!this.store.skill(name) && this.store.lastVersion(name) === 0 && this.store.reports(name, 1).length === 0) throw new Refusal(`no skill is named ${name}`, 404);
    return {
      versions: this.store
        .versions(name)
        .reverse()
        .map(({ files: _, ...v }) => ({ ...v, judgment: this.store.judgment(v.judgment) })),
      judgments: this.store.judgments(name).map((j) => ({ ...j, reports: this.store.reportsOf(j.id) })),
    };
  }

  feedback(name: string): Report[] {
    return this.store.reports(name);
  }

  pending(name: string): Pending | undefined {
    return this.store.pending(name);
  }

  limit(name: string): number {
    return this.store.skill(name)?.maxChars ?? this.maxChars;
  }

  window(name: string): number {
    return this.store.skill(name)?.window ?? DEFAULT_WINDOW;
  }

  /** Resolves once no judgment is running. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running.values()]);
  }

  // Feedback

  /**
   * A report on a skill, an observation on a soft one, or a request for a skill that does not exist yet. Each is checked
   * here, so the sender hears at once how to fix it and the judge reads only ones that hold.
   */
  submitFeedback(input: FeedbackInput, author: string): { report: Report; next: Next } {
    const name = checkName(input.skill);
    const skill = this.store.skill(name);
    const current = this.current(name);
    const text = (input.text ?? "").trim();
    let quote: string | null = (input.quote ?? "").trim() || null;
    const evidence = (input.evidence ?? "").trim() || null;
    const whatChanged = (input.whatChanged ?? "").trim() || null;
    if (evidence && evidence.length > MAX_EVIDENCE) throw new Refusal(`the evidence holds ${evidence.length} characters, over ${MAX_EVIDENCE}: keep only what shows the quote is wrong`);
    if (skill) {
      if (skill.kind === "hard") {
        if (!quote) throw new Refusal(`a report on ${name} needs quote: the exact text in the skill that is wrong or out of date, copied from get_skill`);
        if (!evidence) throw new Refusal("a report needs evidence: a file as it is now, or a command you ran and what it printed");
        if (!whatChanged) throw new Refusal("a report needs what_changed: what you did instead of what the quoted text says, or what you changed that it describes");
      } else if (!quote && !text) {
        throw new Refusal(`an observation on ${name} needs feedback: what you saw the person do or say, in a sentence or two`);
      }
      if (quote && quote.length < MIN_QUOTE) throw new Refusal(`"${quote}" is too short to say which text it is about: quote the whole sentence or line from ${name}`);
      if (quote && !quoted(quote, current)) throw new Refusal(`this text is not in ${name} as it is now (v${skill.version}); get_skill it again and quote it exactly: "${quote.slice(0, 200)}"`);
    } else {
      if (!text) throw new Refusal(`no skill is named ${name} yet: to ask for it, say in feedback what it is for, and draft its ${SKILL_FILE} following ${WRITING_SKILL}`);
      quote = null;
    }
    const files = input.files ?? [];
    if (files.length) {
      const size = textSize(applyFiles(current, files));
      if (size > this.limit(name)) throw new Refusal(`with your draft the skill would hold ${size} characters, over its cap of ${this.limit(name)}: condense it`);
    }
    const report: Report = {
      id: newId(),
      skill: name,
      version: skill?.version ?? 0,
      text,
      quote,
      evidence: skill ? evidence : null,
      whatChanged: skill ? whatChanged : null,
      files,
      author,
      at: now(),
      judgment: null,
      sort: null,
      sortWhy: null,
      sortedBy: null,
    };
    this.store.addReport(report);
    this.schedule(name);
    const next: Next = !this.judge ? "off" : isJudgeSkill(name) ? "person" : skill?.kind === "soft" ? "soft" : skill?.protected ? "protected" : "judging";
    return { report, next };
  }

  // What the person does

  /** The person's change to a skill's files, kept at once as a version; makes the skill if it is new. */
  edit(name: string, change: { write?: SkillFile[]; remove?: string[] }, reason: string, actor: string): Promise<Judgment> {
    return this.exclusive(() => {
      checkName(name);
      const before = this.current(name);
      const writes = (change.write ?? []).map((w) => ({ ...w, executable: w.executable ?? before.find((f) => f.path === w.path)?.executable }));
      const files = applyFiles(before, writes, change.remove ?? []);
      checkSkill(name, files, this.limit(name), before.length ? textSize(before) : undefined);
      if (before.length && sameFiles(before, files)) throw new Refusal("the change leaves the skill as it is", 409);
      const what = [...writes.map((f) => f.path), ...(change.remove ?? []).map((p) => `${p} removed`)].join(", ");
      const j = this.started(name, "person", actor);
      j.reasoning = reason.trim() || `Edited ${what}.`;
      j.version = this.commit(name, files, `Edited by hand: ${what}`, j);
      this.finish(j, true, []);
      return j;
    });
  }

  revert(name: string, to: number, reason: string, actor: string): Promise<Judgment> {
    return this.exclusive(() => {
      const skill = this.row(name);
      if (!Number.isInteger(to) || to < 1 || to >= skill.version) throw new Refusal(`${name} can be reverted to a version from 1 to ${skill.version - 1}`);
      const files = this.store.version(name, to)!.files;
      checkSkill(name, files, this.limit(name), textSize(this.current(name)));
      const j = this.started(name, "person", actor);
      j.reasoning = reason.trim() || `Reverted to version ${to}.`;
      j.version = this.commit(name, files, `Revert to version ${to}`, j);
      this.finish(j, true, []);
      return j;
    });
  }

  /** Takes a skill out of the library. Its versions and feedback stay on record; waiting feedback is closed with it. */
  delete(name: string, reason: string, actor: string): Promise<Judgment> {
    return this.exclusive(() => {
      if (isJudgeSkill(name)) throw new Refusal(`${name} is how the judge decides ${name === HARD_JUDGE ? "every hard" : "every soft"} skill, so it cannot be deleted; edit or revert it instead`, 409);
      const skill = this.row(name);
      const j = this.started(name, "person", actor);
      j.reasoning = reason.trim() || `Deleted at version ${skill.version}.`;
      const held = this.store.pending(name);
      this.store.transaction(() => {
        this.store.deleteSkill(name);
        if (held) this.review(this.store.judgment(held.judgment)!, held, false, "The skill was deleted.", actor);
      });
      this.finish(j, true, this.store.waiting(name).map((f) => f.id));
      return j;
    });
  }

  /** The person's settings on a skill: how it is judged, whether a revision waits for approval, its cap and window. */
  configure(name: string, change: { kind?: SkillKind; protected?: boolean; maxChars?: number | null; window?: number | null }): SkillRow {
    this.row(name);
    if (change.kind !== undefined) {
      if (change.kind !== "hard" && change.kind !== "soft") throw new Refusal("kind must be hard or soft");
      if (isJudgeSkill(name) && change.kind !== "hard") throw new Refusal(`${name} is the judge's own guidance: it stays hard`, 409);
    }
    if (change.maxChars != null && (!Number.isInteger(change.maxChars) || change.maxChars < 1)) throw new Refusal("a cap is a whole number of characters, at least 1, or null for the default");
    if (change.window != null && (!Number.isInteger(change.window) || change.window < 1 || change.window > 200)) throw new Refusal(`a window is a whole number of reports from 1 to 200, or null for the default (${DEFAULT_WINDOW})`);
    this.store.transaction(() => {
      if (change.kind !== undefined) this.store.set(name, "kind", change.kind);
      if (change.protected !== undefined) this.store.set(name, "protected", change.protected ? 1 : 0);
      if (change.maxChars !== undefined) this.store.set(name, "max_chars", change.maxChars);
      if (change.window !== undefined) this.store.set(name, "window_size", change.window);
    });
    if (change.protected === false || change.kind !== undefined) this.schedule(name);
    return this.row(name);
  }

  /** Keeps a held revision as the next version, if the skill is still the version it was made from. */
  approve(name: string, reason: string, actor: string): Promise<Judgment> {
    return this.exclusive(() => {
      const skill = this.row(name);
      const held = this.held(name);
      if (held.version !== skill.version) throw new Refusal(`${name} changed since this revision was made from v${held.version} (it is v${skill.version} now): decline it`, 409);
      checkSkill(name, held.files, this.limit(name), textSize(this.current(name)));
      const j = this.store.judgment(held.judgment)!;
      j.version = this.commit(name, held.files, held.note, j);
      this.store.transaction(() => this.review(j, held, true, reason, actor));
      this.schedule(name);
      return j;
    });
  }

  /** Discards a held revision: the skill stays as it is, and the decision is kept in its history. */
  decline(name: string, reason: string, actor: string): Promise<Judgment> {
    return this.exclusive(() => {
      this.row(name);
      const held = this.held(name);
      const j = this.store.judgment(held.judgment)!;
      this.store.transaction(() => this.review(j, held, false, reason, actor));
      this.schedule(name);
      return j;
    });
  }

  private held(name: string): Pending {
    const held = this.store.pending(name);
    if (!held) throw new Refusal(`no revision of ${name} is waiting for approval`, 404);
    return held;
  }

  private review(j: Judgment, held: Pending, approved: boolean, reason: string, actor: string): void {
    Object.assign(j, { state: "done", finishedAt: now(), changed: approved, review: { by: actor, approved, reason: reason.trim(), at: now() } });
    this.store.putJudgment(j);
    this.store.closePending(held.judgment);
  }

  /** Has the judge consider a skill now, whatever feedback waits: the only way the judge skills change from feedback. */
  judgeNow(name: string): void {
    if (!this.judge) throw new Refusal("the app was started without a judge", 409);
    this.row(name);
    if (this.store.pending(name)) throw new Refusal(`a revision of ${name} waits for your approval: approve or decline it first`, 409);
    this.schedule(name, true);
  }

  // Judging

  private started(skill: string, by: Judgment["by"], actor: string | null = null): Judgment {
    const j: Judgment = { id: newId(), skill, by, actor, state: "running", startedAt: now(), finishedAt: null, changed: null, reasoning: "", error: null, version: null, review: null };
    this.store.putJudgment(j);
    return j;
  }

  private commit(name: string, files: SkillFile[], note: string, j: Judgment): number {
    const version = this.store.lastVersion(name) + 1;
    const createdAt = this.store.skill(name)?.createdAt ?? now();
    files = [...files].sort((a, b) => a.path.localeCompare(b.path));
    this.store.transaction(() => this.store.putVersion({ skill: name, version, files, description: descriptionOf(files), note, judgment: j.id, at: now() }, createdAt));
    return version;
  }

  private finish(j: Judgment, changed: boolean, feedback: string[]): void {
    this.store.transaction(() => {
      this.store.consider(feedback, j.id);
      Object.assign(j, { state: "done", finishedAt: now(), changed });
      this.store.putJudgment(j);
    });
  }

  /** Asks for a judgment on a skill when its feedback calls for one; one at a time per skill. */
  private schedule(name: string, asked = false): void {
    if (!this.judge) return;
    // The judge skills change from feedback only when the person asks.
    if (isJudgeSkill(name) && !asked) return;
    if (this.store.pending(name)) return;
    if (this.running.has(name)) {
      if (!asked) this.dirty.add(name);
      return;
    }
    const run = this.judgeSkill(name, asked)
      .catch((e) => this.log(`judging ${name} failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        this.running.delete(name);
        if (this.dirty.delete(name)) this.schedule(name);
      });
    this.running.set(name, run);
  }

  private due(c: Case): boolean {
    if (c.asked) return c.files.length > 0;
    if (c.kind === "soft") return c.feedback.some((f) => f.sort === null && f.judgment === null);
    return c.feedback.length > 0;
  }

  private gather(name: string, failure: string | null, asked: boolean): Case {
    const skill = this.store.skill(name);
    const version = skill?.version ?? 0;
    const kind = skill?.kind ?? "hard";
    const guide = (n: string) => body(this.current(n).find((f) => f.path === SKILL_FILE)?.content ?? "");
    return {
      skill: name,
      version,
      kind,
      maxChars: this.limit(name),
      files: this.current(name),
      others: this.list()
        .filter((s) => s.name !== name)
        .slice(0, 50)
        .map((s) => ({ name: s.name, description: s.description })),
      feedback: kind === "soft" ? this.store.window(name, this.window(name)) : this.store.waiting(name),
      window: this.window(name),
      precedent: this.store
        .judgments(name, PRECEDENT * 2)
        .filter((j) => j.state === "done" && j.by === "judge")
        .slice(0, PRECEDENT)
        .map((j) => ({ ...j, feedback: this.store.reportsOf(j.id) })),
      asked,
      failure,
      guidance: guide(kind === "soft" ? SOFT_JUDGE : HARD_JUDGE),
      writingGuide: version === 0 ? guide(WRITING_SKILL) || null : null,
    };
  }

  private async judgeSkill(name: string, asked: boolean): Promise<void> {
    let failure: string | null = null;
    for (let attempt = 1; attempt <= JUDGMENT_ATTEMPTS; attempt++) {
      const c = this.gather(name, failure, asked);
      if (!this.due(c)) return;
      const j = this.started(name, "judge");
      this.log(`judging ${name}${attempt > 1 ? ` (attempt ${attempt})` : ""}…`);
      try {
        const decision = await this.judge!.decide(c);
        await this.exclusive(() => this.apply(c, j, decision));
        this.log(j.state === "pending" ? `${name}: a revision waits for your approval` : j.changed ? `${name} → v${j.version}: ${decision.note.trim()}` : `${name} unchanged`);
        return;
      } catch (e) {
        Object.assign(j, { state: "failed", finishedAt: now(), error: e instanceof Error ? e.message : String(e) });
        this.store.putJudgment(j);
        this.log(`${name} could not be judged: ${j.error}`);
        if (e instanceof Outdated) {
          this.dirty.add(name);
          return;
        }
        failure = j.error;
      }
    }
  }

  /** Makes a decision so, if the skill is still the version it was made on and the result is a skill the library can keep. */
  private apply(c: Case, j: Judgment, d: Decision): void {
    if ((this.store.skill(c.skill)?.version ?? 0) !== c.version) throw new Outdated(`${c.skill} changed while the judge was deciding`);
    const sorts = checkSorts(c, d);
    j.reasoning = d.reasoning;
    let change: { files: SkillFile[]; note: string } | null = null;
    if (d.revert_to !== 0) {
      if (!d.changed) throw new Refusal("revert_to restores an earlier version, a change: set changed true, or revert_to 0");
      if (d.edits.length || d.write.length || d.remove.length) throw new Refusal("revert_to restores an earlier version whole: leave edits, write and remove empty, or revert_to 0 and edit");
      if (!Number.isInteger(d.revert_to) || d.revert_to < 1 || d.revert_to >= c.version) throw new Refusal(`revert_to must be a version from 1 to ${c.version - 1}, or 0`);
      const files = this.store.version(c.skill, d.revert_to)!.files;
      checkSkill(c.skill, files, c.maxChars, textSize(c.files));
      const undone = this.store
        .versions(c.skill)
        .filter((v) => v.version > d.revert_to)
        .flatMap((v) => this.store.reportsOf(v.judgment).map((f) => `report ${f.id.slice(0, 8)} by ${f.author} (v${v.version})`));
      const by = c.feedback.filter((f) => sorts.get(f.id)?.kind === "accepted").map((f) => `report ${f.id.slice(0, 8)} by ${f.author}`);
      j.reasoning = `${d.reasoning.trim()}\n\nReverts to v${d.revert_to}, undoing ${undone.join(", ") || "changes made without a report"}; contradicted by ${by.join(", ") || "no new report"}.`;
      change = { files, note: d.note.trim() || `Revert to version ${d.revert_to}` };
    } else if (d.changed) {
      if (!d.edits.length && !d.write.length && !d.remove.length) throw new Refusal("you said you changed the skill but edited, wrote and removed nothing");
      const files = applyFiles(applyEdits(c.files, d.edits), d.write, d.remove);
      checkSkill(c.skill, files, c.maxChars, c.files.length ? textSize(c.files) : undefined);
      if (sameFiles(c.files, files)) throw new Refusal("the change leaves the skill as it is: set changed false, or change it");
      change = { files, note: d.note.trim() || "Changed from feedback" };
    }
    const protect = change !== null && this.store.skill(c.skill)?.protected === true;
    if (change && !protect) j.version = this.commit(c.skill, change.files, change.note, j);
    const considered = c.feedback.filter((f) => f.judgment === null).map((f) => f.id);
    this.store.transaction(() => {
      for (const f of c.feedback) {
        const s = sorts.get(f.id);
        if (s) this.store.sortReport(f.id, s.kind, s.why, j.id);
      }
      this.store.consider(considered, j.id);
      if (change && protect) {
        this.store.addPending({ judgment: j.id, skill: c.skill, version: c.version, note: change.note, files: change.files, at: now() });
        Object.assign(j, { state: "pending", finishedAt: now(), changed: null });
      } else {
        Object.assign(j, { state: "done", finishedAt: now(), changed: change !== null });
      }
      this.store.putJudgment(j);
    });
    // One level of self-review: the judge may note what its guidance gets wrong while judging any other skill.
    const note = d.judge_feedback.trim();
    const guide = c.kind === "soft" ? SOFT_JUDGE : HARD_JUDGE;
    const guideRow = this.store.skill(guide);
    if (note && !isJudgeSkill(c.skill) && guideRow) {
      this.store.addReport({ id: newId(), skill: guide, version: guideRow.version, text: note, quote: null, evidence: null, whatChanged: null, files: [], author: `${JUDGE_AUTHOR} (judging ${c.skill})`, at: now(), judgment: null, sort: null, sortWhy: null, sortedBy: null });
    }
  }
}

class Outdated extends Error {}

/**
 * How the judge sorted each report, refusing a decision that leaves one undecided, names one not in the case, holds one
 * on a hard skill, sorts again one already closed, or changes the skill while accepting none, unless the person asked.
 */
function checkSorts(c: Case, d: Decision): Map<string, { kind: Sort; why: string }> {
  const soft = c.kind === "soft";
  const byShort = new Map(c.feedback.map((f) => [f.id.slice(0, 8), f]));
  const sorts = new Map<string, { kind: Sort; why: string }>();
  for (const s of d.sorted) {
    const f = byShort.get(s.report.trim().slice(0, 8));
    if (!f) throw new Refusal(`sorted names report ${s.report}, which is not in this case: sort only the reports given, by their id`);
    if (!soft && s.kind === "held") throw new Refusal(`report ${s.report} is sorted held, but ${c.skill} is a hard skill: decide every report as accepted or declined, now`);
    if (soft && (f.sort === "accepted" || f.sort === "declined")) throw new Refusal(`report ${s.report} was ${f.sort} before and is closed: sort only new reports and held ones`);
    sorts.set(f.id, { kind: s.kind as Sort, why: s.why.trim() });
  }
  if (c.asked) return sorts;
  const toDecide = soft ? c.feedback.filter((f) => f.sort === null && f.judgment === null) : c.feedback.filter((f) => f.quote !== null);
  const missing = toDecide.filter((f) => !sorts.has(f.id));
  if (missing.length) throw new Refusal(`decide every ${soft ? "new " : ""}report, with why: ${missing.map((f) => f.id.slice(0, 8)).join(", ")} ${missing.length === 1 ? "is" : "are"} not decided`);
  const changes = d.changed || d.revert_to !== 0;
  if (changes && c.files.length > 0 && (soft || toDecide.length > 0) && ![...sorts.values()].some((s) => s.kind === "accepted")) {
    throw new Refusal("you accepted no report here, so nothing calls for a change: leave the skill unchanged, or accept the reports the change comes from");
  }
  return sorts;
}
