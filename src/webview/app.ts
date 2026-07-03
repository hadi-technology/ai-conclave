/**
 * The webview app — a thin, dependency-free DOM projection of the pure cockpit
 * state (state.ts). It holds NO engine access: it renders whatever the extension
 * posts down, and posts action *requests* back up (item 6). All real logic lives
 * in the tested reducer; this file is the sandboxed view + a light FLIP animation
 * so cards visibly flow across columns. Bundled by esbuild for the webview.
 */
import {
  cockpitReducer,
  initialCockpitState,
  phaseIndex,
  PHASE_PIPELINE,
  type Card,
  type CockpitState
} from "./state.js";
import { BOARD_COLUMNS, type BoardColumn } from "../viewmodels/board.js";
import type { GateActionSpec } from "../viewmodels/gate.js";
import {
  focusRequest,
  readyRequest,
  resolveGateRequest,
  type ExtensionToWebview,
  type WebviewToExtension
} from "./protocol.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare function acquireVsCodeApi(): { postMessage(msg: WebviewToExtension): void };
const vscode = acquireVsCodeApi();

const COLUMN_TITLE: Record<BoardColumn, string> = {
  Queued: "Queued",
  Building: "Building",
  Review: "Review · cross-QA",
  Done: "Done",
  Blocked: "Blocked / Excused"
};

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let state: CockpitState = initialCockpitState();
let activeTab: "board" | "streams" = "board";

// Persistent card elements, keyed by unit seq — enables FLIP movement.
const cardEls = new Map<number, HTMLElement>();

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function post(msg: WebviewToExtension): void {
  vscode.postMessage(msg);
}

// ── Board ────────────────────────────────────────────────────────────────────

function chip(seat: string | null, color: { color: string; fg: string } | null, prefix = ""): HTMLElement {
  const c = el("span", "chip", `${prefix}${seat ?? "—"}`);
  if (color) {
    c.style.background = color.color;
    c.style.color = color.fg;
  } else {
    c.classList.add("chip-muted");
  }
  return c;
}

function renderCardInto(target: HTMLElement, card: Card): void {
  target.className = "card";
  target.dataset.status = card.status;
  target.replaceChildren();

  const head = el("div", "card-head");
  head.append(el("span", "card-seq", `#${card.seq}`));
  head.append(el("span", "card-title", card.title));
  target.append(head);

  const meta = el("div", "card-meta");
  meta.append(chip(card.seat, card.seatColor));
  if (card.tier) meta.append(el("span", "tag", card.tier));
  meta.append(el("span", "tag phase-tag", card.phase));
  if (card.isRework) meta.append(el("span", "tag rework-tag", "⟲ reverted"));
  target.append(meta);

  if (card.isCrossQA && card.reviewer) {
    const qa = el("div", "card-qa");
    qa.append(el("span", "qa-label", "QA"));
    qa.append(chip(card.reviewer, card.reviewerColor, ""));
    qa.append(el("span", "qa-sep", "reviews"));
    qa.append(chip(card.seat, card.seatColor, ""));
    target.append(qa);
  }
}

function renderBoard(root: HTMLElement): void {
  // FLIP: capture old positions.
  const firstRects = new Map<number, DOMRect>();
  if (!reducedMotion) {
    for (const [seq, node] of cardEls) firstRects.set(seq, node.getBoundingClientRect());
  }

  const board = el("div", "board");
  const present = new Set<number>();

  for (const col of BOARD_COLUMNS) {
    const cards = state.columns[col];
    const column = el("div", "column");
    column.dataset.col = col;
    const header = el("div", "column-header");
    header.append(el("span", "column-name", COLUMN_TITLE[col]));
    header.append(el("span", "column-count", String(cards.length)));
    column.append(header);
    const body = el("div", "column-body");

    for (const card of cards) {
      present.add(card.seq);
      let node = cardEls.get(card.seq);
      if (!node) {
        node = el("div", "card");
        cardEls.set(card.seq, node);
        if (!reducedMotion) node.classList.add("card-enter");
      }
      renderCardInto(node, card);
      body.append(node);
    }
    if (cards.length === 0) body.append(el("div", "column-empty", "—"));
    column.append(body);
    board.append(column);
  }

  // Drop stale cards.
  for (const seq of [...cardEls.keys()]) if (!present.has(seq)) cardEls.delete(seq);

  root.replaceChildren(board);

  // FLIP: play movement from old → new positions.
  if (!reducedMotion) {
    for (const [seq, node] of cardEls) {
      const first = firstRects.get(seq);
      if (!first) continue;
      const last = node.getBoundingClientRect();
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      node.style.transform = `translate(${dx}px, ${dy}px)`;
      node.style.transition = "none";
      requestAnimationFrame(() => {
        node.style.transition = "transform 320ms cubic-bezier(0.2, 0.8, 0.2, 1)";
        node.style.transform = "";
      });
    }
  }
}

