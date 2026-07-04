/**
 * Headless unit tests for the E2 view-model layer — the bulk of the real logic.
 * No vscode, no engine: pure snapshot/reads/inputs → tree items / specs / args.
 */
import { describe, expect, it } from "vitest";

import {
  modelFromSnapshot,
  modelFromReads,
  gateFromSnapshot,
  gateFromRead,
  normalizeGateKind,
  emptyModel,
  type SnapshotState
} from "../src/viewmodels/model.js";
import { runsTree } from "../src/viewmodels/runs.js";
import { seatsTree, seatChip, seatArgOf } from "../src/viewmodels/seats.js";
import { boardTree, groupUnits, unitColumn, BOARD_COLUMNS } from "../src/viewmodels/board.js";
import { ledgerTree } from "../src/viewmodels/ledger.js";
import { statusBarModel } from "../src/viewmodels/statusbar.js";
import {
  gateNotificationSpec,
  resolveGateCall,
  type GateActionSpec
} from "../src/viewmodels/gate.js";
import {
  buildStartRunArgs,
  planBuildTarget,
  preflightText,
  requiresPreflightConfirm,
  validateStartRunInputs,
  seatArray,
  type StartRunInputs
} from "../src/viewmodels/startRun.js";
import { buildOrchestrateArgs } from "../src/orchestrate.js";
import type { RunSummary, RunStatus, Report, Ledger, GateShow, BudgetShow } from "../src/engine/contract.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const RUNS: RunSummary[] = [
  { name: "frost-anchor", id: 1, phase: "plan", status: "active", spend: 1.234, problem: "solve X", active: true },
  { name: "old-run", id: 2, phase: "done", status: "complete", spend: 0.5, problem: "old", active: false }
];

const SNAPSHOT: SnapshotState = {
  run: { name: "frost-anchor", id: 1, phase: "implement", status: "active", problem: "solve X", budget_usd: 5 },
  seats: [
    { seat: "b", status: "working", paused: false, tier: "premium", headroom: "medium", capped: false, resetsAt: null, cost: 0.4, costMode: "exact", turns: 3, currentItem: "unit 2" },
    { seat: "a", status: "idle", paused: false, tier: "cheap", headroom: "low", capped: true, resetsAt: 1700000000000, cost: 0.1, costMode: "estimated", turns: 1, currentItem: null }
  ],
  units: [
    { seq: 1, title: "scaffold", status: "merged", author_seat: "a", reviewer_seat: "b", required_tier: "cheap" },
    { seq: 2, title: "logic", status: "implemented", author_seat: "b", reviewer_seat: "a", required_tier: "premium" },
    { seq: 3, title: "polish", status: "pending", author_seat: null, reviewer_seat: null, required_tier: "cheap" },
    { seq: 4, title: "broke", status: "blocked", author_seat: "a", reviewer_seat: "b", required_tier: "cheap" }
  ],
  ledger: [
    { seat: "a", model: "m1", turns: 1, cost: 0.1, mode: "estimated" },
    { seat: "b", model: "m2", turns: 3, cost: 0.4, mode: "exact" }
  ],
  perTier: [
    { key: "cheap", turns: 1, cost: 0.1, exact: 0, estimated: 0.1 },
    { key: "premium", turns: 3, cost: 0.4, exact: 0.4, estimated: 0 }
  ],
  perPhase: [{ key: "implement", turns: 4, cost: 0.5, exact: 0.4, estimated: 0.1 }],
  totalCost: 0.5,
  budgetUsd: 5,
  gate: null
};

// ── modelFromSnapshot ────────────────────────────────────────────────────────

