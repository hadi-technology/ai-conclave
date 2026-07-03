/**
 * Gate UX — turns a pending gate (a pure GateNotificationSpec) into a native
 * notification with action buttons, collects any feedback/amount, and resolves it
 * through the EngineClient. The decision surface (which buttons, which client
 * call) is pure and unit-tested; this file is only the vscode plumbing.
 */
import * as vscode from "vscode";

import type { EngineClient } from "./engine/client.js";
import type { GateVM } from "./viewmodels/model.js";
import {
  gateNotificationSpec,
  resolveGateCall,
  type GateActionSpec,
  type GateResolution
} from "./viewmodels/gate.js";

export interface GateUxDeps {
  client: EngineClient;
  runRef: string;
  log: (line: string) => void;
  /** Called for an openReport resolution. */
  openReport: (runRef: string) => Promise<void>;
  /** Called for a stop resolution (tears down orchestrate + watch). */
  stop: (runRef: string) => void;
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

  await runGateAction(action, deps);
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

async function runGateAction(action: GateActionSpec, deps: GateUxDeps): Promise<void> {
  const inputs = await collectInputs(action, deps.runRef);
  if (inputs === null) return; // cancelled

  let resolution: GateResolution;
  try {
    resolution = resolveGateCall(action, { run: deps.runRef, feedback: inputs.feedback, amount: inputs.amount });
  } catch (err) {
    vscode.window.showErrorMessage(`Conclave: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  await dispatchResolution(resolution, deps);
}

/** Dispatch a resolved gate call to the engine client. Exported for reuse/tests. */
export async function dispatchResolution(resolution: GateResolution, deps: GateUxDeps): Promise<void> {
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
    case "stop":
      deps.stop(deps.runRef);
      vscode.window.showInformationMessage(`Conclave: stopped driving "${deps.runRef}".`);
      break;
  }
}
