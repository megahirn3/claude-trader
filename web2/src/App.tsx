import { forwardRef, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
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

/* ── safe markdown ─────────────────────────────────────────────────────────── */
function mdToHtml(src: string): string {
  let s = src
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  // URL char class excludes quotes/brackets so a link can't break out of href.
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)"'<>]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const out: string[] = [];
  let inList = false;
  for (const raw of s.split(/\n/)) {
    const h = raw.match(/^\s*(#{1,4})\s+(.*)$/);
    const li = raw.match(/^\s*[-*]\s+(.*)$/);
    if (h) { if (inList) { out.push("</ul>"); inList = false; } out.push(`<div class="md-h">${h[2]}</div>`); }
    else if (li) { if (!inList) { out.push("<ul>"); inList = true; } out.push(`<li>${li[1]}</li>`); }
    else if (raw.trim() === "") { if (inList) { out.push("</ul>"); inList = false; } out.push('<div class="md-sp"></div>'); }
    else { if (inList) { out.push("</ul>"); inList = false; } out.push(`<div>${raw}</div>`); }
  }
  if (inList) out.push("</ul>");
  return out.join("");
}
const Markdown = ({ text, className }: { text: string; className?: string }) => (
  <div className={`md ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: mdToHtml(text) }} />
);

/* ── primitives ────────────────────────────────────────────────────────────── */
function Panel({ children, className = "", title, action, delay = 0 }: { children: ReactNode; className?: string; title?: string; action?: ReactNode; delay?: number }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55, delay, ease: [0.22, 1, 0.36, 1] }}
      className={`glass shadow-glass ${className}`}
    >
      {title && (
        <div className="flex items-center justify-between border-b hairline px-4 pb-2.5 pt-3.5">
          <h2 className="label">{title}</h2>
          {action}
        </div>
      )}
      {children}
    </motion.section>
  );
}

function Chip({ children, tone = "muted" }: { children: ReactNode; tone?: "good" | "warn" | "bad" | "muted" | "accent" }) {
  const dot = tone === "good" ? "bg-up" : tone === "warn" ? "bg-accent" : tone === "bad" ? "bg-down" : tone === "accent" ? "bg-accent" : "bg-ink-faint";
  const txt = tone === "good" ? "text-up" : tone === "bad" ? "text-down" : tone === "warn" || tone === "accent" ? "text-accent" : "text-ink-soft";
  return (
    <span className="glass shadow-chip inline-flex items-center gap-1.5 rounded-chip px-2.5 py-1 text-[11.5px] font-medium">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      <span className={txt}>{children}</span>
    </span>
  );
}

/* ── app ───────────────────────────────────────────────────────────────────── */
export function App() {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [clock, setClock] = useState<{ is_open: boolean } | null>(null);
  const [watchRequest, setWatchRequest] = useState<{ id: string; n: number } | null>(null);

  const refreshPortfolio = useCallback(async () => {
    const [a, p, o, c] = await Promise.all([
      api.account().catch(() => null),
      api.positions().catch(() => []),
      api.orders().catch(() => []),
      api.clock().catch(() => null),
    ]);
    setAccount(a); setPositions(p); setOrders(o); setClock(c);
  }, []);
  const loadConfig = useCallback(() => { api.config().then(setCfg).catch(() => {}); }, []);

  useEffect(() => {
    loadConfig();
    refreshPortfolio();
    const t = setInterval(refreshPortfolio, 10000);
    return () => clearInterval(t);
  }, [loadConfig, refreshPortfolio]);

  const kill = useCallback(async () => {
    if (!window.confirm("KILL SWITCH\n\nCancel ALL orders, SELL ALL positions at market, and pause the bot?")) return;
    try { const r = await api.kill(); window.alert(`Done. Cancelled ${r.cancelledOrders} order(s), liquidated ${r.closedPositions} position(s).${r.errors?.length ? "\n\n" + r.errors.join("; ") : ""}`); }
    catch (e) { window.alert(`Kill failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { loadConfig(); refreshPortfolio(); }
  }, [loadConfig, refreshPortfolio]);
  const resume = useCallback(async () => { await api.resume().catch(() => {}); loadConfig(); }, [loadConfig]);

  return (
    <div className="mx-auto max-w-[1380px] px-4 py-5 sm:px-6">
      <Header cfg={cfg} clock={clock} onKill={kill} />
      {cfg?.halted && (
        <div className="glass shadow-glass mb-4 flex items-center justify-between gap-3 rounded-glass px-4 py-3 text-down">
          <span className="text-sm">⛔ <strong>Trading halted</strong> — autopilot paused; the agent can’t place orders.</span>
          <button onClick={resume} className="rounded-chip bg-up px-3.5 py-1.5 text-[12.5px] font-semibold text-paper">Resume</button>
        </div>
      )}

      <Ticker positions={positions} clock={clock} />
      <HeroStrip account={account} />

      <main className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.04fr)]">
        <div className="flex flex-col gap-3">
          <EquityPanel hasData={Boolean(account)} />
          <Schedule cfg={cfg} onRunStarted={(id) => setWatchRequest({ id, n: Date.now() })} />
          <Alerts cfg={cfg} />
          <Positions positions={positions} />
          <Orders orders={orders} onCancel={refreshPortfolio} />
        </div>
        <div className="flex flex-col gap-3">
          <AgentPanel cfg={cfg} watchRequest={watchRequest} onChanged={refreshPortfolio} />
          <JournalCard />
        </div>
      </main>
      <footer className="mt-6 text-center text-[11px] text-ink-faint">Claude&nbsp;Trader · paper-first · not financial advice</footer>
    </div>
  );
}