describe("modelFromSnapshot", () => {
  it("normalizes run, seats, units, ledger", () => {
    const m = modelFromSnapshot(SNAPSHOT);
    expect(m.run?.name).toBe("frost-anchor");
    expect(m.run?.phase).toBe("implement");
    expect(m.seats.map((s) => s.seat)).toEqual(["b", "a"]);
    expect(m.seats[1].capped).toBe(true);
    expect(m.units.length).toBe(4);
    expect(m.ledger.total).toBe(0.5);
    expect(m.ledger.budgetUsd).toBe(5);
    expect(m.ledger.fracUsed).toBeCloseTo(0.1);
    expect(m.ledger.exact).toBeCloseTo(0.4);
    expect(m.ledger.estimated).toBeCloseTo(0.1);
  });

  it("tolerates a fully empty state", () => {
    const m = modelFromSnapshot({});
    expect(m.run).toBeNull();
    expect(m.seats).toEqual([]);
    expect(m.ledger.total).toBe(0);
  });

  it("handles the doc-shaped snapshot where run is a name string + hoisted fields", () => {
    const m = modelFromSnapshot({
      run: "frost-anchor",
      id: 1,
      phase: "propose",
      status: "active",
      problem: "solve X",
      budgetUsd: null
    });
    expect(m.run?.name).toBe("frost-anchor");
    expect(m.run?.id).toBe(1);
    expect(m.run?.phase).toBe("propose");
    expect(m.run?.status).toBe("active");
    expect(m.run?.problem).toBe("solve X");
  });
});

// ── modelFromReads ───────────────────────────────────────────────────────────

describe("modelFromReads", () => {
  const status: RunStatus = {
    schemaVersion: 1,
    run: "frost-anchor",
    id: 1,
    phase: "plan",
    status: "active",
    epsilon: 2,
    problem: "solve X",
    criteria: "done when",
    routing: { mode: "auto", effective: "efficiency" },
    seats: [{ seat: "a", status: "idle", headroom: "medium", capped: false, resetsAt: null, tier: "cheap" }],
    headroom: [],
    gate: null
  };
  const report: Report = {
    schemaVersion: 1,
    run: "frost-anchor",
    id: 1,
    problem: "solve X",
    phase: "plan",
    status: "active",
    seats: ["a", "b"],
    units: [{ seq: 1, title: "u1", difficulty: "standard", tier: "cheap", author: "a", reviewer: "b", status: "done", commit: "abc", qa: "pass" }],
    qaFindings: [],
    ratchet: [],
    merges: [],
    validate: [],
    orchestratorReverify: null,
    ledger: [],
    totalCost: 0.5
  };
  const ledger: Ledger = {
    schemaVersion: 1,
    run: "frost-anchor",
    id: 1,
    perSeatModel: [{ seat: "a", model: "m1", turns: 2, cost: 0.5, mode: "exact" }],
    perTier: [{ key: "cheap", turns: 2, cost: 0.5, exact: 0.5, estimated: 0 }],
    perPhase: [{ key: "plan", turns: 2, cost: 0.5, exact: 0.5, estimated: 0 }],
    total: 0.5,
    exact: 0.5,
    estimated: 0,
    budgetUsd: 5,
    fracUsed: 0.1
  };

  it("builds a model from read commands", () => {
    const m = modelFromReads({ status, report, ledger });
    expect(m.run?.name).toBe("frost-anchor");
    expect(m.seats[0].seat).toBe("a");
    expect(m.units[0].title).toBe("u1");
    expect(m.units[0].status).toBe("done");
    expect(m.ledger.total).toBe(0.5);
  });

  it("reads the roster seat tier (schema 2) in the read-command fallback", () => {
    const m = modelFromReads({ status });
    expect(m.seats[0].tier).toBe("cheap");
  });

  it("omits tier (null) when the roster seat carries none (older engine)", () => {
    const noTier: RunStatus = {
      ...status,
      seats: [{ seat: "a", status: "idle", headroom: "medium", capped: false, resetsAt: null }]
    };
    expect(modelFromReads({ status: noTier }).seats[0].tier).toBeNull();
  });

  it("empty bundle yields the empty model", () => {
    expect(modelFromReads({})).toEqual(emptyModel());
  });
});

// ── Runs view ────────────────────────────────────────────────────────────────

describe("runsTree", () => {
  it("orders active first and shows phase/status/spend", () => {
    const nodes = runsTree(RUNS, "frost-anchor");
    expect(nodes[0].label).toBe("frost-anchor");
    expect(nodes[0].description).toContain("plan");
    expect(nodes[0].description).toContain("$1.23");
    expect(nodes[0].contextValue).toBe("conclaveRunActive");
    expect(nodes[0].runRef).toBe("frost-anchor");
    expect(nodes[0].children).toHaveLength(3);
    expect(nodes[1].contextValue).toBe("conclaveRun");
  });

  it("shows a placeholder when empty", () => {
    const nodes = runsTree([]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].label).toMatch(/no runs/i);
  });
});

