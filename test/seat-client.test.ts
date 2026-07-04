/**
 * Headless unit tests for the schema-3 seat takeover client methods
 * (`pauseSeat` / `resumeSeat`). Offline: we override the client's private
 * `spawnRaw` to capture the argv the method builds and to feed back canned engine
 * output — so we assert both the exact `collab seat …` command AND the parsing of
 * the ok + error envelopes, without spawning the real engine.
 */
import { describe, expect, it } from "vitest";

import { EngineClient } from "../src/engine/client.js";

interface RawResult {
  stdout: string;
  stderr: string;
  code: number | null;
  spawnError?: Error;
}

/** Build a client whose spawnRaw is stubbed to record argv + return canned output. */
function stubbedClient(canned: RawResult, adaptersDir?: string) {
  const client = new EngineClient({
    nodePath: "/node",
    enginePath: "/collab.mjs",
    cwd: "/work",
    adaptersDir
  });
  const calls: string[][] = [];
  // spawnRaw is private; the runJson helper calls this.spawnRaw(subArgs).
  (client as unknown as { spawnRaw: (a: string[]) => Promise<RawResult> }).spawnRaw = async (subArgs) => {
    calls.push(subArgs);
    return canned;
  };
  return { client, calls };
}

const okPause: RawResult = {
  stdout: JSON.stringify({
    schemaVersion: 3,
    ok: true,
    seat: "claude",
    session: "sess-abc",
    sessionCwd: "/work/claude",
    resumeCommand: "claude",
    resumeArgs: ["--resume", "sess-abc"],
    ready: true
  }),
  stderr: "",
  code: 0
};

const failPause: RawResult = {
  stdout: "",
  stderr: JSON.stringify({
    schemaVersion: 3,
    ok: false,
    error: { code: "takeover_failed", message: "still mid-turn past wait", hint: "raise --wait-ms" }
  }),
  code: 2
};

describe("EngineClient.adapters — thin-client seat discovery (FIX #1)", () => {
  const okAdapters: RawResult = {
    stdout: JSON.stringify({
      schemaVersion: 3,
      adapters: [
        { name: "claude", tiers: [{ alias: "top", rung: "top" }, { alias: "cheap", rung: "cheap" }] },
        { name: "glm", tiers: [{ alias: "cheap", rung: "cheap" }] }
      ]
    }),
    stderr: "",
    code: 0
  };

  it("builds `adapters` and passes --adapters-dir from config when set", async () => {
    const { client, calls } = stubbedClient(okAdapters, "/cfg-adapters");
    const res = await client.adapters();
    expect(calls[0]).toEqual(["adapters", "--adapters-dir", "/cfg-adapters"]);
    expect(res.adapters.map((a) => a.name)).toEqual(["claude", "glm"]);
  });

  it("omits --adapters-dir when the config has none", async () => {
    const { client, calls } = stubbedClient(okAdapters);
    await client.adapters();
    expect(calls[0]).toEqual(["adapters"]);
  });
});

describe("EngineClient.pauseSeat — argv", () => {
  it("builds `seat pause <seat> --run --adapters-dir --wait-ms`", async () => {
    const { client, calls } = stubbedClient(okPause);
    await client.pauseSeat("claude", "royal-raven", { adaptersDir: "/adapters", waitMs: 5000 });
    expect(calls[0]).toEqual([
      "seat", "pause", "claude",
      "--run", "royal-raven",
      "--adapters-dir", "/adapters",
      "--wait-ms", "5000"
    ]);
  });

  it("falls back to the client config's adaptersDir when opts omit it, and pins the default wait (FIX D)", async () => {
    const { client, calls } = stubbedClient(okPause, "/cfg-adapters");
    await client.pauseSeat("glm", "r");
    // FIX D: --wait-ms is now ALWAYS emitted (default 60000) so the client timeout
    // margin has a known engine wait to exceed.
    expect(calls[0]).toEqual(["seat", "pause", "glm", "--run", "r", "--adapters-dir", "/cfg-adapters", "--wait-ms", "60000"]);
  });

  it("omits optional flags but still pins the default wait (FIX D)", async () => {
    const { client, calls } = stubbedClient(okPause);
    await client.pauseSeat("claude");
    expect(calls[0]).toEqual(["seat", "pause", "claude", "--wait-ms", "60000"]);
  });
});

describe("EngineClient.pauseSeat — client timeout margin (FIX D)", () => {
  it("requests a client timeout strictly greater than the effective wait", async () => {
    const client = new EngineClient({ nodePath: "/node", enginePath: "/collab.mjs", cwd: "/work" });
    let capturedTimeout: number | undefined;
    (client as unknown as {
      spawnRaw: (a: string[], t?: number) => Promise<RawResult>;
    }).spawnRaw = async (_subArgs, timeoutMs) => {
      capturedTimeout = timeoutMs;
      return okPause;
    };

    // Caller-supplied wait: client timeout = wait + 30s margin, and strictly greater.
    await client.pauseSeat("claude", "r", { waitMs: 5000 });
    expect(capturedTimeout).toBe(35000);
    expect(capturedTimeout!).toBeGreaterThan(5000);

    // Default wait (60s, the engine's own default): client timeout 90s > 60s.
    await client.pauseSeat("claude", "r");
    expect(capturedTimeout).toBe(90000);
    expect(capturedTimeout!).toBeGreaterThan(60000);
  });
});

describe("EngineClient.pauseSeat — envelope parsing", () => {
  it("parses the ok spec (session/sessionCwd/resumeCommand/resumeArgs/ready)", async () => {
    const { client } = stubbedClient(okPause);
    const res = await client.pauseSeat("claude", "r");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.session).toBe("sess-abc");
    expect(res.sessionCwd).toBe("/work/claude");
    expect(res.resumeCommand).toBe("claude");
    expect(res.resumeArgs).toEqual(["--resume", "sess-abc"]);
    expect(res.ready).toBe(true);
  });

  it("returns {ok:false,error} (does NOT throw) on the failure envelope", async () => {
    const { client } = stubbedClient(failPause);
    const res = await client.pauseSeat("claude", "r");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.error.code).toBe("takeover_failed");
    expect(res.error.message).toBe("still mid-turn past wait");
    expect(res.error.hint).toBe("raise --wait-ms");
  });
});

describe("EngineClient.resumeSeat", () => {
  const okResume: RawResult = {
    stdout: JSON.stringify({ schemaVersion: 3, ok: true, seat: "claude", resumed: true }),
    stderr: "",
    code: 0
  };

  it("builds `seat resume <seat> --run` and parses the success envelope", async () => {
    const { client, calls } = stubbedClient(okResume);
    const res = await client.resumeSeat("claude", "royal-raven");
    expect(calls[0]).toEqual(["seat", "resume", "claude", "--run", "royal-raven"]);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.resumed).toBe(true);
  });

  it("omits --run when not given", async () => {
    const { client, calls } = stubbedClient(okResume);
    await client.resumeSeat("claude");
    expect(calls[0]).toEqual(["seat", "resume", "claude"]);
  });

  it("returns {ok:false,error} on failure", async () => {
    const { client } = stubbedClient({
      stdout: "",
      stderr: JSON.stringify({
        schemaVersion: 3,
        ok: false,
        error: { code: "no_such_seat", message: "no seat glm", hint: null }
      }),
      code: 2
    });
    const res = await client.resumeSeat("glm", "r");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.error.code).toBe("no_such_seat");
  });
});
