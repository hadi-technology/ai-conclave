import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WatchClient } from "../src/engine/watch.js";
import type { WatchSnapshotLine } from "../src/engine/contract.js";
import { provisionForTests, seedStore, type SeededStore } from "./helpers.js";

let seed: SeededStore;

beforeAll(async () => {
  const prov = await provisionForTests();
  seed = await seedStore(prov);
}, 60000);

afterAll(() => {
  if (seed?.dir) rmSync(seed.dir, { recursive: true, force: true });
});

describe("WatchClient — snapshot + cursor feed", () => {
  it("emits a run-scoped snapshot with a cursor and state, then stops cleanly", async () => {
    const watcher = new WatchClient(
      {
        nodePath: seed.prov.nodePath,
        enginePath: seed.prov.enginePath,
        cwd: seed.dir,
        storePath: seed.storePath
      },
      { run: seed.runId, autoReconnect: false }
    );

    const snapshot = await new Promise<WatchSnapshotLine>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no snapshot within 20s")), 20000);
      watcher.on("snapshot", (line) => {
        clearTimeout(timer);
        resolve(line);
      });
      watcher.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      watcher.start();
    });

    expect(snapshot.type).toBe("snapshot");
    expect(typeof snapshot.cursor).toBe("number");
    expect(snapshot.cursor).toBeGreaterThan(0);
    expect(watcher.lastCursor).toBe(snapshot.cursor);
    const state = snapshot.state as { id?: number; problem?: string };
    expect(state.id).toBe(seed.runId);
    expect(state.problem).toContain("Seed problem");

    const closed = new Promise<{ stopped: boolean }>((resolve) => {
      watcher.on("close", (info) => resolve(info));
    });
    watcher.stop();
    const info = await closed;
    expect(info.stopped).toBe(true);
  });

  it("global --all channel emits a runs snapshot", async () => {
    const watcher = new WatchClient(
      {
        nodePath: seed.prov.nodePath,
        enginePath: seed.prov.enginePath,
        cwd: seed.dir,
        storePath: seed.storePath
      },
      { all: true, autoReconnect: false }
    );

    const snapshot = await new Promise<WatchSnapshotLine>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no snapshot within 20s")), 20000);
      watcher.on("snapshot", (line) => {
        clearTimeout(timer);
        resolve(line);
      });
      watcher.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      watcher.start();
    });

    const state = snapshot.state as { runs?: unknown[] };
    expect(Array.isArray(state.runs)).toBe(true);
    watcher.stop();
  });
});