/* ── header ────────────────────────────────────────────────────────────────── */
function Header({ cfg, clock, onKill }: { cfg: AppConfig | null; clock: { is_open: boolean } | null; onKill: () => void }) {
  const t = cfg?.trading;
  return (
    <motion.header
      initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="glass shadow-glass mb-4 flex flex-wrap items-center justify-between gap-x-5 gap-y-3 px-5 py-3.5"
    >
      <div className="flex items-center gap-3.5">
        <span className="grid h-10 w-10 place-items-center rounded-[12px] bg-gradient-to-br from-accent-soft to-accent text-paper shadow-[0_6px_18px_-6px_rgba(190,91,54,0.6)]">
          <span className="rotate-45 text-lg leading-none">◆</span>
        </span>
        <div>
          <h1 className="font-display text-[22px] font-semibold leading-none tracking-[-0.01em]">Claude Trader</h1>
          <p className="mt-1 text-[12px] text-ink-soft">Autonomous portfolio manager · your Claude&nbsp;Max subscription</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {cfg && cfg.ready.alpaca && !cfg.halted && (
          <button onClick={onKill} title="Cancel all orders, sell all positions, pause the bot"
            className="glass shadow-chip rounded-chip px-2.5 py-1 text-[11.5px] font-semibold text-down transition-colors hover:bg-down hover:text-paper">⏻ Kill</button>
        )}
        {cfg && (
          <>
            <Chip tone={cfg.ready.usingSubscription ? "good" : cfg.ready.usingApiKey ? "warn" : "bad"}>{cfg.ready.usingSubscription ? "Subscription" : cfg.ready.usingApiKey ? "API billed" : "No auth"}</Chip>
            <Chip tone={cfg.ready.alpaca ? "good" : "bad"}>{cfg.broker}</Chip>
            <Chip>{cfg.dataSource.replace(" (real-time)", " · RT")}</Chip>
            <Chip tone={cfg.notify.discord ? "good" : "muted"}>Discord</Chip>
            <Chip tone={cfg.trading.liveEnabled ? "warn" : "good"}>{cfg.trading.liveEnabled ? "LIVE $" : "Paper"}</Chip>
            <Chip>{cfg.model.replace("claude-", "")}</Chip>
            {clock && <Chip tone={clock.is_open ? "good" : "muted"}>{clock.is_open ? "open" : "closed"}</Chip>}
          </>
        )}
      </div>
      {t && (
        <div className="flex w-full flex-wrap items-center gap-1.5 border-t hairline pt-2.5">
          <span className="label mr-1">guards</span>
          <Chip tone="accent">≤{t.maxTradePct}% / trade</Chip>
          {t.noLeverage && <Chip tone="accent">no leverage</Chip>}
          <Chip tone="accent">−{t.dailyLossLimitPct}% breaker</Chip>
          {t.avoidDayTrades === "on" && <Chip tone="accent">no day-trades</Chip>}
          {t.avoidDayTrades === "auto" && <Chip tone="accent">day-trades: auto</Chip>}
          {(t.minPriceUsd > 0 || t.excludeLeveragedEtf) && <Chip tone="accent">{[t.minPriceUsd > 0 ? `≥$${t.minPriceUsd}` : "", t.excludeLeveragedEtf ? "no lev-ETF" : ""].filter(Boolean).join(" · ")}</Chip>}
        </div>
      )}
    </motion.header>
  );
}

