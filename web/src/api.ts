// Typed client for the Claude Trader backend.

export interface AppConfig {
  model: string;
  trading: { mode: "paper" | "live"; liveEnabled: boolean; maxOrderNotionalUsd: number };
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
  mode: "paper" | "live";
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt?: string;
  costUsd?: number;
  eventCount: number;
}

export type RunEvent =
  | { kind: "status"; status: string; at: string }
  | { kind: "thinking"; text: string; at: string }
  | { kind: "assistant"; text: string; at: string }
  | { kind: "tool_call"; tool: string; input: unknown; at: string }
  | { kind: "tool_result"; tool: string; summary: string; at: string }
  | { kind: "decision"; action: string; symbol?: string; rationale: string; at: string }
  | { kind: "order"; summary: string; detail: unknown; at: string }
  | { kind: "error"; message: string; at: string }
  | { kind: "result"; summary: string; costUsd?: number; numTurns?: number; at: string };

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
};

export const usd = (v: string | number | undefined): string => {
  const n = typeof v === "string" ? Number(v) : v ?? 0;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
};

export const pct = (v: string | number | undefined): string => {
  const n = (typeof v === "string" ? Number(v) : v ?? 0) * 100;
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
};