// ── Seats view ───────────────────────────────────────────────────────────────

describe("seatsTree + seatChip", () => {
  it("renders one node per seat, sorted, with state chips", () => {
    const m = modelFromSnapshot(SNAPSHOT);
    const nodes = seatsTree(m.seats);
    expect(nodes.map((n) => n.label)).toEqual(["a", "b"]);
    const a = nodes[0];
    expect(a.description).toContain("capped");
    expect(a.description).toContain("cheap");
    expect(a.contextValue).toBe("conclaveSeatCapped");
  });

  it("seat nodes carry their seat name (for seat-scoped commands like takeover)", () => {
    const m = modelFromSnapshot(SNAPSHOT);
    const nodes = seatsTree(m.seats);
    expect(nodes[0].seat).toBe("a");
    expect(nodes[1].seat).toBe("b");
  });

  it("seatArgOf extracts the seat from a string, a {seat}, a tree node, or nothing (FIX #2)", () => {
    expect(seatArgOf("claude")).toBe("claude");
    expect(seatArgOf({ seat: "glm" })).toBe("glm");
    // The Seats tree passes its node; seat wins, else label = seat name.
    expect(seatArgOf({ key: "seat.codex", label: "codex" })).toBe("codex");
    expect(seatArgOf({ seat: "claude", label: "ignored" })).toBe("claude");
    expect(seatArgOf(undefined)).toBeUndefined();
    expect(seatArgOf({})).toBeUndefined();
    expect(seatArgOf(42)).toBeUndefined();
  });

  it("seatChip reflects capped/working/idle/paused", () => {
    expect(seatChip({ capped: true } as never).chip).toBe("capped");
    expect(seatChip({ capped: false, paused: true } as never).chip).toBe("paused");
    expect(seatChip({ capped: false, paused: false, status: "working" } as never).chip).toBe("live");
    expect(seatChip({ capped: false, paused: false, status: "idle" } as never).chip).toBe("idle");
  });

  it("placeholder when no seats", () => {
    expect(seatsTree([])[0].label).toMatch(/no seats/i);
  });

  it("renders the tier when present, and omits it when null (schema 2 mapping)", () => {
    const base = {
      status: "idle",
      paused: false,
      headroom: "medium",
      capped: false,
      resetsAt: null,
      cost: 0,
      costMode: "exact",
      turns: 0,
      currentItem: null
    };
    const [withTier] = seatsTree([{ ...base, seat: "a", tier: "premium" }]);
    expect(withTier.description).toContain("premium");
    const [noTier] = seatsTree([{ ...base, seat: "b", tier: null }]);
    expect(noTier.description).not.toContain("premium");
    // sanity: still renders the seat with its other state, just no tier chip.
    expect(noTier.description).toContain("headroom");
  });
});

// ── Board view ───────────────────────────────────────────────────────────────

describe("board grouping", () => {
  it("maps statuses to the five columns", () => {
    expect(unitColumn("pending")).toBe("Queued");
    expect(unitColumn("implemented")).toBe("Review");
    expect(unitColumn("qa_fail")).toBe("Building");
    expect(unitColumn("merged")).toBe("Done");
    expect(unitColumn("done")).toBe("Done");
    expect(unitColumn("blocked")).toBe("Blocked");
    expect(unitColumn("weird-unknown")).toBe("Queued");
  });

  it("groups units into columns", () => {
    const m = modelFromSnapshot(SNAPSHOT);
    const g = groupUnits(m.units);
    expect(g.Queued.map((u) => u.seq)).toEqual([3]);
    expect(g.Review.map((u) => u.seq)).toEqual([2]);
    expect(g.Done.map((u) => u.seq)).toEqual([1]);
    expect(g.Blocked.map((u) => u.seq)).toEqual([4]);
  });

  it("boardTree renders every column and unit shows seat + phase", () => {
    const m = modelFromSnapshot(SNAPSHOT);
    const nodes = boardTree(m.units, m.run);
    expect(nodes.map((n) => n.label)).toEqual(BOARD_COLUMNS);
    const review = nodes.find((n) => n.label === "Review")!;
    expect(review.description).toBe("1");
    const unit = review.children![0];
    expect(unit.label).toContain("logic");
    expect(unit.description).toContain("@b");
    expect(unit.description).toContain("implement"); // run phase
  });

  it("placeholder when no units", () => {
    expect(boardTree([], null)[0].label).toMatch(/no work units/i);
  });
});

