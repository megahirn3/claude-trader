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
    maxOrderNotionalUsd: Number(process.env.MAX_ORDER_NOTIONAL_USD ?? 1000),
  },
} as const;

export type AppConfig = typeof config;
