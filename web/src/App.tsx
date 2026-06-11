import { forwardRef, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  api,
  usd,
  pct,
  type Account,
  type AppConfig,
  type Order,
  type Position,
  type RunEvent,
  type RunSummary,
  type ScheduleState,
  type ScheduleSlot,
  type PortfolioHistory,
  type JournalEntry,
  type WatchlistItem,
  type AlertItem,
} from "./api";

// ── Minimal, safe markdown renderer ───────────────────────────────────────────
// Escapes HTML first, then applies a small markdown subset (headings, bold,
// italics, inline code, links, bullet lists) — so agent journals and summaries
// render with real formatting instead of raw ** and ##.
function mdToHtml(src: string): string {
  let s = src.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const out: string[] = [];
  let inList = false;
  for (const raw of s.split(/\n/)) {
    const h = raw.match(/^\s*(#{1,4})\s+(.*)$/);
    const li = raw.match(/^\s*[-*]\s+(.*)$/);
    if (h) {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(`<div class="md-h">${h[2]}</div>`);
    } else if (li) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${li[1]}</li>`);
    } else if (raw.trim() === "") {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push('<div class="md-sp"></div>');
    } else {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(`<div>${raw}</div>`);
    }
  }
  if (inList) out.push("</ul>");
  return out.join("");
}

function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={`md ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: mdToHtml(text) }} />;
}

export function App() {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [clock, setClock] = useState<{ is_open: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // When a scheduled "Run now" starts a run, ask the agent panel to watch it.
  const [watchRequest, setWatchRequest] = useState<{ id: string; n: number } | null>(null);

  const refreshPortfolio = useCallback(async () => {
    try {
      const [a, p, o, c] = await Promise.all([
        api.account().catch(() => null),
        api.positions().catch(() => []),
        api.orders().catch(() => []),
        api.clock().catch(() => null),
      ]);
      setAccount(a);
      setPositions(p);
      setOrders(o);
      setClock(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadConfig = useCallback(() => {
    api.config().then(setCfg).catch(() => {});
  }, []);

  useEffect(() => {
    loadConfig();
    refreshPortfolio();
    // Live-refresh the account/positions/orders (prices, market values, P&L)
    // every 10 seconds so the displayed stock data stays current.
    const t = setInterval(refreshPortfolio, 10000);
    return () => clearInterval(t);
  }, [loadConfig, refreshPortfolio]);

  const kill = useCallback(async () => {
    if (!window.confirm("KILL SWITCH\n\nThis will cancel ALL open orders, SELL ALL positions at market, and pause the bot. Continue?")) return;
    try {
      const r = await api.kill();
      const errs = r.errors?.length ? `\n\nIssues: ${r.errors.join("; ")}` : "";
      window.alert(`Kill switch done.\nCancelled ${r.cancelledOrders} order(s), liquidated ${r.closedPositions} position(s).${errs}`);
    } catch (e) {
      window.alert(`Kill switch failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      loadConfig();
      refreshPortfolio();
    }
  }, [loadConfig, refreshPortfolio]);

  const resume = useCallback(async () => {
    await api.resume().catch(() => {});
    loadConfig();
  }, [loadConfig]);

  return (
    <div className="app">
      <Header cfg={cfg} clock={clock} onKill={kill} />
      {cfg?.halted && (
        <div className="banner halted">
          <span>⛔ <strong>Trading halted</strong> — the autopilot is paused and the agent can't place orders.</span>
          <button className="resume-btn" onClick={resume}>Resume trading</button>
        </div>
      )}
      {error && <div className="banner error">{error}</div>}
      <main>
        <section className="left">
          <AccountCards account={account} />
          <EquityChart configured={Boolean(account)} />
          <Schedule cfg={cfg} onRunStarted={(id) => setWatchRequest({ id, n: Date.now() })} />
          <Alerts cfg={cfg} />
          <Positions positions={positions} />
          <Orders orders={orders} onCancel={refreshPortfolio} />
        </section>
        <section className="right">
          <AgentPanel cfg={cfg} watchRequest={watchRequest} onPortfolioMayHaveChanged={refreshPortfolio} />
          <JournalCard />
        </section>
      </main>
    </div>
  );
}

function Header({ cfg, clock, onKill }: { cfg: AppConfig | null; clock: { is_open: boolean } | null; onKill: () => void }) {
  return (
    <header className="header">
      <div className="brand">
        <span className="logo">◆</span>
        <div>
          <h1>Claude Trader</h1>
          <p className="subtitle">Autonomous portfolio manager — powered by your Claude&nbsp;Max subscription</p>
        </div>
      </div>
      <div className="pills">
        {cfg && cfg.ready.alpaca && !cfg.halted && (
          <button className="kill-btn" onClick={onKill} title="Cancel all orders, sell all positions, pause the bot">
            ⏻ Kill switch
          </button>
        )}
        {cfg && (
          <>
            <Pill ok={cfg.ready.usingSubscription} warn={cfg.ready.usingApiKey}>
              {cfg.ready.usingSubscription ? "Subscription" : cfg.ready.usingApiKey ? "API key (billed)" : "No Claude auth"}
            </Pill>
            <Pill ok={cfg.ready.alpaca}>{cfg.ready.alpaca ? `Broker: ${cfg.broker}` : "Broker not configured"}</Pill>
            <Pill muted>data: {cfg.dataSource}</Pill>
            <Pill ok={cfg.notify.discord} muted={!cfg.notify.discord}>{cfg.notify.discord ? "Discord on" : "Discord off"}</Pill>
            <Pill ok={cfg.trading.mode === "paper"} warn={cfg.trading.liveEnabled}>
              {cfg.trading.liveEnabled ? "LIVE money" : "Paper"}
            </Pill>
            <Pill muted>{cfg.model}</Pill>
            <span className="guards-sep" />
            <Pill ok small>≤{cfg.trading.maxTradePct}% / trade</Pill>
            {cfg.trading.noLeverage && <Pill ok small>no leverage</Pill>}
            <Pill ok small>−{cfg.trading.dailyLossLimitPct}% breaker</Pill>
            {cfg.trading.avoidDayTrades && <Pill ok small>no day-trades</Pill>}
            {(cfg.trading.minPriceUsd > 0 || cfg.trading.excludeLeveragedEtf) && (
              <Pill ok small>
                {cfg.trading.minPriceUsd > 0 ? `≥$${cfg.trading.minPriceUsd}` : ""}
                {cfg.trading.minPriceUsd > 0 && cfg.trading.excludeLeveragedEtf ? " · " : ""}
                {cfg.trading.excludeLeveragedEtf ? "no lev-ETF" : ""}
              </Pill>
            )}
          </>
        )}
        {clock && <Pill ok={clock.is_open} muted={!clock.is_open}>{clock.is_open ? "Market open" : "Market closed"}</Pill>}
      </div>
    </header>
  );
}

function Pill({ children, ok, warn, muted, small }: { children: ReactNode; ok?: boolean; warn?: boolean; muted?: boolean; small?: boolean }) {
  const cls = warn ? "warn" : ok ? "good" : muted ? "muted" : "bad";
  return <span className={`pill ${cls}${small ? " pill-sm" : ""}`}>{children}</span>;
}

function AccountCards({ account }: { account: Account | null }) {
  if (!account) return <Card title="Portfolio"><p className="dim">Connect Alpaca to see your account.</p></Card>;
  const equity = Number(account.equity);
  const lastEquity = Number(account.last_equity);
  const dayPl = equity - lastEquity;
  const dayPlPct = lastEquity ? dayPl / lastEquity : 0;
  return (
    <div className="cards">
      <Stat label="Portfolio value" value={usd(account.portfolio_value)} />
      <Stat label="Today's P&L" value={usd(dayPl)} sub={pct(dayPlPct)} positive={dayPl >= 0} />
      <Stat label="Cash" value={usd(account.cash)} />
      <Stat label="Buying power" value={usd(account.buying_power)} />
    </div>
  );
}

function Stat({ label, value, sub, positive }: { label: string; value: string; sub?: string; positive?: boolean }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className={`stat-sub ${positive ? "up" : "down"}`}>{sub}</div>}
    </div>
  );
}

// ── Equity chart ──────────────────────────────────────────────────────────────

const PERIODS = ["1D", "1W", "1M", "3M"] as const;

function EquityChart({ configured }: { configured: boolean }) {
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>("1M");
  const [hist, setHist] = useState<PortfolioHistory | null>(null);

  useEffect(() => {
    if (!configured) return;
    api.history(period).then(setHist).catch(() => setHist(null));
  }, [period, configured]);

  if (!configured) return null;

  const points = (hist?.equity ?? []).filter((v): v is number => typeof v === "number" && v > 0);
  const first = points[0];
  const last = points[points.length - 1];
  const change = first && last ? (last - first) / first : 0;
  const up = change >= 0;

  // Map equity points into a 600x150 viewBox with a little vertical padding.
  const W = 600;
  const H = 150;
  const PAD = 8;
  let path = "";
  if (points.length >= 2) {
    const min = Math.min(...points);
    const max = Math.max(...points);
    const span = max - min || 1;
    path = points
      .map((v, i) => {
        const x = (i / (points.length - 1)) * W;
        const y = PAD + (1 - (v - min) / span) * (H - PAD * 2);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }

  return (
    <Card
      title="Equity"
      action={
        <div className="periods">
          {PERIODS.map((p) => (
            <button key={p} className={`period ${p === period ? "active" : ""}`} onClick={() => setPeriod(p)}>
              {p}
            </button>
          ))}
        </div>
      }
    >
      {points.length < 2 ? (
        <p className="dim">Not enough history yet — check back after a few trading days.</p>
      ) : (
        <>
          <div className="chart-head">
            <span className="chart-value">{usd(last)}</span>
            <span className={`chart-change ${up ? "up" : "down"}`}>
              {up ? "+" : ""}
              {usd(last - first)} ({pct(change)})
            </span>
          </div>
          <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
            <defs>
              <linearGradient id="eqfill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={up ? "var(--up)" : "var(--down)"} stopOpacity="0.25" />
                <stop offset="100%" stopColor={up ? "var(--up)" : "var(--down)"} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={`${path} L${W},${H} L0,${H} Z`} fill="url(#eqfill)" stroke="none" />
            <path d={path} fill="none" stroke={up ? "var(--up)" : "var(--down)"} strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </svg>
        </>
      )}
    </Card>
  );
}

// ── Journal & watchlist (the agent's memory) ─────────────────────────────────

function JournalCard() {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [watchlist, setWatchlistState] = useState<WatchlistItem[]>([]);

  useEffect(() => {
    const load = () => {
      api.journal(6).then(setEntries).catch(() => {});
      api.watchlist().then(setWatchlistState).catch(() => {});
    };
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  return (
    <Card title="Agent journal">
      {watchlist.length > 0 && (
        <div className="watchlist">
          {watchlist.map((w) => (
            <span key={w.symbol} className="watch-chip" title={w.note}>
              {w.symbol}
            </span>
          ))}
        </div>
      )}
      {entries.length === 0 ? (
        <p className="dim">No journal entries yet — the agent writes a handoff note at the end of every cycle.</p>
      ) : (
        <div className="journal-list">
          {entries.map((e) => (
            <div key={e.id} className="journal-entry">
              <div className="journal-meta">
                <span className="journal-label">{e.label}</span>
                <span className="dim small">{new Date(e.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
              </div>
              <Markdown className="journal-content" text={e.content} />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Positions({ positions }: { positions: Position[] }) {
  return (
    <Card title={`Positions (${positions.length})`}>
      {positions.length === 0 ? (
        <p className="dim">No open positions.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Symbol</th><th>Qty</th><th>Avg</th><th>Price</th><th>Value</th><th>Unrealized P&L</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              const up = Number(p.unrealized_pl) >= 0;
              return (
                <tr key={p.symbol}>
                  <td className="mono strong">{p.symbol}</td>
                  <td>{p.qty}</td>
                  <td>{usd(p.avg_entry_price)}</td>
                  <td>{usd(p.current_price)}</td>
                  <td>{usd(p.market_value)}</td>
                  <td className={up ? "up" : "down"}>
                    {usd(p.unrealized_pl)} <span className="dim">({pct(p.unrealized_plpc)})</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Orders({ orders, onCancel }: { orders: Order[]; onCancel: () => void }) {
  const cancel = async (id: string) => {
    await api.cancelOrder(id).catch(() => {});
    onCancel();
  };
  return (
    <Card title={`Recent orders (${orders.length})`}>
      {orders.length === 0 ? (
        <p className="dim">No orders yet.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Symbol</th><th>Side</th><th>Size</th><th>Type</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {orders.slice(0, 15).map((o) => {
              const open = ["new", "accepted", "pending_new", "partially_filled"].includes(o.status);
              return (
                <tr key={o.id}>
                  <td className="mono strong">{o.symbol}</td>
                  <td className={o.side === "buy" ? "up" : "down"}>{o.side}</td>
                  <td>{o.qty ? `${o.qty} sh` : o.notional ? usd(o.notional) : "—"}</td>
                  <td>{o.type}</td>
                  <td><span className={`status ${open ? "open" : ""}`}>{o.status}</span></td>
                  <td>{open && <button className="link" onClick={() => cancel(o.id)}>cancel</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ── Schedule (daily autopilot) ────────────────────────────────────────────────

function Schedule({ cfg, onRunStarted }: { cfg: AppConfig | null; onRunStarted: (id: string) => void }) {
  const [state, setState] = useState<ScheduleState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api.schedule().then(setState).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  const toggle = async () => {
    if (!state) return;
    setState(await api.setSchedule(!state.enabled));
  };

  const runNow = async (slot: ScheduleSlot) => {
    setBusy(slot.id);
    try {
      const id = await api.runSlot(slot.id);
      onRunStarted(id);
    } catch {
      /* surfaced in the agent panel */
    } finally {
      setBusy(null);
      setTimeout(load, 500);
    }
  };

  const ready = cfg?.ready.claude && cfg?.ready.alpaca;

  return (
    <Card
      title="Daily autopilot"
      action={
        state && (
          <button className={`toggle ${state.enabled ? "on" : ""}`} onClick={toggle}>
            {state.enabled ? "ON" : "OFF"}
          </button>
        )
      }
    >
      {!state ? (
        <p className="dim">Loading schedule…</p>
      ) : (
        <>
          <p className="dim small schedule-tz">
            Times in {state.timezone.replace("America/", "").replace("_", " ")} (market) · now {state.marketTime} ET
          </p>
          <div className="slots">
            {state.slots.map((slot) => (
              <div key={slot.id} className={`slot ${slot.enabled ? "" : "off"}`}>
                <div className="slot-time mono">{slot.time}</div>
                <div className="slot-main">
                  <div className="slot-label">
                    {slot.label}
                    {!slot.allowTrading && <span className="badge review">review only</span>}
                  </div>
                  <div className="slot-next dim small">
                    {slot.enabled ? (state.enabled ? `next: ${slot.nextRun ?? "—"}` : "autopilot off") : "disabled"}
                  </div>
                </div>
                <button className="link" disabled={!ready || busy === slot.id} onClick={() => runNow(slot)}>
                  {busy === slot.id ? "…" : "run now"}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

// ── Discord alerts ────────────────────────────────────────────────────────────

function Alerts({ cfg }: { cfg: AppConfig | null }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [feed, setFeed] = useState<AlertItem[]>([]);
  const on = cfg?.notify.discord;

  const load = useCallback(() => {
    api.alerts().then(setFeed).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const test = async () => {
    setState("sending");
    try {
      await api.testNotify();
      setState("sent");
    } catch {
      setState("error");
    }
    setTimeout(() => {
      setState("idle");
      load();
    }, 1500);
  };

  return (
    <Card
      title="Discord alerts"
      action={
        <div className="alerts-head">
          <span className={`alerts-dot ${on ? "on" : "off"}`} />
          <span className="dim small">{on ? "on" : "off"}</span>
          {on && (
            <button className="link" onClick={test} disabled={state === "sending"}>
              {state === "sending" ? "sending…" : state === "sent" ? "sent ✓" : state === "error" ? "failed" : "send test"}
            </button>
          )}
        </div>
      }
    >
      <p className="dim small" style={{ marginTop: 0 }}>
        {on ? (
          <>Pings on <strong>orders</strong>, <strong>risk-guard blocks</strong>, <strong>errors</strong>, run failures &amp; end-of-day summaries.</>
        ) : (
          <>Off. Set <span className="mono">DISCORD_WEBHOOK_URL</span> in <span className="mono">.env</span> to enable.</>
        )}
      </p>
      {feed.length > 0 && (
        <div className="alert-feed">
          {feed.map((a, i) => (
            <div key={i} className="alert-row">
              <span className="alert-time mono">{new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              <span className="alert-title">{a.title}</span>
              {!a.delivered && <span className="alert-undeliv" title="Recorded but not delivered to Discord">⚠</span>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── Agent panel ───────────────────────────────────────────────────────────────

function AgentPanel({
  cfg,
  watchRequest,
  onPortfolioMayHaveChanged,
}: {
  cfg: AppConfig | null;
  watchRequest: { id: string; n: number } | null;
  onPortfolioMayHaveChanged: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [status, setStatus] = useState<string>("");
  const [starting, setStarting] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  // Refs so the polling loop can read current state without re-subscribing.
  const statusRef = useRef(status);
  const activeRef = useRef(activeId);
  statusRef.current = status;
  activeRef.current = activeId;

  const loadRuns = useCallback(async (): Promise<RunSummary[]> => {
    const list = await api.runs().catch(() => [] as RunSummary[]);
    setRuns(list);
    return list;
  }, []);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  const watch = useCallback(
    (id: string, replay = false) => {
      esRef.current?.close();
      setActiveId(id);
      if (replay) setEvents([]);
      const es = new EventSource(`/api/runs/${id}/stream`);
      esRef.current = es;
      es.onmessage = (msg) => {
        const event = JSON.parse(msg.data) as RunEvent;
        setEvents((prev) => [...prev, event]);
        if (event.kind === "status") setStatus(event.status);
        if (event.kind === "order") onPortfolioMayHaveChanged();
      };
      es.addEventListener("done", () => {
        es.close();
        loadRuns();
        onPortfolioMayHaveChanged();
      });
      es.onerror = () => es.close();
    },
    [loadRuns, onPortfolioMayHaveChanged],
  );

  const openRun = useCallback(
    async (id: string) => {
      esRef.current?.close();
      const run = await api.run(id);
      setActiveId(id);
      setEvents(run.events);
      setStatus(run.status);
      if (run.status === "running") watch(id);
    },
    [watch],
  );

  // A scheduled "Run now" asks us to watch a specific run.
  useEffect(() => {
    if (watchRequest) {
      setEvents([]);
      setStatus("running");
      watch(watchRequest.id, true);
      loadRuns();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchRequest]);

  // Poll for runs; if we're idle and a scheduled run is now executing, attach to it live.
  useEffect(() => {
    const poll = async () => {
      const list = await loadRuns();
      if (statusRef.current !== "running") {
        const live = list.find((r) => r.status === "running");
        if (live && live.id !== activeRef.current) openRun(live.id);
      }
    };
    const t = setInterval(poll, 15000);
    return () => clearInterval(t);
  }, [loadRuns, openRun]);

  useEffect(() => {
    // Auto-scroll the timeline as events arrive.
    timelineRef.current?.scrollTo({ top: timelineRef.current.scrollHeight, behavior: "smooth" });
  }, [events]);

  useEffect(() => () => esRef.current?.close(), []);

  const start = async () => {
    setStarting(true);
    try {
      setEvents([]);
      setStatus("running");
      const id = await api.startRun(prompt.trim() || undefined);
      loadRuns();
      watch(id, true);
    } catch (e) {
      setStatus("failed");
      setEvents([{ kind: "error", message: e instanceof Error ? e.message : String(e), at: new Date().toISOString() }]);
    } finally {
      setStarting(false);
    }
  };

  const ready = cfg?.ready.claude && cfg?.ready.alpaca;
  const running = status === "running";

  return (
    <Card
      title="Trading agent"
      action={<RunBadge runs={runs} activeId={activeId} onPick={openRun} />}
    >
      <div className="agent-controls">
        <textarea
          placeholder="Optional: give the agent a specific focus (e.g. 'Look for an AI infrastructure name to add, max $500'). Leave blank for a full portfolio review."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          disabled={running}
        />
        <div className="agent-actions">
          <button className="primary" onClick={start} disabled={!ready || starting || running}>
            {running ? "Agent working…" : starting ? "Starting…" : "▶ Run trading cycle"}
          </button>
          {cfg?.trading.liveEnabled && <span className="live-warning">LIVE — real money</span>}
          {!ready && <span className="dim small">Configure Claude &amp; Alpaca to enable.</span>}
        </div>
      </div>

      <Timeline events={events} ref={timelineRef} running={running} />
    </Card>
  );
}

function RunBadge({ runs, activeId, onPick }: { runs: RunSummary[]; activeId: string | null; onPick: (id: string) => void }) {
  if (runs.length === 0) return null;
  return (
    <select className="run-select" value={activeId ?? ""} onChange={(e) => e.target.value && onPick(e.target.value)}>
      <option value="">Past runs…</option>
      {runs.map((r) => (
        <option key={r.id} value={r.id}>
          {r.label} · {new Date(r.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {r.status}
        </option>
      ))}
    </select>
  );
}

const Timeline = forwardRef<HTMLDivElement, { events: RunEvent[]; running: boolean }>(
  function Timeline({ events, running }, ref) {
    return (
      <div className="timeline" ref={ref}>
        {events.length === 0 && !running && (
          <p className="dim center">Run a cycle to watch the agent research and trade in real time.</p>
        )}
        {events.map((e, i) => (
          <EventRow key={i} event={e} />
        ))}
        {running && (
          <div className="event thinking-dot">
            <span className="spinner" /> agent is working…
          </div>
        )}
      </div>
    );
  },
);

function EventRow({ event }: { event: RunEvent }) {
  switch (event.kind) {
    case "assistant":
      return (
        <div className="event assistant">
          <div className="event-tag">Claude</div>
          <Markdown className="event-body" text={event.text} />
        </div>
      );
    case "thinking":
      return (
        <div className="event thinking">
          <div className="event-tag">thinking</div>
          <div className="event-body">{event.text}</div>
        </div>
      );
    case "tool_call":
      return (
        <div className="event tool">
          <div className="event-tag">{prettyTool(event.tool)}</div>
          <div className="event-body mono small">{summarizeInput(event.input)}</div>
        </div>
      );
    case "tool_result":
      return (
        <div className="event tool-result">
          <div className="event-tag">{prettyTool(event.tool)} →</div>
          <div className="event-body small">{event.summary}</div>
        </div>
      );
    case "decision":
      return (
        <div className="event decision">
          <div className="event-tag decision-tag">
            {event.action}{event.symbol ? ` ${event.symbol}` : ""}
            {typeof event.conviction === "number" && <span className="conviction">{"●".repeat(event.conviction)}{"○".repeat(Math.max(0, 5 - event.conviction))}</span>}
          </div>
          <div className="event-body">
            <Markdown text={event.rationale} />
            {event.sources && event.sources.length > 0 && (
              <div className="sources dim small">sources: {event.sources.join(" · ")}</div>
            )}
          </div>
        </div>
      );
    case "order":
      return (
        <div className="event order">
          <div className="event-tag order-tag">ORDER</div>
          <div className="event-body strong">{event.summary}</div>
        </div>
      );
    case "journal":
      return (
        <div className="event journal-event">
          <div className="event-tag">journal</div>
          <Markdown className="event-body" text={event.text} />
        </div>
      );
    case "error":
      return (
        <div className="event error-event">
          <div className="event-tag">error</div>
          <div className="event-body">{event.message}</div>
        </div>
      );
    case "result":
      return (
        <div className="event result">
          <div className="event-tag">summary</div>
          <div className="event-body">
            <Markdown text={event.summary} />
            {event.costUsd != null && <div className="dim small">Cost: ${event.costUsd.toFixed(4)} · {event.numTurns ?? "?"} turns</div>}
          </div>
        </div>
      );
    default:
      return null;
  }
}

function prettyTool(tool: string): string {
  return tool.replace(/^mcp__alpaca__/, "").replace(/_/g, " ");
}

function summarizeInput(input: unknown): string {
  if (input == null) return "";
  try {
    const s = JSON.stringify(input);
    return s.length > 160 ? s.slice(0, 160) + "…" : s;
  } catch {
    return String(input);
  }
}

// ── Generic card ──────────────────────────────────────────────────────────────

function Card({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="card">
      <div className="card-head">
        <h2>{title}</h2>
        {action}
      </div>
      <div className="card-body">{children}</div>
    </div>
  );
}
