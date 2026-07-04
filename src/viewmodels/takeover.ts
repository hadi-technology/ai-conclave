/**
 * Takeover hatch — pure decision logic for the REAL pause→attach→release
 * round-trip (E4, item 4). vscode-free so it is unit-tested headlessly.
 *
 * The engine now ships `collab seat pause/resume` (schema 3). `seat pause` SETS
 * the seat's pause flag, WAITS for it to go idle, then returns the AUTHORITATIVE
 * interactive resume spec (`session`, `sessionCwd`, `resumeCommand`, `resumeArgs`,
 * `ready:true`). The contract gap is CLOSED — the extension no longer projects the
 * resume command from the snapshot; it PREFERS the engine's returned spec.
 *
 * This module keeps two small pure pieces:
 *  - {@link seatTakeoverState}: a pre-flight projection off the watch snapshot,
 *    used only to detect "no session yet → nothing to take over" before we ask the
 *    engine to pause.
 *  - {@link planTakeover}: turn a `pauseSeat` result into the effect the vscode
 *    shell performs (attach a terminal, or show an error).
 *  - {@link releaseTracked}: release a tracked seat EXACTLY once (guards the
 *    release-button + terminal-close double-fire).
 *
 * The vscode shell (src/takeover.ts) creates the Terminal and drives these.
 */
import type { SeatPauseResult } from "../engine/contract.js";

/** A seat's takeover-relevant state, projected from the watch snapshot. */
export interface SeatTakeoverState {
  seat: string;
  /** vendor session id, or null if the seat has taken no turn (nothing to resume). */
  session: string | null;
  /** the seat's worktree (schema 3 snapshot `sessionCwd`), or null. Pre-flight only —
   *  the authoritative cwd for attach comes from the `pauseSeat` response. */
  sessionCwd: string | null;
  /** whether the store pause flag is set (read-only via the snapshot). */
  paused: boolean;
  status: string;
}

/**
 * Pull a seat's takeover state out of a watch-snapshot `state` object. The
 * snapshot's `state.seats` are cockpit `SeatView` rows carrying `session`,
 * `sessionCwd`, `paused`, `status`. Returns null if the seat isn't present.
 */
export function seatTakeoverState(
  state: { seats?: Array<Record<string, unknown>> } | null | undefined,
  seat: string
): SeatTakeoverState | null {
  const rows = state?.seats;
  if (!Array.isArray(rows)) return null;
  const row = rows.find((r) => r && (r as { seat?: unknown }).seat === seat);
  if (!row) return null;
  const session = typeof row.session === "string" ? (row.session as string) : null;
  const sessionCwd = typeof row.sessionCwd === "string" ? (row.sessionCwd as string) : null;
  return {
    seat,
    session,
    sessionCwd,
    paused: row.paused === true || row.paused === 1,
    status: typeof row.status === "string" ? (row.status as string) : "unknown"
  };
}

/** Pre-flight: a seat is takeable only once it has a vendor session to resume. */
export function canTakeOver(st: SeatTakeoverState | null): boolean {
  return !!st && !!st.session;
}

/** The effect the vscode shell performs given a `pauseSeat` result. */
export type TakeoverEffect =
  | {
      kind: "attach";
      seat: string;
      /** The seat's worktree — the terminal cwd (authoritative, from the engine). */
      cwd: string;
      /** The exact command line to auto-run, e.g. `claude --resume sess-abc`. */
      commandLine: string;
      /** Vendor session id (for logging). */
      session: string;
    }
  | { kind: "error"; message: string };

/**
 * Turn a `pauseSeat` envelope into the shell effect. Prefers the engine's
 * authoritative spec: on success, attach a terminal in `sessionCwd` and auto-run
 * `resumeCommand resumeArgs` (the engine guarantees paused+idle). On failure,
 * surface `message` (+ ` — hint`) — the engine atomic-fails, so no cleanup.
 */
export function planTakeover(seat: string, res: SeatPauseResult): TakeoverEffect {
  if (!res.ok) {
    const { message, hint } = res.error;
    return { kind: "error", message: message + (hint ? ` — ${hint}` : "") };
  }
  return {
    kind: "attach",
    seat,
    cwd: res.sessionCwd,
    // Shell-quote every token so a command path with a space (e.g.
    // "/My Tools/codex") or a shell metachar in an arg reaches argv as ONE
    // token. Assumes a POSIX shell (bash/zsh) — acceptable: resumeCommand/
    // resumeArgs are engine-controlled and macOS/Linux is the supported env.
    commandLine: [res.resumeCommand, ...res.resumeArgs].map(posixQuote).join(" "),
    session: res.session
  };
}

/**
 * POSIX shell-quote a single token. Leaves shell-safe tokens untouched; wraps
 * anything with a metachar in single quotes (escaping any embedded `'`). Pure —
 * unit-tested. Assumes a POSIX shell (bash/zsh), the supported target platform.
 */
export function posixQuote(s: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Release a tracked takeover EXACTLY once on SUCCESS, retryable on failure.
 * Guards the double-fire ("Release seat" button AND the terminal-close listener)
 * with an in-flight `releasing` flag, and only removes the registry entry AFTER
 * `resume` resolves — so a failed resume KEEPS the entry, letting the user retry
 * release (via the button or by closing the terminal). Re-throws on failure so
 * the shell surfaces the error. Returns true iff it performed the resume.
 */
export async function releaseTracked<T extends { run: string; releasing?: boolean }>(
  registry: Map<string, T>,
  seat: string,
  resume: (seat: string, run: string) => Promise<unknown>
): Promise<boolean> {
  const entry = registry.get(seat);
  if (!entry) return false;
  if (entry.releasing) return false; // a release is already in flight — suppress the double-fire
  entry.releasing = true;
  try {
    await resume(seat, entry.run);
    registry.delete(seat);
    return true;
  } catch (err) {
    entry.releasing = false; // keep the entry so the user CAN retry release
    throw err;
  }
}

/**
 * Shutdown drain (deactivate / window reload): resume EVERY tracked seat so none is
 * left with its engine pause flag stuck set. Each resume is awaited but its failure is
 * SWALLOWED (reported via `onError`) — one seat failing must not block the others, and
 * the drain must NEVER throw (shutdown can't hang or crash). Clears the registry at the
 * end regardless of individual failures. Bounded by the caller's `resume` (the client
 * carries its own spawn timeout). Pure (vscode-free) → unit-tested with a fake resume.
 */
export async function drainTakeovers<T extends { run: string }>(
  registry: Map<string, T>,
  resume: (seat: string, run: string) => Promise<void>,
  onError?: (seat: string, err: unknown) => void
): Promise<void> {
  const entries = [...registry.entries()];
  await Promise.all(
    entries.map(async ([seat, entry]) => {
      try {
        await resume(seat, entry.run);
      } catch (err) {
        onError?.(seat, err);
      }
    })
  );
  registry.clear();
}
