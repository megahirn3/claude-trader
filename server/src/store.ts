import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

/**
 * In-memory store of agent runs and their event streams. A "run" is one
 * research/trade cycle of the Claude agent. Events stream live to the dashboard
 * via SSE and are also persisted on the run for later inspection.
 *
 * This is intentionally simple (process memory). For production you'd back it
 * with a database; the shape here maps cleanly onto one.
 */

export type RunEvent =
  | { kind: "status"; status: RunStatus; at: string }
  | { kind: "thinking"; text: string; at: string }
  | { kind: "assistant"; text: string; at: string }
  | { kind: "tool_call"; tool: string; input: unknown; at: string }
  | { kind: "tool_result"; tool: string; summary: string; at: string }
  | { kind: "decision"; action: string; symbol?: string; rationale: string; at: string }
  | { kind: "order"; summary: string; detail: unknown; at: string }
  | { kind: "error"; message: string; at: string }
  | { kind: "result"; summary: string; usage?: unknown; costUsd?: number; numTurns?: number; at: string };

export type RunStatus = "running" | "completed" | "failed";

export interface Run {
  id: string;
  prompt: string;
  mode: "paper" | "live";
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  events: RunEvent[];
  result?: string;
  costUsd?: number;
  usage?: unknown;
}

class RunStore {
  private runs = new Map<string, Run>();
  private emitters = new Map<string, EventEmitter>();

  create(prompt: string, mode: "paper" | "live"): Run {
    const run: Run = {
      id: randomUUID(),
      prompt,
      mode,
      status: "running",
      startedAt: new Date().toISOString(),
      events: [],
    };
    this.runs.set(run.id, run);
    this.emitters.set(run.id, new EventEmitter().setMaxListeners(0));
    return run;
  }

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }

  list(): Run[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  emit(id: string, event: RunEvent): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.events.push(event);
    if (event.kind === "status") run.status = event.status;
    if (event.kind === "result") {
      run.result = event.summary;
      run.costUsd = event.costUsd;
      run.usage = event.usage;
    }
    this.emitters.get(id)?.emit("event", event);
  }

  finish(id: string, status: RunStatus): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.status = status;
    run.finishedAt = new Date().toISOString();
    this.emit(id, { kind: "status", status, at: run.finishedAt });
    this.emitters.get(id)?.emit("done");
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
