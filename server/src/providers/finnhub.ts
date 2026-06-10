import { config } from "../config.js";

/**
 * Finnhub-backed fundamental / analyst / alternative data — the "financial data
 * grounding" layer (free tier). Everything degrades gracefully: if no
 * FINNHUB_API_KEY is set, calls throw a clear, catchable error so tools can tell
 * the agent the data source isn't configured rather than failing silently.
 */

const BASE = "https://finnhub.io/api/v1";

export class FinnhubError extends Error {
  premium: boolean;
  constructor(message: string, premium = false) {
    super(message);
    this.name = "FinnhubError";
    this.premium = premium;
  }
}

export function finnhubConfigured(): boolean {
  return Boolean(config.data.finnhubKey);
}

async function get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  if (!config.data.finnhubKey) {
    throw new FinnhubError("Finnhub is not configured (set FINNHUB_API_KEY to enable fundamentals/analyst data).");
  }
  const q = new URLSearchParams({ ...params, token: config.data.finnhubKey });
  const res = await fetch(`${BASE}${path}?${q.toString()}`);
  if (res.status === 403) throw new FinnhubError(`Finnhub: "${path}" requires a premium plan on your key.`, true);
  if (res.status === 429) throw new FinnhubError("Finnhub rate limit hit (60/min) — try again shortly.");
  if (!res.ok) throw new FinnhubError(`Finnhub ${res.status} on ${path}`);
  return (await res.json()) as T;
}

const dstr = (d: Date) => d.toISOString().slice(0, 10);
const round = (n: unknown, p = 2) => (typeof n === "number" && isFinite(n) ? Number(n.toFixed(p)) : undefined);
/** First defined value among candidate keys. */
function pick(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "number" && isFinite(v)) return v;
  }
  return undefined;
}

// ── Individual datasets ──────────────────────────────────────────────────────

export interface Profile {
  name?: string;
  exchange?: string;
  industry?: string;
  marketCapM?: number;
  ipo?: string;
  weburl?: string;
}
export async function profile(symbol: string): Promise<Profile> {
  const p = await get<Record<string, unknown>>("/stock/profile2", { symbol });
  return {
    name: p.name as string,
    exchange: p.exchange as string,
    industry: p.finnhubIndustry as string,
    marketCapM: round(p.marketCapitalization, 0),
    ipo: p.ipo as string,
    weburl: p.weburl as string,
  };
}

export async function keyMetrics(symbol: string): Promise<Record<string, number | undefined>> {
  const r = await get<{ metric?: Record<string, unknown> }>("/stock/metric", { symbol, metric: "all" });
  const m = r.metric ?? {};
  return {
    peTTM: round(pick(m, ["peTTM", "peBasicExclExtraTTM", "peNormalizedAnnual"])),
    psTTM: round(pick(m, ["psTTM", "psAnnual"])),
    pbQuarterly: round(pick(m, ["pbQuarterly", "pbAnnual"])),
    evEbitdaTTM: round(pick(m, ["evToEbitdaTTM", "currentEv/freeCashFlowTTM"])),
    grossMarginTTM: round(pick(m, ["grossMarginTTM", "grossMarginAnnual"])),
    netMarginTTM: round(pick(m, ["netProfitMarginTTM", "netProfitMarginAnnual"])),
    roeTTM: round(pick(m, ["roeTTM", "roeRfy"])),
    revenueGrowthYoY: round(pick(m, ["revenueGrowthTTMYoy", "revenueGrowthQuarterlyYoy"])),
    epsGrowthYoY: round(pick(m, ["epsGrowthTTMYoy", "epsGrowthQuarterlyYoy"])),
    currentRatio: round(pick(m, ["currentRatioQuarterly", "currentRatioAnnual"])),
    debtToEquity: round(pick(m, ["totalDebt/totalEquityQuarterly", "totalDebt/totalEquityAnnual", "longTermDebt/equityAnnual"])),
    week52High: round(pick(m, ["52WeekHigh"])),
    week52Low: round(pick(m, ["52WeekLow"])),
    beta: round(pick(m, ["beta"])),
    dividendYield: round(pick(m, ["dividendYieldIndicatedAnnual", "currentDividendYieldTTM"])),
  };
}

export interface Recommendation {
  period?: string;
  strongBuy?: number;
  buy?: number;
  hold?: number;
  sell?: number;
  strongSell?: number;
}
export async function recommendation(symbol: string): Promise<Recommendation | null> {
  const r = await get<Recommendation[]>("/stock/recommendation", { symbol });
  return Array.isArray(r) && r.length ? r[0] : null;
}

