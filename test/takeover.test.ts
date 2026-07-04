/**
 * Headless unit tests for the E4 takeover hatch — the REAL pause→attach→release
 * round-trip (engine schema 3 `collab seat pause/resume`). Verifies (a) the
 * snapshot pre-flight projection, (b) that a `pauseSeat` ok-response is turned into
 * an attach effect with the engine's AUTHORITATIVE cwd + resume command, (c) an
 * error response becomes an error effect surfacing message + hint, and (d) the
 * release guard resumes a tracked seat EXACTLY once (no double-resume).
 */
import { describe, expect, it, vi } from "vitest";

import {
  seatTakeoverState,
  canTakeOver,
  planTakeover,
  posixQuote,
  releaseTracked,
  drainTakeovers
} from "../src/viewmodels/takeover.js";
import type { SeatPauseResult } from "../src/engine/contract.js";

describe("seatTakeoverState", () => {
  const state = {
    seats: [
      { seat: "a", session: "sess-abc", sessionCwd: "/work/a", paused: false, status: "working" },
      { seat: "b", session: null, sessionCwd: null, paused: true, status: "idle" }
    ]
  };

  it("projects a seat's session/sessionCwd/paused/status", () => {
    expect(seatTakeoverState(state, "a")).toEqual({
      seat: "a",
      session: "sess-abc",
      sessionCwd: "/work/a",
      paused: false,
      status: "working"
    });
  });
  it("handles a seat with no session", () => {
    expect(seatTakeoverState(state, "b")).toMatchObject({ session: null, sessionCwd: null, paused: true });
  });
  it("returns null for an unknown seat or empty state", () => {
    expect(seatTakeoverState(state, "z")).toBeNull();
    expect(seatTakeoverState(null, "a")).toBeNull();
    expect(seatTakeoverState({}, "a")).toBeNull();
  });
});

describe("canTakeOver — pre-flight", () => {
  it("is true only when the seat has a session to resume", () => {
    expect(canTakeOver({ seat: "a", session: "s", sessionCwd: "/w", paused: false, status: "idle" })).toBe(true);
    expect(canTakeOver({ seat: "b", session: null, sessionCwd: null, paused: false, status: "idle" })).toBe(false);
    expect(canTakeOver(null)).toBe(false);
  });
});

describe("planTakeover — prefers the engine's authoritative resume spec", () => {
  it("ok response → attach in sessionCwd, auto-run resumeCommand + resumeArgs", () => {
    const res: SeatPauseResult = {
      schemaVersion: 3,
      ok: true,
      seat: "claude",
      session: "sess-abc",
      sessionCwd: "/work/claude",
      resumeCommand: "claude",
      resumeArgs: ["--resume", "sess-abc"],
      ready: true
    };
    const eff = planTakeover("claude", res);
    expect(eff.kind).toBe("attach");
    if (eff.kind !== "attach") throw new Error("expected attach");
    expect(eff.cwd).toBe("/work/claude");
    expect(eff.commandLine).toBe("claude --resume sess-abc");
    expect(eff.session).toBe("sess-abc");
  });

  it("error response → error effect surfacing message + hint (no cleanup path)", () => {
    const res: SeatPauseResult = {
      ok: false,
      error: { code: "takeover_failed", message: "still mid-turn", hint: "raise --wait-ms" }
    };
    const eff = planTakeover("claude", res);
    expect(eff.kind).toBe("error");
    if (eff.kind !== "error") throw new Error("expected error");
    expect(eff.message).toBe("still mid-turn — raise --wait-ms");
  });

  it("error with no hint → bare message", () => {
    const res: SeatPauseResult = {
      ok: false,
      error: { code: "no_session", message: "no session yet", hint: null }
    };
    const eff = planTakeover("x", res);
    if (eff.kind !== "error") throw new Error("expected error");
    expect(eff.message).toBe("no session yet");
  });

  it("shell-quotes a command path with a space so it stays ONE token", () => {
    const res: SeatPauseResult = {
      schemaVersion: 3,
      ok: true,
      seat: "codex",
      session: "sess-1",
      sessionCwd: "/work/codex",
      resumeCommand: "/Users/Baba/My Tools/codex",
      resumeArgs: ["--resume", "sess-1"],
      ready: true
    };
    const eff = planTakeover("codex", res);
    if (eff.kind !== "attach") throw new Error("expected attach");
    expect(eff.commandLine).toBe("'/Users/Baba/My Tools/codex' --resume sess-1");
  });

  it("shell-quotes an arg with shell metachars so the shell can't interpret them", () => {
    const res: SeatPauseResult = {
      schemaVersion: 3,
      ok: true,
      seat: "claude",
      session: "a;b",
      sessionCwd: "/work",
      resumeCommand: "claude",
      resumeArgs: ["--resume", "a; rm -rf /", "$(whoami)"],
      ready: true
    };
    const eff = planTakeover("claude", res);
    if (eff.kind !== "attach") throw new Error("expected attach");
    expect(eff.commandLine).toBe("claude --resume 'a; rm -rf /' '$(whoami)'");
  });
});

