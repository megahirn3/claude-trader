import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { alpaca, AlpacaError } from "./alpaca.js";
import { config } from "./config.js";
import { runStore } from "./store.js";

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

async function priceFor(symbol: string): Promise<number | null> {
  try {
    const snap = (await alpaca.getSnapshots([symbol])) as Record<
      string,
      { latestTrade?: { p?: number }; latestQuote?: { ap?: number; bp?: number } }
    >;
    const s = snap[symbol];
    const p = s?.latestTrade?.p ?? s?.latestQuote?.ap ?? s?.latestQuote?.bp;
    return typeof p === "number" ? p : null;
  } catch {
    return null;
  }
}

/**
 * Build the Alpaca tool server scoped to a single run, so every tool call and
 * decision is logged to that run's event stream for the dashboard.
 */
export function buildAlpacaServer(runId: string) {
  const logCall = (toolName: string, input: unknown) =>
    runStore.emit(runId, { kind: "tool_call", tool: toolName, input, at: now() });
  const logResult = (toolName: string, summary: string) =>
    runStore.emit(runId, { kind: "tool_result", tool: toolName, summary, at: now() });

  return createSdkMcpServer({
    name: "alpaca",
    version: "1.0.0",
    tools: [
      tool("get_account", "Get the brokerage account: cash, equity, buying power, P&L and trading status.", {}, async () => {
        logCall("get_account", {});
        try {
          const a = await alpaca.getAccount();
          logResult("get_account", `equity $${a.equity}, cash $${a.cash}, buying power $${a.buying_power}`);
          return json(a);
        } catch (e) {
          return fail(errMsg(e));
        }
      }),

      tool("list_positions", "List all currently held positions with quantity, avg entry, market value and unrealized P&L.", {}, async () => {
        logCall("list_positions", {});
        try {
          const positions = await alpaca.getPositions();
          logResult("list_positions", `${positions.length} position(s)`);
          return json(positions);
        } catch (e) {
          return fail(errMsg(e));
        }
      }),

      tool(
        "list_orders",
        "List recent orders. Useful to check open/pending orders before placing new ones.",
        { status: z.enum(["open", "closed", "all"]).default("all").describe("Filter by order status") },
        async (args) => {
          logCall("list_orders", args);
          try {
            const orders = await alpaca.getOrders({ status: args.status, limit: 50 });
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
          const clock = await alpaca.getClock();
          logResult("get_market_clock", clock.is_open ? "market OPEN" : "market CLOSED");
          return json(clock);
        } catch (e) {
          return fail(errMsg(e));
        }
      }),

      tool(
        "get_stock_snapshot",
        "Get a real-time snapshot (latest trade, quote, daily/minute bar) for one or more stock symbols.",
        { symbols: z.array(z.string()).min(1).max(20).describe("Ticker symbols, e.g. ['AAPL','MSFT']") },
        async (args) => {
          const symbols = args.symbols.map((s) => s.toUpperCase());
          logCall("get_stock_snapshot", { symbols });
          try {
            const snaps = await alpaca.getSnapshots(symbols);
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
            const bars = await alpaca.getBars({ symbols, timeframe: args.timeframe, limit: args.limit });
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
            const news = await alpaca.getNews({ symbols, limit: args.limit });
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

      tool(
        "record_decision",
        "Record an investment decision and its rationale to the dashboard. Call this whenever you reach a conclusion about a position, BEFORE placing any order, so a human can review your reasoning.",
        {
          action: z.string().describe("Short action label, e.g. 'BUY', 'SELL', 'HOLD', 'WATCH', 'TRIM'"),
          symbol: z.string().optional().describe("Ticker the decision concerns, if applicable"),
          rationale: z.string().describe("Concise reasoning behind the decision"),
        },
        async (args) => {
          runStore.emit(runId, {
            kind: "decision",
            action: args.action.toUpperCase(),
            symbol: args.symbol?.toUpperCase(),
            rationale: args.rationale,
            at: now(),
          });
          return ok("Decision recorded.");
        },
      ),

      tool(
        "place_order",
        "Place a stock order through Alpaca. Provide EITHER qty (number of shares) OR notional (dollar amount), not both. Respect the per-order notional safety cap. Always call record_decision first to log your reasoning.",
        {
          symbol: z.string().describe("Ticker symbol"),
          side: z.enum(["buy", "sell"]),
          type: z.enum(["market", "limit"]).default("market"),
          time_in_force: z.enum(["day", "gtc"]).default("day"),
          qty: z.number().positive().optional().describe("Number of shares (whole or fractional)"),
          notional: z.number().positive().optional().describe("Dollar amount to trade (market orders only)"),
          limit_price: z.number().positive().optional().describe("Required for limit orders"),
        },
        async (args) => {
          const symbol = args.symbol.toUpperCase();
          logCall("place_order", { ...args, symbol });

          if (!args.qty && !args.notional) return fail("Provide either qty or notional.");
          if (args.qty && args.notional) return fail("Provide only one of qty or notional, not both.");
          if (args.type === "limit" && !args.limit_price) return fail("limit_price is required for limit orders.");
          if (args.type === "limit" && args.notional) return fail("notional orders must be market orders; use qty for limit orders.");

          // ── Safety: estimate notional and enforce the hard cap ──────────────
          let estNotional = args.notional ?? null;
          if (estNotional === null && args.qty) {
            const px = args.limit_price ?? (await priceFor(symbol));
            estNotional = px ? px * args.qty : null;
          }
          const cap = config.trading.maxOrderNotionalUsd;
          if (estNotional !== null && estNotional > cap) {
            const msg = `Order blocked: estimated notional $${estNotional.toFixed(2)} exceeds the per-order cap of $${cap}. Reduce the size.`;
            runStore.emit(runId, { kind: "error", message: msg, at: now() });
            return fail(msg);
          }

          try {
            const order = await alpaca.placeOrder({
              symbol,
              side: args.side,
              type: args.type,
              time_in_force: args.time_in_force,
              qty: args.qty,
              notional: args.notional,
              limit_price: args.limit_price,
            });
            const sizeStr = args.notional ? `$${args.notional}` : `${args.qty} sh`;
            const summary = `${config.trading.mode.toUpperCase()} ${args.side.toUpperCase()} ${sizeStr} ${symbol} (${args.type}) → order ${order.id} [${order.status}]`;
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
            await alpaca.cancelOrder(args.order_id);
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

function errMsg(e: unknown): string {
  if (e instanceof AlpacaError) return `Alpaca error (${e.status}): ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/** The tool names (mcp__alpaca__*) this server exposes, for the allowlist. */
export const ALPACA_TOOL_NAMES = [
  "get_account",
  "list_positions",
  "list_orders",
  "get_market_clock",
  "get_stock_snapshot",
  "get_stock_bars",
  "get_market_news",
  "record_decision",
  "place_order",
  "cancel_order",
].map((n) => `mcp__alpaca__${n}`);
