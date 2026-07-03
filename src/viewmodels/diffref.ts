/**
 * Native diff review — pure ref/target resolution (E4, item 3).
 *
 * The engine commits per-unit in the build target's worktrees/branches and the
 * `report --json` payload exposes each unit's `commit` (an 8-char sha) plus
 * `merges[]` (integration branch + reconcile commit). From those we can compute
 * the git refs a native diff should show, WITHOUT touching the engine store — the
 * produced code in the build target is a legitimate work-product artifact.
 *
 * These functions are pure (no vscode, no child_process). The vscode shell
 * (src/diffReview.ts) runs git in the target to materialize the two sides and
 * calls `vscode.diff`.
 *
 * Contract note: the run's build-target PATH is not in the JSON contract, so the
 * shell supplies the target it already knows (from E2's build-target resolution).
 */
import type { Report, ReportUnit } from "../engine/contract.js";

/** A resolved pair of git refs to diff, plus a human label + description. */
export interface DiffRefs {
  /** Left/base ref (older side). */
  left: string;
  /** Right/head ref (newer side — the change under review). */
  right: string;
  /** Short label (e.g. "unit 3: add parser"). */
  label: string;
  /** Longer description for the diff title / picker detail. */
  description: string;
}

/**
 * Resolve the diff for a single work unit: its committed change vs its parent
 * (`<commit>^..<commit>`). Returns null when the unit has no commit yet (queued,
 * building, reverted-away) — there is nothing to diff.
 */
export function resolveUnitDiffRefs(unit: Pick<ReportUnit, "seq" | "title" | "commit" | "status">): DiffRefs | null {
  const commit = unit.commit?.trim();
  if (!commit) return null;
  return {
    left: `${commit}^`,
    right: commit,
    label: `unit ${unit.seq}: ${unit.title}`,
    description: `${commit} vs parent · status ${unit.status}`
  };
}

/**
 * Resolve the integration diff: the run's merged/reconciled result vs a base.
 * Prefers a reconcile commit (has an explicit sha); else uses the merge branch
 * tip. `base` is the ref the fleet integrated onto (default "HEAD~" is wrong for a
 * clean merge, so the shell passes the target's base branch or a merge-base).
 * Returns null when the run produced no merges.
 */
export function resolveIntegrationDiffRefs(
  merges: Report["merges"],
  base: string
): DiffRefs | null {
  if (!merges || merges.length === 0) return null;
  // Prefer the last reconciled merge (explicit commit), else the last clean merge.
  const reconciled = [...merges].reverse().find((m) => m.commit);
  const chosen = reconciled ?? merges[merges.length - 1];
  const right = chosen.commit?.trim() || chosen.branch || "HEAD";
  return {
    left: base,
    right,
    label: `integration: ${chosen.branch ?? right}`,
    description: `${chosen.kind} merge — ${right} vs ${base}`
  };
}

/** argv for `git show <ref>:<file>` (materialize one side of a file's diff). */
export function gitShowArgs(ref: string, file: string): string[] {
  return ["show", `${ref}:${file}`];
}

/** argv for `git diff --name-only <left> <right>` (the files a diff touches). */
export function gitDiffNameOnlyArgs(left: string, right: string): string[] {
  return ["diff", "--name-only", left, right];
}

/** argv for `git rev-parse --verify <ref>` (does a ref/commit exist here?). */
export function gitRevParseArgs(ref: string): string[] {
  return ["rev-parse", "--verify", "--quiet", ref];
}

/** Parse `git diff --name-only` stdout into a clean file list. */
export function parseNameOnly(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}
