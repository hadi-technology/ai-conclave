/**
 * Gate UX — turns a pending gate (a pure GateNotificationSpec) into a native
 * notification with action buttons, collects any feedback/amount, and resolves it
 * through the EngineClient. The decision surface (which buttons, which client
 * call) is pure and unit-tested; this file is only the vscode plumbing.
 */
import * as vscode from "vscode";

import type { EngineClient } from "./engine/client.js";
import type { GateVM } from "./viewmodels/model.js";
import { cancelRunMessage, type CancelOutcome } from "./viewmodels/stop.js";
import {
  gateNotificationSpec,
  gateStillPending,
  resolveGateCall,
  resolutionClearsGate,
  type GateActionSpec,
  type GateResolution
} from "./viewmodels/gate.js";

export interface GateUxDeps {
  client: EngineClient;
  runRef: string;
  log: (line: string) => void;
  /** Called for an openReport resolution. */
  openReport: (runRef: string) => Promise<void>;
  /** Called for a stop resolution (engine-side terminal stop + tear down the
   *  orchestrate child). Returns the honest outcome so the UX reports success
   *  ONLY when the engine confirmed it (mirrors the command path's cancelRun). */
  stop: (runRef: string) => Promise<CancelOutcome>;
  /** Re-spawn the orchestrate child after a gate-CLEARING action, so the run
   *  continues (the child exited idling on the gate). A safe no-op for
   *  attached-only runs with no controller. */
  resume?: (runRef: string) => void;
}

/** Present a pending gate natively and resolve the human's choice. */
export async function presentGate(gate: GateVM, deps: GateUxDeps): Promise<void> {
  const spec = gateNotificationSpec(gate);
  const buttons = spec.actions.map((a) => a.label);
  const show =
    spec.severity === "warning"
      ? vscode.window.showWarningMessage
      : vscode.window.showInformationMessage;

  const message = `Conclave: ${spec.message}`;
  const picked = await show(message, { modal: false, detail: spec.detail } as vscode.MessageOptions, ...buttons);
  if (!picked) return; // dismissed

  const action = spec.actions.find((a) => a.label === picked);
  if (!action) return;

  // Thread the gate id THIS notification was built for, so the dispatch can refuse
  // to mutate if the run has since advanced to a different gate (stale-notification
  // TOCTOU — the notification may sit for a while before the user clicks).
  await runGateAction(action, deps, spec.gateId);
}

async function collectInputs(
  action: GateActionSpec,
  runRef: string
): Promise<{ feedback?: string; amount?: number } | null> {
  const out: { feedback?: string; amount?: number } = {};
  if (action.needsFeedback) {
    const fb = await vscode.window.showInputBox({
      title: `Feedback for ${action.label}`,
      prompt: "Why? (recorded on the run; guides the next revision)",
      ignoreFocusOut: true,
      validateInput: (v) => (action.kind === "reject" && !v.trim() ? "Feedback is required to reject." : null)
    });
    if (fb === undefined) return null; // cancelled
    out.feedback = fb.trim();
  }
  if (action.needsAmount) {
    const amt = await vscode.window.showInputBox({
      title: `Raise budget for ${runRef}`,
      prompt: "New total ceiling in USD",
      ignoreFocusOut: true,
      validateInput: (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? null : "Enter a positive dollar amount.";
      }
    });
    if (amt === undefined) return null;
    out.amount = Number(amt);
  }
  return out;
}

async function runGateAction(action: GateActionSpec, deps: GateUxDeps, actedGateId?: number): Promise<void> {
  const inputs = await collectInputs(action, deps.runRef);
  if (inputs === null) return; // cancelled

  let resolution: GateResolution;
  try {
    resolution = resolveGateCall(action, { run: deps.runRef, feedback: inputs.feedback, amount: inputs.amount });
  } catch (err) {
    vscode.window.showErrorMessage(`Conclave: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  await dispatchResolution(resolution, deps, actedGateId);
}

/**
 * Defensive re-check before a mutating gate call: re-read `gate show` and confirm the
 * still-pending gate is the SAME one the user acted on. Refuses (and tells the user to
 * refresh) if the gate changed or none pends now — never blindly mutates a stale gate.
 * Returns true when it is safe to proceed. Only applied to gate-mutating methods.
 */
async function confirmGateFresh(deps: GateUxDeps, actedGateId: number): Promise<boolean> {
  let current;
  try {
    current = await deps.client.gateShow(deps.runRef);
  } catch (err) {
    deps.log(`gate freshness check failed: ${err instanceof Error ? err.message : String(err)}`);
    void vscode.window.showInformationMessage(
      "Conclave: couldn't confirm the gate is still current — refresh and try again."
    );
    return false;
  }
  if (!gateStillPending(actedGateId, current)) {
    void vscode.window.showInformationMessage("Conclave: that gate already changed — refresh and try again.");
    return false;
  }
  return true;
}

/** Dispatch a resolved gate call to the engine client. Exported for reuse/tests.
 *  `actedGateId` is the id the surface (notification/cockpit button) was built for;
 *  when given, a mutating call is guarded by {@link confirmGateFresh} so a stale
 *  surface can't resolve a gate the run has already moved past. */
export async function dispatchResolution(
  resolution: GateResolution,
  deps: GateUxDeps,
  actedGateId?: number
): Promise<void> {
  // Stale-notification guard: for the gate-CLEARING mutations, verify the pending
  // gate id still matches before mutating. Read-only (openReport) / teardown (stop)
  // don't touch a specific gate, so they skip the check.
  if (actedGateId != null && resolutionClearsGate(resolution.method)) {
    if (!(await confirmGateFresh(deps, actedGateId))) return;
  }

  switch (resolution.method) {
    case "gateApprove": {
      const r = await deps.client.gateApprove(resolution.opts);
      deps.log(`gate #${r.gate} ${r.kind} → ${r.resolution}${r.winner ? ` (winner ${r.winner})` : ""}`);
      vscode.window.showInformationMessage(`Conclave: gate #${r.gate} ${r.resolution}.`);
      break;
    }
    case "gateReject": {
      const r = await deps.client.gateReject(resolution.opts);
      deps.log(`gate #${r.gate} ${r.kind} → ${r.resolution}`);
      vscode.window.showInformationMessage(`Conclave: gate #${r.gate} rejected.`);
      break;
    }
    case "budgetRaise": {
      const r = await deps.client.budgetRaise(resolution.opts);
      deps.log(`budget raised to $${r.budgetUsd} (gateCleared=${r.gateCleared}, resumed=${r.resumed})`);
      vscode.window.showInformationMessage(`Conclave: budget raised to $${r.budgetUsd}.`);
      break;
    }
    case "openReport":
      await deps.openReport(deps.runRef);
      break;
    case "stop": {
      // Honest reporting (FIX E): the stop can fail engine-side — surface the same
      // info-or-error message the command path does, never a blind "stopped".
      const outcome = await deps.stop(deps.runRef);
      const m = cancelRunMessage(deps.runRef, outcome);
      if (m.kind === "info") {
        vscode.window.showInformationMessage(m.text);
      } else {
        vscode.window.showErrorMessage(m.text);
      }
      break;
    }
  }

  // A gate-clearing action succeeded above (a client throw would have escaped
  // before here) → re-spawn the orchestrate child so the gated run continues.
  // openReport/stop don't clear a gate, so they never re-spawn.
  if (resolutionClearsGate(resolution.method)) deps.resume?.(deps.runRef);
}
