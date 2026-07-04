/**
 * Takeover hatch — the vscode shell (E4, item 4). REAL one-click round-trip.
 *
 * The engine ships `collab seat pause/resume` (schema 3), so the contract gap is
 * CLOSED. Flow:
 *   Take over seat → `engine.pauseSeat(seat, run)` → engine SETS the pause flag,
 *   WAITS until the seat is idle, and returns the authoritative resume spec
 *   (session / sessionCwd / resumeCommand / resumeArgs / ready:true) → open an
 *   integrated terminal in `sessionCwd` and AUTO-RUN `resumeCommand resumeArgs`
 *   (safe: the engine guarantees paused+idle) → the user drives by hand → Release
 *   (button OR closing the terminal) → `engine.resumeSeat(seat, run)` → headless
 *   driving resumes.
 *
 * On pause failure the engine ATOMIC-FAILS (clears its own pause flag), so the
 * shell surfaces the message + hint and does NOTHING else — no cleanup.
 *
 * Pure decision logic (plan/guard) lives in src/viewmodels/takeover.ts.
 */
import * as vscode from "vscode";

import type { ConclaveContext } from "./extension.js";
import { EngineClient } from "./engine/client.js";
import { planTakeover, releaseTracked, drainTakeovers } from "./viewmodels/takeover.js";

/** A live takeover: which terminal is attached and which run it belongs to. */
interface ActiveTakeover {
  terminal: vscode.Terminal;
  run: string;
  /** In-flight guard for releaseTracked — set while a resume is being awaited so
   *  the button + on-close double-fire is suppressed, cleared if resume fails. */
  releasing?: boolean;
}

/** Tracked takeovers keyed by seat — so we know which seat a terminal belongs to
 *  and never double-resume. Module-level: shared across command invocations. */
const activeTakeovers = new Map<string, ActiveTakeover>();

/** Seats with a takeover in flight (paused-request sent, not yet tracked in
 *  `activeTakeovers`). Reserved BEFORE the async `pauseSeat` so two rapid
 *  invocations for the same seat can't both pause + attach (the second is
 *  rejected as "already taking over"). */
const pendingTakeovers = new Set<string>();

let listenerRegistered = false;

/**
 * Register the terminal-close listener ONCE (called from extension activate). When
 * a tracked takeover terminal closes, resume the seat headless (release on-close).
 */
export function initTakeover(ctx: ConclaveContext, subscriptions: vscode.Disposable[]): void {
  if (listenerRegistered) return;
  listenerRegistered = true;
  subscriptions.push(
    vscode.window.onDidCloseTerminal((term) => {
      for (const [seat, active] of activeTakeovers) {
        if (active.terminal === term) {
          void release(ctx, seat, "terminal closed");
          break;
        }
      }
    })
  );
}

/** Resume a tracked seat exactly once (guards button + on-close double-fire).
 *  Returns true iff the seat was actually resumed — callers dispose the terminal
 *  ONLY on true, so a failed resume keeps the terminal open (and the entry
 *  tracked, per releaseTracked) for a retry. */
async function release(ctx: ConclaveContext, seat: string, reason: string): Promise<boolean> {
  const client = new EngineClient(await ctx.resolveClientConfig());
  const released = await releaseTracked(activeTakeovers, seat, async (s, run) => {
    const res = await client.resumeSeat(s, run);
    if (!res.ok) {
      throw new Error(res.error.message + (res.error.hint ? ` — ${res.error.hint}` : ""));
    }
  }).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.output.appendLine(`[takeover] resume seat "${seat}" failed (${reason}): ${msg}`);
    void vscode.window.showErrorMessage(`Conclave: failed to resume seat "${seat}" — ${msg}`);
    return false;
  });
  if (released) {
    ctx.output.appendLine(`[takeover] seat "${seat}" released (${reason}) — headless driving resumed.`);
    void vscode.window.showInformationMessage(`Conclave: seat "${seat}" released — headless driving resumed.`);
  }
  return released;
}

