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
