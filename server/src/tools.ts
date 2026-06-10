import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { AlpacaError } from "./alpaca.js";
import { broker } from "./providers/broker.js";
import { marketData } from "./providers/marketdata.js";
import * as finnhub from "./providers/finnhub.js";
import { config } from "./config.js";
import { runStore } from "./store.js";
import { addJournalEntry, listJournal, getWatchlist, setWatchlist } from "./db.js";
import { isHalted } from "./controlState.js";

const now = () => new Date().toISOString();

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}
function json(value: unknown) {
  return ok(JSON.stringify(value, null, 2));
}

function errMsg(e: unknown): string {
  if (e instanceof AlpacaError) return `Alpaca error (${e.status}): ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/** Calendar date (YYYY-MM-DD) of a timestamp in US market time. */
function etDate(d: Date | string = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(typeof d === "string" ? new Date(d) : d);
}

async function priceFor(symbol: string): Promise<number | null> {
  const q = await marketData.getQuote(symbol);
  return q?.price ?? null;
}

/** True if this symbol had a buy filled today (selling it now would be a day trade). */
async function boughtToday(symbol: string): Promise<boolean> {
  const orders = await broker.getOrders({ status: "closed", symbols: [symbol], limit: 50 });
  const today = etDate();
  return orders.some(
    (o) =>
      o.side === "buy" &&
      Number(o.filled_qty) > 0 &&
      etDate(o.filled_at ?? o.submitted_at ?? o.created_at) === today,
  );
}

/** Common leveraged / inverse ETFs — decay-prone, not for holding. */
const LEVERAGED_ETFS = new Set([
  "TQQQ", "SQQQ", "SOXL", "SOXS", "SPXL", "SPXS", "UPRO", "SPXU", "TNA", "TZA",
  "UVXY", "SVXY", "VIXY", "UDOW", "SDOW", "TECL", "TECS", "LABU", "LABD", "FAS",
  "FAZ", "NUGT", "DUST", "JNUG", "JDST", "YINN", "YANG", "BOIL", "KOLD", "GUSH",
  "DRIP", "ERX", "ERY", "TMF", "TMV", "TSLL", "TSLQ", "NVDL", "NVDU", "CONL",
  "BITX", "ETHU", "SARK", "WEBL", "WEBS", "DPST", "URTY", "SRTY", "QID", "SSO",
  "SDS", "QLD", "DDM", "MVV", "SCO", "UCO", "AGQ", "ZSL", "UGL", "GLL",
]);

/**
 * Build the agent's tool server scoped to a single run, so every tool call and
 * decision is logged to that run's event stream for the dashboard.
 */
export function buildAlpacaServer(runId: string, runLabel: string) {
  const logCall = (toolName: string, input: unknown) =>
    runStore.emit(runId, { kind: "tool_call", tool: toolName, input, at: now() });
  const logResult = (toolName: string, summary: string) =>
    runStore.emit(runId, { kind: "tool_result", tool: toolName, summary, at: now() });

  return createSdkMcpServer({
    name: "alpaca",
    version: "2.0.0",
    tools: [
      // ── Account & market data ──────────────────────────────────────────────

      tool("get_account", "Get the brokerage account: cash, equity, buying power, P&L and trading status.", {}, async () => {
        logCall("get_account", {});
        try {
          const a = await broker.getAccount();
          logResult("get_account", `equity $${a.equity}, cash $${a.cash}, buying power $${a.buying_power}`);
          return json(a);
        } catch (e) {
          return fail(errMsg(e));
        }
      }),

      tool("list_positions", "List all currently held positions with quantity, avg entry, market value and unrealized P&L.", {}, async () => {
        logCall("list_positions", {});
        try {
          const positions = await broker.getPositions();
          logResult("list_positions", `${positions.length} position(s)`);
          return json(positions);
        } catch (e) {
          return fail(errMsg(e));
        }
      }),

      tool(
        "list_orders",
        "List recent orders. Useful to check open/pending orders (including protective stops) before placing new ones.",
        { status: z.enum(["open", "closed", "all"]).default("all").describe("Filter by order status") },
        async (args) => {
          logCall("list_orders", args);
          try {
            const orders = await broker.getOrders({ status: args.status, limit: 50 });
            logResult("list_orders", `${orders.length} order(s)`);
            return json(orders);
          } catch (e) {
            return fail(errMsg(e));
          }
        },
      ),

      tool("get_market_clock", "Check whether the US stock market is currently open, and the next open/close times.", {}, async () => {
        logCall("get_market_clock", {});
        try {
          const clock = await broker.getClock();
          logResult("get_market_clock", clock.is_open ? "market OPEN" : "market CLOSED");
          return json(clock);
        } catch (e) {
          return fail(errMsg(e));
        }
      }),

      tool(
        "get_portfolio_history",
        "Get the account's equity curve and P&L over a period — how the portfolio has performed today / this week / this month.",
        { period: z.enum(["1D", "1W", "1M", "3M", "1A"]).default("1D").describe("Lookback period") },
        async (args) => {
          logCall("get_portfolio_history", args);
          try {
            const hist = await broker.getPortfolioHistory({
              period: args.period,
              timeframe: args.period === "1D" ? "15Min" : "1D",
            });
            logResult("get_portfolio_history", `${args.period} history (${hist.equity?.length ?? 0} points)`);
            return json(hist);
          } catch (e) {
            return fail(errMsg(e));
          }
        },
      ),

      tool(
        "get_quote",
        "Get the freshest real-time price for one or more symbols (from the configured real-time data source). Use this for current decision prices — it's faster and fresher than the full snapshot.",
        { symbols: z.array(z.string()).min(1).max(20).describe("Ticker symbols, e.g. ['AAPL','MSFT']") },
        async (args) => {
          const symbols = args.symbols.map((s) => s.toUpperCase());
          logCall("get_quote", { symbols });
          try {
            const quotes = await marketData.getQuotes(symbols);
            const n = Object.keys(quotes).length;
            logResult("get_quote", `${n} quote(s) via ${marketData.quoteSource()}`);
            return json({ source: marketData.quoteSource(), quotes });
          } catch (e) {
            return fail(errMsg(e));
          }
        },
      ),

      tool(
        "get_stock_snapshot",
        "Get a fuller snapshot (latest trade, quote, daily/minute bar) for symbols. For just the current price, prefer get_quote.",
        { symbols: z.array(z.string()).min(1).max(20).describe("Ticker symbols, e.g. ['AAPL','MSFT']") },
        async (args) => {
          const symbols = args.symbols.map((s) => s.toUpperCase());
          logCall("get_stock_snapshot", { symbols });
          try {
            const snaps = await marketData.getSnapshots(symbols);
            logResult("get_stock_snapshot", `snapshot for ${symbols.join(", ")}`);
            return json(snaps);
          } catch (e) {
            return fail(errMsg(e));
          }
        },
      ),

      tool(
        "get_stock_bars",
        "Get historical OHLCV price bars for technical analysis (trend, momentum, volatility).",
        {
          symbols: z.array(z.string()).min(1).max(10).describe("Ticker symbols"),
          timeframe: z.enum(["1Day", "1Hour", "15Min", "5Min", "1Min"]).default("1Day"),
          limit: z.number().int().min(1).max(200).default(30).describe("How many recent bars per symbol"),
        },
        async (args) => {
          const symbols = args.symbols.map((s) => s.toUpperCase());
          logCall("get_stock_bars", { symbols, timeframe: args.timeframe, limit: args.limit });
          try {
            const bars = await marketData.getBars({ symbols, timeframe: args.timeframe, limit: args.limit });
            logResult("get_stock_bars", `${args.timeframe} bars for ${symbols.join(", ")}`);
            return json(bars);
          } catch (e) {
            return fail(errMsg(e));
          }
        },
      ),

      tool(
        "get_market_news",
        "Get recent market news headlines from Alpaca, optionally filtered to specific symbols.",
        {
          symbols: z.array(z.string()).max(10).optional().describe("Optional ticker filter"),
          limit: z.number().int().min(1).max(50).default(10),
        },
        async (args) => {
          const symbols = args.symbols?.map((s) => s.toUpperCase());
          logCall("get_market_news", { symbols, limit: args.limit });
          try {
            const news = await marketData.getNews({ symbols, limit: args.limit });
            const items = (news.news as Array<{ headline?: string; summary?: string; source?: string; created_at?: string; symbols?: string[] }>) ?? [];
            // Trim to the essentials to keep the agent's context lean.
            const trimmed = items.map((n) => ({
              headline: n.headline,
              summary: n.summary,
              source: n.source,
              created_at: n.created_at,
              symbols: n.symbols,
            }));
            logResult("get_market_news", `${trimmed.length} headline(s)`);
            return json(trimmed);
          } catch (e) {
            return fail(errMsg(e));
          }
        },
      ),

      // ── Fundamental & analyst data (financial-grade grounding) ─────────────

      tool(
        "build_dossier",
        "Build a comprehensive company dossier in ONE call: live quote, company profile, key fundamentals (valuation/margins/growth/health), analyst recommendation & price target, recent earnings surprises + next earnings date, insider activity, and company news. Use this as your FIRST deep-research step on any holding or candidate before forming a thesis.",
        { symbol: z.string().describe("Ticker symbol") },
        async (args) => {
          const symbol = args.symbol.toUpperCase();
          logCall("build_dossier", { symbol });
          try {
            const [quote, dossier] = await Promise.all([
              marketData.getQuote(symbol).catch(() => null),
              finnhub.buildDossier(symbol),
            ]);
            logResult("build_dossier", `dossier for ${symbol}${dossier.notes.length ? ` (${dossier.notes.length} note(s))` : ""}`);
            return json({ quote, ...dossier });
          } catch (e) {
            return fail(errMsg(e));
          }
        },
      ),

      tool(
        "get_fundamentals",
        "Compare key fundamentals across one or more symbols (valuation: P/E, P/S, P/B, EV/EBITDA; margins; growth; ROE; debt/equity; 52-week range; beta; dividend yield; market cap). Use for comparable-company analysis across holdings and candidates.",
        { symbols: z.array(z.string()).min(1).max(8).describe("Ticker symbols to compare") },
        async (args) => {
          const symbols = args.symbols.map((s) => s.toUpperCase());
          logCall("get_fundamentals", { symbols });
          try {
            const rows = await Promise.all(
              symbols.map(async (s) => {
                try {
                  const [p, m] = await Promise.all([finnhub.profile(s), finnhub.keyMetrics(s)]);
                  return { symbol: s, profile: p, metrics: m };
                } catch (e) {
                  return { symbol: s, error: errMsg(e) };
                }
              }),
            );
            logResult("get_fundamentals", symbols.join(", "));
            return json(rows);
          } catch (e) {
            return fail(errMsg(e));
          }
        },
      ),

      tool(
        "get_analyst_view",
        "Get Wall Street analyst sentiment for a symbol: buy/hold/sell recommendation counts and (if available) the consensus price target vs the current price.",
        { symbol: z.string() },
        async (args) => {
          const symbol = args.symbol.toUpperCase();
          logCall("get_analyst_view", { symbol });
          try {
            const [rec, pt, quote] = await Promise.all([
              finnhub.recommendation(symbol),
              finnhub.priceTarget(symbol),
              marketData.getQuote(symbol).catch(() => null),
            ]);
            logResult("get_analyst_view", symbol);
            return json({ symbol, recommendation: rec, priceTarget: pt, currentPrice: quote?.price ?? null });
          } catch (e) {
            return fail(errMsg(e));
          }
        },
      ),

      tool(
        "get_earnings",
        "Get a symbol's recent earnings surprises (actual vs estimate) and the NEXT scheduled earnings date — a key catalyst to know before trading (avoid surprise gaps).",
        { symbol: z.string() },
        async (args) => {
          const symbol = args.symbol.toUpperCase();
          logCall("get_earnings", { symbol });
          try {
            const [surprises, nextDate] = await Promise.all([finnhub.earningsSurprises(symbol), finnhub.nextEarningsDate(symbol)]);
            logResult("get_earnings", `${symbol}${nextDate ? ` (next ${nextDate})` : ""}`);
            return json({ symbol, recentSurprises: surprises, nextEarningsDate: nextDate });
          } catch (e) {
            return fail(errMsg(e));
          }
        },
      ),

      tool(
        "get_insider_activity",
        "Get recent insider transactions for a symbol (net shares bought/sold by insiders over ~90 days, plus recent individual transactions). Insider buying can be bullish; heavy selling a caution.",
        { symbol: z.string() },
        async (args) => {
          const symbol = args.symbol.toUpperCase();
          logCall("get_insider_activity", { symbol });
          try {
            const r = await finnhub.insiderActivity(symbol);
            logResult("get_insider_activity", `${symbol} net ${r.netShares90d} sh / 90d`);
            return json({ symbol, ...r });
          } catch (e) {
            return fail(errMsg(e));
          }
        },
      ),

      tool(
        "get_company_news",
        "Get recent company-specific news headlines (with source and link) for a symbol — richer and more targeted than the general market-news feed.",
        { symbol: z.string(), days: z.number().int().min(1).max(30).default(7) },
        async (args) => {
          const symbol = args.symbol.toUpperCase();
          logCall("get_company_news", { symbol, days: args.days });
          try {
            const news = await finnhub.companyNews(symbol, args.days);
            logResult("get_company_news", `${news.length} headline(s) for ${symbol}`);
            return json(news);
          } catch (e) {
            return fail(errMsg(e));
          }
        },
      ),

      tool(
        "get_market_movers",
        "DISCOVERY: surface candidates the market is moving on right now — top % gainers, top % losers (oversold/reversal ideas), and the most-active names by volume. Use this to find opportunities you don't already know about, across the whole market (not just mega-caps), then run build_dossier on the interesting ones.",
        { top: z.number().int().min(5).max(50).default(20).describe("How many names per list") },
        async (args) => {
          logCall("get_market_movers", { top: args.top });
          try {
            const [movers, actives] = await Promise.all([
              marketData.getMovers(args.top),
              marketData.getMostActives(args.top).catch(() => null),
            ]);
            logResult("get_market_movers", `${movers.gainers?.length ?? 0} gainers / ${movers.losers?.length ?? 0} losers`);
            return json({
              gainers: movers.gainers,
              losers: movers.losers,
              mostActive: actives?.most_actives ?? [],
              note: "These are raw movers — screen out illiquid/penny names and verify each with build_dossier before acting.",
            });
          } catch (e) {
            return fail(errMsg(e));
          }
        },
      ),

      // ── Memory: journal & watchlist ────────────────────────────────────────

      tool(
        "read_journal",
        "Read the most recent trading-journal entries left by previous cycles (theses, plans, open questions). ALWAYS call this at the start of a cycle so you build on earlier work instead of starting from scratch.",
        { limit: z.number().int().min(1).max(30).default(8) },
        async (args) => {
          logCall("read_journal", args);
          const entries = listJournal(args.limit);
          logResult("read_journal", `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`);
          if (entries.length === 0) return ok("Journal is empty — this looks like the first cycle. Start one with write_journal at the end of this run.");
          return json(entries);
        },
      ),

      tool(
        "write_journal",
        "Append a handoff note to the trading journal for the NEXT cycle (and the human). Call this at the END of every cycle: current thesis per holding, what you did and why, what to watch, plan for the next run.",
        { content: z.string().min(10).describe("The journal entry (markdown ok, keep it under ~300 words)") },
        async (args) => {
          addJournalEntry(runLabel, args.content);
          runStore.emit(runId, { kind: "journal", text: args.content, at: now() });
          return ok("Journal entry saved.");
        },
      ),

      tool("get_watchlist", "Get the current watchlist (symbols being tracked as candidates, with notes).", {}, async () => {
        logCall("get_watchlist", {});
        const items = getWatchlist();
        logResult("get_watchlist", `${items.length} symbol(s)`);
        return items.length ? json(items) : ok("Watchlist is empty.");
      }),

      tool(
        "set_watchlist",
        "Replace the watchlist with an updated set of candidate symbols and a short note for each (why it's interesting, what would trigger a buy). Keep it to the best 3-8 ideas.",
        {
          items: z
            .array(z.object({ symbol: z.string(), note: z.string() }))
            .max(10)
            .describe("The full new watchlist (replaces the old one)"),
        },
        async (args) => {
          const items = args.items.map((i) => ({ symbol: i.symbol.toUpperCase(), note: i.note }));
          setWatchlist(items);
          logCall("set_watchlist", { symbols: items.map((i) => i.symbol) });
          return ok(`Watchlist updated (${items.length} symbols).`);
        },
      ),

      // ── Decisions & orders ─────────────────────────────────────────────────

      tool(
        "record_decision",
        "Record an investment decision to the dashboard as a short, grounded investment memo. Call this whenever you reach a conclusion about a position, BEFORE placing any order, so a human can review your reasoning. Cite the data/sources behind it.",
        {
          action: z.string().describe("Short action label, e.g. 'BUY', 'SELL', 'HOLD', 'WATCH', 'TRIM', 'STOP'"),
          symbol: z.string().optional().describe("Ticker the decision concerns, if applicable"),
          rationale: z.string().describe("The thesis: why, including bull/bear balance, valuation context, and key catalysts/risks (incl. next earnings date if relevant)"),
          conviction: z.number().int().min(1).max(5).optional().describe("Conviction from 1 (low) to 5 (high)"),
          sources: z
            .array(z.string())
            .max(8)
            .optional()
            .describe("What backs this call: data sources used (e.g. 'Finnhub fundamentals', 'analyst recs', 'insider data') and/or URLs from web research"),
        },
        async (args) => {
          runStore.emit(runId, {
            kind: "decision",
            action: args.action.toUpperCase(),
            symbol: args.symbol?.toUpperCase(),
            rationale: args.rationale,
            conviction: args.conviction,
            sources: args.sources,
            at: now(),
          });
          return ok("Decision recorded.");
        },
      ),

      tool(
        "place_order",
        "Place a stock order through Alpaca. Buys: prefer a `notional` dollar amount (fractional shares are supported). Protective stop-losses: side='sell', type='stop' (or 'stop_limit') with stop_price and qty. Always call record_decision first to log your reasoning.",
        {
          symbol: z.string().describe("Ticker symbol"),
          side: z.enum(["buy", "sell"]),
          type: z.enum(["market", "limit", "stop", "stop_limit"]).default("market"),
          time_in_force: z.enum(["day", "gtc"]).default("day"),
          qty: z.number().positive().optional().describe("Number of shares (whole or fractional)"),
          notional: z.number().positive().optional().describe("Dollar amount to trade (market orders only)"),
          limit_price: z.number().positive().optional().describe("Required for limit and stop_limit orders"),
          stop_price: z.number().positive().optional().describe("Required for stop and stop_limit orders (the trigger price)"),
        },
        async (args) => {
          const symbol = args.symbol.toUpperCase();
          logCall("place_order", { ...args, symbol });

          // ── Kill switch ──────────────────────────────────────────────────
          if (isHalted()) {
            const msg = "Trading is HALTED (kill switch active). No orders can be placed until a human resumes from the dashboard.";
            runStore.emit(runId, { kind: "error", message: msg, at: now() });
            return fail(msg);
          }

          // ── Shape validation ─────────────────────────────────────────────
          if (!args.qty && !args.notional) return fail("Provide either qty or notional.");
          if (args.qty && args.notional) return fail("Provide only one of qty or notional, not both.");
          if ((args.type === "limit" || args.type === "stop_limit") && !args.limit_price)
            return fail(`limit_price is required for ${args.type} orders.`);
          if ((args.type === "stop" || args.type === "stop_limit") && !args.stop_price)
            return fail(`stop_price is required for ${args.type} orders.`);
          if (args.type !== "market" && args.notional)
            return fail("notional sizing only works with market orders; use qty for limit/stop orders.");

          const block = (msg: string) => {
            runStore.emit(runId, { kind: "error", message: msg, at: now() });
            return fail(msg);
          };

          // ── Risk guards ──────────────────────────────────────────────────
          if (args.side === "buy") {
            // Guard 0: investment policy — junk-safety only (NOT a market-cap or
            // popularity filter; small/mid-caps are welcome). Block leveraged/
            // inverse ETFs and sub-floor penny prices.
            if (config.trading.excludeLeveragedEtf && LEVERAGED_ETFS.has(symbol)) {
              return block(`Order blocked: ${symbol} is a leveraged/inverse ETF — these decay over time and aren't suitable to hold. (Set EXCLUDE_LEVERAGED_ETF=false to allow.)`);
            }
            if (config.trading.minPriceUsd > 0) {
              const px = args.limit_price ?? args.stop_price ?? (await priceFor(symbol));
              if (px !== null && px < config.trading.minPriceUsd) {
                return block(`Order blocked: ${symbol} at ~$${px?.toFixed(2)} is below the $${config.trading.minPriceUsd} minimum-price floor (avoids penny-stock manipulation risk). Small/mid-caps above the floor are fine. (Set MIN_PRICE_USD=0 to disable.)`);
              }
            }

            // Estimate the order's dollar size.
            let estNotional = args.notional ?? null;
            if (estNotional === null && args.qty) {
              const px = args.limit_price ?? args.stop_price ?? (await priceFor(symbol));
              estNotional = px ? px * args.qty : null;
            }
            if (estNotional === null) {
              return fail(
                "Can't size this buy: provide a `notional` dollar amount (preferred for sizing) or a price so the order value can be checked against the per-trade cap.",
              );
            }

            let acct;
            try {
              acct = await broker.getAccount();
            } catch (e) {
              return fail(`Couldn't read account to size the order: ${errMsg(e)}`);
            }
            const portfolioValue = Number(acct.portfolio_value || acct.equity || 0);
            const lastEquity = Number(acct.last_equity || 0);

            // Guard 1: per-trade size cap (% of portfolio).
            const cap = portfolioValue * (config.trading.maxTradePct / 100);
            if (estNotional > cap + 0.01) {
              return block(
                `Order blocked: ~$${estNotional.toFixed(2)} exceeds the per-trade limit of ${config.trading.maxTradePct}% of portfolio ($${cap.toFixed(2)} of $${portfolioValue.toFixed(2)}). Reduce the size.`,
              );
            }

            // Guard 2: daily-loss circuit breaker — no new buys after a bad day.
            if (lastEquity > 0) {
              const drawdownPct = ((lastEquity - portfolioValue) / lastEquity) * 100;
              if (drawdownPct >= config.trading.dailyLossLimitPct) {
                return block(
                  `Order blocked by the daily-loss circuit breaker: the account is down ${drawdownPct.toFixed(2)}% today (limit ${config.trading.dailyLossLimitPct}%). No new buys until tomorrow — you may still sell to reduce risk.`,
                );
              }
            }

            // Guard 2b: no-leverage — only invest settled cash, never margin buying power.
            if (config.trading.noLeverage) {
              const cash = Number(acct.cash || 0);
              if (estNotional > cash + 0.01) {
                return block(
                  `Order blocked: this buy (~$${estNotional.toFixed(2)}) exceeds available cash ($${cash.toFixed(2)}). No-leverage mode is on — the bot invests only settled cash, not the 4× margin buying power.`,
                );
              }
            }
          }

          // Guard 3: day-trade guard — don't sell what was bought today.
          if (args.side === "sell" && config.trading.avoidDayTrades) {
            try {
              if (await boughtToday(symbol)) {
                return block(
                  `Order blocked: ${symbol} was bought today, and selling it now would create a day trade (PDT rules) or reuse unsettled cash. Hold it at least overnight — a protective stop with time_in_force='gtc' placed TOMORROW is the right tool if you're worried. (Set AVOID_DAY_TRADES=false to disable this guard.)`,
                );
              }
            } catch (e) {
              return fail(`Couldn't verify day-trade safety: ${errMsg(e)}`);
            }
          }

          // ── Submit ───────────────────────────────────────────────────────
          try {
            const order = await broker.placeOrder({
              symbol,
              side: args.side,
              type: args.type,
              time_in_force: args.time_in_force,
              qty: args.qty,
              notional: args.notional,
              limit_price: args.limit_price,
              stop_price: args.stop_price,
            });
            const sizeStr = args.notional ? `$${args.notional}` : `${args.qty} sh`;
            const priceStr =
              args.type === "limit" ? ` @ limit ${args.limit_price}` :
              args.type === "stop" ? ` @ stop ${args.stop_price}` :
              args.type === "stop_limit" ? ` @ stop ${args.stop_price}/limit ${args.limit_price}` : "";
            const summary = `${config.trading.mode.toUpperCase()} ${args.side.toUpperCase()} ${sizeStr} ${symbol} (${args.type}${priceStr}) → order ${order.id} [${order.status}]`;
            runStore.emit(runId, { kind: "order", summary, detail: order, at: now() });
            logResult("place_order", summary);
            return json({ submitted: true, mode: config.trading.mode, order });
          } catch (e) {
            const msg = errMsg(e);
            runStore.emit(runId, { kind: "error", message: msg, at: now() });
            return fail(msg);
          }
        },
      ),

      tool(
        "cancel_order",
        "Cancel an open order by its order id.",
        { order_id: z.string().describe("The Alpaca order id to cancel") },
        async (args) => {
          logCall("cancel_order", args);
          try {
            await broker.cancelOrder(args.order_id);
            logResult("cancel_order", `cancelled ${args.order_id}`);
            return ok(`Order ${args.order_id} cancelled.`);
          } catch (e) {
            return fail(errMsg(e));
          }
        },
      ),
    ],
  });
}

/** The tool names (mcp__alpaca__*) this server exposes, for the allowlist. */
export const ALPACA_TOOL_NAMES = [
  "get_account",
  "list_positions",
  "list_orders",
  "get_market_clock",
  "get_portfolio_history",
  "get_quote",
  "get_stock_snapshot",
  "get_stock_bars",
  "get_market_news",
  "build_dossier",
  "get_fundamentals",
  "get_analyst_view",
  "get_earnings",
  "get_insider_activity",
  "get_company_news",
  "get_market_movers",
  "read_journal",
  "write_journal",
  "get_watchlist",
  "set_watchlist",
  "record_decision",
  "place_order",
  "cancel_order",
].map((n) => `mcp__alpaca__${n}`);
