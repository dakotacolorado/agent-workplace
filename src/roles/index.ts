import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context as HonoContext } from "hono";
import type { Caller, Role, Roles, SkillFile, StarterSkill } from "../contracts.ts";
import { tool, type Context, type Env, type Module } from "../module.ts";
import { DEFAULT_SKILLS } from "./defaults/index.ts";
import { PREFIX, ROLE_FILE, RoleFields, RoleRefusal, RoleSettingsSchema, SKILL_FILE, byPriority, checkRoleName, readRole, skillMd } from "./domain.ts";

export const INSTRUCTIONS = `A role says what kind of agent to start: the skills it reads, its model, its first message and its priority. list_roles shows every role, highest priority first; get_role one role with its text. Only the person creates or edits roles (create_role, update_role); a role is the skill roles/<name>, so feedback on it revises it like any skill.`;

const Settings = RoleFields.partial();
const Body = z.string().min(1).describe("What the agent is told first: the role's SKILL.md text, without frontmatter.");
const json = (schema: z.ZodType, description: string) => ({ description, content: { "application/json": { schema } } });
const err = z.object({ error: z.string() });
const errors = { 400: json(err, "Refused, with how to fix it."), 403: json(err, "Only the person may do this."), 404: json(err, "No such role.") };

/** Roles agents work in. Each is the skill `roles/<name>`; every call reads the skills afresh, so an edit applies to the next session. */
export function createRoles(opts: { log?: (line: string) => void; defaults?: StarterSkill[] } = {}): Module {
  const log = opts.log ?? ((line) => console.log(`roles: ${line}`));
  const defaults = opts.defaults ?? DEFAULT_SKILLS;
  return {
    name: "roles",
    migrations: [],
    create(ctx: Context) {
      const skills = () => ctx.services.skills;
      // The default roles and their shared skills, added once to a fresh library (one the person deleted stays deleted).
      // Seeded as soon as every module is created; every read waits for it.
      let seeding: Promise<void> | undefined;
      const seeded = () =>
        (seeding ??= skills()
          .seed(defaults)
          .then((added) => {
            if (added.length) log(`seeded ${added.join(", ")}`);
          })
          .catch((e) => log(`seeding the default roles failed: ${(e as Error).message}`)));
      queueMicrotask(() => void seeded());
      const person = (caller: Caller) => {
        if (caller.kind !== "person") throw new RoleRefusal("only the person creates or edits roles", 403);
      };

      const read = async (name: string) => {
        await seeded();
        const skill = await skills().get(PREFIX + name);
        if (!skill) return undefined;
        const r = readRole(skill);
        if ("invalid" in r) {
          log(`role ${name} left out: ${r.invalid}`);
          return undefined;
        }
        return r;
      };
      const readAll = async () => {
        await seeded();
        const out: Role[] = [];
        for (const skill of await skills().list()) {
          if (!skill.name.startsWith(PREFIX)) continue;
          const r = readRole(skill);
          if ("invalid" in r) log(`role ${skill.name.slice(PREFIX.length)} left out: ${r.invalid}`);
          else out.push(r.role);
        }
        return out.sort(byPriority);
      };
      const service: Roles = { list: readAll, get: async (name) => (await read(name))?.role };

      const view = (r: Role) => r;
      const write = async (name: string, files: SkillFile[], caller: Caller, note: string) => {
        const current = await skills().get(PREFIX + name);
        for (const f of files) {
          if (current?.files.find((x) => x.path === f.path)?.content === f.content) continue;
          await skills().writeFile(PREFIX + name, f, caller, note);
        }
      };
      const settingsFile = (s: unknown): SkillFile => ({ path: ROLE_FILE, content: JSON.stringify(s, null, 2) + "\n" });

      const create = async (a: { name: string; body: string } & z.infer<typeof Settings>, caller: Caller) => {
        person(caller);
        checkRoleName(a.name);
        await seeded();
        if (await skills().get(PREFIX + a.name)) throw new RoleRefusal(`a role named ${a.name} already exists; update_role changes it`, 400);
        const { name, body, ...rest } = a;
        const settings = RoleSettingsSchema.parse(rest);
        // SKILL.md first: a skill cannot exist without one.
        await write(name, [{ path: SKILL_FILE, content: skillMd(name, settings.summary, body) }, settingsFile(settings)], caller, `Created role ${name}`);
        return view((await read(name))!.role);
      };
      const update = async (a: { name: string; body?: string } & z.infer<typeof Settings>, caller: Caller) => {
        person(caller);
        const { name, body, ...rest } = a;
        const found = await read(name);
        if (!found) throw new RoleRefusal(`no valid role is named ${name}`, 404);
        const settings = RoleSettingsSchema.parse({ ...found.settings, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) });
        const text = body ?? found.role.instructions ?? "";
        await write(name, [{ path: SKILL_FILE, content: skillMd(name, settings.summary, text) }, settingsFile(settings)], caller, `Updated role ${name}`);
        return view((await read(name))!.role);
      };

      const answer = async (c: HonoContext<Env>, fn: () => Promise<unknown>) => {
        try {
          return c.json((await fn()) as never, 200);
        } catch (e) {
          if (e instanceof RoleRefusal) return c.json({ error: e.message }, e.status);
          if (e instanceof z.ZodError) return c.json({ error: e.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ") }, 400);
          if (e && typeof e === "object" && "status" in e && "message" in e) return c.json({ error: String((e as { message: unknown }).message) }, (e as { status: 400 | 403 | 404 | 409 }).status as 400);
          throw e;
        }
      };
      const nameOf = (c: HonoContext<Env>) => c.req.param("name") ?? "";
      const secured = { security: [{ bearer: [] }] };
      const Name = z.object({ name: z.string() });

      const routes = (api: OpenAPIHono<Env>) => {
        api.openapi(
          createRoute({ method: "get", path: "/", summary: "List roles", description: "Every valid role, highest priority first, then by name. A `roles/` skill with a missing or bad `role.json` is left out.", ...secured, responses: { 200: json(z.any(), "The roles."), ...errors } }),
          (async (c: HonoContext<Env>) => answer(c, async () => ({ roles: await readAll() }))) as never,
        );
        api.openapi(
          createRoute({ method: "get", path: "/{name}", summary: "Get role", description: "A role with its settings and the text its agents are told first.", ...secured, request: { params: Name }, responses: { 200: json(z.any(), "The role."), ...errors } }),
          (async (c: HonoContext<Env>) =>
            answer(c, async () => {
              const r = await read(nameOf(c));
              if (!r) throw new RoleRefusal(`no valid role is named ${nameOf(c)}`, 404);
              return { role: r.role };
            })) as never,
        );
        api.openapi(
          createRoute({
            method: "post",
            path: "/",
            summary: "Create role",
            description: "Writes the skill `roles/<name>`: its SKILL.md from `body` and its role.json from the settings, as new versions. Person only.",
            ...secured,
            request: { body: { content: { "application/json": { schema: RoleFields.partial({ skills: true, priority: true, capability: true, brief: true, whenDone: true }).extend({ name: z.string(), body: Body }) } }, required: true } },
            responses: { 200: json(z.any(), "The role."), ...errors },
          }),
          (async (c: HonoContext<Env>) => answer(c, async () => ({ role: await create(await c.req.json().catch(() => ({})), c.get("caller")) }))) as never,
        );
        api.openapi(
          createRoute({
            method: "patch",
            path: "/{name}",
            summary: "Update role",
            description: "Changes the text (`body`) and any settings given, as new versions of the skill; what is left out stays. Person only.",
            ...secured,
            request: { params: Name, body: { content: { "application/json": { schema: Settings.extend({ body: Body.optional() }) } }, required: true } },
            responses: { 200: json(z.any(), "The role."), ...errors },
          }),
          (async (c: HonoContext<Env>) => answer(c, async () => ({ role: await update({ ...(await c.req.json().catch(() => ({}))), name: nameOf(c) }, c.get("caller")) }))) as never,
        );
      };

      const tools = [
        tool({ name: "list_roles", title: "List roles", description: "Every valid role, highest priority first, then by name: its name, summary, skills, priority, capability, brief and whenDone.", input: {}, readOnly: true, run: async () => ({ roles: (await readAll()).map(({ instructions: _i, ...r }) => r) }) }),
        tool({
          name: "get_role",
          title: "Get a role",
          description: "One role with its settings and instructions, the text its agents are told first.",
          input: { name: z.string().describe("e.g. implementer") },
          readOnly: true,
          run: async ({ name }) => {
            const r = await read(name);
            if (!r) throw new RoleRefusal(`no valid role is named ${name}`, 404);
            return { role: r.role };
          },
        }),
        tool({
          name: "create_role",
          title: "Create a role",
          description: "Person only. Makes the skill roles/<name>: SKILL.md from body and role.json from the settings, as new versions.",
          input: { name: z.string().describe("Lowercase letters, digits and hyphens."), body: Body, ...Settings.shape },
          run: async (a, caller) => ({ role: await create(a, caller) }),
        }),
        tool({
          name: "update_role",
          title: "Update a role",
          description: "Person only. Changes a role's body and any settings given, as new versions of its skill; what is left out stays.",
          input: { name: z.string(), body: Body.optional(), ...Settings.shape },
          run: async (a, caller) => ({ role: await update(a, caller) }),
        }),
      ];

      return { service, routes, tools, instructions: INSTRUCTIONS };
    },
  };
}

export const roles: Module = createRoles();
