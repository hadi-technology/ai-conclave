/**
 * Headless unit tests for StateBus's watch-attach authority — the single live
 * feed the sidebar/status views + "Stop watching" rely on. Faked EngineClient +
 * a fake WatchClient (EventEmitter with start/stop): no engine spawn, no vscode.
 *
 * Locks the FIX-4 contract: attach → detach stops the watch and flips isWatching
 * false, and a subsequent refreshRuns does NOT silently auto-re-attach.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { StateBus, type MakeWatch } from "../src/statebus.js";
import type { EngineClient } from "../src/engine/client.js";
import type { RunSummary } from "../src/engine/contract.js";

class FakeWatch extends EventEmitter {
  started = false;
  stopped = false;
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
}

function run(name: string, active: boolean): RunSummary {
  return { name, id: 1, phase: "propose", status: "active", spend: 0, active };
}

function makeBus(runs: RunSummary[]): { bus: StateBus; watches: FakeWatch[] } {
  const watches: FakeWatch[] = [];
  const client = { runs: vi.fn().mockResolvedValue({ schemaVersion: 1, runs }) } as unknown as EngineClient;
  const makeWatch: MakeWatch = () => {
    const w = new FakeWatch();
    watches.push(w);
    return w as never;
  };
  return { bus: new StateBus(client, makeWatch), watches };
}

describe("StateBus — watch attach/detach authority", () => {
  it("attach starts a watch and isWatching reflects the active run", () => {
    const { bus, watches } = makeBus([]);
    bus.attach("frost");
    expect(bus.activeRunRef).toBe("frost");
    expect(bus.isWatching("frost")).toBe(true);
    expect(bus.isWatching("other")).toBe(false);
    expect(watches).toHaveLength(1);
    expect(watches[0].started).toBe(true);
  });

  it("detach stops the watch, clears the active run, and returns wasWatching", () => {
    const { bus, watches } = makeBus([]);
    bus.attach("frost");
    const was = bus.detach("frost");
    expect(was).toBe(true);
    expect(watches[0].stopped).toBe(true);
    expect(bus.activeRunRef).toBeNull();
    expect(bus.isWatching("frost")).toBe(false);
  });

  it("detach(runRef) for a run that isn't the active watch is a no-op returning false", () => {
    const { bus } = makeBus([]);
    bus.attach("frost");
    expect(bus.detach("someone-else")).toBe(false);
    expect(bus.isWatching("frost")).toBe(true);
  });

  it("after an explicit detach, refreshRuns does NOT auto-re-attach", async () => {
    const { bus, watches } = makeBus([run("frost", true)]);
    // Boot: auto-attach to the active run.
    await bus.refreshRuns();
    expect(bus.isWatching("frost")).toBe(true);
    expect(watches).toHaveLength(1);

    // User stops watching.
    expect(bus.detach()).toBe(true);
    expect(bus.activeRunRef).toBeNull();

    // A later runs refresh must stay detached — no silent re-attach.
    await bus.refreshRuns();
    expect(bus.activeRunRef).toBeNull();
    expect(bus.isWatching("frost")).toBe(false);
    expect(watches).toHaveLength(1); // no second watch spawned

    // An explicit re-focus clears the detached latch and re-attaches.
    bus.attach("frost");
    expect(bus.isWatching("frost")).toBe(true);
    expect(watches).toHaveLength(2);
  });

  it("initial refreshRuns auto-attaches (detached latch starts clear)", async () => {
    const { bus } = makeBus([run("frost", true)]);
    await bus.refreshRuns();
    expect(bus.activeRunRef).toBe("frost");
    expect(bus.isWatching("frost")).toBe(true);
  });
});

describe("StateBus — stale-watch + transient-blip guards (FIX B/C)", () => {
  function snap(runName: string, phase = "propose") {
    return { state: { run: runName, phase, status: "active", seats: [] } };
  }

  it("a late snapshot from a detached previous watch does NOT overwrite the new run's model (FIX B)", () => {
    const { bus, watches } = makeBus([]);
    bus.attach("A");
    const watchA = watches[0];
    bus.attach("B"); // swaps this.watch to watchB
    const watchB = watches[1];
    expect(bus.activeRunRef).toBe("B");

    // A's dying child fires a buffered snapshot on the OLD (now-detached) watch.
    watchA.emit("snapshot", snap("A"));
    // Guarded (this.watch !== w): B's model is untouched (still empty — B has not emitted).
    expect(bus.runModel.run).toBeNull();

    // Sanity: the CURRENT watch DOES update the model.
    watchB.emit("snapshot", snap("B"));
    expect(bus.runModel.run?.name).toBe("B");
  });

  function readClient(): {
    client: EngineClient;
    reads: Record<string, ReturnType<typeof vi.fn>>;
    watches: FakeWatch[];
    bus: StateBus;
  } {
    const reads = {
      runStatus: vi.fn(),
      report: vi.fn(),
      ledger: vi.fn(),
      budgetShow: vi.fn(),
      gateShow: vi.fn()
    };
    const client = {
      runs: vi.fn().mockResolvedValue({ schemaVersion: 1, runs: [] }),
      ...reads
    } as unknown as EngineClient;
    const watches: FakeWatch[] = [];
    const makeWatch: MakeWatch = () => {
      const w = new FakeWatch();
      watches.push(w);
      return w as never;
    };
    return { client, reads, watches, bus: new StateBus(client, makeWatch) };
  }

  it("a transient all-reads-fail blip KEEPS the prior model instead of wiping it (FIX C)", async () => {
    const { bus, reads, watches } = readClient();
    bus.attach("A");
    // Seed a good model from a snapshot.
    watches[0].emit("snapshot", snap("A", "decide"));
    expect(bus.runModel.run?.name).toBe("A");

    // The engine is briefly unavailable → EVERY read rejects (→ null via .catch).
    for (const fn of Object.values(reads)) fn.mockRejectedValue(new Error("engine down"));
    const logs: string[] = [];
    bus.on("log", (l) => logs.push(l));
    await (bus as unknown as { readRefresh: () => Promise<void> }).readRefresh();

    // Prior model preserved (NOT replaced with empty), and the keep was logged.
    expect(bus.runModel.run?.name).toBe("A");
    expect(logs.some((l) => l.includes("keeping prior model"))).toBe(true);
  });

  it("a partial success (>=1 read ok) still replaces the model (FIX C success path)", async () => {
    const { bus, reads, watches } = readClient();
    bus.attach("Z");
    watches[0].emit("snapshot", snap("Z"));

    // status succeeds, everything else fails → model rebuilds from the one good read.
    reads.runStatus.mockResolvedValue({
      schemaVersion: 1,
      run: "Z",
      id: 2,
      phase: "propose",
      status: "active",
      problem: "p",
      seats: [],
      gate: null,
      routing: { mode: "auto" }
    });
    reads.report.mockRejectedValue(new Error("x"));
    reads.ledger.mockRejectedValue(new Error("x"));
    reads.budgetShow.mockRejectedValue(new Error("x"));
    reads.gateShow.mockRejectedValue(new Error("x"));

    await (bus as unknown as { readRefresh: () => Promise<void> }).readRefresh();
    expect(bus.runModel.run?.id).toBe(2);
  });
});