// ── Ledger view ──────────────────────────────────────────────────────────────

describe("ledgerTree", () => {
  it("shows total vs budget and exact vs estimated rollups", () => {
    const m = modelFromSnapshot(SNAPSHOT);
    const nodes = ledgerTree(m.ledger);
    const total = nodes.find((n) => n.key === "ledger.total")!;
    expect(total.description).toContain("$5.00");
    expect(total.description).toContain("10%");
    expect(total.tooltip).toContain("estimated");
    const perTier = nodes.find((n) => n.key === "ledger.perTier")!;
    expect(perTier.children!.some((c) => c.description!.includes("est"))).toBe(true);
    const perSeat = nodes.find((n) => n.key === "ledger.perSeatModel")!;
    expect(perSeat.children).toHaveLength(2);
  });

  it("handles no budget", () => {
    const nodes = ledgerTree({ ...modelFromSnapshot({}).ledger });
    const total = nodes.find((n) => n.key === "ledger.total")!;
    expect(total.description).toMatch(/no budget/);
  });
});

// ── Status bar ───────────────────────────────────────────────────────────────

describe("statusBarModel", () => {
  it("prefers the live model with spend + phase", () => {
    const m = modelFromSnapshot(SNAPSHOT);
    const sb = statusBarModel(m, null);
    expect(sb.visible).toBe(true);
    expect(sb.text).toContain("frost-anchor");
    expect(sb.text).toContain("implement");
    expect(sb.text).toContain("$0.50");
    expect(sb.warning).toBe(false);
  });

  it("flags warning when a gate pends", () => {
    const m = modelFromSnapshot({ ...SNAPSHOT, gate: { gateId: 7, gateKind: "plan_approval", title: "t", body: [], actions: [] } });
    const sb = statusBarModel(m, null);
    expect(sb.warning).toBe(true);
  });

  it("falls back to a run summary", () => {
    const sb = statusBarModel(null, RUNS[0]);
    expect(sb.visible).toBe(true);
    expect(sb.text).toContain("frost-anchor");
  });

  it("hidden when nothing", () => {
    expect(statusBarModel(null, null).visible).toBe(false);
  });
});

// ── Gate model (snapshot + read shapes) ──────────────────────────────────────

describe("gate normalization", () => {
  it("normalizeGateKind maps known + unknown", () => {
    expect(normalizeGateKind("plan_approval")).toBe("plan_approval");
    expect(normalizeGateKind("decide_tie")).toBe("decide_tie");
    expect(normalizeGateKind("budget_exceeded")).toBe("budget_exceeded");
    expect(normalizeGateKind("mystery")).toBe("unknown");
  });

  it("gateFromSnapshot parses cockpit gate view + critique count", () => {
    const g = gateFromSnapshot(
      {
        gateId: 3,
        gateKind: "plan_approval",
        title: "GATE 3 — plan approval",
        body: ["plan v2 by a (hash abcd1234)", "critiques on v1: 4 finding(s), 3 addressed"],
        actions: [
          { key: "a", label: "approve", kind: "approve" },
          { key: "r", label: "reject + feedback", kind: "reject" }
        ]
      },
      5,
      1.2
    );
    expect(g?.kind).toBe("plan_approval");
    expect(g?.critiqueCount).toBe(4);
  });

  it("gateFromSnapshot extracts tie winners from actions", () => {
    const g = gateFromSnapshot(
      {
        gateId: 4,
        gateKind: "decide_tie",
        title: "tie",
        body: ["decide tied"],
        actions: [
          { key: "1", label: "pick a", kind: "tie", winner: "a" },
          { key: "2", label: "pick b", kind: "tie", winner: "b" }
        ]
      },
      null,
      0
    );
    expect(g?.winners).toEqual(["a", "b"]);
  });

  it("gateFromRead parses gate show shape with options + critiques", () => {
    const gs: GateShow = {
      schemaVersion: 1,
      run: "r",
      id: 1,
      gate: {
        id: 3,
        kind: "decide_tie",
        status: "pending",
        critiques: [],
        options: [
          { action: "approve", winner: "a" },
          { action: "approve", winner: "b" }
        ]
      }
    };
    const g = gateFromRead(gs, null);
    expect(g?.kind).toBe("decide_tie");
    expect(g?.winners).toEqual(["a", "b"]);
  });

  it("gateFromRead attaches budget context for budget gates", () => {
    const gs: GateShow = { schemaVersion: 1, run: "r", id: 1, gate: { id: 9, kind: "budget_exceeded", status: "pending" } };
    const budget: BudgetShow = { schemaVersion: 1, run: "r", id: 1, budgetUsd: 5, spent: 6, fracUsed: 120, headroom: null, exceeded: true };
    const g = gateFromRead(gs, budget);
    expect(g?.budget).toEqual({ budgetUsd: 5, spent: 6 });
  });

  it("gateFromRead returns null when no gate", () => {
    expect(gateFromRead({ schemaVersion: 1, run: "r", id: 1, gate: null }, null)).toBeNull();
  });
});

