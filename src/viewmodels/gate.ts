/**
 * Gate model — pure, testable transform: a GateVM (normalized from snapshot OR
 * `gate show`) → a notification spec the vscode layer renders, plus a resolver
 * that turns the human's choice into the exact EngineClient call to make.
 *
 * This is the headline of E2: gate handling as native UX. Keeping the transform
 * pure means the whole decision surface is unit-tested without vscode.
 */
import type { GateVM } from "./model.js";

/** The kind of resolution action a button triggers. */
export type GateActionKind = "approve" | "reject" | "winner" | "raise" | "stop" | "openReport";

export interface GateActionSpec {
  /** Stable id, used to key the button and route the resolution. */
  id: string;
  /** Button label shown in the notification / quick pick. */
  label: string;
  kind: GateActionKind;
  /** For a winner action, the seat it selects. */
  winner?: string;
  /** Whether choosing this action must first collect a free-text feedback string. */
  needsFeedback?: boolean;
  /** Whether choosing this action must first collect a number (budget raise). */
  needsAmount?: boolean;
  /** Whether this is a destructive action (styled as a warning). */
  destructive?: boolean;
}

export interface GateNotificationSpec {
  gateId: number;
  /** "info" | "warning" — budget/validation/dispute are warnings. */
  severity: "info" | "warning";
  message: string;
  detail: string;
  actions: GateActionSpec[];
}

/** Build the native notification spec for a pending gate. Pure. */
export function gateNotificationSpec(gate: GateVM): GateNotificationSpec {
  switch (gate.kind) {
    case "plan_approval": {
      const critiques =
        gate.critiqueCount != null ? `${gate.critiqueCount} critique finding(s)` : "no critiques";
      return {
        gateId: gate.gateId,
        severity: "info",
        message: `Plan ready for approval (gate #${gate.gateId})`,
        detail: [gate.body.join(" · "), critiques].filter(Boolean).join(" — "),
        actions: [
          { id: "approve", label: "Approve", kind: "approve" },
          { id: "reject", label: "Reject…", kind: "reject", needsFeedback: true, destructive: true }
        ]
      };
    }
    case "decide_tie": {
      const winners = gate.winners.length ? gate.winners : [];
      return {
        gateId: gate.gateId,
        severity: "info",
        message: `Tie-break needed (gate #${gate.gateId})`,
        detail: gate.body.join(" · ") || "Pick the winning seat.",
        actions: winners.map((w) => ({
          id: `winner:${w}`,
          label: `Pick ${w}`,
          kind: "winner" as const,
          winner: w
        }))
      };
    }
    case "budget_exceeded": {
      const b = gate.budget;
      const spent = b?.spent != null ? `$${b.spent.toFixed(4)}` : "?";
      const cap = b?.budgetUsd != null ? `$${b.budgetUsd.toFixed(2)}` : "?";
      return {
        gateId: gate.gateId,
        severity: "warning",
        message: `Budget exceeded (gate #${gate.gateId})`,
        detail: `Spent ${spent} of ${cap}. Raise the ceiling to continue, or stop.`,
        actions: [
          { id: "raise", label: "Raise budget…", kind: "raise", needsAmount: true },
          { id: "stop", label: "Stop", kind: "stop", destructive: true }
        ]
      };
    }
    case "validate_failed": {
      return {
        gateId: gate.gateId,
        severity: "warning",
        message: `Validation failed (gate #${gate.gateId})`,
        detail: gate.body.join(" · ") || "Orchestrator re-verify failed. Fix, then acknowledge to re-validate.",
        actions: [
          { id: "openReport", label: "Open report", kind: "openReport" },
          { id: "approve", label: "Acknowledge + re-validate", kind: "approve" }
        ]
      };
    }
    case "dispute": {
      return {
        gateId: gate.gateId,
        severity: "warning",
        message: `Dispute raised (gate #${gate.gateId})`,
        detail: gate.body.join(" · ") || "A dispute needs a human decision.",
        actions: [
          { id: "openReport", label: "Open report", kind: "openReport" },
          { id: "approve", label: "Approve", kind: "approve" },
          { id: "reject", label: "Reject…", kind: "reject", needsFeedback: true, destructive: true }
        ]
      };
    }
    default: {
      return {
        gateId: gate.gateId,
        severity: "warning",
        message: `Gate #${gate.gateId} pending (${gate.rawKind})`,
        detail: gate.body.join(" · ") || "A gate needs attention.",
        actions: [
          { id: "approve", label: "Approve", kind: "approve" },
          { id: "reject", label: "Reject…", kind: "reject", needsFeedback: true, destructive: true }
        ]
      };
    }
  }
}

/** A resolved client call: which EngineClient method to invoke and with what. */
export type GateResolution =
  | { method: "gateApprove"; opts: { run?: string; winner?: string; feedback?: string } }
  | { method: "gateReject"; opts: { run: string; feedback: string } }
  | { method: "budgetRaise"; opts: { run?: string; toUsd: number } }
  | { method: "openReport" }
  | { method: "stop" };

/**
 * Whether a resolved gate method CLEARS the pending gate engine-side. When it
 * does, the orchestrate child (which exited idling on the gate) must be
 * re-spawned to continue the run — see OrchestrateController.resume(). The
 * read-only actions (openReport) and the teardown action (stop) do NOT clear a
 * gate, so they must NOT re-spawn.
 */
export function resolutionClearsGate(method: GateResolution["method"]): boolean {
  return method === "gateApprove" || method === "gateReject" || method === "budgetRaise";
}

/**
 * Defensive TOCTOU guard for a stale gate notification. A native notification (or
 * cockpit button) for gate #N can be clicked AFTER the run advanced to gate #N+1 —
 * resolving it would approve/reject the WRONG gate. Given the id the user acted on
 * and a fresh `gate show` read, this returns true ONLY when the engine still reports
 * a pending gate with that exact id. `false` when the gate changed OR none pends now
 * → the caller must refuse the mutation.
 */
export function gateStillPending(
  actedGateId: number,
  current: { gate: { id: number } | null } | null | undefined
): boolean {
  return !!current && !!current.gate && current.gate.id === actedGateId;
}

export interface ResolveInput {
  run: string;
  /** Free-text feedback, when the chosen action needsFeedback. */
  feedback?: string;
  /** Budget amount, when the chosen action needsAmount. */
  amount?: number;
}

/**
 * Turn a chosen gate action into the exact client call. Pure — the vscode layer
 * collects `feedback`/`amount` first, then calls this, then dispatches.
 */
export function resolveGateCall(action: GateActionSpec, input: ResolveInput): GateResolution {
  switch (action.kind) {
    case "approve":
      return { method: "gateApprove", opts: { run: input.run, feedback: input.feedback || undefined } };
    case "winner":
      return {
        method: "gateApprove",
        opts: { run: input.run, winner: action.winner, feedback: input.feedback || undefined }
      };
    case "reject":
      return {
        method: "gateReject",
        opts: { run: input.run, feedback: input.feedback ?? "rejected without feedback" }
      };
    case "raise": {
      if (input.amount == null || !Number.isFinite(input.amount)) {
        throw new Error("budget raise requires a numeric amount");
      }
      return { method: "budgetRaise", opts: { run: input.run, toUsd: input.amount } };
    }
    case "stop":
      return { method: "stop" };
    case "openReport":
      return { method: "openReport" };
  }
}
