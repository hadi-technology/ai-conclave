/**
 * Guided Start-a-run flow — a multi-step QuickPick/input sequence that collects
 * goal → criteria → seats → domain → approval → routing → budget → full-auto,
 * then shows a preflight confirmation before any spend, calls `run start`, and
 * kicks the OrchestrateController to actually DRIVE the run.
 *
 * All the non-UI logic (arg building, preflight text, validation) lives in the
 * pure view-model (viewmodels/startRun.ts); this file is only the vscode plumbing.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as vscode from "vscode";

import type { EngineClient } from "./engine/client.js";
import { prepareBuildTarget } from "./buildTarget.js";
import {
  buildStartRunArgs,
  discoverSeats,
  planBuildTarget,
  preflightText,
  requiresPreflightConfirm,
  seatArray,
  validateStartRunInputs,
  type StartRunInputs
} from "./viewmodels/startRun.js";

export interface StartRunFlowResult {
  run: string;
  id: number;
  inputs: StartRunInputs;
  /** Absolute path the fleet will build in (already prepared on disk). */
  buildTarget: string;
}

/** OS-temp root for per-run isolated scratch build clones. */
export function scratchRoot(): string {
  return join(tmpdir(), "conclave-builds");
}

async function pickFromEnum(
  title: string,
  options: string[],
  fallback: string
): Promise<string | undefined> {
  const pick = await vscode.window.showQuickPick(options, { title, placeHolder: fallback });
  return pick;
}

/**
 * Run the guided flow. Returns the started run, or undefined if the user
 * cancelled at any step (including the preflight confirmation).
 */
export async function runStartFlow(
  client: EngineClient,
  cfg: vscode.WorkspaceConfiguration,
  cwd: string
): Promise<StartRunFlowResult | undefined> {
  const goal = await vscode.window.showInputBox({
    title: "Start run (1/7) — goal",
    prompt: "What is the problem to solve?",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? null : "A goal is required.")
  });
  if (goal === undefined) return undefined;

  const criteria = await vscode.window.showInputBox({
    title: "Start run (2/7) — acceptance criteria",
    prompt: "How is 'done' judged? (optional)",
    ignoreFocusOut: true
  });
  if (criteria === undefined) return undefined;

  // Seats: ask the engine which adapters it can load, offer them as a multi-pick,
  // else free text. On any engine error discoverSeats returns [] → free-text path.
  const discovered = await discoverSeats(client);
  const defaultSeats = cfg.get<string>("defaultSeats", "").trim();
  let seats: string;
  if (discovered.length > 0) {
    const preselect = new Set(seatArray(defaultSeats));
    const picks = await vscode.window.showQuickPick(
      discovered.map((s) => ({ label: s, picked: preselect.has(s) })),
      { title: "Start run (3/7) — seats", canPickMany: true, placeHolder: "Choose seats for the fleet" }
    );
    if (!picks) return undefined;
    seats = picks.map((p) => p.label).join(",");
  } else {
    const typed = await vscode.window.showInputBox({
      title: "Start run (3/7) — seats",
      prompt: "Comma-separated seats, e.g. claude,glm,codex",
      value: defaultSeats,
      ignoreFocusOut: true,
      validateInput: (v) => (seatArray(v).length ? null : "At least one seat is required.")
    });
    if (typed === undefined) return undefined;
    seats = typed;
  }

  const domain =
    (await pickFromEnum("Start run (4/7) — domain", ["coding", "writing", "research"], cfg.get<string>("defaultDomain", "coding"))) ??
    undefined;
  if (domain === undefined) return undefined;

  const approval =
    (await pickFromEnum(
      "Start run (5/7) — approval policy",
      ["plan-only", "plan+risky-deliver", "final"],
      cfg.get<string>("defaultApproval", "plan-only")
    )) ?? undefined;
  if (approval === undefined) return undefined;

  const routing =
    (await pickFromEnum(
      "Start run (6/7) — routing",
      ["auto", "usage-aware", "efficiency"],
      cfg.get<string>("defaultRouting", "auto")
    )) ?? undefined;
  if (routing === undefined) return undefined;

  const budgetSetting = cfg.get<number | null>("defaultBudget", null);
  const budgetRaw = await vscode.window.showInputBox({
    title: "Start run (7/7) — budget (USD)",
    prompt: "Spend ceiling in USD. Leave blank for no ceiling.",
    value: budgetSetting != null ? String(budgetSetting) : "",
    ignoreFocusOut: true,
    validateInput: (v) => {
      if (!v.trim()) return null;
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? null : "Enter a positive number, or leave blank.";
    }
  });
  if (budgetRaw === undefined) return undefined;
  const budgetUsd = budgetRaw.trim() ? Number(budgetRaw) : null;

  // Full-auto is an explicit opt-in; default is gated (preflight required).
  const autoPick = await vscode.window.showQuickPick(
    [
      { label: "Gated (recommended)", detail: "Stop at approval gates for your decision.", auto: false },
      { label: "Full-auto", detail: "Drive to completion without gate stops. Spends without further prompts.", auto: true }
    ],
    { title: "Start run — autonomy", placeHolder: "How autonomous should this run be?" }
  );
  if (!autoPick) return undefined;

  const inputs: StartRunInputs = {
    goal,
    criteria,
    seats,
    domain,
    approval,
    routing,
    budgetUsd,
    fullAuto: autoPick.auto
  };

  const validation = validateStartRunInputs(inputs);
  if (!validation.ok) {
    vscode.window.showErrorMessage(`Conclave: ${validation.errors.join(" ")}`);
    return undefined;
  }

  // Resolve where the fleet will BUILD — an isolated scratch clone by default,
  // never the live workspace root. The preflight names it so spend + repo writes
  // are never a surprise.
  const plan = planBuildTarget({
    configuredTargetDir: cfg.get<string>("targetDir", ""),
    workspaceRoot: cwd,
    scratchRoot: scratchRoot(),
    runLabel: `${Date.now()}`
  });

  // Preflight confirmation — spend must not begin without it unless full-auto.
  // Even under full-auto we surface a warning when the target is the live repo.
  const needConfirm = requiresPreflightConfirm(inputs) || plan.warnLiveRepo;
  if (needConfirm) {
    const confirm = await vscode.window.showWarningMessage(preflightText(inputs, plan), { modal: true }, "Start run");
    if (confirm !== "Start run") return undefined;
  }

  const buildTarget = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Conclave: preparing isolated build workspace…" },
    () => prepareBuildTarget(plan, cwd)
  );

  const args = buildStartRunArgs(inputs);
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Conclave: starting run…" },
    () => client.runStart(args)
  );

  return { run: result.run, id: result.id, inputs, buildTarget };
}
