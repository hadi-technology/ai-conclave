/**
 * Build-target preparation (the impure half of the repo-safety fix). The pure
 * planner lives in viewmodels/startRun.ts; this creates the chosen target on disk.
 *
 * For a scratch target we make an ISOLATED copy of the workspace repo (a local
 * `git clone --no-hardlinks`), so the fleet's worktrees/branches/commits land in
 * the copy and NEVER touch the user's working tree. Pure Node (no vscode).
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { BuildTargetPlan } from "./viewmodels/startRun.js";

const execFileAsync = promisify(execFile);

/**
 * Ensure the plan's target exists and is ready for the fleet to build in.
 * - explicit: create the dir if missing, use as-is.
 * - scratch: clone the workspace repo into it (isolated copy); if the workspace
 *   isn't a git repo or the clone fails, fall back to an isolated empty dir.
 * Returns the absolute target path.
 */
export async function prepareBuildTarget(plan: BuildTargetPlan, workspaceRoot: string): Promise<string> {
  if (plan.mode === "explicit") {
    if (!existsSync(plan.target)) mkdirSync(plan.target, { recursive: true });
    return plan.target;
  }

  if (existsSync(plan.target)) return plan.target;
  mkdirSync(dirname(plan.target), { recursive: true });

  if (existsSync(join(workspaceRoot, ".git"))) {
    try {
      // --no-hardlinks: a full, physically-independent copy of the object store —
      // the source repo cannot be affected by anything the fleet does in the clone.
      await execFileAsync("git", ["clone", "--no-hardlinks", "--quiet", workspaceRoot, plan.target], {
        timeout: 180000
      });
      return plan.target;
    } catch {
      // Fall through to an isolated empty dir (still off the user's working tree).
    }
  }
  mkdirSync(plan.target, { recursive: true });
  return plan.target;
}
