/**
 * Commands — thin wrappers over the engine client and the E2 UX modules. Each
 * resolves a client (which provisions Node ≥25 + engine + schema check), then
 * drives a `--json` command, the watch feed, the guided start-run flow, or the
 * gate UX. Rich rendering lives in the tree views + status bar (src/views.ts);
 * these handlers cover start/drive/stop, reports, and manual gate resolution.
 */
import * as vscode from "vscode";

import type { ConclaveContext } from "./extension.js";
import { EngineError } from "./engine/errors.js";
import type { EngineClient } from "./engine/client.js";
import type { RunSummary } from "./engine/contract.js";
import { runStartFlow } from "./startRunFlow.js";
import { presentGate } from "./gates.js";
import { gateFromRead } from "./viewmodels/model.js";
import { cancelRunMessage } from "./viewmodels/stop.js";

export function registerCommands(context: vscode.ExtensionContext, ctx: ConclaveContext): void {
  const reg = (id: string, fn: (arg?: unknown) => Promise<void>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, (arg?: unknown) => guarded(ctx, () => fn(arg))));

  reg("conclave.startRun", () => startRun(ctx));
  reg("conclave.showStatus", () => showStatus(ctx));
  reg("conclave.openReport", () => openReport(ctx));
  reg("conclave.showLedger", () => showLedger(ctx));
  reg("conclave.approveGate", () => resolveGate(ctx));
  reg("conclave.cancelRun", (arg) => cancelRunCmd(ctx, arg));
  reg("conclave.stopRun", (arg) => stopWatchingCmd(ctx, arg));
  reg("conclave.attachRun", () => attachRun(ctx));
  reg("conclave.openRun", (arg) => openRun(ctx, arg));
  reg("conclave.focusRun", () => focusRun(ctx));
  reg("conclave.driveRun", (arg) => driveRunCmd(ctx, arg));
  reg("conclave.refresh", () => refresh(ctx));
}

/** Wrap a handler: turn EngineError into a friendly message + hint. */
async function guarded(ctx: ConclaveContext, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof CancelledError) return;
    if (err instanceof EngineError) {
      ctx.output.appendLine(`[conclave] error ${err.code}: ${err.toDisplay()}`);
      vscode.window.showErrorMessage(`Conclave: ${err.toDisplay()}`);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      ctx.output.appendLine(`[conclave] unexpected error: ${message}`);
      vscode.window.showErrorMessage(`Conclave: ${message}`);
    }
  }
}

// ── run selection ──────────────────────────────────────────────────────────

async function pickRun(client: EngineClient, placeholder: string): Promise<string> {
  const { runs } = await client.runs();
  if (runs.length === 0) {
    throw new EngineError("no_runs", "There are no runs in this workspace yet", "Start one with 'Conclave: Start run'.");
  }
  if (runs.length === 1) return runs[0].name;

  const ordered = [...runs].sort((a, b) => Number(b.active) - Number(a.active));
  const pick = await vscode.window.showQuickPick(
    ordered.map((r) => ({
      label: r.name,
      description: `#${r.id} · ${r.phase} · ${r.status}`,
      detail: r.problem,
      run: r
    })),
    { placeHolder: placeholder, matchOnDescription: true, matchOnDetail: true }
  );
  if (!pick) throw new CancelledError();
  return (pick.run as RunSummary).name;
}

/** Coerce a command argument (tree node runRef, or undefined) into a run ref. */
function argRunRef(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  if (arg && typeof arg === "object" && typeof (arg as { runRef?: unknown }).runRef === "string") {
    return (arg as { runRef: string }).runRef;
  }
  return undefined;
}

class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

// ── commands ─────────────────────────────────────────────────────────────────

async function startRun(ctx: ConclaveContext): Promise<void> {
  const client = await ctx.resolveClient();
  const cfg = vscode.workspace.getConfiguration("conclave");
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  const started = await runStartFlow(client, cfg, cwd);
  if (!started) return; // cancelled at some step / preflight declined

  ctx.output.appendLine(`[conclave] started run "${started.run}" (#${started.id}), seats ${started.inputs.seats}.`);
  ctx.output.show(true);

  // Actually DRIVE it: focus the run in the views + spawn the orchestrate child,
  // building in the already-prepared isolated target (never the workspace root).
  await ctx.focusRun(started.run);
  await ctx.driveRun(started.run, { fullAuto: started.inputs.fullAuto, target: started.buildTarget });

  vscode.window.showInformationMessage(
    `Conclave: started + driving "${started.run}" (#${started.id}). Watch the sidebar; gates surface as notifications.`
  );
}

