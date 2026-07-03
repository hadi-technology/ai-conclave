/**
 * Headless unit tests for the E4 takeover hatch — the HONEST gap-aware command
 * construction. Verifies we (a) read the seat's session from the snapshot, (b)
 * build the real `--resume` command when possible, (c) never pretend a paused
 * round-trip exists, and (d) always surface the contract gap.
 */
import { describe, expect, it } from "vitest";

import { seatTakeoverState, buildTakeoverPlan } from "../src/viewmodels/takeover.js";

describe("seatTakeoverState", () => {
  const state = {
    seats: [
      { seat: "a", session: "sess-abc", paused: false, status: "working" },
      { seat: "b", session: null, paused: true, status: "idle" }
    ]
  };

  it("projects a seat's session/paused/status", () => {
    expect(seatTakeoverState(state, "a")).toEqual({ seat: "a", session: "sess-abc", paused: false, status: "working" });
  });
  it("handles a seat with no session", () => {
    expect(seatTakeoverState(state, "b")).toMatchObject({ session: null, paused: true });
  });
  it("returns null for an unknown seat or empty state", () => {
    expect(seatTakeoverState(state, "z")).toBeNull();
    expect(seatTakeoverState(null, "a")).toBeNull();
    expect(seatTakeoverState({}, "a")).toBeNull();
  });
});

describe("buildTakeoverPlan", () => {
  it("builds the real resume command when session + adapter are known", () => {
    const plan = buildTakeoverPlan({
      seat: "a",
      session: "sess-abc",
      working: false,
      adapterCommand: "claude",
      targetCwd: "/tmp/build-run"
    });
    expect(plan.kind).toBe("resume");
    if (plan.kind !== "resume") throw new Error("expected resume");
    expect(plan.resumeCommand).toBe("claude --resume sess-abc");
    expect(plan.cwd).toBe("/tmp/build-run");
    expect(plan.warnDoubleAttach).toBe(false);
    // The contract gap is ALWAYS surfaced (no silent fake round-trip).
    expect(plan.banner.join("\n")).toContain("no seat pause/resume action");
    expect(plan.banner.join("\n")).toContain("ENGINE-GAPS.md");
  });

  it("warns about double-attach when the seat is mid-turn", () => {
    const plan = buildTakeoverPlan({
      seat: "a",
      session: "s1",
      working: true,
      adapterCommand: "claude",
      targetCwd: "/t"
    });
    if (plan.kind !== "resume") throw new Error("expected resume");
    expect(plan.warnDoubleAttach).toBe(true);
    expect(plan.banner.join("\n")).toContain("CURRENTLY WORKING");
  });

  it("reports no-session honestly (no fabricated command)", () => {
    const plan = buildTakeoverPlan({
      seat: "b",
      session: null,
      working: false,
      adapterCommand: "claude",
      targetCwd: "/t"
    });
    expect(plan.kind).toBe("no-session");
    expect(JSON.stringify(plan)).not.toContain("--resume");
  });

  it("reports no-adapter but still tells the user the session id", () => {
    const plan = buildTakeoverPlan({
      seat: "a",
      session: "sess-xyz",
      working: false,
      adapterCommand: null,
      targetCwd: "/t"
    });
    expect(plan.kind).toBe("no-adapter");
    expect(plan.banner.join("\n")).toContain("sess-xyz");
  });
});
