import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { notifyRunStart, notifyRunEvent } from "./notify.js";

/**
 * Run store: SQLite-backed history with an in-memory layer for live runs.
 * Active runs keep their events in memory for low-latency SSE replay; once a
 * run finishes it is evicted from memory and served from the database, so
 * history survives restarts and memory stays bounded.
 */

export type RunEvent =
  | { kind: "status"; status: RunStatus; at: string }
  | { kind: "thinking"; text: string; at: string }
  | { kind: "assistant"; text: string; at: string }
  | { kind: "tool_call"; tool: string; input: unknown; at: string }
  | { kind: "tool_result"; tool: string; summary: string; at: string }
  | { kind: "decision"; action: string; symbol?: string; rationale: string; at: string }
  | { kind: "order"; summary: string; detail: unknown; at: string }
  | { kind: "journal"; text: string; at: string }
  | { kind: "error"; message: string; at: string }
  | { kind: "result"; summary: string; usage?: unknown; costUsd?: number; numTurns?: number; at: string };

export type RunStatus = "running" | "completed" | "failed";

export interface Run {
  id: string;
  prompt: string;
  label: string;
  mode: "paper" | "live";
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  events: RunEvent[];
  result?: string;
  costUsd?: number;
  usage?: unknown;
}

interface RunRow {
  id: string;
  prompt: string;
  label: string;
  mode: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  result: string | null;
  cost_usd: number | null;
  usage: string | null;
}

function rowToRun(row: RunRow, events: RunEvent[] = []): Run {
  return {
    id: row.id,
    prompt: row.prompt,
    label: row.label,
    mode: row.mode as Run["mode"],
    status: row.status as RunStatus,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    result: row.result ?? undefined,
    costUsd: row.cost_usd ?? undefined,
    usage: row.usage ? JSON.parse(row.usage) : undefined,
    events,
  };
}

class RunStore {
  private active = new Map<string, Run>();
  private emitters = new Map<string, EventEmitter>();
  private seq = new Map<string, number>();

  create(prompt: string, mode: "paper" | "live", label = "Manual"): Run {
    const run: Run = {
      id: randomUUID(),
      prompt,
      label,
      mode,
      status: "running",
      startedAt: new Date().toISOString(),
      events: [],
    };
    db.prepare(
      "INSERT INTO runs (id, prompt, label, mode, status, started_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(run.id, run.prompt, run.label, run.mode, run.status, run.startedAt);
    this.active.set(run.id, run);
    this.emitters.set(run.id, new EventEmitter().setMaxListeners(0));
    this.seq.set(run.id, 0);
    notifyRunStart(run);
    return run;
  }

  get(id: string): Run | undefined {
    const live = this.active.get(id);
    if (live) return live;
    const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    if (!row) return undefined;
    const events = (
      db.prepare("SELECT json FROM run_events WHERE run_id = ? ORDER BY seq").all(id) as unknown as { json: string }[]
    ).map((r) => JSON.parse(r.json) as RunEvent);
    return rowToRun(row, events);
  }

  list(limit = 50): Run[] {
    const rows = db
      .prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?")
      .all(limit) as unknown as RunRow[];
    return rows.map((row) => this.active.get(row.id) ?? rowToRun(row));
  }

  isRunning(id: string): boolean {
    return this.active.get(id)?.status === "running";
  }

  emit(id: string, event: RunEvent): void {
    const run = this.active.get(id);
    if (!run) return;
    run.events.push(event);

    const seq = (this.seq.get(id) ?? 0) + 1;
    this.seq.set(id, seq);
    db.prepare("INSERT INTO run_events (run_id, seq, json) VALUES (?, ?, ?)").run(id, seq, JSON.stringify(event));

    if (event.kind === "status") run.status = event.status;
    if (event.kind === "result") {
      run.result = event.summary;
      run.costUsd = event.costUsd;
      run.usage = event.usage;
      db.prepare("UPDATE runs SET result = ?, cost_usd = ?, usage = ? WHERE id = ?").run(
        event.summary,
        event.costUsd ?? null,
        event.usage ? JSON.stringify(event.usage) : null,
        id,
      );
    }
    this.emitters.get(id)?.emit("event", event);
    // Best-effort outbound alerts (orders, risk blocks, errors, summaries).
    notifyRunEvent(run, event);
  }

  finish(id: string, status: RunStatus): void {
    const run = this.active.get(id);
    if (!run) return;
    run.status = status;
    run.finishedAt = new Date().toISOString();
    this.emit(id, { kind: "status", status, at: run.finishedAt });
    db.prepare("UPDATE runs SET status = ?, finished_at = ? WHERE id = ?").run(status, run.finishedAt, id);
    this.emitters.get(id)?.emit("done");
    // Evict from memory; the database now owns this run.
    this.active.delete(id);
    this.emitters.delete(id);
    this.seq.delete(id);
  }

  subscribe(id: string, onEvent: (e: RunEvent) => void, onDone: () => void): () => void {
    const emitter = this.emitters.get(id);
    if (!emitter) {
      onDone();
      return () => {};
    }
    emitter.on("event", onEvent);
    emitter.on("done", onDone);
    return () => {
      emitter.off("event", onEvent);
      emitter.off("done", onDone);
    };
  }
}

export const runStore = new RunStore();
