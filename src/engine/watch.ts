/**
 * WatchClient — consumes `collab watch --json` as a long-lived child emitting
 * parsed JSONL events (snapshot + cursor + events + stream deltas). Run-scoped
 * or global (--all). Tracks the monotonic cursor and, on an unexpected child
 * exit, reconnects with `--since <cursor>` to backfill the gap; the engine emits
 * a `reset` line if the cursor is too old, then a fresh snapshot.
 *
 * Pure Node (no `vscode` import). The consumer subscribes via .on(...) and calls
 * .stop() to detach — a watch attach perturbs nothing on the engine side.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

import type { ClientConfig } from "./client.js";
import type {
  WatchEventLine,
  WatchLine,
  WatchResetLine,
  WatchRunsChangedLine,
  WatchSnapshotLine,
  WatchStreamLine
} from "./contract.js";

export interface WatchOptions {
  /** Run name or id to scope to. Omit with `all:true` for the global channel. */
  run?: string | number;
  /** Global runs-changed channel (--all). */
  all?: boolean;
  /** Reconnect automatically on unexpected child exit (default true). */
  autoReconnect?: boolean;
}

export interface WatchClientEvents {
  snapshot: (line: WatchSnapshotLine) => void;
  event: (line: WatchEventLine) => void;
  stream: (line: WatchStreamLine) => void;
  reset: (line: WatchResetLine) => void;
  "runs-changed": (line: WatchRunsChangedLine) => void;
  /** A raw line that could not be parsed as JSON (rare; surfaced, not thrown). */
  parseError: (raw: string) => void;
  /** Watcher-level error (spawn failure). */
  error: (err: Error) => void;
  /** The feed closed (stopped or gave up reconnecting). */
  close: (info: { stopped: boolean; code: number | null }) => void;
  /** A reconnect attempt is starting (from a cursor, if known). */
  reconnecting: (info: { since: number | null; attempt: number }) => void;
}

export declare interface WatchClient {
  on<E extends keyof WatchClientEvents>(event: E, listener: WatchClientEvents[E]): this;
  emit<E extends keyof WatchClientEvents>(event: E, ...args: Parameters<WatchClientEvents[E]>): boolean;
}

export class WatchClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private cursor: number | null = null;
  private stopped = false;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ClientConfig,
    private readonly options: WatchOptions
  ) {
    super();
  }

  /** The last cursor observed (for external resume/debug). */
  get lastCursor(): number | null {
    return this.cursor;
  }

  /** Start (or restart) the feed. */
  start(): void {
    this.stopped = false;
    this.attempt = 0;
    this.spawnChild(null);
  }

  /** Detach the feed. The engine sees a clean SIGTERM and exits code 0. */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
  }

  private buildArgs(since: number | null): string[] {
    const args = [this.config.enginePath];
    if (this.config.storePath) args.push("--store", this.config.storePath);
    args.push("watch");
    if (this.options.all) {
      args.push("--all");
    } else if (this.options.run != null) {
      args.push("--run", String(this.options.run));
    }
    if (this.config.adaptersDir) args.push("--adapters-dir", this.config.adaptersDir);
    args.push("--json");
    if (since != null) args.push("--since", String(since));
    return args;
  }

  private spawnChild(since: number | null): void {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.config.nodePath, this.buildArgs(since), {
        cwd: this.config.cwd
      });
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.child = child;
    this.buffer = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Engine watch errors (e.g. bad run) arrive here; surface but don't crash.
      const trimmed = chunk.trim();
      if (trimmed) this.emit("error", new Error(trimmed));
    });

    child.on("error", (err) => this.emit("error", err));
    child.on("close", (code) => this.onClose(code));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const raw = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (raw) this.dispatchLine(raw);
    }
  }

  private dispatchLine(raw: string): void {
    let line: WatchLine;
    try {
      line = JSON.parse(raw) as WatchLine;
    } catch {
      this.emit("parseError", raw);
      return;
    }
    switch (line.type) {
      case "snapshot":
        this.cursor = line.cursor;
        this.emit("snapshot", line);
        break;
      case "event":
        this.cursor = line.cursor;
        this.emit("event", line);
        break;
      case "stream":
        this.emit("stream", line);
        break;
      case "reset":
        // Engine will re-snapshot next; drop our stale cursor.
        this.cursor = null;
        this.emit("reset", line);
        break;
      case "runs-changed":
        this.emit("runs-changed", line);
        break;
      default:
        this.emit("parseError", raw);
    }
  }

  private onClose(code: number | null): void {
    this.child = null;
    if (this.stopped) {
      this.emit("close", { stopped: true, code });
      return;
    }
    const autoReconnect = this.options.autoReconnect !== false;
    if (!autoReconnect || this.attempt >= 5) {
      this.emit("close", { stopped: false, code });
      return;
    }
    this.attempt += 1;
    const since = this.cursor;
    const delay = Math.min(1000 * this.attempt, 5000);
    this.emit("reconnecting", { since, attempt: this.attempt });
    this.reconnectTimer = setTimeout(() => {
      if (!this.stopped) this.spawnChild(since);
    }, delay);
  }
}