export async function priceTarget(symbol: string): Promise<{ mean?: number; high?: number; low?: number } | null> {
  try {
    const r = await get<{ targetMean?: number; targetHigh?: number; targetLow?: number }>("/stock/price-target", { symbol });
    if (!r || (!r.targetMean && !r.targetHigh)) return null;
    return { mean: round(r.targetMean), high: round(r.targetHigh), low: round(r.targetLow) };
  } catch (e) {
    if (e instanceof FinnhubError && e.premium) return null; // premium on free tier — skip silently
    throw e;
  }
}

export async function earningsSurprises(symbol: string): Promise<Array<{ period: string; actual?: number; estimate?: number; surprisePct?: number }>> {
  const r = await get<Array<{ period: string; actual?: number; estimate?: number; surprisePercent?: number }>>("/stock/earnings", { symbol });
  return (Array.isArray(r) ? r : []).slice(0, 4).map((e) => ({ period: e.period, actual: e.actual, estimate: e.estimate, surprisePct: round(e.surprisePercent) }));
}

export async function nextEarningsDate(symbol: string): Promise<string | null> {
  const today = new Date();
  const to = new Date(today.getTime() + 120 * 86400000);
  try {
    const r = await get<{ earningsCalendar?: Array<{ date: string }> }>("/calendar/earnings", { symbol, from: dstr(today), to: dstr(to) });
    const next = r.earningsCalendar?.[0];
    return next?.date ?? null;
  } catch {
    return null;
  }
}

export async function insiderActivity(symbol: string): Promise<{ netShares90d: number; recent: Array<{ name: string; change: number; date: string; code: string }> }> {
  const from = new Date(Date.now() - 90 * 86400000);
  const r = await get<{ data?: Array<{ name: string; change: number; transactionDate: string; transactionCode: string }> }>(
    "/stock/insider-transactions",
    { symbol, from: dstr(from), to: dstr(new Date()) },
  );
  const data = r.data ?? [];
  const netShares90d = data.reduce((s, t) => s + (t.change || 0), 0);
  const recent = data.slice(0, 5).map((t) => ({ name: t.name, change: t.change, date: t.transactionDate, code: t.transactionCode }));
  return { netShares90d, recent };
}

export async function companyNews(symbol: string, days = 7): Promise<Array<{ headline: string; source: string; datetime: string; url: string }>> {
  const from = new Date(Date.now() - days * 86400000);
  const r = await get<Array<{ headline: string; source: string; datetime: number; url: string }>>("/company-news", {
    symbol,
    from: dstr(from),
    to: dstr(new Date()),
  });
  return (Array.isArray(r) ? r : []).slice(0, 6).map((n) => ({
    headline: n.headline,
    source: n.source,
    datetime: new Date(n.datetime * 1000).toISOString(),
    url: n.url,
  }));
}

// ── Consolidated dossier ─────────────────────────────────────────────────────

export interface Dossier {
  symbol: string;
  profile?: Profile;
  valuation?: Record<string, number | undefined>;
  analyst?: { recommendation: Recommendation | null; priceTarget: { mean?: number; high?: number; low?: number } | null };
  earnings?: { recentSurprises: Array<{ period: string; actual?: number; estimate?: number; surprisePct?: number }>; nextDate: string | null };
  insider?: { netShares90d: number; recent: Array<{ name: string; change: number; date: string; code: string }> };
  news?: Array<{ headline: string; source: string; datetime: string; url: string }>;
  notes: string[];
}

/** One-call comprehensive company dossier (profile + fundamentals + analyst + earnings + insider + news). */
export async function buildDossier(symbol: string): Promise<Dossier> {
  const notes: string[] = [];
  const d: Dossier = { symbol, notes };
  const settle = async <T>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      notes.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  };
  const [prof, metrics, rec, pt, surprises, nextDate, insider, news] = await Promise.all([
    settle("profile", () => profile(symbol)),
    settle("valuation", () => keyMetrics(symbol)),
    settle("recommendation", () => recommendation(symbol)),
    settle("priceTarget", () => priceTarget(symbol)),
    settle("earnings", () => earningsSurprises(symbol)),
    settle("nextEarnings", () => nextEarningsDate(symbol)),
    settle("insider", () => insiderActivity(symbol)),
    settle("news", () => companyNews(symbol, 7)),
  ]);
  d.profile = prof;
  d.valuation = metrics;
  d.analyst = { recommendation: rec ?? null, priceTarget: pt ?? null };
  d.earnings = { recentSurprises: surprises ?? [], nextDate: nextDate ?? null };
  d.insider = insider;
  d.news = news;
  return d;
}
