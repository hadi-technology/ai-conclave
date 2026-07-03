/**
 * QA findings — the vscode shell (E4, items 1 & 2). Thin GUI over the pure
 * src/viewmodels/findings.ts descriptors:
 *  - a DiagnosticCollection populated from a run's QA findings (Problems panel +
 *    inline squiggles in the build-target files), refreshed as findings change;
 *  - a QuickPick of findings whose selection jumps to the exact file:line via
 *    showTextDocument + Selection.
 *
 * File paths resolve against the run's BUILD TARGET (the scratch clone the fleet
 * built in), which the extension tracks from E2's build-target resolution — NOT
 * the user's workspace (unless they coincide). All RUN STATE still comes via the
 * engine client's `--json` reads; only the produced work-product code is read
 * off disk.
 */
import * as vscode from "vscode";

import type { ConclaveContext } from "./extension.js";
import { EngineError } from "./engine/errors.js";
import type { QaFinding } from "./engine/contract.js";
import {
  findingLocation,
  findingsToDiagnostics,
  findingMessage,
  navigableTarget,
  resolveBuildTarget,
  type FindingSeverity
} from "./viewmodels/findings.js";

function toVsSeverity(sev: FindingSeverity): vscode.DiagnosticSeverity {
  switch (sev) {
    case "error":
      return vscode.DiagnosticSeverity.Error;
    case "warning":
      return vscode.DiagnosticSeverity.Warning;
    default:
      return vscode.DiagnosticSeverity.Information;
  }
}

/** Owns the DiagnosticCollection and the findings jump commands for a run. */
export class FindingsManager {
  private readonly collection: vscode.DiagnosticCollection;

  constructor(private readonly ctx: ConclaveContext) {
    this.collection = vscode.languages.createDiagnosticCollection("conclave-qa");
  }

  dispose(): void {
    this.collection.dispose();
  }

  /**
   * Rebuild diagnostics for a run from its QA findings. Cross-QA findings with a
   * recoverable file:line become native diagnostics in the target files. Findings
   * without a location can't be squiggles (contract gap) — reported once so the
   * user knows they exist but aren't navigable.
   */
  async refresh(run: string): Promise<void> {
    this.collection.clear();
    const client = await this.ctx.resolveClient();
    const report = await client.report(run);
    // Only squiggle files in a PROVENANCE-KNOWN target: the run driven this session
    // OR the engine-reported target/workingDir (schema 2, authoritative even for
    // attached runs). Squiggling a fallback workspace tree could mark the wrong
    // same-named file, so we refuse when neither is available.
    const nav = navigableTarget(resolveBuildTarget(this.ctx.knownBuildTargetFor(run), report));
    if (!nav.ok) {
      this.ctx.output.appendLine(
        `[findings] "${run}": build target not known (no session target and none reported by the engine) — diagnostics suppressed (would risk wrong-tree squiggles).`
      );
      return;
    }
    const targetRoot = nav.target;

    const { byFile, unlocated } = findingsToDiagnostics(report.qaFindings, targetRoot);
    for (const [fsPath, descs] of byFile) {
      const uri = vscode.Uri.file(fsPath);
      const diagnostics = descs.map((d) => {
        const lineIdx = Math.max(0, d.line - 1);
        const range = new vscode.Range(lineIdx, 0, lineIdx, Number.MAX_SAFE_INTEGER);
        const diag = new vscode.Diagnostic(range, d.message, toVsSeverity(d.severity));
        diag.source = `Conclave · ${d.source}`;
        return diag;
      });
      this.collection.set(uri, diagnostics);
    }

    const located = report.qaFindings.length - unlocated;
    this.ctx.output.appendLine(
      `[findings] "${run}": ${located} located → Problems panel, ${unlocated} with no cited file:line (the reviewer named no path:line — nothing to squiggle).`
    );
  }

  /** Auto-refresh the currently-active run (best-effort; used on bus change). */
  async refreshActive(run: string | null): Promise<void> {
    if (!run) return;
    try {
      await this.refresh(run);
    } catch (err) {
      this.ctx.output.appendLine(`[findings] refresh skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** QuickPick every finding; selecting one jumps to its file:line (or explains why not). */
  async showFindings(run: string): Promise<void> {
    const client = await this.ctx.resolveClient();
    const report = await client.report(run);
    const nav = navigableTarget(resolveBuildTarget(this.ctx.knownBuildTargetFor(run), report));
    if (!nav.ok) {
      throw new EngineError("finding_target_unknown", nav.reason, nav.hint);
    }
    const targetRoot = nav.target;
    if (report.qaFindings.length === 0) {
      vscode.window.showInformationMessage(`Conclave: no QA findings for "${run}" yet.`);
      return;
    }
    await this.refresh(run); // keep Problems panel in sync when the user opens the list

    const items = report.qaFindings.map((f) => {
      const loc = findingLocation(f, targetRoot);
      return {
        label: `$(${f.verdict === "pass" ? "pass" : "warning"}) unit ${f.unitSeq} · ${f.severity} · ${f.reviewer}`,
        description: loc ? vscode.workspace.asRelativePath(loc.fsPath) + `:${loc.line}` : "(no cited file:line — not navigable)",
        detail: findingMessage(f),
        finding: f,
        loc
      };
    });
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: `QA findings for "${run}" — pick one to jump to its file:line`,
      matchOnDescription: true,
      matchOnDetail: true
    });
    if (!pick) return;
    if (!pick.loc) {
      vscode.window.showWarningMessage(
        `Conclave: that finding has no cited file:line (the reviewer named no path:line, so there's nowhere to jump).`
      );
      return;
    }
    await this.jumpTo(pick.finding, targetRoot);
  }

  /** Open the finding's file at its line, selecting the line. */
  async jumpTo(finding: QaFinding, targetRoot: string): Promise<void> {
    const loc = findingLocation(finding, targetRoot);
    if (!loc) {
      vscode.window.showWarningMessage("Conclave: this finding has no recoverable file:line.");
      return;
    }
    const uri = vscode.Uri.file(loc.fsPath);
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      throw new EngineError(
        "finding_file_missing",
        `Can't open ${loc.fsPath}`,
        "The file is resolved against the run's build target. If this run wasn't started in this window, Conclave may not know its target — set conclave.targetDir or drive the run from here."
      );
    }
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    const lineIdx = Math.max(0, Math.min(loc.line - 1, doc.lineCount - 1));
    const pos = new vscode.Position(lineIdx, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    this.ctx.output.appendLine(`[findings] jumped to ${loc.fsPath}:${loc.line}`);
  }
}