// ── Top lane: phases, tally, cost ─────────────────────────────────────────────

function renderPhases(): HTMLElement {
  const lane = el("div", "phases");
  const idx = phaseIndex(state.phase);
  PHASE_PIPELINE.forEach((p, i) => {
    const step = el("span", "phase-step", p);
    if (idx >= 0 && i < idx) step.classList.add("phase-done");
    if (idx === i) step.classList.add("phase-current");
    lane.append(step);
  });
  return lane;
}

function money(n: number): string {
  return `$${n.toFixed(n >= 1 ? 2 : 4)}`;
}

function renderCost(): HTMLElement {
  const box = el("div", "cost");
  const total = el("div", "cost-total");
  total.append(el("span", "cost-num", money(state.cost.total)));
  total.append(el("span", "cost-sub", `exact ${money(state.cost.exact)} · est ${money(state.cost.estimated)}`));
  if (state.cost.budgetUsd != null) {
    const frac = state.cost.fracUsed != null ? ` (${Math.round(state.cost.fracUsed * 100)}%)` : "";
    total.append(el("span", "cost-sub", `budget ${money(state.cost.budgetUsd)}${frac}`));
  }
  box.append(total);
  const seats = el("div", "cost-seats");
  for (const row of state.cost.perSeat) {
    const s = chip(row.seat, row.color, "");
    s.append(el("span", "cost-seat-amt", ` ${money(row.cost)}`));
    if (row.mode !== "exact") s.classList.add("cost-est");
    seats.append(s);
  }
  box.append(seats);
  return box;
}

function renderTally(): HTMLElement | null {
  const t = state.tally;
  if (!t || t.totals.length === 0) return null;
  const box = el("div", "tally");
  box.append(el("div", "tally-title", t.escalate ? "Decide · tie / thin margin" : "Decide · tally"));
  const max = Math.max(1, ...t.totals.map((x) => x.total));
  for (const row of t.totals) {
    const line = el("div", "tally-row");
    const isWinner = row.seat === t.winnerSeat;
    line.append(chip(row.seat, null, ""));
    const bar = el("div", "tally-bar");
    const fill = el("div", "tally-fill");
    fill.style.width = `${(row.total / max) * 100}%`;
    if (isWinner) fill.classList.add("tally-winner");
    bar.append(fill);
    line.append(bar);
    line.append(el("span", "tally-num", String(row.total)));
    box.append(line);
  }
  if (t.reason) box.append(el("div", "tally-reason", t.reason));
  return box;
}

// ── Gate area ────────────────────────────────────────────────────────────────

function renderGate(): HTMLElement | null {
  const gate = state.gate;
  if (!gate) return null;
  const box = el("div", `gate gate-${gate.severity}`);
  if (!state.driver) box.classList.add("gate-readonly");
  box.append(el("div", "gate-msg", gate.message));
  if (gate.detail) box.append(el("div", "gate-detail", gate.detail));

  const actions = el("div", "gate-actions");
  for (const action of gate.actions) {
    actions.append(gateButton(gate.gateId, action));
  }
  box.append(actions);
  if (!state.driver) {
    box.append(el("div", "gate-note", "Watch-only attach — actions are read-only."));
  }
  return box;
}

