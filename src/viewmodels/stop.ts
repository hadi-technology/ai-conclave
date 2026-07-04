/**
 * Stop-vs-detach decision logic (pure). Two clearly distinct user actions:
 *
 *   • CANCEL the run  — engine-side terminal stop (`collab run stop`, so a resume
 *     never re-drives it) PLUS SIGTERM the managed orchestrate child. The live
 *     viewer is left attached so the user can watch the run wind down to its
 *     stopped state.
 *   • STOP WATCHING   — detach the live viewer only. The run keeps running (and,
 *     if we're driving it, keeps being driven).
 *
 * Keeping this pure means the exact "what do we tear down" decision is unit-tested
 * without spawning anything. The shell (extension.ts) executes the plan.
 */

/** What the extension currently holds locally for a run. */
export interface LocalRunState {
  /** A managed `collab orchestrate` child is driving this run. */
  driving: boolean;
  /** A live `collab watch` viewer is attached to this run. */
  watching: boolean;
}

/** The concrete teardown steps the shell must perform. */
export interface StopPlan {
  /** Call `collab run stop` to terminally cancel the run engine-side. */
  engineStop: boolean;
  /** SIGTERM the managed orchestrate child (only if we're driving). */
  killOrchestrate: boolean;
  /** Detach the live watch viewer. */
  detachWatch: boolean;
}

/**
 * CANCEL: terminally stop the run. Always asks the engine to stop it (idempotent —
 * safe even if we weren't driving, so an attached-only run can still be cancelled).
 * Kills the orchestrate child only when we're actually driving. Leaves the viewer
 * attached (distinct from "stop watching").
 */
export function planCancelRun(state: LocalRunState): StopPlan {
  return {
    engineStop: true,
    killOrchestrate: state.driving,
    detachWatch: false
  };
}

/**
 * STOP WATCHING: detach the viewer only. Never touches the engine or the driving
 * child — the run is unaffected.
 */
export function planStopWatching(state: LocalRunState): StopPlan {
  return {
    engineStop: false,
    killOrchestrate: false,
    detachWatch: state.watching
  };
}

/** The outcome of executing a cancel plan (what actually happened). */
export interface CancelOutcome {
  /** The engine confirmed the terminal stop (`collab run stop` succeeded). */
  engineStopped: boolean;
  /** Present when the engine stop was ATTEMPTED but failed — the error message. */
  error?: string;
  /** The managed orchestrate child was actually SIGTERM'd. */
  killedChild: boolean;
}

/** A user-facing message + its severity, chosen purely from the cancel outcome. */
export interface CancelMessage {
  kind: "info" | "error";
  text: string;
}

/**
 * Pick the honest cancel message. Success ("terminally stopped, won't resume") is
 * shown ONLY when the engine actually confirmed the stop. If the engine stop failed,
 * surface an ERROR — and if the local driver was still killed, say so AND warn the run
 * may resume (the engine still holds it resumable). Keeping this pure means the
 * message-selection is unit-tested without vscode.
 */
export function cancelRunMessage(run: string, outcome: CancelOutcome): CancelMessage {
  if (outcome.engineStopped) {
    return {
      kind: "info",
      text: `Conclave: stopped "${run}" — engine marked it terminally stopped (won't resume)${
        outcome.killedChild ? "; driving child terminated" : ""
      }.`
    };
  }
  const detail = outcome.error ? ` (${outcome.error})` : "";
  if (outcome.killedChild) {
    return {
      kind: "error",
      text: `Conclave: local driver for "${run}" was terminated, but the engine stop FAILED${detail} — the run may resume. Retry Stop.`
    };
  }
  return {
    kind: "error",
    text: `Conclave: failed to stop "${run}"${detail}. The run was not stopped — retry.`
  };
}
