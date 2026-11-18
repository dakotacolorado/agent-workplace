#!/usr/bin/env bash
# Sets up and starts agent-workplace on macOS or Linux. Safe to run again:
# it installs only what is missing and reuses an app already running.
#
#   curl -fsSL https://raw.githubusercontent.com/dakotacolorado/agent-workplace/main/scripts/setup.sh | bash
#
# AGENT_WORKPLACE_YES=1 installs what is missing without asking.
set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { printf 'setup: %s\n' "$*" >&2; exit 1; }

# Asks a yes/no question on the terminal, even when this script is piped in.
confirm() {
  [ "${AGENT_WORKPLACE_YES:-}" = 1 ] && return 0
  local answer
  if [ -r /dev/tty ] && printf '%s [y/N] ' "$1" >/dev/tty 2>/dev/null && read -r answer </dev/tty; then
    case "$answer" in y | Y | yes | YES) return 0 ;; esac
  fi
  return 1
}

# Installs a package with Homebrew, or says what to do where there is none.
brew_install() {
  local pkg=$1 hint=$2
  command -v brew >/dev/null 2>&1 || die "$pkg is missing and Homebrew is not installed. $hint"
  confirm "Install $pkg with Homebrew?" || die "$pkg is needed. Install it ($hint) and run this again."
  brew install "$pkg"
}

node_ok() {
  command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ]
}

if node_ok; then
  say "node $(node -v): ok"
else
  brew_install node "Install Node 24 or later from https://nodejs.org and run this again."
  node_ok || die "Node 24 or later is needed; brew installed $(node -v 2>/dev/null || echo none). Run 'brew upgrade node' and try again."
fi

if command -v gh >/dev/null 2>&1; then
  say "gh: ok"
else
  brew_install gh "Install it from https://cli.github.com and run this again."
fi

if command -v claude >/dev/null 2>&1; then
  say "claude: ok"
else
  confirm "Install Claude Code with npm (npm install -g @anthropic-ai/claude-code)?" || die "Claude Code is needed. Run 'npm install -g @anthropic-ai/claude-code' and run this again."
  npm install -g @anthropic-ai/claude-code || die "npm could not install Claude Code globally. Fix npm's global folder permissions, or run it with sudo, and run this again."
fi

gh auth status >/dev/null 2>&1 || die "gh is not signed in. Run: gh auth login   then run this again."
if [ -z "${ANTHROPIC_API_KEY:-}" ] && ! claude auth status >/dev/null 2>&1; then
  die "Claude Code is not signed in. Run: claude   then type /login, and run this again."
fi
say "logins: ok"

dir=${AGENT_WORKPLACE_DIR:-$HOME/.agent-workplace}
port=${AGENT_WORKPLACE_PORT:-4747}

# An app already answering on the port is reused, not started twice.
if curl -fsS "http://localhost:$port/health" >/dev/null 2>&1; then
  if [ -r "$dir/admin-token" ]; then
    say "agent-workplace is already running. Open it signed in:"
    say "http://localhost:$port/#signin=$(cat "$dir/admin-token")"
    exit 0
  fi
  die "something answers on port $port but it is not agent-workplace's data in $dir. Set AGENT_WORKPLACE_PORT to a free port."
fi

# Run from this checkout when the script is in one, else from GitHub.
here=
if [ -f "${BASH_SOURCE[0]:-}" ]; then here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd); fi
if [ -n "$here" ] && [ -f "$here/../package.json" ] && grep -q '"name": "agent-workplace"' "$here/../package.json"; then
  cd "$here/.."
  [ -f dist/cli.js ] || npm ci
  say "Starting agent-workplace (Ctrl-C stops it)."
  exec node dist/cli.js
fi
say "Starting agent-workplace (Ctrl-C stops it)."
exec npx --yes github:dakotacolorado/agent-workplace