describe("posixQuote", () => {
  it("leaves shell-safe tokens untouched", () => {
    expect(posixQuote("claude")).toBe("claude");
    expect(posixQuote("--resume")).toBe("--resume");
    expect(posixQuote("/usr/local/bin/codex")).toBe("/usr/local/bin/codex");
    expect(posixQuote("sess-abc_123")).toBe("sess-abc_123");
  });
  it("single-quotes tokens with spaces or metachars", () => {
    expect(posixQuote("My Tools")).toBe("'My Tools'");
    expect(posixQuote("a;b")).toBe("'a;b'");
    expect(posixQuote("$(whoami)")).toBe("'$(whoami)'");
  });
  it("escapes an embedded single quote", () => {
    expect(posixQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("releaseTracked — exactly-once on success, retryable on failure", () => {
  type Entry = { run: string; releasing?: boolean };

  it("(a) success → resume called once, entry deleted, returns true", async () => {
    const registry = new Map<string, Entry>([["claude", { run: "royal-raven" }]]);
    const resume = vi.fn().mockResolvedValue({ ok: true });
    const did = await releaseTracked(registry, "claude", resume);
    expect(did).toBe(true);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith("claude", "royal-raven");
    expect(registry.has("claude")).toBe(false);
  });

  it("(b) concurrent double-fire (button + on-close) → second is a no-op while in-flight", async () => {
    const registry = new Map<string, Entry>([["a", { run: "r" }]]);
    let resolveResume: () => void = () => {};
    const resume = vi.fn().mockImplementation(() => new Promise<void>((r) => { resolveResume = r; }));
    const p1 = releaseTracked(registry, "a", resume);
    // The entry SURVIVES while in-flight (so a failure can be retried), but the
    // in-flight `releasing` flag suppresses the second trigger.
    expect(registry.get("a")?.releasing).toBe(true);
    const second = await releaseTracked(registry, "a", resume);
    expect(second).toBe(false);
    resolveResume();
    expect(await p1).toBe(true);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(registry.has("a")).toBe(false);
  });

  it("(c) resume FAILS → entry REMAINS (retryable), releasing reset, throws", async () => {
    const registry = new Map<string, Entry>([["a", { run: "r" }]]);
    const resume = vi.fn().mockRejectedValue(new Error("engine down"));
    await expect(releaseTracked(registry, "a", resume)).rejects.toThrow("engine down");
    expect(registry.has("a")).toBe(true); // NOT deleted — the user can retry
    expect(registry.get("a")?.releasing).toBe(false); // flag reset so retry isn't suppressed
  });

  it("(d) retry after a failure → succeeds and deletes", async () => {
    const registry = new Map<string, Entry>([["a", { run: "r" }]]);
    const resume = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(undefined);
    await expect(releaseTracked(registry, "a", resume)).rejects.toThrow("transient");
    expect(registry.has("a")).toBe(true);
    const did = await releaseTracked(registry, "a", resume);
    expect(did).toBe(true);
    expect(registry.has("a")).toBe(false);
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it("returns false for an unknown seat", async () => {
    const resume = vi.fn();
    expect(await releaseTracked(new Map<string, Entry>(), "ghost", resume)).toBe(false);
    expect(resume).not.toHaveBeenCalled();
  });
});

describe("drainTakeovers — shutdown drain releases every seat (FIX #5)", () => {
  type Entry = { run: string; releasing?: boolean };

  it("resumes every tracked seat and empties the map", async () => {
    const registry = new Map<string, Entry>([
      ["claude", { run: "r1" }],
      ["glm", { run: "r2" }]
    ]);
    const resume = vi.fn().mockResolvedValue(undefined);
    await drainTakeovers(registry, resume);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(resume).toHaveBeenCalledWith("claude", "r1");
    expect(resume).toHaveBeenCalledWith("glm", "r2");
    expect(registry.size).toBe(0);
  });

  it("still drains ALL seats and empties the map even if one resume rejects (never throws)", async () => {
    const registry = new Map<string, Entry>([
      ["claude", { run: "r1" }],
      ["glm", { run: "r2" }]
    ]);
    const resume = vi.fn(async (seat: string) => {
      if (seat === "claude") throw new Error("engine down");
    });
    const errors: string[] = [];
    await expect(
      drainTakeovers(registry, resume, (seat) => errors.push(seat))
    ).resolves.toBeUndefined();
    expect(resume).toHaveBeenCalledTimes(2); // glm still resumed despite claude failing
    expect(errors).toEqual(["claude"]);
    expect(registry.size).toBe(0); // cleared regardless of the failure
  });

  it("is a no-op on an empty registry", async () => {
    const resume = vi.fn();
    await drainTakeovers(new Map<string, Entry>(), resume);
    expect(resume).not.toHaveBeenCalled();
  });
});
