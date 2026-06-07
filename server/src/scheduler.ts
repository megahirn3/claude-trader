import { config, type ScheduleSlot } from "./config.js";
import { alpaca } from "./alpaca.js";
import { runStore } from "./store.js";
import { runCycle } from "./agent.js";

/**
 * Daily autopilot. Ticks every 30s, and when the wall-clock time in US market
 * time matches an enabled slot — on a real trading day — it kicks off the
 * corresponding agent cycle exactly once. Weekends and holidays are skipped via
 * Alpaca's trading calendar.
 *
 * State (last-fired day, last run) is in-memory; restarting resets it, which is
 * safe because the per-day guard keys on the calendar date.
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface SlotState {
  lastFiredDate?: string; // ET date string we last fired on (guards against double-fire)
  lastRunAt?: string;
  lastRunId?: string;
}

const state = new Map<string, SlotState>();
let timer: NodeJS.Timeout | null = null;

/** Current time in market timezone, as plain calendar fields. */
function nowMarket(): { date: string; hhmm: string; weekday: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: config.schedule.timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${hour}:${parts.minute}`,
    weekday: WEEKDAYS.indexOf(parts.weekday),
  };
}

/** Human label for a slot's next run, e.g. "Mon 10:00 ET" (skips weekends; holidays handled at fire time). */
function nextRunLabel(slot: ScheduleSlot): string | null {
  if (!slot.enabled) return null;
  const m = nowMarket();
  const [y, mo, d] = m.date.split("-").map(Number);
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(Date.UTC(y, mo - 1, d + offset));
    const wd = day.getUTCDay();
    if (wd === 0 || wd === 6) continue; // weekend
    if (offset === 0 && m.hhmm >= slot.time) continue; // already passed today
    return `${WEEKDAYS[wd]} ${slot.time} ET`;
  }
  return null;
}

async function isTradingDay(date: string): Promise<boolean> {
  if (!config.alpaca.configured) return false;
  try {
    const sessions = await alpaca.getCalendar(date, date);
    return sessions.some((s) => s.date === date);
  } catch {
    // If the calendar lookup fails, fall back to a weekday check so we still run.
    const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
    return wd !== 0 && wd !== 6;
  }
}

function promptFor(slot: ScheduleSlot): string {
  switch (slot.id) {
    case "morning":
      return "Morning review (market just opened). Assess the account and positions, check overnight news and pre-market moves for our holdings and any candidates, and set the plan for the day. Make early, well-reasoned adjustments within the safety limits, then summarize.";
    case "midday":
      return "Midday check. Review how the morning has played out for our positions, scan for fresh catalysts or news since the open, and trim/add where the thesis has changed. Stay disciplined — only act if warranted. Summarize.";
    case "preclose":
      return "Pre-close positioning (final actionable window before the close). Lock in profits where appropriate, cut losers that have broken down, and manage overnight risk. Make any last adjustments within the safety limits, then summarize what you did into the close.";
    case "eod":
      return "End-of-day review. The market is closed. Produce a full summary of the trading day: total and per-position P&L, the notable movers and why, what was traded today, what worked and what didn't, and a short watchlist/plan for tomorrow.";
    default:
      return "Run a portfolio review cycle and summarize.";
  }
}

async function fire(slot: ScheduleSlot, etDate: string): Promise<void> {
  const s = state.get(slot.id) ?? {};
  state.set(slot.id, { ...s, lastFiredDate: etDate }); // guard synchronously before any await

  if (!(await isTradingDay(etDate))) {
    console.log(`[scheduler] ${etDate} is not a trading day — skipping "${slot.label}".`);
    return;
  }

  const run = runStore.create(promptFor(slot), config.trading.mode, slot.label);
  state.set(slot.id, { lastFiredDate: etDate, lastRunAt: run.startedAt, lastRunId: run.id });
  console.log(`[scheduler] firing "${slot.label}" (${slot.time} ET) → run ${run.id}`);
  void runCycle(run, run.prompt, { allowTrading: slot.allowTrading });
}

function tick(): void {
  if (!config.schedule.enabled) return;
  const m = nowMarket();
  for (const slot of config.schedule.slots) {
    if (!slot.enabled) continue;
    if (m.hhmm !== slot.time) continue;
    if (state.get(slot.id)?.lastFiredDate === m.date) continue;
    void fire(slot, m.date);
  }
}

export function startScheduler(): void {
  if (timer) return;
  timer = setInterval(tick, 30_000);
  const active = config.schedule.slots.filter((s) => s.enabled).map((s) => `${s.time} ${s.label}`);
  if (config.schedule.enabled && active.length) {
    console.log(`  Scheduler ON (${config.schedule.timezone}): ${active.join(" · ")}`);
  } else {
    console.log(`  Scheduler ${config.schedule.enabled ? "ON (no slots)" : "OFF"}.`);
  }
}

/** Snapshot of the schedule for the dashboard. */
export function scheduleState() {
  return {
    enabled: config.schedule.enabled,
    timezone: config.schedule.timezone,
    marketTime: nowMarket().hhmm,
    slots: config.schedule.slots.map((slot) => ({
      id: slot.id,
      label: slot.label,
      time: slot.time,
      enabled: slot.enabled,
      allowTrading: slot.allowTrading,
      nextRun: nextRunLabel(slot),
      lastRunAt: state.get(slot.id)?.lastRunAt,
      lastRunId: state.get(slot.id)?.lastRunId,
    })),
  };
}

/** Enable/disable the autopilot at runtime (overrides the env default until restart). */
export function setScheduleEnabled(enabled: boolean): void {
  (config.schedule as { enabled: boolean }).enabled = enabled;
}

/** Trigger a slot's cycle immediately (used by the "Run now" buttons). */
export function runSlotNow(slotId: string): { id: string } | null {
  const slot = config.schedule.slots.find((s) => s.id === slotId);
  if (!slot) return null;
  const run = runStore.create(promptFor(slot), config.trading.mode, slot.label);
  state.set(slot.id, { ...state.get(slot.id), lastRunAt: run.startedAt, lastRunId: run.id });
  void runCycle(run, run.prompt, { allowTrading: slot.allowTrading });
  return { id: run.id };
}