async function driveRunCmd(ctx: ConclaveContext, arg: unknown): Promise<void> {
  const client = await ctx.resolveClient();
  const run = argRunRef(arg) ?? (await pickRun(client, "Drive which run?"));
  await ctx.focusRun(run);
  await ctx.driveRun(run);
  vscode.window.showInformationMessage(`Conclave: driving "${run}".`);
}

async function openRun(ctx: ConclaveContext, arg: unknown): Promise<void> {
  const run = argRunRef(arg);
  if (!run) return;
  await ctx.focusRun(run);
}

async function focusRun(ctx: ConclaveContext): Promise<void> {
  const bus = await ctx.ensureBus();
  await vscode.commands.executeCommand("conclave.runsView.focus");
  if (bus.activeRunRef) ctx.output.appendLine(`[conclave] focused run "${bus.activeRunRef}".`);
}

async function refresh(ctx: ConclaveContext): Promise<void> {
  const bus = await ctx.ensureBus();
  await bus.refreshRuns();
}

async function showStatus(ctx: ConclaveContext): Promise<void> {
  const client = await ctx.resolveClient();
  const run = await pickRun(client, "Show status for which run?");
  const s = await client.runStatus(run);
  const lines: string[] = [];
  lines.push(`Run: ${s.run} (#${s.id})`);
  lines.push(`Phase: ${s.phase}   Status: ${s.status}`);
  lines.push(`Problem: ${s.problem}`);
  if (s.criteria) lines.push(`Criteria: ${s.criteria}`);
  lines.push(`Routing: ${s.routing.mode} (effective: ${s.routing.effective})`);
  lines.push("Seats:");
  for (const seat of s.seats) {
    lines.push(`  · ${seat.seat}: ${seat.status}, headroom ${seat.headroom}${seat.capped ? " (capped)" : ""}`);
  }
  lines.push(s.gate ? `Gate: #${s.gate.id} ${s.gate.kind} (${s.gate.status})` : "Gate: none pending");
  writeBlock(ctx, `Status — ${s.run}`, lines);
}

async function openReport(ctx: ConclaveContext): Promise<void> {
  const client = await ctx.resolveClient();
  const run = await pickRun(client, "Open report for which run?");
  await openReportForRun(ctx, run);
}

/** Open a run's structured report as a Markdown document. Reused by the gate UX. */
export async function openReportForRun(ctx: ConclaveContext, run: string): Promise<void> {
  const client = await ctx.resolveClient();
  const r = await client.report(run);
  const md: string[] = [];
  md.push(`# Conclave report — ${r.run} (#${r.id})`, "");
  md.push(`**Problem:** ${r.problem}`, "");
  md.push(`**Phase:** ${r.phase}  ·  **Status:** ${r.status}  ·  **Seats:** ${r.seats.join(", ")}`, "");
  md.push(`**Total cost:** $${r.totalCost.toFixed(4)}`, "");
  md.push("## Units", "");
  if (r.units.length === 0) {
    md.push("_No work units yet._", "");
  } else {
    md.push("| # | Title | Tier | Author | Reviewer | Status | QA | Commit |");
    md.push("|---|-------|------|--------|----------|--------|----|--------|");
    for (const u of r.units) {
      md.push(`| ${u.seq} | ${u.title} | ${u.tier} | ${u.author} | ${u.reviewer} | ${u.status} | ${u.qa} | ${u.commit ?? "—"} |`);
    }
    md.push("");
  }
  md.push("## QA findings", "");
  if (r.qaFindings.length === 0) {
    md.push("_None._", "");
  } else {
    for (const f of r.qaFindings) {
      md.push(`- **unit ${f.unitSeq}** [${f.severity}] ${f.verdict} — ${f.claim} (reviewer ${f.reviewer})`);
    }
    md.push("");
  }
  const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: md.join("\n") });
  await vscode.window.showTextDocument(doc, { preview: false });
  ctx.output.appendLine(`[conclave] opened report for "${r.run}" (#${r.id}).`);
}

