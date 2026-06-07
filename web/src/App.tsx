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
} from "./api";

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

  useEffect(() => {
    api.config().then(setCfg).catch(() => {});
    refreshPortfolio();
  }, [refreshPortfolio]);

  return (
    <div className="app">
      <Header cfg={cfg} clock={clock} />
      {error && <div className="banner error">{error}</div>}
      <main>
        <section className="left">
          <AccountCards account={account} />
          <Schedule cfg={cfg} onRunStarted={(id) => setWatchRequest({ id, n: Date.now() })} />
          <Positions positions={positions} />
          <Orders orders={orders} onCancel={refreshPortfolio} />
        </section>
        <section className="right">
          <AgentPanel cfg={cfg} watchRequest={watchRequest} onPortfolioMayHaveChanged={refreshPortfolio} />
        </section>
      </main>
    </div>
  );
}

function Header({ cfg, clock }: { cfg: AppConfig | null; clock: { is_open: boolean } | null }) {
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
        {cfg && (
          <>
            <Pill ok={cfg.ready.usingSubscription} warn={cfg.ready.usingApiKey}>
              {cfg.ready.usingSubscription ? "Subscription" : cfg.ready.usingApiKey ? "API key (billed)" : "No Claude auth"}
            </Pill>
            <Pill ok={cfg.ready.alpaca}>{cfg.ready.alpaca ? "Alpaca connected" : "Alpaca not configured"}</Pill>
            <Pill ok={cfg.trading.mode === "paper"} warn={cfg.trading.liveEnabled}>
              {cfg.trading.liveEnabled ? "LIVE money" : "Paper"}
            </Pill>
            <Pill muted>{cfg.model}</Pill>
          </>
        )}
        {clock && <Pill ok={clock.is_open} muted={!clock.is_open}>{clock.is_open ? "Market open" : "Market closed"}</Pill>}
      </div>
    </header>
  );
}

function Pill({ children, ok, warn, muted }: { children: ReactNode; ok?: boolean; warn?: boolean; muted?: boolean }) {
  const cls = warn ? "warn" : ok ? "good" : muted ? "muted" : "bad";
  return <span className={`pill ${cls}`}>{children}</span>;
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
          <div className="event-body">{event.text}</div>
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
          <div className="event-tag decision-tag">{event.action}{event.symbol ? ` ${event.symbol}` : ""}</div>
          <div className="event-body">{event.rationale}</div>
        </div>
      );
    case "order":
      return (
        <div className="event order">
          <div className="event-tag order-tag">ORDER</div>
          <div className="event-body strong">{event.summary}</div>
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
            {event.summary}
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
