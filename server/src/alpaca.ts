import { config } from "./config.js";

/**
 * Thin, dependency-free wrapper around the Alpaca REST API.
 * Covers the trading endpoints (account, positions, orders) and the market
 * data endpoints (snapshots, bars, news) the agent needs to do research.
 */

export class AlpacaError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AlpacaError";
    this.status = status;
  }
}

function headers() {
  return {
    "APCA-API-KEY-ID": config.alpaca.keyId,
    "APCA-API-SECRET-KEY": config.alpaca.secretKey,
    "Content-Type": "application/json",
  };
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  if (!config.alpaca.configured) {
    throw new AlpacaError("Alpaca API keys are not configured (set ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY).", 400);
  }
  const res = await fetch(url, { ...init, headers: { ...headers(), ...(init?.headers ?? {}) } });
  const text = await res.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const msg =
      typeof body === "object" && body && "message" in body
        ? String((body as Record<string, unknown>).message)
        : `Alpaca request failed (${res.status})`;
    throw new AlpacaError(msg, res.status);
  }
  return body as T;
}

const trading = (path: string) => `${config.alpaca.tradingBaseUrl}${path}`;
const data = (path: string) => `${config.alpaca.dataBaseUrl}${path}`;

// ── Trading / account ────────────────────────────────────────────────────────

export interface AlpacaAccount {
  account_number: string;
  status: string;
  currency: string;
  cash: string;
  portfolio_value: string;
  equity: string;
  last_equity: string;
  buying_power: string;
  multiplier: string;
  long_market_value: string;
  short_market_value: string;
  daytrade_count: number;
  pattern_day_trader: boolean;
  trading_blocked: boolean;
  account_blocked: boolean;
}

export interface AlpacaPosition {
  symbol: string;
  qty: string;
  side: string;
  avg_entry_price: string;
  market_value: string;
  cost_basis: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  current_price: string;
  change_today: string;
}

export interface AlpacaOrder {
  id: string;
  symbol: string;
  qty: string | null;
  notional: string | null;
  side: string;
  type: string;
  time_in_force: string;
  limit_price: string | null;
  status: string;
  filled_qty: string;
  filled_avg_price: string | null;
  filled_at: string | null;
  created_at: string;
  submitted_at: string;
}

export const alpaca = {
  getAccount: () => request<AlpacaAccount>(trading("/v2/account")),

  getPositions: () => request<AlpacaPosition[]>(trading("/v2/positions")),

  getClock: () =>
    request<{ timestamp: string; is_open: boolean; next_open: string; next_close: string }>(
      trading("/v2/clock"),
    ),

  /** Trading-calendar sessions between two YYYY-MM-DD dates (empty on holidays/weekends). */
  getCalendar: (start: string, end: string) => {
    const q = new URLSearchParams({ start, end });
    return request<Array<{ date: string; open: string; close: string }>>(trading(`/v2/calendar?${q.toString()}`));
  },

  getOrders: (params: { status?: string; limit?: number; after?: string; symbols?: string[] } = {}) => {
    const q = new URLSearchParams();
    q.set("status", params.status ?? "all");
    q.set("limit", String(params.limit ?? 50));
    q.set("direction", "desc");
    if (params.after) q.set("after", params.after);
    if (params.symbols?.length) q.set("symbols", params.symbols.join(","));
    return request<AlpacaOrder[]>(trading(`/v2/orders?${q.toString()}`));
  },

  cancelOrder: (id: string) =>
    request<void>(trading(`/v2/orders/${encodeURIComponent(id)}`), { method: "DELETE" }),

  /** Cancel ALL open orders. Returns one entry per order with its cancel status. */
  cancelAllOrders: () =>
    request<Array<{ id: string; status: number }>>(trading("/v2/orders"), { method: "DELETE" }),

  /** Liquidate ALL positions at market (and cancel any open orders first). */
  closeAllPositions: () =>
    request<Array<{ symbol: string; status: number }>>(trading("/v2/positions?cancel_orders=true"), {
      method: "DELETE",
    }),

  getPortfolioHistory: (params: { period?: string; timeframe?: string } = {}) => {
    const q = new URLSearchParams();
    q.set("period", params.period ?? "1M");
    q.set("timeframe", params.timeframe ?? "1D");
    return request<{
      timestamp: number[];
      equity: number[];
      profit_loss: number[];
      profit_loss_pct: number[];
      base_value: number;
    }>(trading(`/v2/account/portfolio/history?${q.toString()}`));
  },

  placeOrder: (order: {
    symbol: string;
    side: "buy" | "sell";
    type: "market" | "limit" | "stop" | "stop_limit";
    time_in_force: "day" | "gtc";
    qty?: number;
    notional?: number;
    limit_price?: number;
    stop_price?: number;
  }) =>
    request<AlpacaOrder>(trading("/v2/orders"), {
      method: "POST",
      body: JSON.stringify(order),
    }),

  // ── Market data ────────────────────────────────────────────────────────────

  getSnapshots: (symbols: string[]) => {
    const q = new URLSearchParams({ symbols: symbols.join(","), feed: "iex" });
    return request<Record<string, unknown>>(data(`/v2/stocks/snapshots?${q.toString()}`));
  },

  getBars: (params: { symbols: string[]; timeframe?: string; start?: string; limit?: number }) => {
    const q = new URLSearchParams({
      symbols: params.symbols.join(","),
      timeframe: params.timeframe ?? "1Day",
      limit: String(params.limit ?? 30),
      feed: "iex",
      adjustment: "all",
    });
    if (params.start) q.set("start", params.start);
    return request<Record<string, unknown>>(data(`/v2/stocks/bars?${q.toString()}`));
  },

  getNews: (params: { symbols?: string[]; limit?: number } = {}) => {
    const q = new URLSearchParams({ limit: String(params.limit ?? 10) });
    if (params.symbols?.length) q.set("symbols", params.symbols.join(","));
    return request<{ news: unknown[] }>(data(`/v1beta1/news?${q.toString()}`));
  },

  // ── Discovery / screening (free Alpaca screener) ───────────────────────────

  getMovers: (top = 20) =>
    request<{
      gainers: Array<{ symbol: string; percent_change: number; change: number; price: number }>;
      losers: Array<{ symbol: string; percent_change: number; change: number; price: number }>;
      market_type: string;
      last_updated: string;
    }>(data(`/v1beta1/screener/stocks/movers?top=${top}`)),

  getMostActives: (top = 20) =>
    request<{ most_actives: Array<{ symbol: string; volume: number; trade_count: number }>; last_updated: string }>(
      data(`/v1beta1/screener/stocks/most-actives?top=${top}&by=volume`),
    ),
};
