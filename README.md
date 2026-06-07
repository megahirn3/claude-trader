# Claude Trader

A full-stack, autonomous **equities trading bot driven by Claude** — that runs on
your **Claude Max/Pro subscription instead of the Anthropic API**. It researches
the market, forms theses, and manages a real portfolio through **Alpaca**, with a
live dashboard so you can watch every decision as it happens.

> ⚠️ **This is software for managing money. Read the [Safety](#safety) section.**
> It defaults to **paper trading** (simulated, fake money). Real-money trading is
> off by default and requires two explicit switches to enable.

---

## How it uses your Claude Max account (no API key)

The trick is the **[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)**
(`@anthropic-ai/claude-agent-sdk`). It's the same engine behind Claude Code, and
it can authenticate with your **Claude subscription** via an OAuth token instead
of a pay-as-you-go `ANTHROPIC_API_KEY`.

```
┌────────────┐    HTTP/SSE     ┌──────────────────┐   Agent SDK    ┌─────────────────┐
│  React     │ ◀────────────▶  │  Express server  │ ─────────────▶ │  Claude (your   │
│  dashboard │                 │  (the "broker")  │  (subscription │  Max subscription)│
└────────────┘                 └────────┬─────────┘   OAuth token) └─────────────────┘
                                        │ custom tools
                                        ▼
                               ┌──────────────────┐
                               │  Alpaca brokerage │  ← account, positions, market
                               │  (paper or live)  │     data, news, order placement
                               └──────────────────┘
```

The server gives Claude a set of **in-process tools** (account, positions, market
data, news, decision logging, order placement) plus the built-in **WebSearch /
WebFetch** tools for open-web research. Claude runs an agentic loop: assess →
research → decide → act, streaming every step to the dashboard.

**Why this works without the API:** when `CLAUDE_CODE_OAUTH_TOKEN` is set and
`ANTHROPIC_API_KEY` is **not**, the Agent SDK draws from your subscription. (If
both are set, the API key wins and you get billed — so leave it unset.)

---

## Quick start

### 0. Prerequisites
- **Node.js 18+** (22 recommended)
- The **Claude CLI** installed and logged into your Max/Pro account
  (`npm i -g @anthropic-ai/claude-code`, then `claude` once to log in)
- An **Alpaca** account → grab **paper** API keys from <https://alpaca.markets>

> **Is Alpaca the broker, or just an API?** Alpaca *is* the broker — Alpaca
> Securities (US, FINRA/SIPC) executes and custodies your orders and cash. It is
> not a bridge to another broker like Trade Republic (which has no trading API and
> can't be automated). **Paper** trading works anywhere; **live** Alpaca accounts
> aren't available in every country — check your country is supported before
> funding one. The bot and the per-trade cap behave identically either way.

### 1. Install
```bash
npm install
```

### 2. Mint a subscription token
```bash
npm run setup-token      # wraps `claude setup-token`
```
Copy the printed token.

### 3. Configure
```bash
cp .env.example .env
```
Edit `.env`:
```ini
CLAUDE_CODE_OAUTH_TOKEN=<the token from step 2>
ALPACA_API_KEY_ID=<your paper key id>
ALPACA_API_SECRET_KEY=<your paper secret>
# TRADING_MODE stays "paper" — do not change yet
```

### 4. Run
```bash
npm run dev
```
- Dashboard → <http://localhost:5173>
- API → <http://localhost:8787>

Click **▶ Run trading cycle** and watch Claude work.

### Production build
```bash
npm run build     # builds the frontend
npm start         # serves API + frontend from http://localhost:8787
```

---

## What the agent can do

| Capability | Tool(s) |
|---|---|
| Read account, cash, buying power, P&L | `get_account` |
| Inspect positions | `list_positions` |
| Check open/closed orders | `list_orders` |
| See if the market is open | `get_market_clock` |
| Real-time quotes & snapshots | `get_stock_snapshot` |
| Historical bars (technicals) | `get_stock_bars` |
| Market news headlines | `get_market_news` |
| Open-web research | `WebSearch`, `WebFetch` |
| Log a thesis for human review | `record_decision` |
| Place / cancel orders | `place_order`, `cancel_order` |

The agent is **explicitly denied** filesystem and shell access — it can only
research and trade.

---

## Daily autopilot (scheduler)

The bot runs itself at strategic points each **trading day** (weekends and
holidays are skipped automatically via Alpaca's calendar). All times are in
**US market time** (`America/New_York`) and configurable in `.env`.

| Time (ET) | Slot | Trades? | Purpose |
|---|---|---|---|
| **10:00** | Morning review | ✅ | Opening volatility has settled and the free 15‑min‑delayed data is meaningful — react to overnight news/gaps and set the day's plan |
| **12:30** | Midday check | ✅ | Confirm the morning thesis held; catch midday catalysts; trim/add |
| **15:45** | Pre‑close positioning | ✅ | Last actionable window — take profits, cut losers, manage overnight risk |
| **16:15** | End‑of‑day summary | ❌ **review only** | Market closed; final bars in — full‑day P&L recap, movers, what it did, watchlist for tomorrow |

The **end‑of‑day slot cannot trade** — its order tools are removed entirely, so
it's a guaranteed read‑only recap, not just a polite instruction.

Configure in `.env`:
```ini
SCHEDULE_ENABLED=true       # master switch
MORNING_TIME=10:00          # set any slot to "off" to disable it
MIDDAY_TIME=12:30
PRECLOSE_TIME=15:45
EOD_TIME=16:15
```
From the dashboard you can toggle the autopilot on/off and hit **run now** on any
slot to trigger it immediately (handy for testing). Every scheduled run appears,
labeled, in the run history and streams live just like a manual run.

> The server process must be running for the schedule to fire. Keep it up with a
> process manager (pm2, systemd, a container, etc.) for unattended operation.

## Safety

Money is hard to get back, so the design is defensive:

1. **Paper by default.** `TRADING_MODE=paper` routes all orders to Alpaca's
   simulator. Nothing touches real money.
2. **Two switches for live.** Real-money orders require **both**
   `TRADING_MODE=live` **and** `ALLOW_LIVE_TRADING=true`. Either one alone keeps
   you in paper mode.
3. **Per-trade size cap (% of portfolio).** `MAX_TRADE_PCT` (default `5`) caps
   every **buy** at that share of your *current* portfolio value — e.g. 5% of a
   $2,000 account is $100/trade — enforced server-side before any order is sent.
   It scales as your account grows, and sells are never size-capped.
4. **Decisions are logged before action.** The agent calls `record_decision`
   with its rationale, visible in the dashboard, before placing orders.
5. **Buying-power limits** are enforced by Alpaca itself.

Before going live: run in paper for a good while, review the decision logs, set a
conservative cap, and start small. **You are responsible for any trades placed.**
This is not financial advice.

---

## Project layout

```
claude-trader/
├── server/                 # Express API + Claude Agent driver
│   └── src/
│       ├── config.ts       # env, trading-mode + safety resolution
│       ├── alpaca.ts        # Alpaca REST client (trading + market data)
│       ├── tools.ts         # Claude tools (the agent's hands)
│       ├── agent.ts         # Agent SDK query loop + system prompt
│       ├── store.ts         # in-memory run/event store (+ SSE)
│       └── server.ts        # HTTP routes & SSE streaming
└── web/                    # React + Vite dashboard
    └── src/
        ├── App.tsx          # dashboard + live agent timeline
        ├── api.ts           # typed backend client
        └── styles.css
```

## API reference (server)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/config` | Model, trading mode, readiness flags |
| `GET` | `/api/account` | Alpaca account snapshot |
| `GET` | `/api/positions` | Open positions |
| `GET` | `/api/orders` | Recent orders |
| `GET` | `/api/clock` | Market open/closed |
| `GET` | `/api/portfolio-history` | Equity curve |
| `DELETE` | `/api/orders/:id` | Cancel an order |
| `POST` | `/api/runs` | Start an agent cycle (optional `{ prompt }`) |
| `GET` | `/api/runs` | List past runs |
| `GET` | `/api/runs/:id` | Full run with events |
| `GET` | `/api/runs/:id/stream` | SSE stream of a run's events |
| `GET` | `/api/schedule` | Autopilot state + slots + next-run times |
| `POST` | `/api/schedule` | Enable/disable autopilot (`{ enabled }`) |
| `POST` | `/api/schedule/run/:slot` | Trigger a slot now (`morning`/`midday`/`preclose`/`eod`) |

---

## Notes & limitations

- **In-memory state.** Run history is kept in process memory; restarting the
  server clears it. Swap `store.ts` for a database to persist.
- **Market data feed.** Uses Alpaca's free IEX feed. A paid SIP subscription
  gives fuller coverage; adjust `feed` in `alpaca.ts`.
- **Not financial advice.** An LLM can be wrong, overconfident, or misread data.
  Keep a human in the loop, especially before enabling live trading.
- **Subscription usage.** Heavy agent runs consume your Claude usage; long runs
  use more. Keep `MAX_TRADE_PCT` conservative and your own judgment as the guardrails.
