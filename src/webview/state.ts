/**
 * The cockpit's pure state layer — the brain of the webview. It folds the
 * extension→webview message stream (a normalized `CockpitSnapshot`, plus live
 * `stream`/`event`/`gate`/`theme` deltas) into everything the UI renders:
 *
 *   • the Kanban board — cards grouped into columns, derived STRICTLY from E2's
 *     `unitColumn` mapping (one source of truth, not re-derived here);
 *   • per-seat stream buffers, capped so a long run cannot bloat memory;
 *   • the current gate spec (+ driver flag), the decide tally, the phase stage,
 *     a capped activity log, and the per-seat + total cost rollup.
 *
 * No DOM, no `vscode` — every transition is a pure `(state, msg) => state`, so
 * the whole live surface is unit-tested headlessly. The DOM layer (app.ts) is a
 * thin projection of this state.
 */
import { unitColumn, BOARD_COLUMNS, type BoardColumn } from "../viewmodels/board.js";
import { emptyModel, type RunModel, type UnitVM } from "../viewmodels/model.js";
import { vendorFor, type VendorColor } from "./vendorColors.js";
import type {
  CockpitEvent,
  CockpitSnapshot,
  ExtensionToWebview,
  TallyVM
} from "./protocol.js";
import type { GateNotificationSpec } from "../viewmodels/gate.js";

/** Max lines retained per seat's stream pane (append-only + virtualized). */
export const STREAM_CAP = 500;
/** Max entries retained in the activity log. */
export const ACTIVITY_CAP = 60;

/** The condensed, legible phase pipeline lit in the top lane. */
export const PHASE_PIPELINE = [
  "propose",
  "decide",
  "plan",
  "decompose",
  "implement",
  "qa",
  "merge",
  "validate",
  "report",
  "done"
] as const;
export type Phase = (typeof PHASE_PIPELINE)[number];

/** Map the engine's finer-grained phase names onto a pipeline stage. */
export function phaseStage(phase: string | null | undefined): Phase | null {
  if (!phase) return null;
  switch (phase) {
    case "plan_review":
    case "plan_revise":
    case "approve":
      return "plan";
    case "score":
      return "decide";
    case "reconcile":
      return "merge";
    case "curate":
      return "report";
    default:
      return (PHASE_PIPELINE as readonly string[]).includes(phase) ? (phase as Phase) : null;
  }
}

/** Index of the current phase in the pipeline (-1 when unknown). */
export function phaseIndex(phase: string | null | undefined): number {
  const stage = phaseStage(phase);
  return stage ? PHASE_PIPELINE.indexOf(stage) : -1;
}

// ── Cards ────────────────────────────────────────────────────────────────────

export interface Card {
  seq: number;
  title: string;
  status: string;
  column: BoardColumn;
  /** Owning (author) seat + its vendor colour. */
  seat: string | null;
  seatColor: VendorColor | null;
  reviewer: string | null;
  reviewerColor: VendorColor | null;
  tier: string | null;
  phase: string;
  /** True in the Review column: a cross-QA card (reviewer ≠ author). */
  isCrossQA: boolean;
  /** True when this unit failed QA and is being reworked (reverted commit, fix
   *  enqueued) — it stays in Building but must read as "reverted" at a glance,
   *  distinct from clean in-progress work AND from a terminal Blocked unit. */
  isRework: boolean;
}

/** Building-column statuses that mean "failed QA / reverted → being reworked". */
export const REWORK_STATUSES: ReadonlySet<string> = new Set(["qa_fail", "fixed"]);

export interface StreamBuffer {
  lines: string[];
  /** How many lines have been dropped off the top (virtualization headroom). */
  dropped: number;
}

export interface CostRow {
  seat: string;
  color: VendorColor;
  cost: number;
  mode: string;
  turns: number;
}

export interface CockpitState {
  model: RunModel;
  tally: TallyVM | null;
  gate: GateNotificationSpec | null;
  driver: boolean;
  /** Board columns (in canonical order) → cards. */
  columns: Record<BoardColumn, Card[]>;
  streams: Record<string, StreamBuffer>;
  /** Ordered list of seats that have streamed (stable for stable panes). */
  streamOrder: string[];
  activity: string[];
  phase: string | null;
  themeKind: string;
  cost: { perSeat: CostRow[]; total: number; exact: number; estimated: number; budgetUsd: number | null; fracUsed: number | null };
}

function emptyColumns(): Record<BoardColumn, Card[]> {
  const cols = {} as Record<BoardColumn, Card[]>;
  for (const c of BOARD_COLUMNS) cols[c] = [];
  return cols;
}

