/**
 * Normalized run model — the vscode-free intermediate the tree view-models
 * consume. It can be built from EITHER the rich `collab watch --json` snapshot
 * (the cockpit-shaped projection) OR from the `--json` read commands (the
 * polling fallback). Both adapters are pure functions, so every view-model is
 * unit-testable headlessly against either source.
 *
 * The primary live source is the watch snapshot; the read-command adapter is the
 * fallback refresh path (triggered by watch events, since the feed emits only one
 * snapshot on attach). Never file/DB reads — always the JSON contract.
 */
import type {
  BudgetShow,
  GateDetail,
  GateShow,
  Ledger,
  Report,
  RunStatus
} from "../engine/contract.js";

// ── Normalized shapes the view-models read ───────────────────────────────────

export interface RunMeta {
  name: string;
  id: number;
  phase: string;
  status: string;
  problem: string;
}

export interface SeatVM {
  seat: string;
  /** live status: idle | working | left. */
  status: string;
  paused: boolean;
  tier: string | null;
  headroom: string;
  capped: boolean;
  resetsAt: number | null;
  cost: number;
  costMode: string;
  turns: number;
  currentItem: string | null;
}

export interface UnitVM {
  seq: number;
  title: string;
  status: string;
  author: string | null;
  reviewer: string | null;
  tier: string | null;
}

export interface LedgerSeatModelVM {
  seat: string;
  model: string;
  turns: number;
  cost: number;
  mode: string;
}

export interface RollupVM {
  key: string;
  turns: number;
  cost: number;
  exact: number;
  estimated: number;
}

export interface LedgerVM {
  perSeatModel: LedgerSeatModelVM[];
  perTier: RollupVM[];
  perPhase: RollupVM[];
  total: number;
  exact: number;
  estimated: number;
  budgetUsd: number | null;
  fracUsed: number | null;
}

/** The gate kinds the UX handles natively. */
export type GateKind =
  | "plan_approval"
  | "decide_tie"
  | "budget_exceeded"
  | "validate_failed"
  | "dispute"
  | "unknown";

export interface GateVM {
  gateId: number;
  kind: GateKind;
  /** original engine kind string, verbatim. */
  rawKind: string;
  title: string;
  /** human-readable summary lines. */
  body: string[];
  /** plan-gate critique count, if applicable. */
  critiqueCount: number | null;
  /** candidate winner seats for a tie gate. */
  winners: string[];
  /** budget context for a budget gate. */
  budget: { budgetUsd: number | null; spent: number | null } | null;
}

export interface RunModel {
  run: RunMeta | null;
  seats: SeatVM[];
  units: UnitVM[];
  ledger: LedgerVM;
  gate: GateVM | null;
}

const EMPTY_LEDGER: LedgerVM = {
  perSeatModel: [],
  perTier: [],
  perPhase: [],
  total: 0,
  exact: 0,
  estimated: 0,
  budgetUsd: null,
  fracUsed: null
};

export function emptyModel(): RunModel {
  return { run: null, seats: [], units: [], ledger: { ...EMPTY_LEDGER }, gate: null };
}

// ── Gate-kind normalization ──────────────────────────────────────────────────

export function normalizeGateKind(raw: string): GateKind {
  switch (raw) {
    case "plan_approval":
    case "decide_tie":
    case "budget_exceeded":
    case "validate_failed":
    case "dispute":
      return raw;
    default:
      return "unknown";
  }
}

// ── Snapshot (watch feed) adapter ────────────────────────────────────────────
//
// The snapshot `state` follows the cockpit projection (src/cockpit/snapshot.ts).
// Shapes are intentionally read defensively — unknown/extra keys are ignored.

/** Loose typing over the cockpit snapshot `state` object. `run` may serialize as
 *  the full Run object (cockpit code) or, per some doc examples, as the run name
 *  string with phase/status/problem hoisted to the top level — handle both. */
export interface SnapshotState {
  run?:
    | string
    | {
        name?: string;
        id?: number;
        phase?: string;
        status?: string;
        problem?: string;
        budget_usd?: number | null;
      }
    | null;
  id?: number;
  phase?: string;
  status?: string;
  problem?: string;
  seats?: Array<Record<string, unknown>>;
  units?: Array<Record<string, unknown>>;
  unitCounts?: Record<string, number>;
  tally?: Record<string, unknown> | null;
  ledger?: Array<Record<string, unknown>>;
  perTier?: Array<Record<string, unknown>>;
  perPhase?: Array<Record<string, unknown>>;
  totalCost?: number;
  budgetUsd?: number | null;
  gate?: Record<string, unknown> | null;
  routing?: { mode?: string; effective?: string } | null;
}

