import { kvGet, kvSet } from "./db.js";

/**
 * The "halted" flag — set by the kill switch. When halted, the scheduler won't
 * fire and the agent's place_order tool refuses to trade. Persisted in SQLite,
 * so a restart can't silently un-halt a bot you deliberately froze.
 *
 * Kept in its own tiny module (no broker/scheduler imports) to avoid import
 * cycles — both the scheduler and the order tool need to read it.
 */

export function isHalted(): boolean {
  return kvGet("halt") === "true";
}

export function setHalted(value: boolean): void {
  kvSet("halt", String(value));
}
