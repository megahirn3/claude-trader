import { config } from "../config.js";
import { alpaca } from "../alpaca.js";

/**
 * Market-data provider abstraction. The bot makes decisions against this clean
 * interface and never cares which vendor is behind it. Real-time quotes come
 * from Finnhub when a key is configured (free real-time US data), with Alpaca's
 * real-time IEX feed as the always-available fallback. Snapshots / bars / news
 * stay on Alpaca for now.
 */

export interface Quote {
  symbol: string;
  price: number;
  prevClose?: number;
  changePct?: number;
  bid?: number;
  ask?: number;
  ts: string;
  source: string;
}

export interface MarketData {
  /** Human label of the active real-time quote source, for the dashboard. */
  quoteSource(): string;
  getQuote(symbol: string): Promise<Quote | null>;
  getQuotes(symbols: string[]): Promise<Record<string, Quote>>;
  getSnapshots(symbols: string[]): Promise<Record<string, unknown>>;
  getBars(params: { symbols: string[]; timeframe?: string; limit?: number }): Promise<Record<string, unknown>>;
  getNews(params: { symbols?: string[]; limit?: number }): Promise<{ news: unknown[] }>;
  getMovers(top?: number): ReturnType<typeof alpaca.getMovers>;
  getMostActives(top?: number): ReturnType<typeof alpaca.getMostActives>;
}

// ── Finnhub (free real-time US quotes) ───────────────────────────────────────

interface FinnhubQuote {
  c: number; // current price
  d: number | null; // change
  dp: number | null; // percent change
  h: number; // high
  l: number; // low
  o: number; // open
  pc: number; // previous close
  t: number; // unix seconds
}

async function finnhubQuote(symbol: string): Promise<Quote | null> {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${config.data.finnhubKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnhub ${res.status}`);
  const q = (await res.json()) as FinnhubQuote;
  // Finnhub returns c:0 for unknown/invalid symbols.
  if (!q || typeof q.c !== "number" || q.c === 0) return null;
  return {
    symbol,
    price: q.c,
    prevClose: q.pc || undefined,
    changePct: typeof q.dp === "number" ? q.dp : undefined,
    ts: q.t ? new Date(q.t * 1000).toISOString() : new Date().toISOString(),
    source: "finnhub",
  };
}

// ── Alpaca (real-time IEX) quote, derived from the snapshot ───────────────────

async function alpacaQuote(symbol: string): Promise<Quote | null> {
  const snap = (await alpaca.getSnapshots([symbol])) as Record<
    string,
    {
      latestTrade?: { p?: number; t?: string };
      latestQuote?: { ap?: number; bp?: number };
      prevDailyBar?: { c?: number };
    }
  >;
  const s = snap[symbol];
  const price = s?.latestTrade?.p ?? s?.latestQuote?.ap ?? s?.latestQuote?.bp;
  if (typeof price !== "number") return null;
  const prevClose = s?.prevDailyBar?.c;
  return {
    symbol,
    price,
    prevClose,
    changePct: prevClose ? ((price - prevClose) / prevClose) * 100 : undefined,
    bid: s?.latestQuote?.bp,
    ask: s?.latestQuote?.ap,
    ts: s?.latestTrade?.t ?? new Date().toISOString(),
    source: "alpaca-iex",
  };
}

class MarketDataProvider implements MarketData {
  private useFinnhub = Boolean(config.data.finnhubKey);

  quoteSource(): string {
    return this.useFinnhub ? "Finnhub (real-time)" : "Alpaca IEX (real-time)";
  }

  async getQuote(symbol: string): Promise<Quote | null> {
    const sym = symbol.toUpperCase();
    if (this.useFinnhub) {
      try {
        const q = await finnhubQuote(sym);
        if (q) return q;
      } catch {
        // fall through to Alpaca on any Finnhub hiccup (rate limit, outage)
      }
    }
    try {
      return await alpacaQuote(sym);
    } catch {
      return null;
    }
  }

  async getQuotes(symbols: string[]): Promise<Record<string, Quote>> {
    const out: Record<string, Quote> = {};
    // Small fan-out with bounded concurrency to respect Finnhub's 60/min limit.
    const syms = symbols.map((s) => s.toUpperCase());
    const CONCURRENCY = 5;
    for (let i = 0; i < syms.length; i += CONCURRENCY) {
      const batch = syms.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map((s) => this.getQuote(s).catch(() => null)));
      results.forEach((q, j) => {
        if (q) out[batch[j]] = q;
      });
    }
    return out;
  }

  getSnapshots(symbols: string[]) {
    return alpaca.getSnapshots(symbols);
  }

  getBars(params: { symbols: string[]; timeframe?: string; limit?: number }) {
    return alpaca.getBars(params);
  }

  getNews(params: { symbols?: string[]; limit?: number }) {
    return alpaca.getNews(params);
  }

  getMovers(top = 20) {
    return alpaca.getMovers(top);
  }

  getMostActives(top = 20) {
    return alpaca.getMostActives(top);
  }
}

export const marketData: MarketData = new MarketDataProvider();