function num(v: unknown, d = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function rollupFrom(rows: Array<Record<string, unknown>> | undefined): RollupVM[] {
  return (rows ?? []).map((r) => ({
    key: str(r.key) ?? "-",
    turns: num(r.turns),
    cost: num(r.cost),
    exact: num(r.exact),
    estimated: num(r.estimated)
  }));
}

export function modelFromSnapshot(state: SnapshotState): RunModel {
  // `run` is either the full Run object or just the name string (see note above).
  const runStr = typeof state.run === "string" ? state.run : null;
  const runObj = state.run && typeof state.run === "object" ? state.run : null;
  const present = runStr !== null || runObj !== null;
  const run: RunMeta | null = present
    ? {
        name: runStr ?? str(runObj?.name) ?? "(run)",
        id: num(runObj?.id ?? state.id),
        phase: str(runObj?.phase) ?? str(state.phase) ?? "?",
        status: str(runObj?.status) ?? str(state.status) ?? "?",
        problem: str(runObj?.problem) ?? str(state.problem) ?? ""
      }
    : null;

  const seats: SeatVM[] = (state.seats ?? []).map((s) => ({
    seat: str(s.seat) ?? "?",
    status: str(s.status) ?? "idle",
    paused: s.paused === true,
    tier: str(s.tier),
    headroom: str(s.headroom) ?? "medium",
    capped: s.capped === true,
    resetsAt: typeof s.resetsAt === "number" ? s.resetsAt : null,
    cost: num(s.cost),
    costMode: str(s.costMode) ?? "exact",
    turns: num(s.turns),
    currentItem: str(s.currentItem)
  }));

  const units: UnitVM[] = (state.units ?? []).map((u) => ({
    seq: num(u.seq),
    title: str(u.title) ?? "(untitled)",
    status: str(u.status) ?? "pending",
    author: str(u.author_seat) ?? str(u.author),
    reviewer: str(u.reviewer_seat) ?? str(u.reviewer),
    tier: str(u.required_tier) ?? str(u.tier)
  }));

  const perSeatModel: LedgerSeatModelVM[] = (state.ledger ?? []).map((l) => ({
    seat: str(l.seat) ?? "?",
    model: str(l.model) ?? "-",
    turns: num(l.turns),
    cost: num(l.cost),
    mode: str(l.mode) ?? "exact"
  }));

  const perTier = rollupFrom(state.perTier);
  const perPhase = rollupFrom(state.perPhase);
  const total = num(state.totalCost, perSeatModel.reduce((a, r) => a + r.cost, 0));
  const exact = perTier.reduce((a, r) => a + r.exact, 0);
  const estimated = perTier.reduce((a, r) => a + r.estimated, 0);
  const budgetUsd =
    typeof state.budgetUsd === "number"
      ? state.budgetUsd
      : typeof runObj?.budget_usd === "number"
        ? runObj.budget_usd
        : null;

  const ledger: LedgerVM = {
    perSeatModel,
    perTier,
    perPhase,
    total,
    exact,
    estimated,
    budgetUsd,
    fracUsed: budgetUsd && budgetUsd > 0 ? total / budgetUsd : null
  };

  return { run, seats, units, ledger, gate: gateFromSnapshot(state.gate, budgetUsd, total) };
}

/** The cockpit gate-prompt view: `{gateId, gateKind, title, body[], actions[], needsFeedback}`. */
export function gateFromSnapshot(
  gate: Record<string, unknown> | null | undefined,
  budgetUsd: number | null,
  spent: number
): GateVM | null {
  if (!gate) return null;
  const rawKind = str(gate.gateKind) ?? str(gate.kind) ?? "unknown";
  const kind = normalizeGateKind(rawKind);
  const bodyArr = Array.isArray(gate.body) ? (gate.body as unknown[]).map((b) => String(b)) : [];
  const actions = Array.isArray(gate.actions) ? (gate.actions as Array<Record<string, unknown>>) : [];
  const winners = actions
    .map((a) => str(a.winner))
    .filter((w): w is string => !!w);
  // critique count: parse from a body line like "critiques on v1: N finding(s), ..."
  let critiqueCount: number | null = null;
  for (const line of bodyArr) {
    const m = /critiques[^:]*:\s*(\d+)\s*finding/i.exec(line);
    if (m) critiqueCount = Number(m[1]);
  }
  return {
    gateId: num(gate.gateId ?? gate.id),
    kind,
    rawKind,
    title: str(gate.title) ?? `Gate ${num(gate.gateId ?? gate.id)}`,
    body: bodyArr,
    critiqueCount,
    winners,
    budget: kind === "budget_exceeded" ? { budgetUsd, spent } : null
  };
}

/** The decide-phase tally projection (from the cockpit snapshot's `TallyResult`).
 *  Pure and defensive — returns null when no tally is present. */
export interface TallyProjection {
  totals: Array<{ label: string; seat: string; total: number }>;
  winnerSeat: string | null;
  winnerLabel: string | null;
  margin: number;
  escalate: boolean;
  reason: string;
}

export function tallyFromSnapshot(
  tally: Record<string, unknown> | null | undefined
): TallyProjection | null {
  if (!tally) return null;
  const rawTotals = Array.isArray(tally.totals) ? (tally.totals as Array<Record<string, unknown>>) : [];
  const totals = rawTotals.map((t) => ({
    label: str(t.label) ?? "?",
    seat: str(t.seat) ?? "?",
    total: num(t.total)
  }));
  if (totals.length === 0 && tally.winnerSeat == null && tally.reason == null) return null;
  return {
    totals,
    winnerSeat: str(tally.winnerSeat),
    winnerLabel: str(tally.winnerLabel),
    margin: num(tally.margin),
    escalate: tally.escalate === true,
    reason: str(tally.reason) ?? ""
  };
}

// ── Read-command adapter (polling fallback) ──────────────────────────────────

export interface ReadBundle {
  status?: RunStatus | null;
  report?: Report | null;
  ledger?: Ledger | null;
  budget?: BudgetShow | null;
  gate?: GateShow | null;
}

export function modelFromReads(b: ReadBundle): RunModel {
  const s = b.status ?? null;
  const rep = b.report ?? null;
  const led = b.ledger ?? null;

  const run: RunMeta | null = s
    ? { name: s.run, id: s.id, phase: s.phase, status: s.status, problem: s.problem }
    : rep
      ? { name: rep.run, id: rep.id, phase: rep.phase, status: rep.status, problem: rep.problem }
      : null;

  const seats: SeatVM[] = (s?.seats ?? []).map((row) => ({
    seat: row.seat,
    status: row.status,
    paused: false,
    tier: null,
    headroom: row.headroom,
    capped: row.capped,
    resetsAt: null,
    cost: 0,
    costMode: "exact",
    turns: 0,
    currentItem: null
  }));

  const units: UnitVM[] = (rep?.units ?? []).map((u) => ({
    seq: u.seq,
    title: u.title,
    status: u.status,
    author: u.author,
    reviewer: u.reviewer,
    tier: u.tier
  }));

  const ledger: LedgerVM = led
    ? {
        perSeatModel: led.perSeatModel.map((r) => ({
          seat: r.seat,
          model: r.model,
          turns: r.turns,
          cost: r.cost,
          mode: r.mode
        })),
        perTier: led.perTier,
        perPhase: led.perPhase,
        total: led.total,
        exact: led.exact,
        estimated: led.estimated,
        budgetUsd: led.budgetUsd,
        fracUsed: led.fracUsed
      }
    : { ...EMPTY_LEDGER };

  return { run, seats, units, ledger, gate: gateFromRead(b.gate ?? null, b.budget ?? null) };
}

/** The `gate show` shape: `{gate:{id, kind, status, plan?, critiques?, options?}}`. */
export function gateFromRead(g: GateShow | null, budget: BudgetShow | null): GateVM | null {
  const detail: GateDetail | null | undefined = g?.gate;
  if (!detail) return null;
  const kind = normalizeGateKind(detail.kind);
  const critiqueCount = Array.isArray(detail.critiques) ? detail.critiques.length : null;
  const winners = Array.isArray(detail.options)
    ? detail.options
        .map((o) => (typeof o === "object" && o !== null ? (o as { winner?: string }).winner : undefined))
        .filter((w): w is string => !!w)
    : [];
  const body: string[] = [];
  if (detail.plan) body.push(`plan v${detail.plan.version} by ${detail.plan.seat}`);
  if (critiqueCount != null) body.push(`${critiqueCount} critique finding(s)`);
  return {
    gateId: detail.id,
    kind,
    rawKind: detail.kind,
    title: `Gate ${detail.id} — ${detail.kind}`,
    body,
    critiqueCount,
    winners,
    budget:
      kind === "budget_exceeded"
        ? { budgetUsd: budget?.budgetUsd ?? null, spent: budget?.spent ?? null }
        : null
  };
}
