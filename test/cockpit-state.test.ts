/**
 * Headless unit tests for E3's pure cockpit state layer — the reducer that folds
 * a snapshot + a stream of events/streams/gates into board columns, stream
 * buffers, gate state, tally, cost, and the phase pipeline. No DOM, no vscode.
 *
 * These cover the bulk of E3's real logic: column derivation (asserting it reuses
 * E2's `unitColumn`), QA-card detection, stream capping/virtualization, gate/theme
 * folding, and the phase-stage mapping.
 */
import { describe, expect, it } from "vitest";

import {
  cockpitReducer,
  initialCockpitState,
  deriveColumns,
  phaseStage,
  phaseIndex,
  describeEvent,
  STREAM_CAP,
  ACTIVITY_CAP,
  type CockpitState
} from "../src/webview/state.js";
import { modelFromSnapshot, type SnapshotState } from "../src/viewmodels/model.js";
import { unitColumn } from "../src/viewmodels/board.js";
import { vendorFor } from "../src/webview/vendorColors.js";
import { gateNotificationSpec } from "../src/viewmodels/gate.js";
import type { CockpitSnapshot, ExtensionToWebview } from "../src/webview/protocol.js";

const SNAPSHOT: SnapshotState = {
  run: { name: "frost-anchor", id: 1, phase: "implement", status: "active", problem: "solve X", budget_usd: 5 },
  seats: [
    { seat: "claude", status: "working", tier: "premium", cost: 0.4, costMode: "exact", turns: 3 },
    { seat: "glm", status: "idle", tier: "cheap", cost: 0.1, costMode: "estimated", turns: 1 }
  ],
  units: [
    { seq: 1, title: "scaffold", status: "merged", author_seat: "claude", reviewer_seat: "glm", required_tier: "cheap" },
    { seq: 2, title: "logic", status: "implemented", author_seat: "glm", reviewer_seat: "claude", required_tier: "premium" },
    { seq: 3, title: "polish", status: "pending", author_seat: null, reviewer_seat: null, required_tier: "cheap" },
    { seq: 4, title: "broke", status: "blocked", author_seat: "claude", reviewer_seat: "glm", required_tier: "cheap" },
    { seq: 5, title: "skip", status: "excused", author_seat: "glm", reviewer_seat: null, required_tier: "cheap" }
  ],
  ledger: [
    { seat: "glm", model: "glm-4.6", turns: 1, cost: 0.1, mode: "estimated" },
    { seat: "claude", model: "claude-opus", turns: 3, cost: 0.4, mode: "exact" }
  ],
  perTier: [
    { key: "cheap", turns: 1, cost: 0.1, exact: 0, estimated: 0.1 },
    { key: "premium", turns: 3, cost: 0.4, exact: 0.4, estimated: 0 }
  ],
  totalCost: 0.5,
  budgetUsd: 5,
  tally: {
    totals: [
      { label: "P1", seat: "claude", total: 18 },
      { label: "P2", seat: "glm", total: 12 }
    ],
    winnerSeat: "claude",
    winnerLabel: "P1",
    margin: 6,
    escalate: false,
    reason: "clear winner by 6"
  },
  gate: null
};

function stateMsg(driver = true): ExtensionToWebview {
  const snap: CockpitSnapshot = { model: modelFromSnapshot(SNAPSHOT), tally: null, driver };
  snap.tally = {
    totals: [
      { label: "P1", seat: "claude", total: 18 },
      { label: "P2", seat: "glm", total: 12 }
    ],
    winnerSeat: "claude",
    winnerLabel: "P1",
    margin: 6,
    escalate: false,
    reason: "clear winner by 6"
  };
  return { type: "state", snapshot: snap };
}

function fold(msgs: ExtensionToWebview[], start?: CockpitState): CockpitState {
  return msgs.reduce((s, m) => cockpitReducer(s, m), start ?? initialCockpitState());
}

