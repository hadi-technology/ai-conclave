/**
 * StateBus — the vscode-free glue between the engine feed and the tree/status
 * views. It owns the run list + the active run's normalized model, and emits a
 * single "change" whenever either updates. Views subscribe and re-render; nothing
 * here imports vscode, so the reducer path stays headlessly testable.
 *
 * Primary live source: the `collab watch --json` snapshot (rich, cockpit-shaped).
 * Because the feed emits only one snapshot on attach, subsequent watch *events*
 * trigger a debounced JSON read-command refresh (status/report/ledger/gate) — the
 * fallback path, driven by the feed, never by file/DB watches.
 */
import { EventEmitter } from "node:events";

import type { EngineClient } from "./engine/client.js";
import type { RunSummary } from "./engine/contract.js";
import type { WatchClient } from "./engine/watch.js";
import {
  emptyModel,
  modelFromReads,
  modelFromSnapshot,
  tallyFromSnapshot,
  type RunModel,
  type SnapshotState,
  type TallyProjection
} from "./viewmodels/model.js";
import type { GateVM } from "./viewmodels/model.js";
import type { CockpitEvent } from "./webview/protocol.js";

export type MakeWatch = (run: string) => WatchClient;

export interface StateBusEvents {
  change: () => void;
  /** A newly-pending gate (fires once per gate id). */
  gate: (gate: GateVM, runRef: string) => void;
  /** A live per-seat stream delta from the watch feed (forwarded for the cockpit). */
  stream: (seat: string, line: string) => void;
  /** A live append-only watch event (forwarded for the cockpit's activity/animation). */
  event: (event: CockpitEvent) => void;
  log: (line: string) => void;
}

export declare interface StateBus {
  on<E extends keyof StateBusEvents>(event: E, listener: StateBusEvents[E]): this;
  emit<E extends keyof StateBusEvents>(event: E, ...args: Parameters<StateBusEvents[E]>): boolean;
}

export class StateBus extends EventEmitter {
  private runsList: RunSummary[] = [];
  private model: RunModel = emptyModel();
  private lastTally: TallyProjection | null = null;
  private lastSnapshot: Record<string, unknown> | null = null;
  private activeRun: string | null = null;
  private watch: WatchClient | null = null;
  private lastGateId: number | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  /** Set by an explicit detach() so refreshRuns won't silently auto-re-attach.
   *  Cleared by attach() (an explicit focus re-enables the live feed). */
  private detached = false;

  constructor(
    private readonly client: EngineClient,
    private readonly makeWatch: MakeWatch
  ) {
    super();
  }

  get runs(): RunSummary[] {
    return this.runsList;
  }
  get runModel(): RunModel {
    return this.model;
  }
  /** The most recent decide-phase tally (from the last snapshot), or null. */
  get tally(): TallyProjection | null {
    return this.lastTally;
  }
  /** The raw cockpit-shaped snapshot state (carries seats[].session/paused —
   *  needed by the takeover hatch), or null before the first snapshot. */
  get snapshotState(): Record<string, unknown> | null {
    return this.lastSnapshot;
  }
  get activeRunRef(): string | null {
    return this.activeRun;
  }
  activeRunSummary(): RunSummary | null {
    if (!this.activeRun) return null;
    return (
      this.runsList.find((r) => r.name === this.activeRun || String(r.id) === this.activeRun) ?? null
    );
  }