export function initialCockpitState(): CockpitState {
  return {
    model: emptyModel(),
    tally: null,
    gate: null,
    driver: false,
    columns: emptyColumns(),
    streams: {},
    streamOrder: [],
    activity: [],
    phase: null,
    themeKind: "dark",
    cost: { perSeat: [], total: 0, exact: 0, estimated: 0, budgetUsd: null, fracUsed: null }
  };
}

/** A seat's model string, looked up from the ledger (sharpens vendor colour). */
function seatModel(model: RunModel, seat: string | null): string | null {
  if (!seat) return null;
  return model.ledger.perSeatModel.find((r) => r.seat === seat)?.model ?? null;
}

function cardFor(u: UnitVM, model: RunModel): Card {
  const column = unitColumn(u.status);
  const seatColor = u.author ? vendorFor(u.author, seatModel(model, u.author)) : null;
  const reviewerColor = u.reviewer ? vendorFor(u.reviewer, seatModel(model, u.reviewer)) : null;
  return {
    seq: u.seq,
    title: u.title,
    status: u.status,
    column,
    seat: u.author,
    seatColor,
    reviewer: u.reviewer,
    reviewerColor,
    tier: u.tier,
    phase: model.run?.phase ?? "?",
    isCrossQA: column === "Review" && !!u.reviewer && u.reviewer !== u.author,
    isRework: column === "Building" && REWORK_STATUSES.has(u.status)
  };
}

/** Group the model's units into board columns via E2's `unitColumn` (reused). */
export function deriveColumns(model: RunModel): Record<BoardColumn, Card[]> {
  const cols = emptyColumns();
  for (const u of model.units) cols[unitColumn(u.status)].push(cardFor(u, model));
  for (const c of BOARD_COLUMNS) cols[c].sort((a, b) => a.seq - b.seq);
  return cols;
}

function deriveCost(model: RunModel): CockpitState["cost"] {
  const perSeat: CostRow[] = model.ledger.perSeatModel.map((r) => ({
    seat: r.seat,
    color: vendorFor(r.seat, r.model),
    cost: r.cost,
    mode: r.mode,
    turns: r.turns
  }));
  const { total, exact, estimated, budgetUsd, fracUsed } = model.ledger;
  return { perSeat, total, exact, estimated, budgetUsd, fracUsed };
}

// ── Stream buffer capping (append-only + virtualization) ─────────────────────

function appendStream(buf: StreamBuffer | undefined, line: string): StreamBuffer {
  const lines = buf ? buf.lines.slice() : [];
  let dropped = buf ? buf.dropped : 0;
  lines.push(line);
  if (lines.length > STREAM_CAP) {
    const overflow = lines.length - STREAM_CAP;
    lines.splice(0, overflow);
    dropped += overflow;
  }
  return { lines, dropped };
}

// ── The reducer ──────────────────────────────────────────────────────────────

export function cockpitReducer(state: CockpitState, msg: ExtensionToWebview): CockpitState {
  switch (msg.type) {
    case "state": {
      const snap: CockpitSnapshot = msg.snapshot;
      return {
        ...state,
        model: snap.model,
        tally: snap.tally,
        driver: snap.driver,
        columns: deriveColumns(snap.model),
        phase: snap.model.run?.phase ?? null,
        cost: deriveCost(snap.model)
      };
    }
    case "stream": {
      const streams = { ...state.streams, [msg.seat]: appendStream(state.streams[msg.seat], msg.line) };
      const streamOrder = state.streamOrder.includes(msg.seat)
        ? state.streamOrder
        : [...state.streamOrder, msg.seat];
      return { ...state, streams, streamOrder };
    }
    case "event": {
      return { ...state, activity: pushActivity(state.activity, describeEvent(msg.event)) };
    }
    case "gate": {
      return { ...state, gate: msg.spec, driver: msg.driver };
    }
    case "theme": {
      return { ...state, themeKind: msg.kind };
    }
    default:
      return state;
  }
}

function pushActivity(log: string[], line: string): string[] {
  const next = [...log, line];
  if (next.length > ACTIVITY_CAP) next.splice(0, next.length - ACTIVITY_CAP);
  return next;
}

/** A short human label for an event, for the activity strip. Pure. */
export function describeEvent(ev: CockpitEvent): string {
  const seat = ev.seat ? ` ${ev.seat}` : "";
  const item = ev.itemId != null ? ` #${ev.itemId}` : "";
  return `${ev.type}${seat}${item}`.trim();
}