/* ── ticker ────────────────────────────────────────────────────────────────── */
function Ticker({ positions, clock }: { positions: Position[]; clock: { is_open: boolean } | null }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5, delay: 0.04 }}
      className="glass mb-3 flex items-center gap-4 overflow-hidden rounded-[12px] px-3.5 py-2">
      <span className="num flex items-center gap-1.5 whitespace-nowrap text-[11px] font-semibold uppercase tracking-wider text-ink-soft">
        <span className={`h-1.5 w-1.5 rounded-full ${clock?.is_open ? "animate-pulseSoft bg-up" : "bg-ink-faint"}`} />
        {clock?.is_open ? "market live" : "market closed"}
      </span>
      <div className="h-3.5 w-px bg-line" />
      <div className="num flex flex-1 items-center gap-5 overflow-x-auto whitespace-nowrap text-[12.5px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {positions.length === 0 ? (
          <span className="text-ink-faint">no open positions</span>
        ) : (
          positions.map((p) => {
            const up = Number(p.change_today) >= 0;
            return (
              <span key={p.symbol} className="flex items-center gap-1.5">
                <span className="font-semibold">{p.symbol}</span>
                <span className="text-ink-soft">{usd(p.current_price)}</span>
                <span className={up ? "text-up" : "text-down"}>{up ? "▲" : "▼"}{pct(Math.abs(Number(p.change_today))).replace("+", "")}</span>
              </span>
            );
          })
        )}
      </div>
    </motion.div>
  );
}

/* ── hero metric strip ─────────────────────────────────────────────────────── */
function MetricCell({ label, value, sub, subTone, big, delay }: { label: string; value: string; sub?: string; subTone?: "up" | "down"; big?: boolean; delay: number }) {
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] }}
      className="glass relative overflow-hidden p-4">
      <div className="label">{label}</div>
      <div className={`num mt-1.5 font-semibold leading-none ${big ? "text-[30px]" : "text-[21px]"} ${subTone === "up" ? "text-up" : subTone === "down" ? "text-down" : ""}`}>{value}</div>
      {sub && <div className={`num mt-1 text-[12px] ${subTone === "up" ? "text-up" : subTone === "down" ? "text-down" : "text-ink-faint"}`}>{sub}</div>}
    </motion.div>
  );
}
function HeroStrip({ account }: { account: Account | null }) {
  const equity = Number(account?.equity ?? 0);
  const last = Number(account?.last_equity ?? 0);
  const dayPl = equity - last;
  const dayPlPct = last ? dayPl / last : 0;
  const up = dayPl >= 0;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <MetricCell label="Portfolio value" big value={account ? usd(account.portfolio_value) : "—"} delay={0.06} />
      <MetricCell label="Today" value={account ? `${up ? "▲" : "▼"} ${usd(Math.abs(dayPl))}` : "—"} sub={account ? pct(dayPlPct) : undefined} subTone={up ? "up" : "down"} delay={0.1} />
      <MetricCell label="Cash" value={account ? usd(account.cash) : "—"} delay={0.14} />
      <MetricCell label="Buying power" value={account ? usd(account.buying_power) : "—"} delay={0.18} />
    </div>
  );
}

