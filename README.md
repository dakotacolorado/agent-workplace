# agent-workplace

One app on one machine for working with Claude agents: tasks, a queue, agents
working in roles, and skills that sharpen from agents' feedback.

## Run it

Needs Node 24 or later.

```sh
npx github:dakotacolorado/agent-workplace
```

It prints a link that opens the page signed in. Its data is kept in
`~/.agent-workplace` (set `AGENT_WORKPLACE_DIR` to change it); it listens on
port 4747 (`AGENT_WORKPLACE_PORT`).

## Develop it

```sh
npm ci
npm run typecheck
npm test
npm run build
```

## License

MIT
