/**
 * Gate-resolution wiring — a pending gate model, once a button is chosen,
 * dispatches the RIGHT EngineClient call. The client is faked (no engine spawn);
 * we assert the method + args reaching it. Mirrors the vscode gate UX's
 * dispatchResolution path without needing vscode.
 */
import { describe, expect, it, vi } from "vitest";

import { gateFromRead } from "../src/viewmodels/model.js";
import { gateNotificationSpec, resolveGateCall, type GateResolution } from "../src/viewmodels/gate.js";
import type { GateShow, BudgetShow } from "../src/engine/contract.js";

/** A fake EngineClient capturing gate/budget calls. */
function fakeClient() {
  return {
    gateApprove: vi.fn().mockResolvedValue({ schemaVersion: 1, ok: true, gate: 3, kind: "plan_approval", resolution: "approved", winner: null }),
    gateReject: vi.fn().mockResolvedValue({ schemaVersion: 1, ok: true, gate: 3, kind: "plan_approval", resolution: "rejected", feedback: "no" }),
    budgetRaise: vi.fn().mockResolvedValue({ schemaVersion: 1, ok: true, run: "r", id: 1, budgetUsd: 10, gateCleared: true, resumed: true })
  };
}

/** The same dispatch the vscode layer performs, minus vscode. */
async function dispatch(client: ReturnType<typeof fakeClient>, res: GateResolution): Promise<void> {
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