async function showLedger(ctx: ConclaveContext): Promise<void> {
  const client = await ctx.resolveClient();
  const run = await pickRun(client, "Show ledger for which run?");
  const l = await client.ledger(run);
  const lines: string[] = [];
  lines.push(`Ledger — ${l.run} (#${l.id})`);
  lines.push(`Total: $${l.total.toFixed(4)}  (exact $${l.exact.toFixed(4)}, estimated $${l.estimated.toFixed(4)})`);
  if (l.budgetUsd != null) {
    const frac = l.fracUsed != null ? ` (${Math.round(l.fracUsed * 100)}% used)` : "";
    lines.push(`Budget: $${l.budgetUsd.toFixed(2)}${frac}`);
  } else {
    lines.push("Budget: none set");
  }
  lines.push("Per seat/model:");
  if (l.perSeatModel.length === 0) {
    lines.push("  (no spend yet)");
  } else {
    for (const row of l.perSeatModel) {
      lines.push(`  · ${row.seat} [${row.model}] ${row.turns} turns, $${row.cost.toFixed(4)} (${row.mode})`);
    }
  }
  writeBlock(ctx, `Ledger — ${l.run}`, lines);
}

/** Manual gate resolution (also raised automatically by the bus on a pending gate). */
async function resolveGate(ctx: ConclaveContext): Promise<void> {
  const client = await ctx.resolveClient();
  const run = await pickRun(client, "Resolve the gate on which run?");
  const [gateShow, budget] = await Promise.all([client.gateShow(run), client.budgetShow(run).catch(() => null)]);
  const gate = gateFromRead(gateShow, budget);
  if (!gate) {
    vscode.window.showInformationMessage(`Conclave: no gate is pending on "${run}".`);
    return;
  }
  await presentGate(gate, {
    client,
    runRef: run,
    log: (l) => ctx.output.appendLine(`[gate] ${l}`),
    openReport: (r) => openReportForRun(ctx, r),
    stop: (r) => ctx.cancelRun(r)
  });
}

/** CANCEL a run: engine-side terminal stop (`collab run stop`) + tear down the
 *  orchestrate child. Distinct from "Stop watching", which only detaches the viewer. */
async function cancelRunCmd(ctx: ConclaveContext, arg: unknown): Promise<void> {
  const client = await ctx.resolveClient();
  const run = argRunRef(arg) ?? (await pickRun(client, "Stop (cancel) which run?"));
  const outcome = await ctx.cancelRun(run);
  // Honest reporting: only claim "terminally stopped" when the engine confirmed it.
  const msg = cancelRunMessage(run, outcome);
  if (msg.kind === "info") {
    vscode.window.showInformationMessage(msg.text);
  } else {
    vscode.window.showErrorMessage(msg.text);
  }
}

/** STOP WATCHING: detach the live viewer only. The run keeps running. */
async function stopWatchingCmd(ctx: ConclaveContext, arg: unknown): Promise<void> {
  const client = await ctx.resolveClient();
  const run = argRunRef(arg) ?? (await pickRun(client, "Stop watching which run?"));
  const watching = ctx.isWatching(run);
  ctx.stopWatching(run);
  if (watching) {
    vscode.window.showInformationMessage(`Conclave: stopped watching "${run}" (viewer detached; the run keeps running).`);
  } else {
    vscode.window.showWarningMessage(`Conclave: not watching "${run}" — nothing to detach.`);
  }
}

async function attachRun(ctx: ConclaveContext): Promise<void> {
  const client = await ctx.resolveClient();
  const run = await pickRun(client, "Attach (watch-only) to which run?");

  if (ctx.isWatching(run)) {
    vscode.window.showInformationMessage(`Conclave: already attached to "${run}".`);
    return;
  }
  // The StateBus owns the single live feed: focusRun attaches its watch and
  // populates the sidebar (board/ledger). No separate WatchClient here — a second
  // one would double-watch the same run.
  await ctx.focusRun(run);
  ctx.output.show(true);
  vscode.window.showInformationMessage(`Conclave: attached to "${run}". Live events stream to the sidebar + output.`);
}

// ── rendering helper ─────────────────────────────────────────────────────────

function writeBlock(ctx: ConclaveContext, header: string, lines: string[]): void {
  ctx.output.appendLine("");
  ctx.output.appendLine(`──── ${header} ────`);
  for (const l of lines) ctx.output.appendLine(l);
  ctx.output.show(true);
}
