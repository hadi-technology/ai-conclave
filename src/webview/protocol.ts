/**
 * The typed extension↔webview message protocol — the ONE contract between the
 * privileged extension host (which alone touches the engine) and the sandboxed
 * webview (which only renders + asks). Pure: no `vscode`, no DOM. Imported by
 * BOTH bundles, so the wire shapes can never drift between the two sides.
 *
 * Thin-client rule (roadmap principle 1/2, item 6): the webview holds no engine
 * access. The extension subscribes to the WatchClient / StateBus and posts state
 * down; the webview posts action *requests* up, and the extension performs them.
 */
import type { RunModel } from "../viewmodels/model.js";
import type { GateNotificationSpec } from "../viewmodels/gate.js";

// ── Decide-phase tally (projected from the cockpit snapshot) ─────────────────

export interface TallyEntryVM {
  label: string;
  seat: string;
  total: number;
}

export interface TallyVM {
  totals: TallyEntryVM[];
  winnerSeat: string | null;
  winnerLabel: string | null;
  margin: number;
  /** Tie at top / margin < epsilon — a human tie-break may be needed. */
  escalate: boolean;
  reason: string;
}

/** The full state the board + shell render from. Derived entirely from E2's
 *  pure view-models (`RunModel`) plus the decide tally — one source of truth. */
export interface CockpitSnapshot {
  model: RunModel;
  tally: TallyVM | null;
  /** True when this panel can mutate the run (an orchestrate child is driving).
   *  False = watch-only attach → gate rendered read-only (principle 6). */
  driver: boolean;
}

/** A single append-only watch event, forwarded for phase/activity + animation. */
export interface CockpitEvent {
  type: string;
  seat?: string | null;
  itemId?: number | null;
  ts?: number;
  payload?: Record<string, unknown>;
}

// ── extension → webview ──────────────────────────────────────────────────────

export type ExtensionToWebview =
  | { type: "state"; snapshot: CockpitSnapshot }
  | { type: "event"; event: CockpitEvent }
  | { type: "stream"; seat: string; line: string }
  | { type: "gate"; spec: GateNotificationSpec | null; driver: boolean }
  | { type: "theme"; kind: string };

// ── webview → extension ──────────────────────────────────────────────────────

export type WebviewToExtension =
  | { type: "ready" }
  | {
      type: "resolveGate";
      gateId: number;
      /** The `GateActionSpec.id` the user clicked. */
      actionId: string;
      feedback?: string;
      amount?: number;
      winner?: string;
    }
  | { type: "focus"; view: "board" | "streams" };

// ── Pure message builders (extension side) — unit-tested without vscode ──────

export function stateMessage(snapshot: CockpitSnapshot): ExtensionToWebview {
  return { type: "state", snapshot };
}

export function streamMessage(seat: string, line: string): ExtensionToWebview {
  return { type: "stream", seat, line };
}

export function eventMessage(event: CockpitEvent): ExtensionToWebview {
  return { type: "event", event };
}

export function gateMessage(spec: GateNotificationSpec | null, driver: boolean): ExtensionToWebview {
  return { type: "gate", spec, driver };
}

export function themeMessage(kind: string): ExtensionToWebview {
  return { type: "theme", kind };
}

/**
 * Translate a single raw `collab watch --json` line into the outbound message,
 * or `null` when the line carries nothing the webview needs directly (events
 * drive a normalized state re-post, handled separately). Pure — this is the
 * documented "WatchClient line → postMessage" mapping under test.
 */
export function translateWatchLine(
  line: { type: string; seat?: string; line?: string; event?: CockpitEvent }
): ExtensionToWebview | null {
  switch (line.type) {
    case "stream":
      if (typeof line.seat === "string" && typeof line.line === "string") {
        return streamMessage(line.seat, line.line);
      }
      return null;
    case "event":
      return line.event ? eventMessage(line.event) : null;
    default:
      // snapshot/reset/runs-changed do not map 1:1 — they trigger a normalized
      // state re-post (`stateMessage`) built from the E2 view-models instead.
      return null;
  }
}

// ── Pure outbound builder (webview side) — action → request message ──────────

export interface GateActionInputs {
  feedback?: string;
  amount?: number;
  winner?: string;
}

/** Turn a clicked gate action into the exact upward request. Pure. */
export function resolveGateRequest(
  gateId: number,
  actionId: string,
  inputs: GateActionInputs = {}
): WebviewToExtension {
  return {
    type: "resolveGate",
    gateId,
    actionId,
    ...(inputs.feedback !== undefined ? { feedback: inputs.feedback } : {}),
    ...(inputs.amount !== undefined ? { amount: inputs.amount } : {}),
    ...(inputs.winner !== undefined ? { winner: inputs.winner } : {})
  };
}

export function readyRequest(): WebviewToExtension {
  return { type: "ready" };
}

export function focusRequest(view: "board" | "streams"): WebviewToExtension {
  return { type: "focus", view };
}
