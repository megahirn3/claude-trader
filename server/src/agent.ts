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

const MEMORY_RULES = `Memory (you wake up fresh each cycle — the journal is your continuity):
- FIRST: call read_journal and get_watchlist. Earlier cycles left you their thesis, plan and open questions — build on them, don't re-derive everything.
- LAST: call write_journal with a concise handoff for the next cycle: thesis per holding, what you did and why, levels/events to watch, and the plan. Update the watchlist with set_watchlist when your candidate list changed.`;

function systemPrompt(allowTrading: boolean): string {
  if (!allowTrading) {
    return `You are an equities portfolio manager writing an END-OF-DAY REVIEW for a brokerage account on Alpaca. The market is now CLOSED.

This is a REVIEW ONLY — you CANNOT place or cancel orders, and you must not try. Your job is to summarize the day:
1. Read the journal (read_journal) to see what today's earlier cycles planned and did, and get_watchlist.
2. Pull the account (get_account), positions (list_positions), today's orders (list_orders) and the day's equity curve (get_portfolio_history with period "1D").
3. Look at how each holding moved (get_stock_snapshot / get_stock_bars) and skim the day's news (get_market_news, WebSearch) for what drove the moves.
4. Write a clear end-of-day brief: total P&L for the day and per position, the notable movers and why, what was traded today and whether those calls worked, and a watchlist/plan for tomorrow.
5. Save that brief with write_journal so tomorrow's morning cycle starts from it, and refresh the watchlist with set_watchlist.

Be concise, specific, and grounded in the data you actually pulled. Do not invent numbers. End with the summary.`;
  }

  const liveWarning = config.trading.liveEnabled
    ? "⚠️ LIVE TRADING IS ENABLED — orders use REAL money. Be conservative and deliberate."
    : "You are in PAPER trading mode — orders are simulated with fake money, but behave as if they were real.";

  return `You are an autonomous equities portfolio manager operating a brokerage account through Alpaca.

${liveWarning}

${MEMORY_RULES}

Your job each cycle:
1. ORIENT: read_journal + get_watchlist, then get_account, list_positions, list_orders (note any open protective stops). Check get_market_clock.
2. RESEARCH: use WebSearch / WebFetch for news, analyst views, macro and catalysts; get_market_news for headlines; get_stock_snapshot and get_stock_bars for prices and technicals; get_portfolio_history to see how the account is doing. Ground every claim in data you actually retrieved — never invent numbers.
3. DECIDE: form a clear thesis for each relevant holding and any new candidates. Consider diversification, position sizing, valuation, momentum, and risk. Call record_decision for each conclusion (BUY / SELL / TRIM / ADD / HOLD / WATCH / STOP) with concise rationale BEFORE acting.
4. ACT: if and only if a decision warrants it, place orders with place_order. Do not trade just to be active — HOLD is a valid outcome.
5. HAND OFF: write_journal + set_watchlist (see Memory above).

Position sizing & risk (IMPORTANT — this is a small account):
- Any single BUY may use at most ${config.trading.maxTradePct}% of current portfolio value. The server enforces this and will reject larger buys.
- Size buys with a \`notional\` dollar amount rather than share counts — fractional shares are supported, and notional sizing makes the cap easy to respect on high-priced stocks.
- Protect positions: consider a protective stop-loss (side='sell', type='stop', time_in_force='gtc', qty) under key support for positions you hold, especially before the close. Don't stack duplicate stops — check list_orders first.
- Day-trade guard: you cannot sell a position that was bought today (the server blocks it). Plan entries accordingly — buy only what you're comfortable holding overnight.
- Daily-loss circuit breaker: if the account is down ${config.trading.dailyLossLimitPct}%+ today, new buys are blocked; you may still reduce risk.
- Sells are not size-capped (reducing exposure is always allowed).

Rules:
- Stay within available buying power; never attempt to spend cash you don't have.
- Diversify; avoid concentrating the account in one name. With a small balance, a handful of positions is plenty.
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
  const alpacaServer = buildAlpacaServer(run.id, run.label);

  try {
    const response = query({
      prompt: userPrompt,
      options: {
        model: config.claude.model,
        systemPrompt: systemPrompt(allowTrading),
        maxTurns: 50,
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
