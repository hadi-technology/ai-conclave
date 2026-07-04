/**
 * Gate-resolution wiring — a pending gate model, once a button is chosen,
 * dispatches the RIGHT EngineClient call. The client is faked (no engine spawn);
 * we assert the method + args reaching it. Mirrors the vscode gate UX's
 * dispatchResolution path without needing vscode.
 */
import { describe, expect, it, vi } from "vitest";

import { gateFromRead } from "../src/viewmodels/model.js";
import {
  gateNotificationSpec,
  gateStillPending,
  resolveGateCall,
  resolutionClearsGate,
  type GateResolution
} from "../src/viewmodels/gate.js";
import { cancelRunMessage, type CancelOutcome } from "../src/viewmodels/stop.js";
import type { GateShow, BudgetShow } from "../src/engine/contract.js";

/** A fake EngineClient capturing gate/budget calls. */
function fakeClient() {
  return {
    gateApprove: vi.fn().mockResolvedValue({ schemaVersion: 1, ok: true, gate: 3, kind: "plan_approval", resolution: "approved", winner: null }),
    gateReject: vi.fn().mockResolvedValue({ schemaVersion: 1, ok: true, gate: 3, kind: "plan_approval", resolution: "rejected", feedback: "no" }),
    budgetRaise: vi.fn().mockResolvedValue({ schemaVersion: 1, ok: true, run: "r", id: 1, budgetUsd: 10, gateCleared: true, resumed: true })
  };
}

/** The same dispatch the vscode layer performs, minus vscode. Mirrors
 *  dispatchResolution (src/gates.ts): fire the `resume` hook after a
 *  gate-CLEARING action, using the SAME `resolutionClearsGate` predicate the
 *  real code uses. */
async function dispatch(
  client: ReturnType<typeof fakeClient>,
  res: GateResolution,
  resume?: (runRef: string) => void
): Promise<void> {
  switch (res.method) {
    case "gateApprove":
      await client.gateApprove(res.opts);
      break;
    case "gateReject":
      await client.gateReject(res.opts);
      break;
    case "budgetRaise":
      await client.budgetRaise(res.opts);
      break;
    default:
      break;
  }
  if (resolutionClearsGate(res.method)) resume?.("frost");
}

describe("pending gate → client call", () => {
  it("plan gate + Approve → client.gateApprove({run})", async () => {
    const gs: GateShow = { schemaVersion: 1, run: "frost", id: 1, gate: { id: 3, kind: "plan_approval", status: "pending", critiques: [] } };
    const spec = gateNotificationSpec(gateFromRead(gs, null)!);
    const approve = spec.actions.find((a) => a.kind === "approve")!;
    const res = resolveGateCall(approve, { run: "frost" });

    const client = fakeClient();
    await dispatch(client, res);
    expect(client.gateApprove).toHaveBeenCalledWith({ run: "frost", feedback: undefined });
    expect(client.gateReject).not.toHaveBeenCalled();
  });

  it("plan gate + Reject → client.gateReject({run,feedback})", async () => {
    const gs: GateShow = { schemaVersion: 1, run: "frost", id: 1, gate: { id: 3, kind: "plan_approval", status: "pending" } };
    const spec = gateNotificationSpec(gateFromRead(gs, null)!);
    const reject = spec.actions.find((a) => a.kind === "reject")!;
    const res = resolveGateCall(reject, { run: "frost", feedback: "needs work" });

    const client = fakeClient();
    await dispatch(client, res);
    expect(client.gateReject).toHaveBeenCalledWith({ run: "frost", feedback: "needs work" });
  });

  it("tie gate + Pick b → client.gateApprove({run,winner:'b'})", async () => {
    const gs: GateShow = {
      schemaVersion: 1,
      run: "frost",
      id: 1,
      gate: { id: 4, kind: "decide_tie", status: "pending", options: [{ action: "approve", winner: "a" }, { action: "approve", winner: "b" }] }
    };
    const spec = gateNotificationSpec(gateFromRead(gs, null)!);
    const pickB = spec.actions.find((a) => a.winner === "b")!;
    const res = resolveGateCall(pickB, { run: "frost" });

    const client = fakeClient();
    await dispatch(client, res);
    expect(client.gateApprove).toHaveBeenCalledWith({ run: "frost", winner: "b", feedback: undefined });
  });

  it("budget gate + Raise → client.budgetRaise({run,toUsd})", async () => {
    const gs: GateShow = { schemaVersion: 1, run: "frost", id: 1, gate: { id: 9, kind: "budget_exceeded", status: "pending" } };
    const budget: BudgetShow = { schemaVersion: 1, run: "frost", id: 1, budgetUsd: 5, spent: 6, fracUsed: 120, headroom: null, exceeded: true };
    const spec = gateNotificationSpec(gateFromRead(gs, budget)!);
    const raise = spec.actions.find((a) => a.kind === "raise")!;
    const res = resolveGateCall(raise, { run: "frost", amount: 10 });

    const client = fakeClient();
    await dispatch(client, res);
    expect(client.budgetRaise).toHaveBeenCalledWith({ run: "frost", toUsd: 10 });
  });
});

