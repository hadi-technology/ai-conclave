/**
 * E1 core commands — thin wrappers over the engine client. Each resolves a
 * client (which provisions Node ≥25 + engine + schema check), calls a `--json`
 * command or the watch feed, and renders real data or a clear, actionable error.
 * Rich UI (trees, cockpit webview, gate notifications) is E2/E3; here we use the
 * Output channel, info/error messages, and simple input flows.
 */
import * as vscode from "vscode";

import type { ConclaveContext } from "./extension.js";
import { EngineError } from "./engine/errors.js";
import type { EngineClient } from "./engine/client.js";
import type { RunSummary } from "./engine/contract.js";
import { WatchClient } from "./engine/watch.js";

export function registerCommands(context: vscode.ExtensionContext, ctx: ConclaveContext): void {
  const reg = (id: string, fn: () => Promise<void>) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, () => guarded(ctx, fn))
    );

  reg("conclave.startRun", () => startRun(ctx));
  reg("conclave.showStatus", () => showStatus(ctx));
  reg("conclave.openReport", () => openReport(ctx));
  reg("conclave.showLedger", () => showLedger(ctx));
  reg("conclave.approveGate", () => approveGate(ctx));
  reg("conclave.stopRun", () => stopRun(ctx));
  reg("conclave.attachRun", () => attachRun(ctx));

  // Detach any live watchers on unload.
  context.subscriptions.push({
    dispose: () => {
      for (const w of ctx.watchers.values()) w.stop();
      ctx.watchers.clear();
    }
  });
}

/** Wrap a handler: turn EngineError into a friendly message + hint. */
async function guarded(ctx: ConclaveContext, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof CancelledError) {
      return; // user dismissed a picker — not an error
    }
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

/**
 * Pick a run: 0 → error, 1 → that one, many → Quick Pick (active first).
 * Returns the run name (the engine accepts name or id).
 */
async function pickRun(client: EngineClient, placeholder: string): Promise<string> {
  const { runs } = await client.runs();
  if (runs.length === 0) {
    throw new EngineError(
      "no_runs",
      "There are no runs in this workspace yet",
      "Start one with 'Conclave: Start run'."
    );
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

  const problem = await vscode.window.showInputBox({
    title: "Conclave: Start run",
    prompt: "What is the problem to solve? (the run goal)",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? null : "A goal is required.")
  });
  if (problem === undefined) return; // cancelled

  const criteria = await vscode.window.showInputBox({
    title: "Conclave: Start run — acceptance criteria",
    prompt: "How is 'done' judged? (acceptance criteria — optional)",
    ignoreFocusOut: true
  });
  if (criteria === undefined) return;

  const seats = await vscode.window.showInputBox({
    title: "Conclave: Start run — seats",
    prompt: "Comma-separated seats, e.g. claude,glm,codex",
    value: cfg.get<string>("defaultSeats", ""),
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? null : "At least one seat is required.")
  });
  if (seats === undefined) return;

  const budgetSetting = cfg.get<number | null>("defaultBudget", null);

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Conclave: starting run…" },
    () =>
      client.runStart({
        problem: problem.trim(),
        criteria: criteria.trim() || undefined,
        seats: seats.trim(),
        domain: cfg.get<string>("defaultDomain", "coding"),
        approval: cfg.get<string>("defaultApproval", "plan-only"),
        routing: cfg.get<string>("defaultRouting", "auto"),
        budgetUsd: typeof budgetSetting === "number" ? budgetSetting : null
      })
  );

  ctx.output.appendLine(
    `[conclave] started run "${result.run}" (#${result.id}) — phase ${result.phase}, seats ${result.seats.join(", ")}.`
  );
  ctx.output.show(true);
  vscode.window.showInformationMessage(
    `Conclave: started run "${result.run}" (#${result.id}) in phase ${result.phase}.`
  );
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
    lines.push(
      `  · ${seat.seat}: ${seat.status}, headroom ${seat.headroom}${seat.capped ? " (capped)" : ""}`
    );
  }
  lines.push(s.gate ? `Gate: #${s.gate.id} ${s.gate.kind} (${s.gate.status})` : "Gate: none pending");

  writeBlock(ctx, `Status — ${s.run}`, lines);
  vscode.window.showInformationMessage(
    `Conclave: ${s.run} — ${s.phase}/${s.status}${s.gate ? `, gate ${s.gate.kind} pending` : ""}.`
  );
}

async function openReport(ctx: ConclaveContext): Promise<void> {
  const client = await ctx.resolveClient();
  const run = await pickRun(client, "Open report for which run?");
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
      md.push(
        `| ${u.seq} | ${u.title} | ${u.tier} | ${u.author} | ${u.reviewer} | ${u.status} | ${u.qa} | ${u.commit ?? "—"} |`
      );
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
  lines.push(
    `Total: $${l.total.toFixed(4)}  (exact $${l.exact.toFixed(4)}, estimated $${l.estimated.toFixed(4)})`
  );
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
  vscode.window.showInformationMessage(`Conclave: ${l.run} total spend $${l.total.toFixed(4)}.`);
}

