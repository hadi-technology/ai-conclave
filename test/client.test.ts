import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EngineClient } from "../src/engine/client.js";
import { EngineError } from "../src/engine/errors.js";
import { CLIENT_SCHEMA_VERSION } from "../src/engine/contract.js";
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
  it("version() parses the compatibility payload (schema-agnostic)", async () => {
    const v = await client.version();
    // Do NOT hardcode the engine's schemaVersion — it is a monotonic feature level
    // that advances additively (may go higher). Assert the compatibility invariant
    // holds dynamically instead: minClientSchema <= CLIENT_SCHEMA_VERSION <= schemaVersion.
    expect(typeof v.schemaVersion).toBe("number");
    expect(typeof v.minClientSchema).toBe("number");
    expect(v.engineVersion).toMatch(/\d+\.\d+\.\d+/);
    expect(v.schemaVersion).toBeGreaterThanOrEqual(v.minClientSchema);
    expect(v.minClientSchema).toBeLessThanOrEqual(CLIENT_SCHEMA_VERSION);
    expect(CLIENT_SCHEMA_VERSION).toBeLessThanOrEqual(v.schemaVersion);
    // The extension DOES require schema 3 (it calls `seat pause/resume` + `run stop`),
    // so it must advertise 3 — not 1 — or an older engine would pass provisioning and
    // then fail at runtime. Pin it so an accidental downgrade fails fast here.
    expect(CLIENT_SCHEMA_VERSION).toBe(3);
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
    // Schema 2 (additive): the run's working dir is reported; target is a string or null.
    expect(typeof s.workingDir).toBe("string");
    expect(s.target === null || typeof s.target === "string").toBe(true);
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
    // Schema 2 (additive): report carries the same workingDir/target as run status.
    expect(typeof r.workingDir).toBe("string");
    expect(r.target === null || typeof r.target === "string").toBe(true);
    // Each qaFinding (if any) carries structured file/line (string|null, number|null).
    for (const f of r.qaFindings) {
      expect(f.file === null || typeof f.file === "string").toBe(true);
      expect(f.line === null || typeof f.line === "number").toBe(true);
    }
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

  it("runStop() terminally stops a run (schema 2)", async () => {
    const res = await client.runStop(seed.runName);
    expect(res.ok).toBe(true);
    expect(res.run).toBe(seed.runName);
    expect(res.status).toBe("stopped");
    // Idempotent-ish: the run now reads back as stopped through the contract.
    const s = await client.runStatus(seed.runName);
    expect(s.status).toBe("stopped");
  });

  it("runStop() on an unknown run throws run_not_found", async () => {
    await expect(client.runStop("does-not-exist")).rejects.toSatisfy(
      (err: unknown) => err instanceof EngineError && err.code === "run_not_found"
    );
  });
});
