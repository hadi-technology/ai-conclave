import { describe, expect, it } from "vitest";

import {
  DEFAULT_ENGINE_PATH,
  locateEngine,
  locateNode,
  parseNodeMajor,
  provision
} from "../src/engine/provision.js";
import { EngineError } from "../src/engine/errors.js";

describe("parseNodeMajor", () => {
  it("parses v25.9.0 → 25", () => {
    expect(parseNodeMajor("v25.9.0")).toBe(25);
  });
  it("parses without leading v", () => {
    expect(parseNodeMajor("20.11.1\n")).toBe(20);
  });
  it("returns null on garbage", () => {
    expect(parseNodeMajor("not a version")).toBeNull();
  });
});

describe("locateNode", () => {
  it("auto-detects a Node ≥25 on this machine", async () => {
    const node = await locateNode({});
    expect(node).toBeTruthy();
    // Homebrew Node ≥25 is expected at this path per the environment.
    expect(typeof node).toBe("string");
  });

  it("accepts an explicit valid Node override", async () => {
    const node = await locateNode({ nodePath: "/opt/homebrew/bin/node" });
    expect(node).toBe("/opt/homebrew/bin/node");
  });

  it("gives a clear error for a missing configured node", async () => {
    await expect(locateNode({ nodePath: "/nope/does/not/exist/node" })).rejects.toMatchObject({
      code: "node_not_found"
    });
  });
});

describe("locateEngine", () => {
  it("detects the default local engine checkout", () => {
    expect(locateEngine({})).toBe(DEFAULT_ENGINE_PATH);
  });

  it("gives a clear error for a missing configured engine", () => {
    try {
      locateEngine({ enginePath: "/nope/collab.mjs" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      expect((err as EngineError).code).toBe("engine_not_found");
      expect((err as EngineError).hint).toBeTruthy();
    }
  });
});

describe("provision", () => {
  it("reports the engine ready with a compatible schema", async () => {
    const result = await provision({});
    expect(result.status).toBe("ready");
    expect(result.engineVersion).toMatch(/\d+\.\d+\.\d+/);
    expect(result.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(result.minClientSchema).toBeLessThanOrEqual(1);
  });
});