// ── Gate → notification spec ─────────────────────────────────────────────────

describe("gateNotificationSpec", () => {
  it("plan gate → Approve / Reject(+feedback)", () => {
    const g = gateFromRead(
      { schemaVersion: 1, run: "r", id: 1, gate: { id: 3, kind: "plan_approval", status: "pending", critiques: [{ ordinal: 1, severity: "high", seat: "b", claim: "c", evidence: "e" }] } },
      null
    )!;
    const spec = gateNotificationSpec(g);
    expect(spec.severity).toBe("info");
    expect(spec.detail).toContain("1 critique");
    expect(spec.actions.map((a) => a.kind)).toEqual(["approve", "reject"]);
    expect(spec.actions[1].needsFeedback).toBe(true);
  });

  it("tie gate → one Pick button per winner", () => {
    const g = gateFromRead(
      { schemaVersion: 1, run: "r", id: 1, gate: { id: 4, kind: "decide_tie", status: "pending", options: [{ action: "approve", winner: "a" }, { action: "approve", winner: "b" }] } },
      null
    )!;
    const spec = gateNotificationSpec(g);
    expect(spec.actions.map((a) => a.label)).toEqual(["Pick a", "Pick b"]);
    expect(spec.actions.every((a) => a.kind === "winner")).toBe(true);
  });

  it("budget gate → Raise(+amount) / Stop, warning severity", () => {
    const g = gateFromRead(
      { schemaVersion: 1, run: "r", id: 1, gate: { id: 9, kind: "budget_exceeded", status: "pending" } },
      { schemaVersion: 1, run: "r", id: 1, budgetUsd: 5, spent: 6, fracUsed: 120, headroom: null, exceeded: true }
    )!;
    const spec = gateNotificationSpec(g);
    expect(spec.severity).toBe("warning");
    expect(spec.actions.find((a) => a.kind === "raise")!.needsAmount).toBe(true);
    expect(spec.actions.find((a) => a.kind === "stop")!.destructive).toBe(true);
  });

  it("validate_failed → openReport + acknowledge", () => {
    const g = gateFromRead({ schemaVersion: 1, run: "r", id: 1, gate: { id: 2, kind: "validate_failed", status: "pending" } }, null)!;
    const spec = gateNotificationSpec(g);
    expect(spec.actions.map((a) => a.kind)).toContain("openReport");
    expect(spec.actions.map((a) => a.kind)).toContain("approve");
  });
});

// ── Gate resolution wiring ───────────────────────────────────────────────────