/* ── equity chart ──────────────────────────────────────────────────────────── */
const PERIODS = ["1D", "1W", "1M", "3M"] as const;
function EquityPanel({ hasData }: { hasData: boolean }) {
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>("1M");
  const [hist, setHist] = useState<PortfolioHistory | null>(null);
  useEffect(() => { if (hasData) api.history(period).then(setHist).catch(() => setHist(null)); }, [period, hasData]);

  const pts = (hist?.equity ?? []).filter((v): v is number => typeof v === "number" && v > 0);
  const first = pts[0], lastv = pts[pts.length - 1];
  const change = first && lastv ? (lastv - first) / first : 0;
  const up = change >= 0;
  const W = 600, H = 150, PAD = 10;
  let line = "";
  if (pts.length >= 2) {
    const min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
    line = pts.map((v, i) => `${i === 0 ? "M" : "L"}${((i / (pts.length - 1)) * W).toFixed(1)},${(PAD + (1 - (v - min) / span) * (H - PAD * 2)).toFixed(1)}`).join(" ");
  }
  return (
    <Panel title="Equity" delay={0.1} action={
      <div className="flex gap-1">
        {PERIODS.map((p) => (
          <button key={p} onClick={() => setPeriod(p)} className={`num rounded-md px-2 py-0.5 text-[11px] transition-colors ${p === period ? "bg-accent text-paper" : "text-ink-soft hover:bg-black/5"}`}>{p}</button>
        ))}
      </div>
    }>
      <div className="p-4">
        {pts.length < 2 ? <p className="text-[13px] text-ink-soft">Not enough history yet — check back after a few trading days.</p> : (
          <>
            <div className="mb-2 flex items-baseline gap-3">
              <span className="num text-[20px] font-semibold">{usd(lastv)}</span>
              <span className={`num text-[13px] ${up ? "text-up" : "text-down"}`}>{up ? "+" : ""}{usd(lastv - first)} ({pct(change)})</span>
            </div>
            <svg className="block h-[120px] w-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
              <defs>
                <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={up ? "var(--up)" : "var(--down)"} stopOpacity="0.28" />
                  <stop offset="100%" stopColor={up ? "var(--up)" : "var(--down)"} stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d={`${line} L${W},${H} L0,${H} Z`} fill="url(#eq)" />
              <path d={line} fill="none" stroke={up ? "var(--up)" : "var(--down)"} strokeWidth="2" vectorEffect="non-scaling-stroke" />
            </svg>
          </>
        )}
      </div>
    </Panel>
  );
}

