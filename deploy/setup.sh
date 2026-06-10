#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Claude Trader — one-command server setup (Ubuntu/Debian).
#
# Installs Node 22 + the Claude CLI, builds the app, and installs a systemd
# service that keeps it running and restarts it on reboot.
#
# It NEVER writes secrets: all keys live in ./.env (git-ignored), which you fill
# in yourself. Run this from the repo root:
#
#     bash deploy/setup.sh
#
# Re-running is safe (idempotent).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say() { printf "\n\033[1;36m▸ %s\033[0m\n" "$1"; }
warn() { printf "\033[1;33m  ! %s\033[0m\n" "$1"; }

SERVICE_NAME="claude-trader"
RUN_USER="${SUDO_USER:-$(whoami)}"

# ── 1. Node.js 22 ─────────────────────────────────────────────────────────────
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -ge 18 ]; then need_node=0; fi
fi
if [ "$need_node" -eq 1 ]; then
  say "Installing Node.js 22…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  say "Node $(node -v) already present — skipping."
fi

# ── 2. Claude CLI (the Agent SDK shells out to it) ────────────────────────────
if ! command -v claude >/dev/null 2>&1; then
  say "Installing the Claude CLI…"
  sudo npm install -g @anthropic-ai/claude-code
else
  say "Claude CLI already present — skipping."
fi

# ── 3. Dependencies + build ───────────────────────────────────────────────────
say "Installing dependencies…"
npm install

say "Building the dashboard…"
npm run build

# ── 4. .env (you fill this in — no secrets are written here) ───────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  warn ".env created from the template — you MUST edit it before the bot can run:"
  warn "    nano $ROOT/.env"
  warn "Set CLAUDE_CODE_OAUTH_TOKEN, ALPACA_API_KEY_ID/SECRET, and (optional) FINNHUB_API_KEY / DISCORD_WEBHOOK_URL."
else
  say ".env already exists — leaving it untouched."
fi

# ── 5. systemd service ────────────────────────────────────────────────────────
say "Installing the systemd service…"
NPM_BIN="$(command -v npm)"
NODE_DIR="$(dirname "$(command -v node)")"
RUN_HOME="$(getent passwd "${RUN_USER}" | cut -d: -f6)"; RUN_HOME="${RUN_HOME:-/root}"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

sed \
  -e "s#__USER__#${RUN_USER}#g" \
  -e "s#__ROOT__#${ROOT}#g" \
  -e "s#__NPM__#${NPM_BIN}#g" \
  -e "s#__HOME__#${RUN_HOME}#g" \
  -e "s#__PATH__#${NODE_DIR}:/usr/bin:/bin:/usr/local/bin#g" \
  deploy/claude-trader.service | sudo tee "$SERVICE_PATH" >/dev/null

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true

cat <<EOF

$(printf "\033[1;32m✓ Setup complete.\033[0m")

Next:
  1. Fill in your keys:        nano $ROOT/.env
  2. Start the bot:            sudo systemctl restart $SERVICE_NAME
  3. Watch the logs:           journalctl -u $SERVICE_NAME -f
  4. Open the dashboard:       http://<this-server>:\${PORT:-8787}

The bot starts in PAPER mode. Keep it there for the test week.

⚠  Do NOT expose the dashboard to the public internet (it has no login).
   Use Tailscale (recommended) or an SSH tunnel — see deploy/README.md.
EOF