function gateButton(gateId: number, action: GateActionSpec): HTMLElement {
  const wrap = el("div", "gate-action");
  const btn = el("button", action.destructive ? "btn btn-danger" : "btn", action.label);
  btn.disabled = !state.driver;

  btn.addEventListener("click", () => {
    if (!state.driver) return;
    if (action.needsFeedback || action.needsAmount) {
      revealInput(wrap, gateId, action);
    } else {
      post(resolveGateRequest(gateId, action.id, action.winner ? { winner: action.winner } : {}));
    }
  });
  wrap.append(btn);
  return wrap;
}

function revealInput(wrap: HTMLElement, gateId: number, action: GateActionSpec): void {
  if (wrap.querySelector(".gate-input")) return;
  const row = el("div", "gate-input");
  const field = el("input");
  field.type = action.needsAmount ? "number" : "text";
  field.placeholder = action.needsAmount ? "new budget (USD)" : "feedback…";
  const confirm = el("button", "btn btn-sm", "Send");
  confirm.addEventListener("click", () => {
    const val = field.value.trim();
    if (action.needsAmount) {
      const amount = Number(val);
      if (!Number.isFinite(amount) || amount <= 0) return;
      post(resolveGateRequest(gateId, action.id, { amount }));
    } else {
      post(resolveGateRequest(gateId, action.id, { feedback: val }));
    }
    row.remove();
  });
  row.append(field, confirm);
  wrap.append(row);
  field.focus();
}

// ── Streams ──────────────────────────────────────────────────────────────────

function renderStreams(root: HTMLElement): void {
  const wrap = el("div", "streams");
  if (state.streamOrder.length === 0) {
    wrap.append(el("div", "streams-empty", "No streaming output yet."));
  }
  for (const seat of state.streamOrder) {
    const buf = state.streams[seat];
    if (!buf) continue;
    const pane = el("div", "stream-pane");
    const head = el("div", "stream-head");
    head.append(el("span", "stream-seat", seat));
    if (buf.dropped > 0) head.append(el("span", "stream-dropped", `+${buf.dropped} earlier lines trimmed`));
    pane.append(head);
    const body = el("pre", "stream-body");
    body.textContent = buf.lines.join("\n");
    pane.append(body);
    wrap.append(pane);
    // Auto-scroll to newest.
    requestAnimationFrame(() => {
      body.scrollTop = body.scrollHeight;
    });
  }
  root.replaceChildren(wrap);
}

// ── Shell ────────────────────────────────────────────────────────────────────

function renderTabs(): HTMLElement {
  const tabs = el("div", "tabs");
  (["board", "streams"] as const).forEach((view) => {
    const label = view === "board" ? "Kanban board" : "Streams";
    const t = el("button", "tab", label);
    if (activeTab === view) t.classList.add("tab-active");
    t.addEventListener("click", () => {
      activeTab = view;
      post(focusRequest(view));
      render();
    });
    tabs.append(t);
  });
  return tabs;
}

function render(): void {
  const rootEl = document.getElementById("root");
  if (!rootEl) return;

  const shell = el("div", "cockpit");
  shell.dataset.theme = state.themeKind;

  const runName = state.model.run?.name ?? "no active run";
  const header = el("header", "top-lane");
  const title = el("div", "run-title");
  title.append(el("span", "run-name", runName));
  if (state.model.run) title.append(el("span", "run-status", `${state.model.run.phase} · ${state.model.run.status}`));
  if (!state.driver) title.append(el("span", "badge-watch", "watch-only"));
  header.append(title);
  header.append(renderPhases());
  const laneRow = el("div", "lane-row");
  const tally = renderTally();
  if (tally) laneRow.append(tally);
  laneRow.append(renderCost());
  header.append(laneRow);
  shell.append(header);

  const gate = renderGate();
  if (gate) shell.append(gate);

  shell.append(renderTabs());

  const main = el("main", "view");
  if (activeTab === "board") {
    if (state.model.units.length === 0) {
      main.append(el("div", "board-empty", "No work units yet — decomposition begins after the plan is approved."));
    } else {
      renderBoard(main);
    }
  } else {
    renderStreams(main);
  }
  shell.append(main);

  rootEl.replaceChildren(shell);
}

// ── Message pump ─────────────────────────────────────────────────────────────

window.addEventListener("message", (e: MessageEvent<ExtensionToWebview>) => {
  state = cockpitReducer(state, e.data);
  render();
});

render();
post(readyRequest());
