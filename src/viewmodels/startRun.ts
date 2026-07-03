/**
 * Start-run view-model — pure functions that turn the guided-flow inputs into
 * `run start` args and the preflight-confirmation text. Unit-testable without
 * vscode. The vscode layer (src/startRunFlow.ts) only collects the inputs.
 */
import { join, resolve } from "node:path";

import type { StartRunOptions } from "../engine/client.js";

export interface StartRunInputs {
  goal: string;
  criteria: string;
  /** comma-separated seats. */
  seats: string;
  domain: string;
  approval: string;
  routing: string;
  budgetUsd: number | null;
  /** full-auto: skip the spend-confirmation gate (explicit opt-in). */
  fullAuto: boolean;
}

export interface StartRunValidation {
  ok: boolean;
  errors: string[];
}

export function validateStartRunInputs(inputs: Partial<StartRunInputs>): StartRunValidation {
  const errors: string[] = [];
  if (!inputs.goal || !inputs.goal.trim()) errors.push("A goal is required.");
  const seatList = seatArray(inputs.seats ?? "");
  if (seatList.length === 0) errors.push("At least one seat is required.");
  if (inputs.budgetUsd != null && (!Number.isFinite(inputs.budgetUsd) || inputs.budgetUsd <= 0)) {
    errors.push("Budget must be a positive number (or unset).");
  }
  return { ok: errors.length === 0, errors };
}

export function seatArray(seats: string): string[] {
  return seats
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build the `run start` options. `run start` requires acceptance criteria, so a
 * blank criteria is defaulted to a neutral, explicit sentinel rather than omitted
 * (omitting it makes the engine reject the command).
 */
export function buildStartRunArgs(inputs: StartRunInputs): StartRunOptions {
  return {
    problem: inputs.goal.trim(),
    criteria: inputs.criteria.trim() || "Meets the stated goal.",
    seats: seatArray(inputs.seats).join(","),
    domain: inputs.domain,
    approval: inputs.approval,
    routing: inputs.routing,
    budgetUsd: inputs.budgetUsd
  };
}

// ── Build-target safety (spend + repo safety) ────────────────────────────────
//
// Driving a run with execution makes the engine create git worktrees, branches,
// and commits under `--target`. That must NEVER default to the user's live
// workspace root. This planner is pure (path math only, no IO) so it is testable;
// the actual scratch-clone creation is the impure `prepareBuildTarget`.

export interface BuildTargetPlan {
  /** Absolute path the fleet will build in (the engine's `--target`). */
  target: string;
  /** "explicit" = the user's conclave.targetDir; "scratch" = an isolated per-run clone. */
  mode: "explicit" | "scratch";
  /** True only when the explicit target IS the live workspace repo root — warn loudly. */
  warnLiveRepo: boolean;
}

/**
 * Decide where the fleet builds. Order: (a) a configured targetDir (explicit);
 * (b) otherwise a per-run isolated scratch dir under `scratchRoot` — NEVER the
 * workspace root. `runLabel` names the scratch dir (caller supplies a unique,
 * side-effect-free label so this stays pure).
 */
export function planBuildTarget(opts: {
  configuredTargetDir: string;
  workspaceRoot: string;
  scratchRoot: string;
  runLabel: string;
}): BuildTargetPlan {
  const configured = opts.configuredTargetDir.trim();
  if (configured) {
    const target = resolve(configured);
    return { target, mode: "explicit", warnLiveRepo: target === resolve(opts.workspaceRoot) };
  }
  const safe = opts.runLabel.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
  return { target: join(resolve(opts.scratchRoot), `build-${safe}`), mode: "scratch", warnLiveRepo: false };
}

/** The preflight confirmation text — shown before any spend begins. Names the
 *  build target explicitly so the user always knows where the work lands. */
export function preflightText(inputs: StartRunInputs, plan?: BuildTargetPlan): string {
  const seats = seatArray(inputs.seats);
  const budget = inputs.budgetUsd != null ? `$${inputs.budgetUsd.toFixed(2)}` : "no ceiling";
  const auto = inputs.fullAuto ? "full-auto (no gate stops)" : `approval: ${inputs.approval}`;
  const parts = [`Start run with ${seats.length} seat(s) [${seats.join(", ")}], budget ${budget}, ${auto}.`];
  if (plan) {
    parts.push(
      `Fleet will build in: ${plan.target}${plan.mode === "scratch" ? " (isolated scratch copy of your repo)" : ""}.`
    );
    if (plan.warnLiveRepo) {
      parts.push(
        "WARNING: that is your LIVE workspace repo — the fleet will create git worktrees, branches, and commits there."
      );
    }
  }
  parts.push("This spends real money/quota on your model subscriptions. Continue?");
  return parts.join(" ");
}

/**
 * Whether the flow must show an explicit preflight confirm before spending.
 * Always true unless the user explicitly chose full-auto.
 */
export function requiresPreflightConfirm(inputs: StartRunInputs): boolean {
  return !inputs.fullAuto;
}