describe("cockpitReducer — state / board", () => {
  it("folds a snapshot into board columns via E2's unitColumn (integration)", () => {
    const s = fold([stateMsg()]);
    // Every card lands in exactly the column E2's mapping dictates.
    for (const u of s.model.units) {
      const col = unitColumn(u.status);
      expect(s.columns[col].some((c) => c.seq === u.seq)).toBe(true);
    }
    expect(s.columns.Done.map((c) => c.seq)).toEqual([1]); // merged
    expect(s.columns.Review.map((c) => c.seq)).toEqual([2]); // implemented
    expect(s.columns.Queued.map((c) => c.seq)).toEqual([3]); // pending
    // blocked + excused share the Blocked/Excused lane.
    expect(s.columns.Blocked.map((c) => c.seq)).toEqual([4, 5]);
  });

  it("deriveColumns matches unitColumn for every unit and sorts by seq", () => {
    const model = modelFromSnapshot(SNAPSHOT);
    const cols = deriveColumns(model);
    for (const u of model.units) {
      expect(cols[unitColumn(u.status)].some((c) => c.seq === u.seq)).toBe(true);
    }
    expect(cols.Blocked.map((c) => c.seq)).toEqual([4, 5]); // sorted
  });

  it("flags a cross-QA card (reviewer ≠ author) only in the Review column", () => {
    const s = fold([stateMsg()]);
    const review = s.columns.Review[0];
    expect(review.isCrossQA).toBe(true);
    expect(review.reviewer).toBe("claude");
    expect(review.seat).toBe("glm");
    // A Done card is not marked cross-QA even though reviewer ≠ author.
    expect(s.columns.Done[0].isCrossQA).toBe(false);
  });

  it("attaches per-vendor colours to each card's seat", () => {
    const s = fold([stateMsg()]);
    const done = s.columns.Done[0];
    expect(done.seatColor?.vendor).toBe(vendorFor("claude", "claude-opus").vendor);
    expect(done.seatColor?.vendor).toBe("claude");
  });

  it("a qa_fail (reverted) unit stays in Building AND carries the rework marker", () => {
    const reverted = structuredClone(SNAPSHOT);
    reverted.units![1].status = "qa_fail"; // QA failed, commit reverted, fix enqueued
    const s = cockpitReducer(initialCockpitState(), {
      type: "state",
      snapshot: { model: modelFromSnapshot(reverted), tally: null, driver: true }
    });
    // It IS being reworked, not terminally blocked → Building, not Blocked.
    expect(s.columns.Building.some((c) => c.seq === 2)).toBe(true);
    expect(s.columns.Blocked.some((c) => c.seq === 2)).toBe(false);
    // …but it must be visually distinguishable from clean in-progress work.
    const card = s.columns.Building.find((c) => c.seq === 2)!;
    expect(card.isRework).toBe(true);
    expect(card.status).toBe("qa_fail"); // data-status renders qa_fail, not just the column
    // A clean in-progress unit in the same column is NOT flagged.
    const clean = structuredClone(SNAPSHOT);
    clean.units![1].status = "implementing";
    const s2 = cockpitReducer(initialCockpitState(), {
      type: "state",
      snapshot: { model: modelFromSnapshot(clean), tally: null, driver: true }
    });
    expect(s2.columns.Building.find((c) => c.seq === 2)!.isRework).toBe(false);
  });

  it("a unit that fails QA moves to Blocked, then back to Building on retry", () => {
    let s = fold([stateMsg()]);
    expect(s.columns.Building.some((c) => c.seq === 2)).toBe(false);

    const failed = structuredClone(SNAPSHOT);
    failed.units![1].status = "blocked"; // unit 2 fails QA
    s = cockpitReducer(s, { type: "state", snapshot: { model: modelFromSnapshot(failed), tally: null, driver: true } });
    expect(s.columns.Blocked.some((c) => c.seq === 2)).toBe(true);

    const retry = structuredClone(SNAPSHOT);
    retry.units![1].status = "implementing"; // reopened / retried
    s = cockpitReducer(s, { type: "state", snapshot: { model: modelFromSnapshot(retry), tally: null, driver: true } });
    expect(s.columns.Building.some((c) => c.seq === 2)).toBe(true);
    expect(s.columns.Blocked.some((c) => c.seq === 2)).toBe(false);
  });
});

describe("cockpitReducer — cost & tally", () => {
  it("derives per-seat + total cost with exact/estimated split", () => {
    const s = fold([stateMsg()]);
    expect(s.cost.total).toBeCloseTo(0.5);
    expect(s.cost.exact).toBeCloseTo(0.4);
    expect(s.cost.estimated).toBeCloseTo(0.1);
    expect(s.cost.perSeat.map((r) => r.seat).sort()).toEqual(["claude", "glm"]);
    const glm = s.cost.perSeat.find((r) => r.seat === "glm")!;
    expect(glm.mode).toBe("estimated");
    expect(s.cost.budgetUsd).toBe(5);
  });

  it("carries the decide tally through", () => {
    const s = fold([stateMsg()]);
    expect(s.tally?.winnerSeat).toBe("claude");
    expect(s.tally?.totals).toHaveLength(2);
  });
});

