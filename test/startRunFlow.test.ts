/**
 * Headless test for the thin-client seat discovery (FIX #1): discoverSeats asks the
 * ENGINE which adapters it can load (`client.adapters()`) instead of globbing the
 * engine's adapters dir from the extension. On any engine error it degrades to an
 * empty list so the start flow falls back to free-text seat entry (never crashes).
 *
 * Pure-logic + fake client — no vscode, no real engine spawn.
 */
import { describe, expect, it } from "vitest";

import type { EngineClient } from "../src/engine/client.js";
import type { AdaptersResponse } from "../src/engine/contract.js";
import { discoverSeats } from "../src/viewmodels/startRun.js";

/** A fake EngineClient exposing only the adapters() method discoverSeats uses. */
function fakeClient(adapters: () => Promise<AdaptersResponse>): EngineClient {
  return { adapters } as unknown as EngineClient;
}

describe("discoverSeats — engine-backed seat enumeration (thin client)", () => {
  it("returns sorted seat names from the engine's adapters list", async () => {
    const client = fakeClient(async () => ({
      schemaVersion: 3,
      adapters: [
        { name: "glm", tiers: [{ alias: "cheap", rung: "cheap" }] },
        { name: "claude", tiers: [{ alias: "top", rung: "top" }] },
        { name: "codex", tiers: [{ alias: "cheap", rung: "cheap" }] }
      ]
    }));
    expect(await discoverSeats(client)).toEqual(["claude", "codex", "glm"]);
  });

  it("returns [] when the engine list is empty", async () => {
    const client = fakeClient(async () => ({ schemaVersion: 3, adapters: [] }));
    expect(await discoverSeats(client)).toEqual([]);
  });

  it("falls back to [] on any engine error (never throws)", async () => {
    const client = fakeClient(async () => {
      throw new Error("engine unreachable");
    });
    expect(await discoverSeats(client)).toEqual([]);
  });
});