describe("gateStillPending — stale-notification TOCTOU guard (FIX #3)", () => {
  it("true when the still-pending gate id matches the acted-on id", () => {
    const current: GateShow = { schemaVersion: 1, run: "frost", id: 1, gate: { id: 7, kind: "plan_approval", status: "pending" } };
    expect(gateStillPending(7, current)).toBe(true);
  });

  it("false when the run advanced to a DIFFERENT gate id", () => {
    const current: GateShow = { schemaVersion: 1, run: "frost", id: 1, gate: { id: 8, kind: "decide_tie", status: "pending" } };
    expect(gateStillPending(7, current)).toBe(false);
  });

  it("false when no gate is pending now", () => {
    const current: GateShow = { schemaVersion: 1, run: "frost", id: 1, gate: null };
    expect(gateStillPending(7, current)).toBe(false);
    expect(gateStillPending(7, null)).toBe(false);
  });
});

describe("dispatchResolution → re-spawns the orchestrate child on a gate-clearing action", () => {
  it("resolutionClearsGate is true for the 3 gate-clearing methods, false for openReport/stop", () => {
    expect(resolutionClearsGate("gateApprove")).toBe(true);
    expect(resolutionClearsGate("gateReject")).toBe(true);
    expect(resolutionClearsGate("budgetRaise")).toBe(true);
    expect(resolutionClearsGate("openReport")).toBe(false);
    expect(resolutionClearsGate("stop")).toBe(false);
  });

  it("approve / reject / budgetRaise each invoke resume exactly once", async () => {
    for (const res of [
      { method: "gateApprove", opts: { run: "frost" } },
      { method: "gateReject", opts: { run: "frost", feedback: "no" } },
      { method: "budgetRaise", opts: { run: "frost", toUsd: 10 } }
    ] as GateResolution[]) {
      const resume = vi.fn();
      await dispatch(fakeClient(), res, resume);
      expect(resume).toHaveBeenCalledTimes(1);
      expect(resume).toHaveBeenCalledWith("frost");
    }
  });

  it("openReport and stop do NOT invoke resume", async () => {
    for (const res of [{ method: "openReport" }, { method: "stop" }] as GateResolution[]) {
      const resume = vi.fn();
      await dispatch(fakeClient(), res, resume);
      expect(resume).not.toHaveBeenCalled();
    }
  });
});

describe("gate 'stop' action → honest cancel reporting (FIX E)", () => {
  // Mirrors dispatchResolution's stop case (src/gates.ts) minus vscode: it now
  // AWAITS deps.stop (which returns a CancelOutcome) and routes through
  // cancelRunMessage — never a fire-and-forget "stopped driving".
  async function dispatchStop(stop: (r: string) => Promise<CancelOutcome>) {
    const outcome = await stop("frost");
    return cancelRunMessage("frost", outcome);
  }

  it("awaits stop and reports info ONLY when the engine confirmed the stop", async () => {
    const stop = vi.fn().mockResolvedValue({ engineStopped: true, killedChild: true });
    const m = await dispatchStop(stop);
    expect(stop).toHaveBeenCalledWith("frost");
    expect(m.kind).toBe("info");
    expect(m.text).toContain("terminally stopped");
  });

  it("reports an ERROR (not a blind success) when the engine stop FAILED", async () => {
    const stop = vi.fn().mockResolvedValue({ engineStopped: false, killedChild: true, error: "boom" });
    const m = await dispatchStop(stop);
    expect(m.kind).toBe("error");
    expect(m.text).toContain("may resume");
    expect(m.text).toContain("boom");
  });
});
