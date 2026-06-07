import { query, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import { runStore, type Run } from "./store.js";
import { buildAlpacaServer, ALPACA_TOOL_NAMES } from "./tools.js";

const now = () => new Date().toISOString();

// Built-in Claude Code tools the agent is allowed to use for open-web research,
// alongside our Alpaca tools. Everything else (file system, bash, etc.) is denied.
const RESEARCH_TOOLS = ["WebSearch", "WebFetch"];
const TRADE_TOOLS = ["mcp__alpaca__place_order", "mcp__alpaca__cancel_order"];

/** The allowed tool set for a cycle. In review mode, order tools are removed. */
function allowedTools(allowTrading: boolean): Set<string> {
  const alpaca = allowTrading ? ALPACA_TOOL_NAMES : ALPACA_TOOL_NAMES.filter((t) => !TRADE_TOOLS.includes(t));
  return new Set([...alpaca, ...RESEARCH_TOOLS]);
}

function systemPrompt(allowTrading: boolean): string {
  if (!allowTrading) {
    return `You are an equities portfolio manager writing an END-OF-DAY REVIEW for a brokerage account on Alpaca. The market is now CLOSED.

This is a REVIEW ONLY — you CANNOT place or cancel orders, and you must not try. Your job is to summarize the day:
1. Pull the current account (get_account) and positions (list_positions); check today's orders with list_orders.
2. Look at how each holding moved today (get_stock_snapshot / get_stock_bars) and skim the day's news (get_market_news, WebSearch) for what drove the moves.
3. Write a clear end-of-day brief: total P&L for the day and per position, what the notable movers were and why, what was bought/sold today, what worked and what didn't, and a short watchlist / plan for tomorrow.

Be concise, specific, and grounded in the data you actually pulled. Do not invent numbers. End with the summary.`;
  }

  const liveWarning = config.trading.liveEnabled
    ? "⚠️ LIVE TRADING IS ENABLED — orders use REAL money. Be conservative and deliberate."
    : "You are in PAPER trading mode — orders are simulated with fake money, but behave as if they were real.";

  return `You are an autonomous equities portfolio manager operating a brokerage account through Alpaca.

${liveWarning}

Your job each cycle:
1. ASSESS the current portfolio: call get_account and list_positions. Check get_market_clock.
2. RESEARCH: use WebSearch / WebFetch for news, analyst views, macro and catalysts; use get_market_news for headlines; use get_stock_snapshot and get_stock_bars for prices and technicals. Ground every claim in data you actually retrieved — never invent numbers.
3. DECIDE: form a clear thesis for each relevant holding and any new candidates. Consider diversification, position sizing, valuation, momentum, and risk. Call record_decision for each conclusion (BUY / SELL / TRIM / ADD / HOLD / WATCH) with concise rationale BEFORE acting.
4. ACT: if and only if a decision warrants it, place orders with place_order. Respect the per-order notional cap of $${config.trading.maxOrderNotionalUsd}. Prefer modest, well-reasoned sizes. Do not trade just to be active — HOLD is a valid outcome.

Rules:
- Stay within available buying power; never attempt to spend cash you don't have.
- Diversify; avoid concentrating the whole account in one name.
- If the market is closed, you may still research and queue day/GTC orders, but note the timing in your reasoning.
- Be transparent: your final message should be a brief, plain-English summary of what you found, what you decided, and what you did (or deliberately did not do).
- If data is missing or a tool fails, say so rather than guessing.

Work efficiently and finish with a concise summary.`;
}

function permissionFor(allowed: Set<string>) {
  return async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
    // Allow our trading/research tools; deny anything else (file writes, bash, …).
    if (allowed.has(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }
    return { behavior: "deny", message: `Tool "${toolName}" is not permitted for this cycle.` };
  };
}

/**
 * Run one research/trade cycle. Streams events into the run store as it goes and
 * resolves when the agent finishes. Designed to run detached (fire-and-forget)
 * from the HTTP handler or scheduler; progress is observed via SSE.
 *
 * `allowTrading: false` runs a review-only cycle (e.g. the end-of-day summary):
 * the order tools are removed entirely, so it physically cannot trade.
 */
export async function runCycle(run: Run, userPrompt: string, opts: { allowTrading?: boolean } = {}): Promise<void> {
  const allowTrading = opts.allowTrading ?? true;
  const allowed = allowedTools(allowTrading);
  const alpacaServer = buildAlpacaServer(run.id);

  try {
    const response = query({
      prompt: userPrompt,
      options: {
        model: config.claude.model,
        systemPrompt: systemPrompt(allowTrading),
        maxTurns: 40,
        mcpServers: { alpaca: alpacaServer },
        allowedTools: [...allowed],
        canUseTool: permissionFor(allowed),
        // We never want the agent touching the host filesystem or shell.
        disallowedTools: ["Bash", "Write", "Edit", "Read", "NotebookEdit"],
      },
    });

    for await (const message of response) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim()) {
            runStore.emit(run.id, { kind: "assistant", text: block.text, at: now() });
          } else if (block.type === "thinking" && "thinking" in block && block.thinking?.trim()) {
            runStore.emit(run.id, { kind: "thinking", text: block.thinking, at: now() });
          } else if (block.type === "tool_use") {
            // Alpaca tools log their own richer events from inside the handler;
            // emit here only for built-in research tools so the timeline is complete.
            if (!block.name.startsWith("mcp__alpaca__")) {
              runStore.emit(run.id, { kind: "tool_call", tool: block.name, input: block.input, at: now() });
            }
          }
        }
      } else if (message.type === "result") {
        const summary = message.subtype === "success" ? message.result : `Run ended: ${message.subtype}`;
        runStore.emit(run.id, {
          kind: "result",
          summary,
          usage: "usage" in message ? message.usage : undefined,
          costUsd: "total_cost_usd" in message ? message.total_cost_usd : undefined,
          numTurns: "num_turns" in message ? message.num_turns : undefined,
          at: now(),
        });
      }
    }

    runStore.finish(run.id, "completed");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    runStore.emit(run.id, { kind: "error", message: msg, at: now() });
    runStore.finish(run.id, "failed");
  }
}