describe("resolveGateCall", () => {
  const approve: GateActionSpec = { id: "approve", label: "Approve", kind: "approve" };
  const reject: GateActionSpec = { id: "reject", label: "Reject", kind: "reject", needsFeedback: true };
  const winner: GateActionSpec = { id: "w:a", label: "Pick a", kind: "winner", winner: "a" };
  const raise: GateActionSpec = { id: "raise", label: "Raise", kind: "raise", needsAmount: true };
  const stop: GateActionSpec = { id: "stop", label: "Stop", kind: "stop" };

  it("approve → gateApprove", () => {
    expect(resolveGateCall(approve, { run: "r", feedback: "lgtm" })).toEqual({
      method: "gateApprove",
      opts: { run: "r", feedback: "lgtm" }
    });
  });

  it("reject → gateReject with feedback", () => {
    expect(resolveGateCall(reject, { run: "r", feedback: "no" })).toEqual({
      method: "gateReject",
      opts: { run: "r", feedback: "no" }
    });
  });

  it("winner → gateApprove --winner", () => {
    expect(resolveGateCall(winner, { run: "r" })).toEqual({
      method: "gateApprove",
      opts: { run: "r", winner: "a", feedback: undefined }
    });
  });

  it("raise → budgetRaise with amount", () => {
    expect(resolveGateCall(raise, { run: "r", amount: 10 })).toEqual({
      method: "budgetRaise",
      opts: { run: "r", toUsd: 10 }
    });
  });

  it("raise without amount throws", () => {
    expect(() => resolveGateCall(raise, { run: "r" })).toThrow();
  });

  it("stop → stop", () => {
    expect(resolveGateCall(stop, { run: "r" })).toEqual({ method: "stop" });
  });
});

// ── Start-run inputs → args + preflight ──────────────────────────────────────

describe("start-run view-model", () => {
  const inputs: StartRunInputs = {
    goal: "  build a thing  ",
    criteria: "  passes tests ",
    seats: " claude, glm ,codex ",
    domain: "coding",
    approval: "plan-only",
    routing: "auto",
    budgetUsd: 5,
    fullAuto: false
  };

  it("seatArray trims + drops blanks", () => {
    expect(seatArray(inputs.seats)).toEqual(["claude", "glm", "codex"]);
  });

  it("buildStartRunArgs trims + joins + keeps budget", () => {
    const args = buildStartRunArgs(inputs);
    expect(args.problem).toBe("build a thing");
    expect(args.criteria).toBe("passes tests");
    expect(args.seats).toBe("claude,glm,codex");
    expect(args.budgetUsd).toBe(5);
    expect(args.domain).toBe("coding");
  });

  it("blank criteria defaults (engine requires it)", () => {
    const args = buildStartRunArgs({ ...inputs, criteria: "  " });
    expect(args.criteria).toBeTruthy();
  });

  it("validation rejects empty goal / no seats / bad budget", () => {
    expect(validateStartRunInputs({ goal: "", seats: "a" }).ok).toBe(false);
    expect(validateStartRunInputs({ goal: "g", seats: "" }).ok).toBe(false);
    expect(validateStartRunInputs({ goal: "g", seats: "a", budgetUsd: -1 }).ok).toBe(false);
    expect(validateStartRunInputs({ goal: "g", seats: "a", budgetUsd: 5 }).ok).toBe(true);
  });

  it("preflight text mentions seats, budget, autonomy + spend", () => {
    const t = preflightText(inputs);
    expect(t).toContain("3 seat");
    expect(t).toContain("$5.00");
    expect(t).toContain("plan-only");
    expect(t.toLowerCase()).toContain("spend");
  });

  it("preflight required unless full-auto", () => {
    expect(requiresPreflightConfirm(inputs)).toBe(true);
    expect(requiresPreflightConfirm({ ...inputs, fullAuto: true })).toBe(false);
  });

  it("no-budget preflight reads 'no ceiling'", () => {
    expect(preflightText({ ...inputs, budgetUsd: null })).toContain("no ceiling");
  });

  it("preflight names the build target and flags a live-repo target", () => {
    const scratch = planBuildTarget({
      configuredTargetDir: "",
      workspaceRoot: "/home/me/proj",
      scratchRoot: "/tmp/conclave-builds",
      runLabel: "123"
    });
    const t1 = preflightText(inputs, scratch);
    expect(t1).toContain("Fleet will build in:");
    expect(t1).toContain("/tmp/conclave-builds/build-123");
    expect(t1).toContain("isolated scratch");
    expect(t1).not.toContain("LIVE workspace");

    const live = planBuildTarget({
      configuredTargetDir: "/home/me/proj",
      workspaceRoot: "/home/me/proj",
      scratchRoot: "/tmp/conclave-builds",
      runLabel: "123"
    });
    expect(preflightText(inputs, live)).toContain("LIVE workspace");
  });
});

