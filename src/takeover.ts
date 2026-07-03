/**
 * Takeover hatch — the vscode shell (E4, item 4). HONEST implementation.
 *
 * The JSON contract exposes each seat's `session` (watch snapshot
 * `state.seats[].session`) and `paused` flag, so Conclave can build the exact
 * interactive resume command — but it has NO action to SET the pause flag or run
 * the round-trip (the engine's real takeover is in-process store-only). So this
 * command opens an integrated Terminal in the build target, echoes a clear
 * explanation + the contract gap, and STAGES the real `<cli> --resume <session>`
 * on the prompt (does not auto-run it, and warns about double-attach if the seat
 * is mid-turn). The precise engine additions needed for a true one-click
 * pause→resume→release round-trip are recorded in docs/ENGINE-GAPS.md.
 *
 * Pure command construction + gap detection lives in src/viewmodels/takeover.ts
 * (unit-tested); this file only reads the adapter command off disk and drives the
 * Terminal API.
 */
import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { ConclaveContext } from "./extension.js";
import { seatTakeoverState, buildTakeoverPlan } from "./viewmodels/takeover.js";

/** Read the `command` field out of a seat's adapter JSON, or null if unreadable. */
function adapterCommand(adaptersDir: string | undefined, cwd: string, seat: string): string | null {
  const base = adaptersDir?.trim() || join(cwd, "adapters");
  const path = base.endsWith(".json") ? base : join(isAbsolute(base) ? base : join(cwd, base), `${seat}.json`);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { command?: unknown };
    return typeof parsed.command === "string" ? parsed.command : null;
  } catch {
    return null;
  }
}

/**
 * Take over a seat. Reads the seat's session/paused/status from the active run's
 * watch snapshot, builds the honest takeover plan, and opens an integrated
 * terminal in the build target with the plan's banner + staged resume command.
 */
export async function takeoverSeat(ctx: ConclaveContext, seatArg?: string): Promise<void> {
  const bus = await ctx.ensureBus();
  const run = bus.activeRunRef;
  if (!run) {
    vscode.window.showWarningMessage("Conclave: focus a run first (its live snapshot carries the seat sessions).");
    return;
  }
  const snapshot = bus.snapshotState;
  const seats = Array.isArray(snapshot?.seats)
    ? (snapshot!.seats as Array<{ seat?: string }>).map((s) => s.seat).filter((s): s is string => !!s)
    : [];

  let seat = seatArg;
  if (!seat) {
    if (seats.length === 0) {
      vscode.window.showWarningMessage("Conclave: no seats in the live snapshot yet — wait for the run to start working.");
      return;
    }
    seat = await vscode.window.showQuickPick(seats, { placeHolder: `Take over which seat on "${run}"?` });
    if (!seat) return;
  }

  const st = seatTakeoverState(snapshot, seat);
  const clientConfig = await ctx.resolveClientConfig();
  const cwd = ctx.buildTargetFor(run);
  const cmd = adapterCommand(clientConfig.adaptersDir, clientConfig.cwd, seat);

  const plan = buildTakeoverPlan({
    seat,
    session: st?.session ?? null,
    working: st?.status === "working",
    adapterCommand: cmd,
    targetCwd: cwd
  });

  const terminal = vscode.window.createTerminal({ name: `Conclave takeover · ${seat}`, cwd });
  terminal.show();
  // Echo the banner as comments so it survives on the prompt without executing.
  for (const line of plan.banner) {
    terminal.sendText(line ? `# ${line}` : "", true);
  }
  if (plan.kind === "resume") {
    // Stage the real command WITHOUT executing — the user reviews then presses Enter.
    terminal.sendText(plan.resumeCommand, false);
    if (plan.warnDoubleAttach) {
      void vscode.window.showWarningMessage(
        `Conclave: staged "${plan.resumeCommand}" for seat "${seat}". WARNING: seat is mid-turn — wait until idle before pressing Enter. Conclave can't pause it (contract gap).`
      );
    } else {
      void vscode.window.showInformationMessage(
        `Conclave: staged "${plan.resumeCommand}" for seat "${seat}" in the terminal. Review, then press Enter to attach. Conclave can't auto-pause the harness (contract gap — see docs/ENGINE-GAPS.md).`
      );
    }
  } else {
    vscode.window.showWarningMessage(
      `Conclave: can't stage a takeover for "${seat}" (${plan.kind}). See the terminal + docs/ENGINE-GAPS.md.`
    );
  }
  ctx.output.appendLine(`[takeover] seat "${seat}" on "${run}": ${plan.kind} (target ${cwd}).`);
}
