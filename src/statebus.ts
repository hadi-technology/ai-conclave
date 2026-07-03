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
  type RunModel,
  type SnapshotState
} from "./viewmodels/model.js";
import type { GateVM } from "./viewmodels/model.js";

export type MakeWatch = (run: string) => WatchClient;

export interface StateBusEvents {
  change: () => void;
  /** A newly-pending gate (fires once per gate id). */
  gate: (gate: GateVM, runRef: string) => void;
  log: (line: string) => void;
}

export declare interface StateBus {
  on<E extends keyof StateBusEvents>(event: E, listener: StateBusEvents[E]): this;
  emit<E extends keyof StateBusEvents>(event: E, ...args: Parameters<StateBusEvents[E]>): boolean;
}

export class StateBus extends EventEmitter {
  private runsList: RunSummary[] = [];
  private model: RunModel = emptyModel();
  private activeRun: string | null = null;
  private watch: WatchClient | null = null;
  private lastGateId: number | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;

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
      // Auto-pick an active run if none is set.
      if (!this.activeRun) {
        const active = runs.find((r) => r.active) ?? runs[0];
        if (active) this.attach(active.name);
      }
      this.emit("change");
    } catch (err) {
      this.emit("log", `runs refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Focus a run: (re)attach the watch feed and load its model. */
  attach(runRef: string): void {
    if (this.activeRun === runRef && this.watch) return;
    this.detachWatch();
    this.activeRun = runRef;
    this.model = emptyModel();
    this.lastGateId = null;

    const w = this.makeWatch(runRef);
    w.on("snapshot", (line) => {
      this.model = modelFromSnapshot(line.state as SnapshotState);
      this.detectGate();
      this.emit("change");
    });
    w.on("event", (line) => {
      this.emit("log", `event ${line.event.type}`);
      this.scheduleReadRefresh();
    });
    w.on("reset", () => this.scheduleReadRefresh());
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
