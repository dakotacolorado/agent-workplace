# agent-workplace

One Node process on one machine: tasks, a queue, agents working in roles, and
skills that sharpen from agents' feedback. Checks: `.claude/skills/test/SKILL.md`.

## Layout

- `src/cli.ts` reads `AGENT_WORKPLACE_DIR` (default `~/.agent-workplace`) and
  `AGENT_WORKPLACE_PORT` (default 4747), starts the app on 127.0.0.1 and prints
  the sign-in link.
- `src/app.ts` builds the app: the data folder, the database, auth, `/health`,
  `/api/docs`, `/api/me`, each module's routes under `/api/<module>/`, one
  `/mcp` with every module's tools, and the built page.
- `src/modules.ts` lists the modules; `src/module.ts` is what a module is
  (`name`, `migrations`, `create(ctx)` returning its service, routes, tools).
- `src/contracts.ts` holds the interfaces modules call each other by
  (`Tasks`, `Skills`, `Roles`, `Agents`). A module reaches another only
  through `ctx.services`, read at call time.
- `src/<module>/` holds everything of one module: `index.ts`, its migrations,
  routes, tools, tests, and its page files under `src/<module>/ui/`. Work on
  one module stays in its folder; a change to `contracts.ts` or `modules.ts`
  keeps every other module's entries.
- `src/ui/` is the page shell (Vite root): sign-in from `#signin=<token>`, the
  header and nav, routing. `src/ui/pages.ts` gathers each module's pages.
- Auth: the admin token (`<dir>/admin-token`, mode 600) is the person; each
  agent's token (issued by `ctx.tokens`) is that agent. Every `/api/*` route
  but `/api/docs`, and `/mcp`, gets `c.get("caller")`.

## Rules

- Tests never call Claude or any paid API: use fakes.
- This repo imports none of the workplace's own services (waypoint, honed,
  agency, agency-host, hopper, workplace-ui). Read them for behaviour; port it
  here.
- Migrations are appended, never edited once merged.
- Route summaries and tool titles are two or three words; the rest goes in the
  description.
