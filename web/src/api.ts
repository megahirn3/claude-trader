// Typed client for the Claude Trader backend.

export interface AppConfig {
  model: string;
  trading: {
    mode: "paper" | "live";
    liveEnabled: boolean;
    maxTradePct: number;
    dailyLossLimitPct: number;
    avoidDayTrades: boolean;
    noLeverage: boolean;
    minPriceUsd: number;
    excludeLeveragedEtf: boolean;
  };
  broker: string;
  dataSource: string;
  notify: { discord: boolean };
  halted: boolean;
  ready: {
    claude: boolean;
    usingSubscription: boolean;
    usingApiKey: boolean;
    alpaca: boolean;
  };
}

export interface Account {
  portfolio_value: string;
  equity: string;
  last_equity: string;
  cash: string;
  buying_power: string;
  long_market_value: string;
  status: string;
}

export interface Position {
  symbol: string;
  qty: string;
  side: string;
  avg_entry_price: string;
  market_value: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  current_price: string;
  change_today: string;
}

export interface Order {
  id: string;
  symbol: string;
  qty: string | null;
  notional: string | null;
  side: string;
  type: string;
  status: string;
  filled_avg_price: string | null;
  submitted_at: string;
}

export interface RunSummary {
  id: string;
  prompt: string;
  label: string;
  mode: "paper" | "live";
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt?: string;
  costUsd?: number;
  eventCount: number;
}

export interface ScheduleSlot {
  id: string;
  label: string;
  time: string;
  enabled: boolean;
  allowTrading: boolean;
  nextRun: string | null;
  lastRunAt?: string;
  lastRunId?: string;
}

export interface ScheduleState {
  enabled: boolean;
  timezone: string;
  marketTime: string;
  slots: ScheduleSlot[];
}

export type RunEvent =
  | { kind: "status"; status: string; at: string }
  | { kind: "thinking"; text: string; at: string }
  | { kind: "assistant"; text: string; at: string }
  | { kind: "tool_call"; tool: string; input: unknown; at: string }
  | { kind: "tool_result"; tool: string; summary: string; at: string }
  | { kind: "decision"; action: string; symbol?: string; rationale: string; conviction?: number; sources?: string[]; at: string }
  | { kind: "order"; summary: string; detail: unknown; at: string }
  | { kind: "journal"; text: string; at: string }
  | { kind: "error"; message: string; at: string }
  | { kind: "result"; summary: string; costUsd?: number; numTurns?: number; at: string };

export interface PortfolioHistory {
  timestamp: number[];
  equity: (number | null)[];
  profit_loss: number[];
  profit_loss_pct: number[];
  base_value: number;
}

export interface JournalEntry {
  id: number;
  at: string;
  label: string;
  content: string;
}

export interface WatchlistItem {
  symbol: string;
  note: string;
}

export interface AlertItem {
  at: string;
  title: string;
  detail?: string;
  delivered: boolean;
}

export interface Run extends RunSummary {
  events: RunEvent[];
  result?: string;
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Request failed: ${res.status}`);
  return res.json();
}

export const api = {
  config: () => get<AppConfig>("/api/config"),
  account: () => get<Account>("/api/account"),
  positions: () => get<Position[]>("/api/positions"),
  orders: () => get<Order[]>("/api/orders"),
  clock: () => get<{ is_open: boolean; next_open: string; next_close: string }>("/api/clock"),
  runs: () => get<RunSummary[]>("/api/runs"),
  run: (id: string) => get<Run>(`/api/runs/${id}`),

  startRun: async (prompt?: string): Promise<string> => {
    const res = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to start run");
    return (await res.json()).id as string;
  },

  cancelOrder: async (id: string): Promise<void> => {
    const res = await fetch(`/api/orders/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error("Failed to cancel order");
  },

  history: (period: string) => get<PortfolioHistory>(`/api/portfolio-history?period=${encodeURIComponent(period)}`),
  journal: (limit = 8) => get<JournalEntry[]>(`/api/journal?limit=${limit}`),
  watchlist: () => get<WatchlistItem[]>("/api/watchlist"),

  schedule: () => get<ScheduleState>("/api/schedule"),

  setSchedule: async (enabled: boolean): Promise<ScheduleState> => {
    const res = await fetch("/api/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    return res.json();
  },

  runSlot: async (slot: string): Promise<string> => {
    const res = await fetch(`/api/schedule/run/${slot}`, { method: "POST" });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to start");
    return (await res.json()).id as string;
  },

  testNotify: async (): Promise<void> => {
    const res = await fetch("/api/notify/test", { method: "POST" });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to send test");
  },

  alerts: () => get<AlertItem[]>("/api/alerts"),

  kill: async (): Promise<{ cancelledOrders: number; closedPositions: number; errors: string[] }> => {
    const res = await fetch("/api/kill", { method: "POST" });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Kill switch failed");
    return res.json();
  },

  resume: async (): Promise<void> => {
    const res = await fetch("/api/resume", { method: "POST" });
    if (!res.ok) throw new Error("Resume failed");
  },
};

export const usd = (v: string | number | undefined): string => {
  const n = typeof v === "string" ? Number(v) : v ?? 0;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
};

export const pct = (v: string | number | undefined): string => {
  const n = (typeof v === "string" ? Number(v) : v ?? 0) * 100;
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
};
