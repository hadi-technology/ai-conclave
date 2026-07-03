/**
 * Takeover hatch — pure command construction + honest gap detection (E4, item 4).
 *
 * ASSESSMENT of the JSON contract (docs/JSON-CONTRACT.md + wrk2gthr
 * src/cockpit/fleet.ts):
 *  - The seat's `session_id` IS exposed: the `collab watch --json` snapshot's
 *    `state.seats[].session`, and `collab status --json` roster `session`. So the
 *    extension CAN learn what to `--resume`.
 *  - The seat's `paused` flag IS readable (snapshot `state.seats[].paused`).
 *  - BUT there is NO contract action to SET the pause flag or run the round-trip.
 *    The engine's real takeover (`beginTakeover`/`endTakeover`) lives ONLY inside
 *    the in-process terminal cockpit and calls `store.setSeatPaused(...)` +
 *    `store.getSeat(...)` directly — never surfaced as a `collab` command. The
 *    extension must not touch the store (principle 2), so it cannot pause/resume.
 *
 * Therefore the HONEST takeover: we build the exact interactive resume command and
 * open it in an integrated terminal in the build target, but we DO NOT auto-run it
 * and we WARN that the harness can't be paused via the contract (double-attach
 * risk if the seat is mid-turn). The precise engine additions needed to make this
 * a real one-click round-trip are recorded in docs/ENGINE-GAPS.md.
 *
 * Pure (no vscode). The vscode shell (src/takeover.ts) creates the Terminal and
 * sends these lines.
 */

/** A seat's takeover-relevant state, projected from the watch snapshot. */
export interface SeatTakeoverState {
  seat: string;
  /** vendor session id to `--resume`, or null if the seat has taken no turn. */
  session: string | null;
  /** whether the store pause flag is set (read-only via contract). */
  paused: boolean;
  status: string;
}

/**
 * Pull a seat's takeover state out of a watch-snapshot `state` object. The
 * snapshot's `state.seats` are cockpit `SeatView` rows carrying `session`,
 * `paused`, `status`. Returns null if the seat isn't present.
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
  return {
    seat,
    session,
    paused: row.paused === true || row.paused === 1,
    status: typeof row.status === "string" ? (row.status as string) : "unknown"
  };
}

export interface TakeoverPlanInput {
  seat: string;
  /** From the snapshot; null when the seat has no session to resume. */
  session: string | null;
  /** Whether the seat is currently working a turn (double-attach risk). */
  working: boolean;
  /** The adapter's CLI binary (e.g. "claude"), read from the seat's adapter JSON. */
  adapterCommand: string | null;
  /** The build target the session was created in (resume is cwd-scoped). */
  targetCwd: string;
}

export type TakeoverPlan =
  | {
      kind: "resume";
      seat: string;
      cwd: string;
      /** The exact interactive command, e.g. `claude --resume <session>`. */
      resumeCommand: string;
      /** Instruction lines to echo into the terminal before staging the command. */
      banner: string[];
      /** True when the seat is mid-turn — running resume now risks double-attach. */
      warnDoubleAttach: boolean;
    }
  | {
      kind: "no-session";
      seat: string;
      cwd: string;
      /** Why we can't build a resume command yet. */
      banner: string[];
    }
  | {
      kind: "no-adapter";
      seat: string;
      cwd: string;
      banner: string[];
    };

const GAP_LINE =
  "NOTE: the JSON contract has no seat pause/resume action, so Conclave cannot pause the harness for you.";
const GAP_LINE2 = "See docs/ENGINE-GAPS.md for the exact engine additions a one-click round-trip needs.";

/**
 * Build the honest takeover plan. Never fabricates a working round-trip: when the
 * session is known it stages (does NOT auto-run) the real `--resume` command and
 * warns; when it isn't, it explains why.
 */
export function buildTakeoverPlan(input: TakeoverPlanInput): TakeoverPlan {
  const cwd = input.targetCwd;
  if (!input.session) {
    return {
      kind: "no-session",
      seat: input.seat,
      cwd,
      banner: [
        `Seat "${input.seat}" has no vendor session yet (it has taken no turn) — nothing to resume.`,
        "Wait until the seat has worked at least once, then take over.",
        GAP_LINE,
        GAP_LINE2
      ]
    };
  }
  if (!input.adapterCommand) {
    return {
      kind: "no-adapter",
      seat: input.seat,
      cwd,
      banner: [
        `Could not resolve the CLI command for seat "${input.seat}" (adapter JSON missing/unreadable).`,
        `The session to resume is: ${input.session}`,
        "Set conclave.adaptersDir to the folder holding <seat>.json adapters.",
        GAP_LINE,
        GAP_LINE2
      ]
    };
  }
  const resumeCommand = `${input.adapterCommand} --resume ${input.session}`;
  const banner = [
    `=== Conclave takeover — seat "${input.seat}" ===`,
    `Build target: ${cwd}`,
    `Session: ${input.session}`,
    "",
    "The interactive resume command is staged on the prompt below — review, then press Enter to attach.",
    "When you finish, exit the CLI to return the terminal; then resume driving from the sidebar.",
    ""
  ];
  if (input.working) {
    banner.push(
      "WARNING: this seat is CURRENTLY WORKING a headless turn. Attaching now double-attaches the",
      "session. Wait until the seat is idle before pressing Enter."
    );
  }
  banner.push(GAP_LINE, GAP_LINE2);
  return {
    kind: "resume",
    seat: input.seat,
    cwd,
    resumeCommand,
    banner,
    warnDoubleAttach: input.working
  };
}
