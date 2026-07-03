/**
 * Headless unit tests for E3's typed extension↔webview protocol — the pure
 * message layer that keeps the thin-client contract from drifting.
 *
 *  • extension side: a raw `collab watch --json` line → the correct outbound
 *    postMessage (`translateWatchLine`), and the normalized builders;
 *  • webview side: a clicked gate action → the correct upward request
 *    (`resolveGateRequest`), plus the ready/focus requests.
 *
 * No DOM, no vscode.
 */
import { describe, expect, it } from "vitest";

import {
  translateWatchLine,
  stateMessage,
  streamMessage,
  eventMessage,
  gateMessage,
  themeMessage,
  resolveGateRequest,
  readyRequest,
  focusRequest,
  type CockpitSnapshot
} from "../src/webview/protocol.js";
import { emptyModel } from "../src/viewmodels/model.js";
import { gateNotificationSpec } from "../src/viewmodels/gate.js";

describe("protocol — extension side (WatchClient line → postMessage)", () => {
  it("translates a stream line into a stream message", () => {
    const msg = translateWatchLine({ type: "stream", seat: "claude", line: "▸ working" });
    expect(msg).toEqual({ type: "stream", seat: "claude", line: "▸ working" });
  });

  it("translates an event line into an event message", () => {
    const event = { type: "exec_item_status", itemId: 2, seat: "glm" };
    const msg = translateWatchLine({ type: "event", event });
    expect(msg).toEqual({ type: "event", event });
  });

  it("returns null for snapshot/reset lines (they trigger a normalized re-post)", () => {
    expect(translateWatchLine({ type: "snapshot" })).toBeNull();
    expect(translateWatchLine({ type: "reset" })).toBeNull();
  });

  it("returns null for a malformed stream line (missing fields)", () => {
    expect(translateWatchLine({ type: "stream" })).toBeNull();
  });

  it("builds a normalized state message carrying model + tally + driver", () => {
    const snapshot: CockpitSnapshot = {
      model: emptyModel(),
      tally: { totals: [{ label: "P1", seat: "claude", total: 5 }], winnerSeat: "claude", winnerLabel: "P1", margin: 5, escalate: false, reason: "" },
      driver: true
    };
    const msg = stateMessage(snapshot);
    expect(msg.type).toBe("state");
    expect(msg).toMatchObject({ type: "state", snapshot: { driver: true } });
  });

  it("builds stream / event / gate / theme messages", () => {
    expect(streamMessage("a", "x")).toEqual({ type: "stream", seat: "a", line: "x" });
    expect(eventMessage({ type: "seat_joined" })).toEqual({ type: "event", event: { type: "seat_joined" } });
    const spec = gateNotificationSpec({
      gateId: 1,
      kind: "plan_approval",
      rawKind: "plan_approval",
      title: "t",
      body: [],
      critiqueCount: null,
      winners: [],
      budget: null
    });
    expect(gateMessage(spec, false)).toEqual({ type: "gate", spec, driver: false });
    expect(gateMessage(null, true)).toEqual({ type: "gate", spec: null, driver: true });
    expect(themeMessage("light")).toEqual({ type: "theme", kind: "light" });
  });
});

describe("protocol — webview side (action → upward request)", () => {
  it("builds a plain approve request", () => {
    expect(resolveGateRequest(3, "approve")).toEqual({ type: "resolveGate", gateId: 3, actionId: "approve" });
  });

  it("carries feedback for a reject", () => {
    expect(resolveGateRequest(3, "reject", { feedback: "no" })).toEqual({
      type: "resolveGate",
      gateId: 3,
      actionId: "reject",
      feedback: "no"
    });
  });

  it("carries a numeric amount for a budget raise", () => {
    expect(resolveGateRequest(9, "raise", { amount: 12 })).toEqual({
      type: "resolveGate",
      gateId: 9,
      actionId: "raise",
      amount: 12
    });
  });

  it("carries a winner for a tie-break pick", () => {
    expect(resolveGateRequest(5, "winner:claude", { winner: "claude" })).toEqual({
      type: "resolveGate",
      gateId: 5,
      actionId: "winner:claude",
      winner: "claude"
    });
  });

  it("omits absent optional fields (no undefined keys on the wire)", () => {
    const msg = resolveGateRequest(1, "approve");
    expect(Object.keys(msg)).toEqual(["type", "gateId", "actionId"]);
  });

  it("builds ready + focus requests", () => {
    expect(readyRequest()).toEqual({ type: "ready" });
    expect(focusRequest("streams")).toEqual({ type: "focus", view: "streams" });
    expect(focusRequest("board")).toEqual({ type: "focus", view: "board" });
  });
});

describe("protocol — round-trip integration with the gate view-model", () => {
  it("a spec's action id round-trips to a resolvable request", () => {
    const spec = gateNotificationSpec({
      gateId: 7,
      kind: "decide_tie",
      rawKind: "decide_tie",
      title: "tie",
      body: [],
      critiqueCount: null,
      winners: ["claude", "glm"],
      budget: null
    });
    const pick = spec.actions.find((a) => a.winner === "glm")!;
    const req = resolveGateRequest(spec.gateId, pick.id, { winner: pick.winner });
    expect(req).toMatchObject({ type: "resolveGate", gateId: 7, actionId: pick.id, winner: "glm" });
  });
});
