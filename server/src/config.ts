import "dotenv/config";

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

const tradingMode = (process.env.TRADING_MODE ?? "paper").toLowerCase() === "live" ? "live" : "paper";
const allowLiveTrading = bool(process.env.ALLOW_LIVE_TRADING, false);

// Live trading is only actually enabled when BOTH the mode is "live" AND the
// explicit safety switch is flipped. Otherwise we fall back to paper.
const liveEnabled = tradingMode === "live" && allowLiveTrading;

export const config = {
  port: Number(process.env.PORT ?? 8787),

  claude: {
    model: process.env.CLAUDE_MODEL ?? "claude-opus-4-8",
    // True when an OAuth subscription token is present and no API key is forcing
    // pay-as-you-go billing.
    hasOAuthToken: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN),
    hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
  },

  alpaca: {
    keyId: process.env.ALPACA_API_KEY_ID ?? "",
    secretKey: process.env.ALPACA_API_SECRET_KEY ?? "",
    // Trading endpoint depends on whether we're live or paper.
    tradingBaseUrl: liveEnabled
      ? "https://api.alpaca.markets"
      : "https://paper-api.alpaca.markets",
    // Market data is the same host for paper and live.
    dataBaseUrl: "https://data.alpaca.markets",
    configured: Boolean(process.env.ALPACA_API_KEY_ID && process.env.ALPACA_API_SECRET_KEY),
  },

  trading: {
    mode: tradingMode as "paper" | "live",
    /** Whether real-money orders are permitted right now. */
    liveEnabled,
    allowLiveTrading,
    /** Max share of current portfolio value any single trade may use, in percent. */
    maxTradePct: Number(process.env.MAX_TRADE_PCT ?? 5),
    /** Block new buys when today's equity drawdown exceeds this percentage. */
    dailyLossLimitPct: Number(process.env.DAILY_LOSS_LIMIT_PCT ?? 3),
    /** Block sells that would round-trip a position opened the same day (PDT / good-faith protection). */
    avoidDayTrades: bool(process.env.AVOID_DAY_TRADES, true),
  },

  data: {
    /** Optional Finnhub API key — enables free real-time US quotes for decisions. */
    finnhubKey: process.env.FINNHUB_API_KEY ?? "",
  },

  notify: {
    /** Discord incoming webhook URL (kept in .env, never in code). */
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL ?? "",
    configured: Boolean(process.env.DISCORD_WEBHOOK_URL),
    /** Whether to ping when each scheduled/manual run starts (can be noisy). */
    runStart: bool(process.env.NOTIFY_RUN_START, true),
  },

  schedule: {
    // Master switch for the daily autopilot.
    enabled: bool(process.env.SCHEDULE_ENABLED, true),
    // All times are interpreted in US market time.
    timezone: "America/New_York",
    slots: [
      slot("morning", "10:00", "Morning review", true),
      slot("midday", "12:30", "Midday check", true),
      slot("preclose", "15:45", "Pre-close positioning", true),
      slot("eod", "16:15", "End-of-day summary", false),
    ],
  },
} as const;

export interface ScheduleSlot {
  id: string;
  time: string; // "HH:MM" in market time, or disabled
  label: string;
  allowTrading: boolean;
  enabled: boolean;
}

/** Build a schedule slot, allowing the time to be overridden via env (e.g. MIDDAY_TIME=12:45 or "off"). */
function slot(id: string, defaultTime: string, label: string, allowTrading: boolean): ScheduleSlot {
  const time = (process.env[`${id.toUpperCase()}_TIME`] ?? defaultTime).trim();
  const enabled = time.toLowerCase() !== "off" && /^\d{1,2}:\d{2}$/.test(time);
  return { id, time, label, allowTrading, enabled };
}

export type AppConfig = typeof config;
