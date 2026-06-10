import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

/**
 * SQLite persistence (via Node's built-in node:sqlite — no native deps).
 * Holds run history, the agent's trading journal, the watchlist, and small
 * key-value state (scheduler fire guards, toggles) so everything survives
 * restarts — important for a bot that's meant to run unattended every day.
 */

const dataDir = process.env.DATA_DIR ?? path.resolve(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, "trader.db"));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS runs (
    id          TEXT PRIMARY KEY,
    prompt      TEXT NOT NULL,
    label       TEXT NOT NULL,
    mode        TEXT NOT NULL,
    status      TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    result      TEXT,
    cost_usd    REAL,
    usage       TEXT
  );

  CREATE TABLE IF NOT EXISTS run_events (
    run_id TEXT NOT NULL,
    seq    INTEGER NOT NULL,
    json   TEXT NOT NULL,
    PRIMARY KEY (run_id, seq)
  );

  CREATE TABLE IF NOT EXISTS journal (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    at      TEXT NOT NULL,
    label   TEXT NOT NULL,
    content TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kv (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );
`);

// ── kv ────────────────────────────────────────────────────────────────────────

export function kvGet(key: string): string | null {
  const row = db.prepare("SELECT v FROM kv WHERE k = ?").get(key) as { v: string } | undefined;
  return row?.v ?? null;
}

export function kvSet(key: string, value: string): void {
  db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(key, value);
}

// ── journal ───────────────────────────────────────────────────────────────────

export interface JournalEntry {
  id: number;
  at: string;
  label: string;
  content: string;
}

export function addJournalEntry(label: string, content: string): void {
  db.prepare("INSERT INTO journal (at, label, content) VALUES (?, ?, ?)").run(new Date().toISOString(), label, content);
}

export function listJournal(limit = 10): JournalEntry[] {
  return db
    .prepare("SELECT id, at, label, content FROM journal ORDER BY id DESC LIMIT ?")
    .all(limit) as unknown as JournalEntry[];
}

// ── watchlist (stored as JSON in kv) ─────────────────────────────────────────

export interface WatchlistItem {
  symbol: string;
  note: string;
}

export function getWatchlist(): WatchlistItem[] {
  const raw = kvGet("watchlist");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function setWatchlist(items: WatchlistItem[]): void {
  kvSet("watchlist", JSON.stringify(items));
}