async function approveGate(ctx: ConclaveContext): Promise<void> {
  const client = await ctx.resolveClient();
  const run = await pickRun(client, "Approve the gate on which run?");
  const g = await client.gateShow(run);

  if (!g.gate) {
    vscode.window.showInformationMessage(`Conclave: no gate is pending on "${run}".`);
    return;
  }

  let winner: string | undefined;
  if (g.gate.kind === "decide_tie") {
    // tie gates require a winner seat.
    const options = (g.gate.options ?? [])
      .map((o) => (typeof o === "object" && o !== null ? (o as { winner?: string }).winner : undefined))
      .filter((w): w is string => !!w);
    const proposalSeats = options.length ? options : g.gate.plan ? [g.gate.plan.seat] : [];
    winner = await vscode.window.showQuickPick(proposalSeats, {
      placeHolder: "Pick the winning seat for this tie gate"
    });
    if (!winner) return; // cancelled
  }

  const feedback = await vscode.window.showInputBox({
    title: `Approve gate #${g.gate.id} (${g.gate.kind})`,
    prompt: "Optional feedback for approval (leave blank for none)",
    ignoreFocusOut: true
  });
  if (feedback === undefined) return; // cancelled

  const res = await client.gateApprove({
    run,
    winner,
    feedback: feedback.trim() || undefined
  });
  ctx.output.appendLine(
    `[conclave] gate #${res.gate} ${res.kind} → ${res.resolution}${res.winner ? ` (winner ${res.winner})` : ""}.`
  );
  vscode.window.showInformationMessage(`Conclave: gate #${res.gate} ${res.resolution}.`);
}

async function stopRun(ctx: ConclaveContext): Promise<void> {
  // The engine's JSON contract exposes no run cancel/stop command yet, so
  // "Stop run" detaches the extension's own live watch attachments (the thing
  // the thin client actually owns). Engine-side hard-cancel awaits a contract
  // command — surfaced clearly rather than faked.
  const client = await ctx.resolveClient();
  const run = await pickRun(client, "Stop watching which run?");

  const w = ctx.watchers.get(run);
  if (w) {
    w.stop();
    ctx.watchers.delete(run);
    ctx.output.appendLine(`[conclave] detached live watch for "${run}".`);
    vscode.window.showInformationMessage(`Conclave: detached the live feed for "${run}".`);
    return;
  }

  vscode.window.showWarningMessage(
    `Conclave: no live feed attached for "${run}". Engine-side run cancellation is not yet in the JSON contract — nothing to stop.`
  );
}

async function attachRun(ctx: ConclaveContext): Promise<void> {
  const client = await ctx.resolveClient();
  const run = await pickRun(client, "Attach (watch-only) to which run?");

  if (ctx.watchers.has(run)) {
    vscode.window.showInformationMessage(`Conclave: already attached to "${run}".`);
    ctx.output.show(true);
    return;
  }

  const prov = await ctx.ensureProvisioned();
  const cfg = vscode.workspace.getConfiguration("conclave");
  const adaptersDir = cfg.get<string>("adaptersDir", "").trim();
  const cwd = vscode.workspace.workspaceFolders![0].uri.fsPath;

  const watcher = new WatchClient(
    {
      nodePath: prov.nodePath,
      enginePath: prov.enginePath,
      cwd,
      adaptersDir: adaptersDir || undefined
    },
    { run }
  );

  watcher.on("snapshot", (line) => {
    const state = line.state as { phase?: string; status?: string };
    ctx.output.appendLine(
      `[watch ${run}] snapshot @cursor ${line.cursor} — phase ${state.phase ?? "?"}, status ${state.status ?? "?"}`
    );
  });
  watcher.on("event", (line) => {
    ctx.output.appendLine(`[watch ${run}] event @${line.cursor} ${line.event.type}`);
  });
  watcher.on("stream", (line) => {
    ctx.output.appendLine(`[watch ${run}] ${line.seat}> ${line.line}`);
  });
  watcher.on("reset", (line) => {
    ctx.output.appendLine(`[watch ${run}] reset — ${line.reason} (re-snapshotting)`);
  });
  watcher.on("reconnecting", (info) => {
    ctx.output.appendLine(`[watch ${run}] reconnecting (attempt ${info.attempt}, since ${info.since ?? "head"})`);
  });
  watcher.on("error", (err) => {
    ctx.output.appendLine(`[watch ${run}] error: ${err.message}`);
  });
  watcher.on("close", (info) => {
    ctx.output.appendLine(`[watch ${run}] closed (${info.stopped ? "detached" : "ended"}, code ${info.code}).`);
    ctx.watchers.delete(run);
  });

  watcher.start();
  ctx.watchers.set(run, watcher);
  ctx.output.show(true);
  vscode.window.showInformationMessage(
    `Conclave: attached to "${run}" (watch-only). Live events stream to the Conclave output channel. Use 'Stop run' to detach.`
  );
}

// ── rendering helper ─────────────────────────────────────────────────────────

function writeBlock(ctx: ConclaveContext, header: string, lines: string[]): void {
  ctx.output.appendLine("");
  ctx.output.appendLine(`──── ${header} ────`);
  for (const l of lines) ctx.output.appendLine(l);
  ctx.output.show(true);
}