describe("cockpitReducer — stream buffers (cap / virtualize)", () => {
  it("appends per-seat lines and tracks stream order", () => {
    const s = fold([
      { type: "stream", seat: "claude", line: "hello" },
      { type: "stream", seat: "glm", line: "world" },
      { type: "stream", seat: "claude", line: "again" }
    ]);
    expect(s.streams.claude.lines).toEqual(["hello", "again"]);
    expect(s.streams.glm.lines).toEqual(["world"]);
    expect(s.streamOrder).toEqual(["claude", "glm"]);
  });

  it("caps a seat's buffer at STREAM_CAP and counts dropped lines", () => {
    const msgs: ExtensionToWebview[] = [];
    const N = STREAM_CAP + 250;
    for (let i = 0; i < N; i++) msgs.push({ type: "stream", seat: "claude", line: `L${i}` });
    const s = fold(msgs);
    expect(s.streams.claude.lines).toHaveLength(STREAM_CAP);
    expect(s.streams.claude.dropped).toBe(250);
    // Newest retained, oldest trimmed.
    expect(s.streams.claude.lines[s.streams.claude.lines.length - 1]).toBe(`L${N - 1}`);
    expect(s.streams.claude.lines[0]).toBe(`L${250}`);
  });

  it("does not mutate the previous state's buffer (pure)", () => {
    const a = cockpitReducer(initialCockpitState(), { type: "stream", seat: "x", line: "1" });
    const b = cockpitReducer(a, { type: "stream", seat: "x", line: "2" });
    expect(a.streams.x.lines).toEqual(["1"]);
    expect(b.streams.x.lines).toEqual(["1", "2"]);
  });
});

describe("cockpitReducer — gate / event / theme", () => {
  it("stores the gate spec + driver flag; clears on null", () => {
    const spec = gateNotificationSpec({
      gateId: 3,
      kind: "plan_approval",
      rawKind: "plan_approval",
      title: "t",
      body: [],
      critiqueCount: 1,
      winners: [],
      budget: null
    });
    let s = cockpitReducer(initialCockpitState(), { type: "gate", spec, driver: false });
    expect(s.gate?.gateId).toBe(3);
    expect(s.driver).toBe(false);
    s = cockpitReducer(s, { type: "gate", spec: null, driver: true });
    expect(s.gate).toBeNull();
    expect(s.driver).toBe(true);
  });

  it("appends events to a capped activity log", () => {
    const msgs: ExtensionToWebview[] = [];
    for (let i = 0; i < ACTIVITY_CAP + 20; i++) msgs.push({ type: "event", event: { type: "exec_item_status", itemId: i } });
    const s = fold(msgs);
    expect(s.activity).toHaveLength(ACTIVITY_CAP);
    expect(s.activity[s.activity.length - 1]).toBe(`exec_item_status #${ACTIVITY_CAP + 19}`);
  });

  it("describeEvent renders type + seat + item", () => {
    expect(describeEvent({ type: "seat_joined", seat: "claude" })).toBe("seat_joined claude");
    expect(describeEvent({ type: "exec_item_status", itemId: 7 })).toBe("exec_item_status #7");
  });

  it("records theme kind", () => {
    const s = cockpitReducer(initialCockpitState(), { type: "theme", kind: "high-contrast" });
    expect(s.themeKind).toBe("high-contrast");
  });
});

describe("phase pipeline", () => {
  it("maps finer engine phases onto pipeline stages", () => {
    expect(phaseStage("plan_review")).toBe("plan");
    expect(phaseStage("plan_revise")).toBe("plan");
    expect(phaseStage("score")).toBe("decide");
    expect(phaseStage("reconcile")).toBe("merge");
    expect(phaseStage("implement")).toBe("implement");
    expect(phaseStage("nonsense")).toBeNull();
    expect(phaseStage(null)).toBeNull();
  });

  it("indexes the current phase in the pipeline", () => {
    expect(phaseIndex("propose")).toBe(0);
    expect(phaseIndex("implement")).toBe(4);
    expect(phaseIndex("done")).toBe(9);
    expect(phaseIndex("nonsense")).toBe(-1);
  });
});
