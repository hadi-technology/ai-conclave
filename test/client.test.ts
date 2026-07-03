import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EngineClient } from "../src/engine/client.js";
import { EngineError } from "../src/engine/errors.js";
import { provisionForTests, seedStore, type SeededStore } from "./helpers.js";

let seed: SeededStore;
let client: EngineClient;

beforeAll(async () => {
  const prov = await provisionForTests();
  seed = await seedStore(prov);
  client = new EngineClient({
    nodePath: prov.nodePath,
    enginePath: prov.enginePath,
    cwd: seed.dir,
    storePath: seed.storePath
  });
}, 60000);

afterAll(() => {
  if (seed?.dir) rmSync(seed.dir, { recursive: true, force: true });
});

describe("EngineClient — typed read envelopes", () => {
  it("version() parses the compatibility payload", async () => {
    const v = await client.version();
    expect(v.schemaVersion).toBe(1);
    expect(v.engineVersion).toMatch(/\d+\.\d+\.\d+/);
    expect(v.minClientSchema).toBe(1);
  });

  it("runs() lists the seeded run", async () => {
    const { runs } = await client.runs();
    expect(runs.length).toBe(1);
    expect(runs[0].name).toBe(seed.runName);
    expect(runs[0].id).toBe(seed.runId);
    expect(runs[0].active).toBe(true);
  });

  it("runStatus() parses phase, seats, and gate=null", async () => {
    const s = await client.runStatus(seed.runName);
    expect(s.run).toBe(seed.runName);
    expect(s.phase).toBe("propose");
    expect(s.seats.map((x) => x.seat).sort()).toEqual(["a", "b"]);
    expect(s.gate).toBeNull();
    expect(s.routing.mode).toBeTruthy();
  });

  it("ledger() parses the rollup with zero spend", async () => {
    const l = await client.ledger(seed.runName);
    expect(l.total).toBe(0);
    expect(Array.isArray(l.perSeatModel)).toBe(true);
    expect(l.budgetUsd).toBeNull();
  });

  it("report() parses the structured report", async () => {
    const r = await client.report(seed.runName);
    expect(r.run).toBe(seed.runName);
    expect(r.seats.sort()).toEqual(["a", "b"]);
    expect(Array.isArray(r.units)).toBe(true);
    expect(r.totalCost).toBe(0);
  });

  it("gateShow() reports no pending gate", async () => {
    const g = await client.gateShow(seed.runName);
    expect(g.gate).toBeNull();
  });
});

describe("EngineClient — error envelopes", () => {
  it("run_not_found throws a typed EngineError with a hint", async () => {
    await expect(client.runStatus("does-not-exist")).rejects.toSatisfy((err: unknown) => {
      return err instanceof EngineError && err.code === "run_not_found" && !!err.hint;
    });
  });

  it("no_store when the store path is wrong", async () => {
    const bad = new EngineClient({
      nodePath: seed.prov.nodePath,
      enginePath: seed.prov.enginePath,
      cwd: seed.dir,
      storePath: "/tmp/conclave-nope/store.db"
    });
    await expect(bad.runStatus()).rejects.toMatchObject({ code: "no_store" });
  });

  it("spawn_failed when the engine path is bogus", async () => {
    const bad = new EngineClient({
      nodePath: seed.prov.nodePath,
      enginePath: "/tmp/conclave-nope/collab.mjs",
      cwd: seed.dir
    });
    // A missing engine file makes Node exit nonzero with a module-not-found error;
    // it surfaces as a typed EngineError (not a raw throw).
    await expect(bad.version()).rejects.toBeInstanceOf(EngineError);
  });
});

describe("EngineClient — actions", () => {
  it("runStart() returns a typed success envelope", async () => {
    const res = await client.runStart({
      problem: "A second run via the client",
      criteria: "started ok",
      seats: "a,b"
    });
    expect(res.ok).toBe(true);
    expect(res.phase).toBe("propose");
    expect(res.seats).toEqual(["a", "b"]);
  });
});
