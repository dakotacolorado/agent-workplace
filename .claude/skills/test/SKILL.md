---
name: test
description: How to run agent-workplace's checks. Use before submitting a change to agent-workplace, and when reviewing one.
---

# Testing agent-workplace

One Node process (`dist/cli.js`) that serves the API, `/mcp` and the built
page (`dist/public`). It needs Node 24 and npm.

## The checks

Run these at the PR's head from the repo's root, each on its own, reading its
exit status (never `| tail`, which reports `tail`'s), with the workplace's
service variables unset so nothing reaches a live service:

```sh
npm ci
env -u HONED_URL -u HONED_TOKEN -u WAYPOINT_URL -u WAYPOINT_TOKEN -u JOBBER_URL -u JOBBER_TOKEN -u AGENCY_URL -u AGENCY_TOKEN -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN npm run typecheck; echo "exit $?"
env -u HONED_URL -u HONED_TOKEN -u WAYPOINT_URL -u WAYPOINT_TOKEN -u JOBBER_URL -u JOBBER_TOKEN -u AGENCY_URL -u AGENCY_TOKEN -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN npm test; echo "exit $?"
env -u HONED_URL -u HONED_TOKEN -u WAYPOINT_URL -u WAYPOINT_TOKEN -u JOBBER_URL -u JOBBER_TOKEN -u AGENCY_URL -u AGENCY_TOKEN -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN npm run build; echo "exit $?"
```

Each must exit 0. `npm run typecheck` checks the server and the page (two
tsconfigs); `npm test` is vitest, the page's tests under happy-dom; the tests
make their data folders under the system's temp folder and call no model.

## Looking at it

After `npm run build`, start it on a data folder of its own and a free port,
and open the link it prints:

```sh
AGENT_WORKPLACE_DIR="$(mktemp -d)" AGENT_WORKPLACE_PORT=4790 node dist/cli.js
```

`/health` answers without a token; `/api/docs` is the OpenAPI document, its
`x-mcp-tools` the tools `/mcp` serves.