/**
 * Take over a seat: pause it engine-side (the engine waits until it's idle), then
 * open a terminal in its worktree already attached via the returned resume spec.
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

  // Already taken over (or a pause is in flight) → focus / no-op instead of
  // pausing twice. The pending check closes the race where two rapid invocations
  // both pass the activeTakeovers check before either has set() its entry.
  const existing = activeTakeovers.get(seat);
  if (existing) {
    existing.terminal.show();
    vscode.window.showInformationMessage(`Conclave: already driving seat "${seat}" — focused its terminal.`);
    return;
  }
  if (pendingTakeovers.has(seat)) {
    vscode.window.showInformationMessage(`Conclave: already taking over seat "${seat}" — waiting for it to go idle…`);
    return;
  }

  // NO snapshot preflight: `lastSnapshot` only refreshes on the INITIAL watch
  // snapshot, so a seat that gained its session AFTER attach would be wrongly
  // refused. The engine's `pauseSeat` is authoritative — it atomic-fails with a
  // clear "no session yet" envelope, which planTakeover surfaces below. Relying
  // on it (not a possibly-stale snapshot) is both correct and simpler.
  const clientConfig = await ctx.resolveClientConfig();
  const client = new EngineClient(clientConfig);
  ctx.output.appendLine(`[takeover] pausing seat "${seat}" on "${run}" (waiting for it to go idle)…`);

  // Reserve BEFORE the async pause so a concurrent invocation is rejected above.
  pendingTakeovers.add(seat);
  let terminal: vscode.Terminal;
  try {
    const res = await client.pauseSeat(seat, run, { adaptersDir: clientConfig.adaptersDir });
    const effect = planTakeover(seat, res);
    if (effect.kind === "error") {
      // Engine atomic-fails (clears its own pause flag) — surface + return, no cleanup.
      vscode.window.showErrorMessage(effect.message);
      ctx.output.appendLine(`[takeover] pause seat "${seat}" failed: ${effect.message}`);
      return;
    }
    terminal = vscode.window.createTerminal({ name: `Conclave takeover · ${seat}`, cwd: effect.cwd });
    // Auto-run: the engine guarantees the seat is paused AND idle (ready:true), so
    // attaching now is safe (no double-attach).
    terminal.sendText(effect.commandLine, true);
    terminal.show();
    activeTakeovers.set(seat, { terminal, run });
    ctx.output.appendLine(
      `[takeover] seat "${seat}" paused; attached "${effect.commandLine}" in ${effect.cwd} (session ${effect.session}).`
    );
  } finally {
    // Once tracked in activeTakeovers (or bailed), drop the reservation so the
    // long "Release" prompt below doesn't hold it — the activeTakeovers entry
    // now guards re-entry.
    pendingTakeovers.delete(seat);
  }

  const choice = await vscode.window.showInformationMessage(
    `Conclave: took over seat "${seat}" — you're driving it in the terminal. Close the terminal or click Release to resume headless driving.`,
    "Release seat"
  );
  if (choice === "Release seat") {
    // Dispose ONLY on a successful release — a failed resume keeps the terminal
    // open + the entry tracked so the user can retry (close it, or click again).
    if (await release(ctx, seat, "release button")) terminal.dispose();
  }
}

/**
 * Shutdown drain (extension deactivate / window reload / disable): best-effort release
 * of EVERY active takeover, so a seat is never left with its engine pause flag stuck
 * set indefinitely. Bounded + never throws: each resume failure is logged, the
 * registry (and its terminal refs) is cleared regardless, and any attached terminals
 * are disposed. Safe to call with nothing tracked (no-op).
 */
export async function disposeAllTakeovers(ctx: ConclaveContext): Promise<void> {
  if (activeTakeovers.size === 0) return;
  // Snapshot terminals BEFORE draining (drainTakeovers clears the registry).
  const terminals = [...activeTakeovers.values()].map((a) => a.terminal);
  let client: EngineClient | undefined;
  try {
    client = new EngineClient(await ctx.resolveClientConfig());
  } catch (err) {
    ctx.output.appendLine(
      `[takeover] shutdown drain: could not resolve engine client — ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (client) {
    const engine = client;
    await drainTakeovers(
      activeTakeovers,
      async (seat, run) => {
        const res = await engine.resumeSeat(seat, run);
        if (!res.ok) throw new Error(res.error.message);
      },
      (seat, err) =>
        ctx.output.appendLine(
          `[takeover] shutdown resume seat "${seat}" failed: ${err instanceof Error ? err.message : String(err)}`
        )
    );
  } else {
    // No client to resume with — still clear so we don't leak references.
    activeTakeovers.clear();
  }
  for (const t of terminals) {
    try {
      t.dispose();
    } catch {
      /* ignore */
    }
  }
}

/**
 * `conclave.releaseSeat` — release a tracked takeover (resume headless). Picks when
 * multiple seats are taken over. Disposing the terminal after release is a no-op on
 * the on-close listener (the registry entry is already gone).
 */
export async function releaseSeatCommand(ctx: ConclaveContext, seatArg?: string): Promise<void> {
  const seats = [...activeTakeovers.keys()];
  if (seats.length === 0) {
    vscode.window.showInformationMessage("Conclave: no seat is currently taken over.");
    return;
  }
  let seat = seatArg && activeTakeovers.has(seatArg) ? seatArg : undefined;
  if (!seat) {
    seat = seats.length === 1 ? seats[0] : await vscode.window.showQuickPick(seats, { placeHolder: "Release which seat?" });
  }
  if (!seat || !activeTakeovers.has(seat)) return;
  const terminal = activeTakeovers.get(seat)!.terminal;
  // Dispose only on a successful release — keep the terminal open on failure.
  if (await release(ctx, seat, "release command")) terminal.dispose();
}