/* ── positions / orders ────────────────────────────────────────────────────── */
function Positions({ positions }: { positions: Position[] }) {
  return (
    <Panel title={`Positions · ${positions.length}`} delay={0.18}>
      <div className="p-2">
        {positions.length === 0 ? <p className="px-2 py-3 text-[13px] text-ink-soft">No open positions.</p> : (
          <table className="w-full text-[13px]">
            <thead><tr className="label">{["Symbol", "Qty", "Avg", "Price", "Value", "P&L"].map((h, i) => <th key={h} className={`px-2 py-1.5 font-semibold ${i === 0 ? "text-left" : "text-right"}`}>{h}</th>)}</tr></thead>
            <tbody>
              {positions.map((p) => {
                const up = Number(p.unrealized_pl) >= 0;
                return (
                  <tr key={p.symbol} className="border-t hairline">
                    <td className="num px-2 py-1.5 font-semibold">{p.symbol}</td>
                    <td className="num px-2 py-1.5 text-right text-ink-soft">{Number(p.qty).toFixed(2)}</td>
                    <td className="num px-2 py-1.5 text-right text-ink-soft">{usd(p.avg_entry_price)}</td>
                    <td className="num px-2 py-1.5 text-right">{usd(p.current_price)}</td>
                    <td className="num px-2 py-1.5 text-right">{usd(p.market_value)}</td>
                    <td className={`num px-2 py-1.5 text-right ${up ? "text-up" : "text-down"}`}>{usd(p.unrealized_pl)} <span className="text-ink-faint">({pct(p.unrealized_plpc)})</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Panel>
  );
}

function Orders({ orders, onCancel }: { orders: Order[]; onCancel: () => void }) {
  const cancel = async (id: string) => { await api.cancelOrder(id).catch(() => {}); onCancel(); };
  return (
    <Panel title={`Recent orders · ${orders.length}`} delay={0.24}>
      <div className="p-2">
        {orders.length === 0 ? <p className="px-2 py-3 text-[13px] text-ink-soft">No orders yet.</p> : (
          <table className="w-full text-[13px]">
            <thead><tr className="label">{["Symbol", "Side", "Size", "Type", "Status", ""].map((h, i) => <th key={h + i} className={`px-2 py-1.5 font-semibold ${i === 5 ? "text-right" : "text-left"}`}>{h}</th>)}</tr></thead>
            <tbody>
              {orders.slice(0, 12).map((o) => {
                const open = ["new", "accepted", "pending_new", "partially_filled"].includes(o.status);
                return (
                  <tr key={o.id} className="border-t hairline">
                    <td className="num px-2 py-1.5 font-semibold">{o.symbol}</td>
                    <td className={`px-2 py-1.5 ${o.side === "buy" ? "text-up" : "text-down"}`}>{o.side}</td>
                    <td className="num px-2 py-1.5">{o.qty ? `${o.qty} sh` : o.notional ? usd(o.notional) : "—"}</td>
                    <td className="px-2 py-1.5 text-ink-soft">{o.type}</td>
                    <td className={`num px-2 py-1.5 ${open ? "text-accent" : "text-ink-faint"}`}>{o.status}</td>
                    <td className="px-2 py-1.5 text-right">{open && <button onClick={() => cancel(o.id)} className="text-[12px] text-accent hover:underline">cancel</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Panel>
  );
}

/* ── schedule ──────────────────────────────────────────────────────────────── */
function Schedule({ cfg, onRunStarted }: { cfg: AppConfig | null; onRunStarted: (id: string) => void }) {
  const [state, setState] = useState<ScheduleState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => { api.schedule().then(setState).catch(() => {}); }, []);
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);
  const toggle = async () => { if (state) setState(await api.setSchedule(!state.enabled)); };
  const runNow = async (s: ScheduleSlot) => { setBusy(s.id); try { onRunStarted(await api.runSlot(s.id)); } catch { /* shown in panel */ } finally { setBusy(null); setTimeout(load, 600); } };
  const ready = cfg?.ready.claude && cfg?.ready.alpaca;
  return (
    <Panel title="Daily autopilot" delay={0.12} action={state && (
      <button onClick={toggle} className={`num rounded-chip px-3 py-0.5 text-[11px] font-bold tracking-wider ${state.enabled ? "bg-up text-paper" : "bg-black/10 text-ink-soft"}`}>{state.enabled ? "ON" : "OFF"}</button>
    )}>
      <div className="p-3">
        {!state ? <p className="text-[13px] text-ink-soft">Loading…</p> : (
          <>
            <p className="mb-2.5 text-[11.5px] text-ink-faint">{state.timezone.replace("America/", "").replace("_", " ")} · now <span className="num">{state.marketTime}</span> ET</p>
            <div className="flex flex-col gap-2">
              {state.slots.map((s) => (
                <div key={s.id} className={`glass flex items-center gap-3 rounded-[12px] px-3 py-2 ${s.enabled ? "" : "opacity-50"}`}>
                  <div className="num w-11 text-[15px] font-semibold">{s.time}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[13px] font-medium">{s.label}{!s.allowTrading && <span className="num rounded bg-accent/15 px-1.5 py-px text-[9.5px] uppercase tracking-wide text-accent">review</span>}</div>
                    <div className="text-[11px] text-ink-faint">{s.enabled ? (state.enabled ? `next ${s.nextRun ?? "—"}` : "autopilot off") : "disabled"}</div>
                  </div>
                  <button disabled={!ready || busy === s.id} onClick={() => runNow(s)} className="text-[12px] text-accent hover:underline disabled:text-ink-faint disabled:no-underline">{busy === s.id ? "…" : "run now"}</button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

/* ── alerts ────────────────────────────────────────────────────────────────── */
function Alerts({ cfg }: { cfg: AppConfig | null }) {
  const [st, setSt] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [feed, setFeed] = useState<AlertItem[]>([]);
  const on = cfg?.notify.discord;
  const load = useCallback(() => { api.alerts().then(setFeed).catch(() => {}); }, []);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  const test = async () => { setSt("sending"); try { await api.testNotify(); setSt("sent"); } catch { setSt("error"); } setTimeout(() => { setSt("idle"); load(); }, 1500); };
  return (
    <Panel title="Discord alerts" delay={0.2} action={
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${on ? "bg-up" : "bg-ink-faint"}`} />
        {on && <button onClick={test} disabled={st === "sending"} className="text-[12px] text-accent hover:underline">{st === "sending" ? "sending…" : st === "sent" ? "sent ✓" : st === "error" ? "failed" : "test"}</button>}
      </div>
    }>
      <div className="p-3">
        <p className="text-[12px] text-ink-soft">{on ? "Pings on orders, risk blocks, errors & end-of-day summaries." : <>Off — set <span className="num">DISCORD_WEBHOOK_URL</span>.</>}</p>
        {feed.length > 0 && (
          <div className="mt-2.5 flex max-h-40 flex-col gap-1 overflow-y-auto">
            {feed.map((a, i) => (
              <div key={i} className="flex items-baseline gap-2 border-t hairline py-1 text-[12.5px]">
                <span className="num text-[11px] text-ink-faint">{new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                <span className="flex-1">{a.title}</span>
                {!a.delivered && <span className="text-accent" title="not delivered">⚠</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}

/* ── agent panel ───────────────────────────────────────────────────────────── */
function AgentPanel({ cfg, watchRequest, onChanged }: { cfg: AppConfig | null; watchRequest: { id: string; n: number } | null; onChanged: () => void }) {
  const [prompt, setPrompt] = useState("");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [status, setStatus] = useState<string>("");
  const [starting, setStarting] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const statusRef = useRef(status); statusRef.current = status;
  const activeRef = useRef(activeId); activeRef.current = activeId;

  const loadRuns = useCallback(async () => { const l = await api.runs().catch(() => [] as RunSummary[]); setRuns(l); return l; }, []);
  useEffect(() => { loadRuns(); }, [loadRuns]);

  const watch = useCallback((id: string, replay = false) => {
    esRef.current?.close(); setActiveId(id); if (replay) setEvents([]);
    const es = new EventSource(`/api/runs/${id}/stream`); esRef.current = es;
    es.onmessage = (m) => { const e = JSON.parse(m.data) as RunEvent; setEvents((p) => [...p, e]); if (e.kind === "status") setStatus(e.status); if (e.kind === "order") onChanged(); };
    es.addEventListener("done", () => { es.close(); loadRuns(); onChanged(); });
    es.onerror = () => es.close();
  }, [loadRuns, onChanged]);

  const openRun = useCallback(async (id: string) => {
    esRef.current?.close(); const run = await api.run(id); setActiveId(id); setEvents(run.events); setStatus(run.status); if (run.status === "running") watch(id);
  }, [watch]);

  useEffect(() => { if (watchRequest) { setEvents([]); setStatus("running"); watch(watchRequest.id, true); loadRuns(); } /* eslint-disable-next-line */ }, [watchRequest]);
  useEffect(() => {
    const poll = async () => { const l = await loadRuns(); if (statusRef.current !== "running") { const live = l.find((r) => r.status === "running"); if (live && live.id !== activeRef.current) openRun(live.id); } };
    const t = setInterval(poll, 15000); return () => clearInterval(t);
  }, [loadRuns, openRun]);
  useEffect(() => { timelineRef.current?.scrollTo({ top: timelineRef.current.scrollHeight, behavior: "smooth" }); }, [events]);
  useEffect(() => () => esRef.current?.close(), []);

  const start = async () => {
    setStarting(true);
    try { setEvents([]); setStatus("running"); const id = await api.startRun(prompt.trim() || undefined); loadRuns(); watch(id, true); }
    catch (e) { setStatus("failed"); setEvents([{ kind: "error", message: e instanceof Error ? e.message : String(e), at: new Date().toISOString() }]); }
    finally { setStarting(false); }
  };
  const ready = cfg?.ready.claude && cfg?.ready.alpaca;
  const running = status === "running";

  return (
    <Panel title="Trading agent" delay={0.08} className="flex min-h-[640px] flex-col"
      action={runs.length > 0 && (
        <select value={activeId ?? ""} onChange={(e) => e.target.value && openRun(e.target.value)} className="num rounded-md border hairline bg-white/40 px-2 py-0.5 text-[11px]">
          <option value="">past runs…</option>
          {runs.map((r) => <option key={r.id} value={r.id}>{r.label} · {new Date(r.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {r.status}</option>)}
        </select>
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3.5">
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} disabled={running}
          placeholder="Optional focus (e.g. 'find an under-the-radar AI-infra name with upside'). Blank = full cycle."
          className="w-full resize-none rounded-[12px] border hairline bg-white/45 px-3 py-2.5 text-[13px] outline-none placeholder:text-ink-faint focus:border-accent/60" />
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={start} disabled={!ready || starting || running}
            className="rounded-[12px] bg-gradient-to-br from-accent-soft to-accent px-4 py-2 text-[13.5px] font-semibold text-paper shadow-[0_8px_22px_-8px_rgba(190,91,54,0.6)] disabled:opacity-50">
            {running ? "Agent working…" : starting ? "Starting…" : "▶ Run trading cycle"}
          </button>
          {cfg?.trading.liveEnabled && <span className="text-[12px] font-semibold text-down">LIVE — real money</span>}
          {!ready && <span className="text-[12px] text-ink-faint">Configure Claude &amp; Alpaca to enable.</span>}
        </div>
        <Timeline ref={timelineRef} events={events} running={running} />
      </div>
    </Panel>
  );
}

const Timeline = forwardRef<HTMLDivElement, { events: RunEvent[]; running: boolean }>(function Timeline({ events, running }, ref) {
  return (
    <div ref={ref} className="glass flex min-h-[300px] flex-1 flex-col gap-2.5 overflow-y-auto rounded-[14px] bg-white/30 p-3.5">
      {events.length === 0 && !running && <p className="m-auto text-center text-[13px] text-ink-faint">Run a cycle to watch the agent research and trade in real time.</p>}
      {events.map((e, i) => <EventRow key={i} event={e} />)}
      {running && <div className="flex items-center gap-2 text-[12.5px] text-ink-soft"><span className="h-2 w-2 animate-pulseSoft rounded-full bg-accent" /> agent is working…</div>}
    </div>
  );
});

function Tag({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`label shrink-0 pt-0.5 ${className}`} style={{ minWidth: 84 }}>{children}</div>;
}
function EventRow({ event: e }: { event: RunEvent }) {
  switch (e.kind) {
    case "assistant": return <div className="flex gap-3"><Tag className="text-accent">Claude</Tag><Markdown className="flex-1 text-[13px]" text={e.text} /></div>;
    case "thinking": return <div className="flex gap-3 opacity-70"><Tag>thinking</Tag><div className="flex-1 text-[12.5px] italic text-ink-soft">{e.text}</div></div>;
    case "tool_call": return <div className="flex gap-3"><Tag className="text-up">{e.tool.replace(/^mcp__alpaca__/, "").replace(/_/g, " ")}</Tag><div className="num flex-1 break-words text-[11.5px] text-ink-faint">{summarize(e.input)}</div></div>;
    case "tool_result": return <div className="flex gap-3"><Tag className="text-up">→</Tag><div className="flex-1 text-[12px] text-ink-soft">{e.summary}</div></div>;
    case "decision": return (
      <div className="rounded-[12px] border border-accent/25 bg-accent/[0.06] p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="num text-[12px] font-bold tracking-wide text-accent">{e.action}{e.symbol ? ` ${e.symbol}` : ""}</span>
          {typeof e.conviction === "number" && <span className="text-[10px] tracking-[2px] text-accent">{"●".repeat(e.conviction)}{"○".repeat(Math.max(0, 5 - e.conviction))}</span>}
        </div>
        <Markdown className="mt-1 text-[12.5px]" text={e.rationale} />
        {e.sources && e.sources.length > 0 && <div className="mt-1.5 text-[11px] text-ink-faint">sources: {e.sources.join(" · ")}</div>}
      </div>
    );
    case "order": return <div className="rounded-[12px] border border-up/30 bg-up/[0.07] p-2.5"><div className="num text-[10.5px] font-bold uppercase tracking-wide text-up">order</div><div className="num mt-0.5 text-[13px] font-medium">{e.summary}</div></div>;
    case "journal": return <div className="rounded-[12px] border border-accent/20 bg-accent/[0.05] p-2.5"><Tag className="text-accent">journal</Tag><Markdown className="mt-1 text-[12.5px]" text={e.text} /></div>;
    case "error": return <div className="flex gap-3"><Tag className="text-down">error</Tag><div className="flex-1 text-[12.5px] text-down">{e.message}</div></div>;
    case "result": return (
      <div className="rounded-[12px] border hairline bg-white/40 p-3">
        <Tag className="text-accent">summary</Tag>
        <Markdown className="mt-1 text-[13px]" text={e.summary} />
        {e.costUsd != null && <div className="num mt-1.5 text-[11px] text-ink-faint">cost ${e.costUsd.toFixed(4)} · {e.numTurns ?? "?"} turns</div>}
      </div>
    );
    default: return null;
  }
}
function summarize(input: unknown): string { try { const s = JSON.stringify(input); return s.length > 150 ? s.slice(0, 150) + "…" : s; } catch { return String(input); } }

/* ── journal + watchlist ───────────────────────────────────────────────────── */
function JournalCard() {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [watch, setWatch] = useState<WatchlistItem[]>([]);
  useEffect(() => {
    const load = () => { api.journal(6).then(setEntries).catch(() => {}); api.watchlist().then(setWatch).catch(() => {}); };
    load(); const t = setInterval(load, 30000); return () => clearInterval(t);
  }, []);
  return (
    <Panel title="Agent journal" delay={0.16}>
      <div className="p-3.5">
        {watch.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {watch.map((w) => <span key={w.symbol} title={w.note} className="num glass shadow-chip rounded-chip px-2.5 py-1 text-[12px] font-semibold text-accent">{w.symbol}</span>)}
          </div>
        )}
        {entries.length === 0 ? <p className="text-[13px] text-ink-soft">No journal entries yet — the agent writes a handoff note each cycle.</p> : (
          <div className="flex max-h-[460px] flex-col gap-2.5 overflow-y-auto">
            {entries.map((e) => (
              <div key={e.id} className="glass rounded-[12px] bg-white/35 p-3">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="label text-accent">{e.label}</span>
                  <span className="num text-[11px] text-ink-faint">{new Date(e.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                </div>
                <Markdown text={e.content} />
              </div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}
