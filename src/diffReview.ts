/**
 * Native diff review — the vscode shell (E4, items 3 & 3b). Thin GUI over the
 * pure src/viewmodels/diffref.ts resolver: pick a unit (or the integration
 * result), compute the git refs, materialize both sides from the build target,
 * and open VS Code's native diff (`vscode.diff`).
 *
 * The build target is a git repo the fleet committed into (E2's scratch clone).
 * Reading its committed blobs via `git show` is reading the run's produced
 * work-product — a legitimate artifact — never the engine store. Run STATE
 * (units, commits, merges) still comes from the engine client's `report --json`.
 */
import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import type { ConclaveContext } from "./extension.js";
import { EngineError } from "./engine/errors.js";
import type { Report } from "./engine/contract.js";
import {
  resolveUnitDiffRefs,
  resolveIntegrationDiffRefs,
  gitShowArgs,
  gitDiffNameOnlyArgs,
  gitRevParseArgs,
  parseNameOnly,
  type DiffRefs
} from "./viewmodels/diffref.js";
import { resolveBuildTarget } from "./viewmodels/findings.js";

const execFileAsync = promisify(execFile);

/** Resolve the run's produced-code build target from a PROVENANCE-CORRECT source:
 *  the session `targets` map OR the engine-reported target/workingDir (schema 2).
 *  Refuses (throws) when neither is available — never falls back to the workspace
 *  root, which could point git at an arbitrary same-named tree. */
function requireBuildTarget(
  ctx: ConclaveContext,
  run: string,
  contract: { target?: string | null; workingDir?: string | null }
): string {
  const cwd = resolveBuildTarget(ctx.knownBuildTargetFor(run), contract);
  if (!cwd) {
    throw new EngineError(
      "build_target_unknown",
      `Conclave doesn't know the build target for "${run}"`,
      "Drive this run from here (or set conclave.targetDir) so its produced code resolves against the real build tree — not an arbitrary same-named path."
    );
  }
  return cwd;
}

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/** Materialize `git show <ref>:<file>` to a temp file; empty content if the path
 *  didn't exist at that ref (added/deleted files → one empty side). */
async function materialize(cwd: string, ref: string, file: string, dir: string, tag: string): Promise<vscode.Uri> {
  const res = await git(cwd, gitShowArgs(ref, file));
  const safe = `${tag}-${basename(file)}`;
  const out = join(dir, safe);
  await writeFile(out, res.ok ? res.stdout : "");
  return vscode.Uri.file(out);
}

/** Resolve a base ref for the integration diff: prefer origin/HEAD, else main/master, else first commit. */
async function resolveIntegrationBase(cwd: string): Promise<string> {
  for (const cand of ["origin/HEAD", "main", "master"]) {
    if ((await git(cwd, gitRevParseArgs(cand))).ok) return cand;
  }
  // Fall back to the repo's root commit so a diff is always possible.
  const root = await git(cwd, ["rev-list", "--max-parents=0", "HEAD"]);
  return root.ok ? root.stdout.trim().split("\n")[0] : "HEAD";
}

/** Open a native diff for the given refs, letting the user pick which file when several changed. */
async function openDiffForRefs(ctx: ConclaveContext, cwd: string, refs: DiffRefs): Promise<void> {
  if (!(await git(cwd, gitRevParseArgs(refs.right)).then((r) => r.ok))) {
    throw new EngineError(
      "diff_ref_missing",
      `The ref "${refs.right}" isn't in the build target's git history`,
      "This run may not have been built in this window (Conclave only knows the target of runs it drove). Drive the run from here, or set conclave.targetDir."
    );
  }
  const files = parseNameOnly((await git(cwd, gitDiffNameOnlyArgs(refs.left, refs.right))).stdout);
  if (files.length === 0) {
    vscode.window.showInformationMessage(`Conclave: ${refs.label} — no file changes between ${refs.left} and ${refs.right}.`);
    return;
  }
  let file = files[0];
  if (files.length > 1) {
    const pick = await vscode.window.showQuickPick(files, {
      placeHolder: `${refs.label} — ${files.length} files changed; pick one to diff`
    });
    if (!pick) return;
    file = pick;
  }
  const dir = await mkdtemp(join(tmpdir(), "conclave-diff-"));
  const [left, right] = await Promise.all([
    materialize(cwd, refs.left, file, dir, "base"),
    materialize(cwd, refs.right, file, dir, "head")
  ]);
  await vscode.commands.executeCommand("vscode.diff", left, right, `${refs.label} — ${file}`);
  ctx.output.appendLine(`[diff] ${refs.label}: ${file} (${refs.left} ↔ ${refs.right}) in ${cwd}`);
}

/** Command: review a work unit's committed change as a native diff. */
export async function reviewUnit(ctx: ConclaveContext, run: string, unitSeq?: number): Promise<void> {
  const client = await ctx.resolveClient();
  const report = await client.report(run);
  const cwd = requireBuildTarget(ctx, run, report);

  const committed = report.units.filter((u) => u.commit);
  if (committed.length === 0) {
    vscode.window.showInformationMessage(`Conclave: no committed units to diff in "${run}" yet.`);
    return;
  }
  let unit = unitSeq != null ? committed.find((u) => u.seq === unitSeq) : undefined;
  if (!unit) {
    const pick = await vscode.window.showQuickPick(
      committed.map((u) => ({
        label: `unit ${u.seq}: ${u.title}`,
        description: `${u.commit} · ${u.status} · QA ${u.qa}`,
        unit: u
      })),
      { placeHolder: `Review which unit's change in "${run}"?` }
    );
    if (!pick) return;
    unit = pick.unit;
  }
  const refs = resolveUnitDiffRefs(unit);
  if (!refs) {
    vscode.window.showInformationMessage(`Conclave: unit ${unit.seq} has no commit to diff.`);
    return;
  }
  await openDiffForRefs(ctx, cwd, refs);
}

/** Command (3b): open the run's produced integration diff — one-click "see what the fleet built". */
export async function openIntegrationDiff(ctx: ConclaveContext, run: string): Promise<void> {
  const client = await ctx.resolveClient();
  const report: Report = await client.report(run);
  const cwd = requireBuildTarget(ctx, run, report);
  const base = await resolveIntegrationBase(cwd);
  const refs = resolveIntegrationDiffRefs(report.merges, base);
  if (!refs) {
    vscode.window.showInformationMessage(
      `Conclave: "${run}" has no integration merge yet — nothing to diff. Review individual units instead.`
    );
    return;
  }
  await openDiffForRefs(ctx, cwd, refs);
}

/** Command (3b): reveal the build target / integration branch in the OS/SCM. */
export async function revealBuildTarget(ctx: ConclaveContext, run: string): Promise<void> {
  // Resolve provenance-correctly: session target OR the engine-reported
  // target/workingDir (schema 2). No workspace-root fallback.
  const client = await ctx.resolveClient();
  const status = await client.runStatus(run).catch(() => null);
  const cwd = requireBuildTarget(ctx, run, status ?? {});
  const uri = vscode.Uri.file(cwd);
  // Open the target folder in the OS file manager; also log the branch for SCM use.
  const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  ctx.output.appendLine(`[diff] build target for "${run}": ${cwd} (branch ${branch || "?"})`);
  await vscode.commands.executeCommand("revealFileInOS", uri);
}
