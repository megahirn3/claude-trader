# Deploying Claude Trader on a server

Goal: run the bot unattended on a small VPS (e.g. **Hetzner CX22, ~€4/mo**,
Ubuntu 24.04), reachable from your iPad, with **no secret ever committed to git**.

## One-command setup

```bash
# on the server, as a normal user with sudo
git clone https://github.com/megahirn3/claude-trader
cd claude-trader
bash deploy/setup.sh
```

`setup.sh` installs Node 22 + the Claude CLI, builds the app, and installs a
systemd service that auto-restarts and survives reboots. It creates `.env` from
the template but **never writes secrets** — you fill it in.

## Fill in your keys (the only place secrets live)

```bash
nano ~/claude-trader/.env
```

| Variable | Where to get it |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Run `claude setup-token` **on your own laptop** (needs a browser login), copy the token |
| `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY` | Alpaca dashboard → **Paper** API keys |
| `FINNHUB_API_KEY` | finnhub.io free tier (optional — broader real-time data) |
| `DISCORD_WEBHOOK_URL` | Discord channel → Edit → Integrations → Webhooks (optional) |

> `CLAUDE_CODE_OAUTH_TOKEN` is the one secret the server can't generate itself —
> `claude setup-token` opens a browser, so mint it on your laptop and paste the
> resulting string here. **Do not** set `ANTHROPIC_API_KEY` (that would bill the
> API instead of your subscription).

Then start it:

```bash
sudo systemctl restart claude-trader
journalctl -u claude-trader -f      # live logs
```

It boots in **paper mode**. Going live later is just `.env` edits
(`TRADING_MODE=live`, `ALLOW_LIVE_TRADING=true`, live Alpaca keys) + a restart.

## Reaching the dashboard safely (do NOT skip)

The dashboard has **no login** — never expose port 8787 to the public internet.

**Recommended — Tailscale** (free, works great from iPad):
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```
Install Tailscale on your iPad too, then open `http://<server-name>:8787` in
Safari. Only your devices can reach it.

Also lock the cloud firewall to **SSH only** (Hetzner Cloud Console → Firewalls),
and leave 8787 closed to the world — Tailscale doesn't need it open.

## Updating to a new version

```bash
cd ~/claude-trader
git pull
npm install && npm run build
sudo systemctl restart claude-trader
```

## Useful commands

| | |
|---|---|
| Status | `systemctl status claude-trader` |
| Live logs | `journalctl -u claude-trader -f` |
| Stop / start | `sudo systemctl stop\|start claude-trader` |
| Disable autostart | `sudo systemctl disable claude-trader` |

## Notes

- Data (run history, journal, watchlist) lives in `server/data/` (SQLite,
  git-ignored). Back it up if you care about the history.
- The systemd unit stores **no secrets** — it only points at the working
  directory; the app loads `.env` itself.
