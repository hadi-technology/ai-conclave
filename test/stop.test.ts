/**
 * Headless unit tests for the pure stop-vs-detach decision logic — the exact
 * teardown a "Stop run (cancel)" vs a "Stop watching" action performs, without
 * spawning anything.
 */
import { describe, expect, it } from "vitest";

import { cancelRunMessage, planCancelRun, planStopWatching } from "../src/viewmodels/stop.js";

describe("planCancelRun — engine-side terminal cancel", () => {
  it("always asks the engine to stop, and kills the child when driving", () => {
    expect(planCancelRun({ driving: true, watching: true })).toEqual({
      engineStop: true,
      killOrchestrate: true,
      detachWatch: false
    });
  });

  it("still cancels engine-side for an attached-only run (no driving child to kill)", () => {
    expect(planCancelRun({ driving: false, watching: true })).toEqual({
      engineStop: true,
      killOrchestrate: false,
      detachWatch: false
    });
  });

  it("cancels even when nothing local is held (idempotent engine stop)", () => {
    expect(planCancelRun({ driving: false, watching: false })).toEqual({
      engineStop: true,
      killOrchestrate: false,
      detachWatch: false
    });
  });

  it("never detaches the viewer — you can watch the run wind down", () => {
    expect(planCancelRun({ driving: true, watching: true }).detachWatch).toBe(false);
  });
});

describe("planStopWatching — detach the viewer only", () => {
  it("detaches the viewer and touches NOTHING engine-side or the driving child", () => {
    expect(planStopWatching({ driving: true, watching: true })).toEqual({
      engineStop: false,
      killOrchestrate: false,
      detachWatch: true
    });
  });

  it("is a no-op when not watching", () => {
    expect(planStopWatching({ driving: true, watching: false })).toEqual({
      engineStop: false,
      killOrchestrate: false,
      detachWatch: false
    });
  });

  it("never engine-stops or kills the driving child (distinct from cancel)", () => {
    const plan = planStopWatching({ driving: true, watching: true });
    expect(plan.engineStop).toBe(false);
    expect(plan.killOrchestrate).toBe(false);
  });
});

describe("cancelRunMessage — honest reporting of the cancel outcome (FIX #4)", () => {
  it("engine confirmed the stop → info 'terminally stopped'", () => {
    const m = cancelRunMessage("frost", { engineStopped: true, killedChild: false });
    expect(m.kind).toBe("info");
    expect(m.text).toContain("terminally stopped");
    expect(m.text).not.toContain("driving child terminated");
  });

  it("engine confirmed + child killed → info notes the child was terminated", () => {
    const m = cancelRunMessage("frost", { engineStopped: true, killedChild: true });
    expect(m.kind).toBe("info");
    expect(m.text).toContain("driving child terminated");
  });

  it("engine stop FAILED, no child → error, does NOT claim stopped", () => {
    const m = cancelRunMessage("frost", { engineStopped: false, killedChild: false, error: "boom" });
    expect(m.kind).toBe("error");
    expect(m.text).toContain("failed to stop");
    expect(m.text).toContain("boom");
    expect(m.text).not.toContain("terminally stopped");
  });

  it("engine stop FAILED but child was killed → error warns the run may resume", () => {
    const m = cancelRunMessage("frost", { engineStopped: false, killedChild: true, error: "timeout" });
    expect(m.kind).toBe("error");
    expect(m.text).toContain("local driver");
    expect(m.text).toContain("may resume");
    expect(m.text).toContain("timeout");
  });
});

describe("cancel vs detach are clearly distinct actions", () => {
  it("cancel engine-stops but leaves the viewer; detach leaves the engine but drops the viewer", () => {
    const state = { driving: true, watching: true };
    const cancel = planCancelRun(state);
    const detach = planStopWatching(state);
    expect(cancel.engineStop).toBe(true);
    expect(detach.engineStop).toBe(false);
    expect(cancel.detachWatch).toBe(false);
    expect(detach.detachWatch).toBe(true);
  });
});