// ── Build-target safety (repo + spend safety) ────────────────────────────────

describe("planBuildTarget", () => {
  it("defaults to an isolated scratch dir under scratchRoot — NEVER the workspace root", () => {
    const plan = planBuildTarget({
      configuredTargetDir: "",
      workspaceRoot: "/home/me/proj",
      scratchRoot: "/tmp/conclave-builds",
      runLabel: "run-42"
    });
    expect(plan.mode).toBe("scratch");
    expect(plan.warnLiveRepo).toBe(false);
    expect(plan.target).toBe("/tmp/conclave-builds/build-run-42");
    expect(plan.target).not.toBe("/home/me/proj");
    expect(plan.target.startsWith("/tmp/conclave-builds/")).toBe(true);
  });

  it("uses an explicit configured target dir", () => {
    const plan = planBuildTarget({
      configuredTargetDir: "/scratch/builds/here",
      workspaceRoot: "/home/me/proj",
      scratchRoot: "/tmp/conclave-builds",
      runLabel: "x"
    });
    expect(plan.mode).toBe("explicit");
    expect(plan.target).toBe("/scratch/builds/here");
    expect(plan.warnLiveRepo).toBe(false);
  });

  it("warns when the explicit target IS the live workspace root (incl. trailing slash)", () => {
    const plan = planBuildTarget({
      configuredTargetDir: "/home/me/proj/",
      workspaceRoot: "/home/me/proj",
      scratchRoot: "/tmp/conclave-builds",
      runLabel: "x"
    });
    expect(plan.mode).toBe("explicit");
    expect(plan.warnLiveRepo).toBe(true);
  });

  it("sanitizes the run label into a single safe scratch dir segment", () => {
    const plan = planBuildTarget({
      configuredTargetDir: "",
      workspaceRoot: "/w",
      scratchRoot: "/tmp/cb",
      runLabel: "frost anchor/evil"
    });
    // The slash is sanitized to '-', so it stays a single dir under scratchRoot
    // and can never escape into the workspace.
    expect(plan.target).toBe("/tmp/cb/build-frost-anchor-evil");
    expect(plan.target).not.toContain(" ");
  });
});

// ── Orchestrate arg construction ─────────────────────────────────────────────

describe("buildOrchestrateArgs", () => {
  it("builds the execute drive args mirroring the cockpit fleet spawn", () => {
    const args = buildOrchestrateArgs(
      {
        nodePath: "/node",
        enginePath: "/engine/collab.mjs",
        cwd: "/work",
        storePath: "/work/.collab/store.db",
        adaptersDir: "/work/adapters",
        execute: true,
        target: "/tmp/conclave-builds/build-7",
        routing: "auto",
        budgetUsd: 5
      },
      7
    );
    expect(args[0]).toBe("/engine/collab.mjs");
    expect(args).toContain("--store");
    expect(args).toContain("/work/.collab/store.db");
    expect(args.slice(args.indexOf("orchestrate"))).toEqual(
      expect.arrayContaining([
        "orchestrate",
        "--run",
        "7",
        "--adapters-dir",
        "/work/adapters",
        "--execute",
        "--target",
        "/tmp/conclave-builds/build-7",
        "--routing",
        "auto",
        "--budget",
        "5"
      ])
    );
  });

  it("omits execute-only flags when not executing", () => {
    const args = buildOrchestrateArgs({ nodePath: "/n", enginePath: "/e", cwd: "/w" }, 1);
    expect(args).not.toContain("--execute");
    expect(args).not.toContain("--target");
    expect(args).toContain("--adapters-dir");
  });

  it("REFUSES to --execute without an explicit target (never the workspace root)", () => {
    expect(() => buildOrchestrateArgs({ nodePath: "/n", enginePath: "/e", cwd: "/w", execute: true }, 1)).toThrow(
      /explicit build target/
    );
  });

  it("uses the explicit target verbatim (does not fall back to cwd)", () => {
    const args = buildOrchestrateArgs(
      { nodePath: "/n", enginePath: "/e", cwd: "/live/repo", execute: true, target: "/tmp/scratch/build-1" },
      3
    );
    expect(args[args.indexOf("--target") + 1]).toBe("/tmp/scratch/build-1");
    expect(args).not.toContain("/live/repo");
  });
});