  /** Refresh the run list via `collab runs` (used at boot and on runs-changed). */
  async refreshRuns(): Promise<void> {
    try {
      const { runs } = await this.client.runs();
      this.runsList = runs;
      // Auto-pick an active run if none is set — unless the user explicitly
      // detached, in which case a runs refresh must NOT silently re-attach.
      if (!this.activeRun && !this.detached) {
        const active = runs.find((r) => r.active) ?? runs[0];
        if (active) this.attach(active.name);
      }
      this.emit("change");
    } catch (err) {
      this.emit("log", `runs refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Whether the live watch feed is currently attached to `runRef`. */
  isWatching(runRef: string): boolean {
    return this.activeRun === runRef && this.watch != null;
  }

  /**
   * Detach the live watch viewer. If `runRef` is omitted or matches the active
   * run, tear the watch down, clear the focused model, and mark detached so a
   * later refreshRuns won't silently re-attach. Returns true iff it WAS watching
   * (a real detach happened); false if the given run wasn't the active watch.
   */
  detach(runRef?: string): boolean {
    if (runRef !== undefined && runRef !== this.activeRun) return false;
    const wasWatching = this.watch != null;
    this.detachWatch();
    this.activeRun = null;
    this.model = emptyModel();
    this.lastTally = null;
    this.lastSnapshot = null;
    this.lastGateId = null;
    this.detached = true;
    this.emit("change");
    return wasWatching;
  }

  /** Focus a run: (re)attach the watch feed and load its model. */
  attach(runRef: string): void {
    this.detached = false;
    if (this.activeRun === runRef && this.watch) return;
    this.detachWatch();
    this.activeRun = runRef;
    this.model = emptyModel();
    this.lastTally = null;
    this.lastSnapshot = null;
    this.lastGateId = null;

    const w = this.makeWatch(runRef);
    // Detached-watch guard (FIX B): each handler captures its OWN watch `w` (and
    // `runRef`). A buffered callback from a PREVIOUS run's dying child still fires
    // that run's watch after attach() swapped `this.watch`; guarding at the top of
    // every handler means a stale watch can NEVER write this.model / emit for the
    // new run. (The `snapshot` handler — which mutates model + detectGate — is the
    // critical one; guard all four for consistency.)
    w.on("snapshot", (line) => {
      if (this.watch !== w) return;
      const state = line.state as SnapshotState;
      this.lastSnapshot = line.state as Record<string, unknown>;
      this.model = modelFromSnapshot(state);
      this.lastTally = tallyFromSnapshot(state.tally);
      this.detectGate();
      this.emit("change");
    });
    w.on("event", (line) => {
      if (this.watch !== w) return;
      this.emit("log", `event ${line.event.type}`);
      this.emit("event", {
        type: line.event.type,
        seat: line.event.seat ?? null,
        itemId: line.event.itemId ?? null,
        ts: line.event.ts,
        payload: line.event.payload
      });
      this.scheduleReadRefresh();
    });
    w.on("stream", (line) => {
      if (this.watch !== w) return;
      this.emit("stream", line.seat, line.line);
    });
    w.on("reset", () => {
      if (this.watch !== w) return;
      this.scheduleReadRefresh();
    });
    w.on("error", (err) => this.emit("log", `watch error: ${err.message}`));
    w.start();
    this.watch = w;
  }

  /** Debounced JSON read refresh (the event-driven fallback path). */
  private scheduleReadRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.readRefresh();
    }, 300);
  }

  private async readRefresh(): Promise<void> {
    const run = this.activeRun;
    if (!run) return;
    try {
      const [status, report, ledger, budget, gate] = await Promise.all([
        this.client.runStatus(run).catch(() => null),
        this.client.report(run).catch(() => null),
        this.client.ledger(run).catch(() => null),
        this.client.budgetShow(run).catch(() => null),
        this.client.gateShow(run).catch(() => null)
      ]);
      // Stale-run guard: the reads are async; if the user switched runs (or
      // detached) while they were in flight, `run` is no longer active — drop
      // this result so run A's data never overwrites run B's model or fires a
      // gate for B from A's reads.
      if (this.activeRun !== run) return;
      // Transient-blip guard (FIX C): every read is `.catch(() => null)`, so a brief
      // engine unavailability makes ALL of them null and modelFromReads would REPLACE
      // the good model with an empty one (the UI blanks). Only replace when at least
      // one read succeeded; otherwise keep the prior model until the next refresh.
      if (status == null && report == null && ledger == null && budget == null && gate == null) {
        this.emit("log", "read refresh: all engine reads failed, keeping prior model");
        return;
      }
      this.model = modelFromReads({ status, report, ledger, budget, gate });
      this.detectGate();
      this.emit("change");
    } catch (err) {
      this.emit("log", `read refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private detectGate(): void {
    const gate = this.model.gate;
    if (gate && gate.gateId !== this.lastGateId) {
      this.lastGateId = gate.gateId;
      if (this.activeRun) this.emit("gate", gate, this.activeRun);
    } else if (!gate) {
      this.lastGateId = null;
    }
  }

  private detachWatch(): void {
    if (this.watch) {
      this.watch.stop();
      this.watch = null;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  dispose(): void {
    this.detachWatch();
    this.removeAllListeners();
  }
}
