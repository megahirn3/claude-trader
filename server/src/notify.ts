import { config } from "./config.js";
import type { Run, RunEvent } from "./store.js";

/**
 * Discord notifications via an incoming webhook. Configure with
 * DISCORD_WEBHOOK_URL (kept in .env — never in code). When unset, every function
 * here is a no-op, so the bot runs fine without it.
 *
 * Notifications are best-effort and never throw: a failed ping must not affect
 * trading.
 */

const COLOR = {
  green: 0x41d18a,
  red: 0xf06a6a,
  blue: 0x6ea8fe,
  amber: 0xe8b13a,
  accent: 0xc98a4b,
};

interface Embed {
  title: string;
  description?: string;
  color: number;
  footer?: { text: string };
  timestamp?: string;
}

// Ring buffer of recently-sent alerts, surfaced on the dashboard so you can see
// the alert feed without leaving the app.
export interface AlertRecord {
  at: string;
  title: string;
  detail?: string;
  delivered: boolean;
}
const recentAlerts: AlertRecord[] = [];
export function getRecentAlerts(limit = 20): AlertRecord[] {
  return recentAlerts.slice(0, limit);
}

async function post(embed: Embed): Promise<boolean> {
  const url = config.notify.discordWebhookUrl;
  let delivered = false;
  if (url) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "Claude Trader", embeds: [embed] }),
      });
      delivered = res.ok;
    } catch {
      delivered = false;
    }
  }
  // Record regardless of delivery so the dashboard shows what was triggered.
  recentAlerts.unshift({ at: embed.timestamp ?? new Date().toISOString(), title: embed.title, detail: embed.description, delivered });
  if (recentAlerts.length > 50) recentAlerts.length = 50;
  return delivered;
}

function footer(run: Run): { text: string } {
  return { text: `${run.label} · ${run.mode.toUpperCase()}` };
}

function trim(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function notifyRunStart(run: Run): void {
  if (!config.notify.configured || !config.notify.runStart) return;
  void post({ title: `▶ ${run.label} started`, color: COLOR.blue, footer: footer(run), timestamp: run.startedAt });
}

/**
 * Called for every run event; only the interesting kinds (orders, risk-guard
 * blocks, errors, run summaries, failures) actually produce a Discord message.
 */
export function notifyRunEvent(run: Run, e: RunEvent): void {
  if (!config.notify.configured) return;
  switch (e.kind) {
    case "order":
      void post({ title: "🟢 Order placed", description: e.summary, color: COLOR.green, footer: footer(run), timestamp: e.at });
      return;
    case "error": {
      const blocked = e.message.toLowerCase().includes("blocked");
      void post({
        title: blocked ? "🛑 Order blocked by a risk guard" : "⚠️ Run error",
        description: trim(e.message, 1500),
        color: blocked ? COLOR.amber : COLOR.red,
        footer: footer(run),
        timestamp: e.at,
      });
      return;
    }
    case "result":
      void post({
        title: `✅ ${run.label} — summary`,
        description: trim(e.summary, 3500),
        color: COLOR.green,
        footer: { text: `${run.mode.toUpperCase()}${e.costUsd != null ? ` · $${e.costUsd.toFixed(3)}` : ""}` },
        timestamp: e.at,
      });
      return;
    case "status":
      if (e.status === "failed") {
        void post({ title: `❌ ${run.label} failed`, color: COLOR.red, footer: footer(run), timestamp: e.at });
      }
      return;
    default:
      return;
  }
}

/** Alert that the kill switch fired. */
export function notifyKill(cancelledOrders: number, closedPositions: number, errors: string[]): void {
  if (!config.notify.configured) return;
  const lines = [
    `Autopilot paused and trading halted.`,
    `Cancelled **${cancelledOrders}** order(s), liquidated **${closedPositions}** position(s) at market.`,
  ];
  if (errors.length) lines.push(`⚠️ ${errors.join("; ")}`);
  void post({
    title: "🚨 KILL SWITCH ACTIVATED",
    description: lines.join("\n"),
    color: COLOR.red,
    timestamp: new Date().toISOString(),
  });
}

/** Send a test message so the user can verify their webhook from the dashboard. */
export async function sendTestNotification(): Promise<boolean> {
  if (!config.notify.configured) return false;
  return post({
    title: "🔔 Claude Trader — test alert",
    description:
      "Discord notifications are working. You'll get pings for orders, risk-guard blocks, errors, run failures, and end-of-day summaries.",
    color: COLOR.accent,
    timestamp: new Date().toISOString(),
  });
}
