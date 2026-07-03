/**
 * OrchestrateController lifecycle — start / gate-driven resume / stop teardown —
 * tested headlessly with a fake spawn (no real child, no LLM turns).
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { OrchestrateController, type SpawnedChild, type SpawnFn } from "../src/orchestrate.js";

class FakeChild extends EventEmitter implements SpawnedChild {
  stdout = new EventEmitter() as unknown as SpawnedChild["stdout"];
  stderr = new EventEmitter() as unknown as SpawnedChild["stderr"];
  killed: NodeJS.Signals | null = null;
  kill(signal?: NodeJS.Signals): void {
    this.killed = signal ?? "SIGTERM";
  }
  fireExit(code: number | null): void {
    this.emit("exit", code);
  }
}

function fakeSpawnFactory(): { spawn: SpawnFn; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const spawn: SpawnFn = () => {
    const c = new FakeChild();
    children.push(c);
    return c;
  };
  return { spawn, children };
}

const CFG = { nodePath: "/node", enginePath: "/engine", cwd: "/work", execute: true, target: "/scratch/build-1" };

describe("OrchestrateController", () => {
  it("start() spawns a child and is running", () => {
    const { spawn, children } = fakeSpawnFactory();
    const c = new OrchestrateController(CFG, 1, {}, spawn);
    c.start();
    expect(children).toHaveLength(1);
    expect(c.isRunning).toBe(true);
  });

  it("onExit fires when the child idles on a gate, and resume() re-spawns", () => {
    const { spawn, children } = fakeSpawnFactory();
    const onExit = vi.fn();
    const c = new OrchestrateController(CFG, 1, { onExit }, spawn);
    c.start();
    children[0].fireExit(0);
    expect(onExit).toHaveBeenCalledWith({ code: 0, stopped: false });
    expect(c.isRunning).toBe(false);

    c.resume();
    expect(children).toHaveLength(2);
    expect(c.isRunning).toBe(true);
  });

  it("stop() kills the child and marks stopped so a late exit reports stopped=true", () => {
    const { spawn, children } = fakeSpawnFactory();
    const onExit = vi.fn();
    const c = new OrchestrateController(CFG, 1, { onExit }, spawn);
    c.start();
    c.stop();
    expect(children[0].killed).toBe("SIGTERM");
    expect(c.isRunning).toBe(false);
    // resume after stop is a no-op
    c.resume();
    expect(children).toHaveLength(1);
  });

  it("does not double-spawn while already running", () => {
    const { spawn, children } = fakeSpawnFactory();
    const c = new OrchestrateController(CFG, 1, {}, spawn);
    c.start();
    c.resume(); // running → ignored
    expect(children).toHaveLength(1);
  });

  it("streams stdout/stderr lines to onLog", () => {
    const { spawn, children } = fakeSpawnFactory();
    const logs: string[] = [];
    const c = new OrchestrateController(CFG, 1, { onLog: (l) => logs.push(l) }, spawn);
    c.start();
    (children[0].stdout as unknown as EventEmitter).emit("data", "line one\nline two\n");
    expect(logs).toEqual(["line one", "line two"]);
  });
});
