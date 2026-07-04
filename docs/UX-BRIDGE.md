# Conclave — Onboarding & the Discovery Bridge

**Status: design only. No code yet.** This captures two related gaps — (1) a fresh
user can't get set up, and (2) the tool expects an already-scoped problem — and the
plan to close them so Conclave feels like one product instead of "a CLI plus a viewer."

---

## 1. The target experience

Install the extension → guided setup → describe a rough idea → the council scopes it
*with* you → it runs → you watch and steer. The fresh-user path we're aiming for:

```
Set up  →  Discover  →  Run  →  Cockpit
```

Today the middle two don't exist for a new user, and "Set up" doesn't exist at all.

---

## 2. Where we are today (honest current state)

The extension is a clean **thin client**: it spawns the `collab` engine, reads `--json`
+ the `watch` feed, and never touches the DB. That part is right. But it assumes a lot:

| Assumed present | Fresh user reality | Extension help today |
|---|---|---|
| Node ≥ 25 | maybe (default is often Node 20) | ✅ detects + friendly "set `conclave.nodePath`" |
| The engine (`wrk2gthr`) | absent (not bundled) | ❌ none — manual clone |
| Adapters (`adapters/*.json`) | none; hand-writing is expert-level | ❌ `collab adapters --json` just lists what exists (nothing) |
| Vendor CLIs installed + authed | some, maybe | ❌ not detected, not guided |
| A scoped problem + criteria | user has a vague idea | ❌ no discovery phase |
| First-class "Start" | — | ❌ command-palette only (`Cmd-P`) |
| Run visibility | — | ❌ no auto-detect of externally-started runs |

Net: it "works on the author's machine." For the marketplace goal, the onboarding and
discovery layers are what's missing.

---

## 3. Principles (the constraints that decide the design)

1. **Thin client stays thin.** No embedded LLM, no DB access, no new API keys. The
   *intelligence* and *process spawning* live in the engine — or in one of the user's
   own CLIs, **seated by the engine**.
2. **The engine owns** adapters, sessions, spawning, and the run pipeline. The extension
   is the UI over it (plus the one thing it already does: spawn `collab`).
3. **Vendor-neutral, on the user's own subscriptions.** Everything runs through CLIs the
   user already pays for.
4. **The run spec is the seam** between discovery and execution (see §5.1).
5. **Credential boundary:** the extension *detects and guides*; the **user** installs CLIs
   and authenticates. The extension never handles keys or logins on their behalf — correct
   security, and a trust signal.

---

## 4. The gaps

### A — Onboarding (fresh user)
- **A1 Engine acquisition** — `wrk2gthr` isn't bundled; nothing to point `enginePath` at.
- **A2 Node ≥ 25** — detected + guided, but not installed.
- **A3 Vendor-CLI detection** — is `claude`/`codex`/`glm` on PATH? Authenticated? Not checked.
- **A4 Adapter scaffolding** — the shipped `claude/glm/codex.json` are hand-written with
  **machine-specific paths**; there's no auto-generate for a new machine.
- **A5 Auth guidance** — missing auth isn't detected or explained.
- **A6 No welcome/setup surface** — no wizard ties the above together.

### B — Discovery / scoping
- **B1 No intake/brainstorming phase.** The engine's Intake is "human types goal + criteria";
  there's no model-assisted scoping of a fuzzy idea.
- **B2 The skill (the scoping brain) isn't reachable from the extension.** It lives in
  `wrk2gthr/skills/w2g` and only runs when a chat agent invokes it.

### C — Entry & visibility
- **C1 No direct start input** — starting a run means `Cmd-P` → command list → describe.
- **C2 No auto-detect** — a run started outside the extension (e.g. by a chat agent) doesn't
  surface until you manually **Attach**. There's no always-on runs-changed listener.

---

## 5. The design

### 5.1 The run spec — the seam

One contract object is produced by discovery and consumed by `collab run start`.
Everything converges here, so both front doors (chat + panel) stay interchangeable.

```jsonc
{
  "goal": "…",                       // the scoped problem statement
  "acceptanceCriteria": ["…"],       // falsifiable "done" — tests/checks/checklist
  "seats": ["claude", "glm"],        // which agents sit (>= 2 vendors for cross-QA)
  "domain": "coding",                // coding | writing | research
  "approval": "plan-only",           // plan-only | plan+risky-deliver | final
  "routing": "usage-aware",          // usage-aware | efficiency | auto
  "budgetUsd": 5,                    // optional ceiling
  "ceremony": "full"                 // full | editorial | lightweight
}
```

The extension always lets the user **review/edit** the spec before launch (safety net for
imperfect scoping).

### 5.2 Onboarding — "Set up Conclave"

**Engine (new): `collab init` / `collab doctor`.** Probe `PATH` for the vendor CLIs it has
templates for (claude/codex/glm), check whether each is authenticated, and **scaffold
adapter JSONs from built-in templates using the *detected* local paths** — turning today's
hand-written reference configs into real templates. Emit a machine-readable status report.

**Extension (new): a welcome view** — a checklist with live status, fix actions, and a
Recheck button:

```
Node ≥ 25        ✓  /opt/homebrew/bin/node
Engine           ✓  wrk2gthr detected        ( or [ Get the engine ] )
Agents detected
  claude         ✓  authenticated            → seated
  codex          ✗  not signed in            → run: codex login
  glm            ✗  no ZAI_API_KEY            → set it, then Recheck
[ Set up my agents ]   → collab init: scaffolds adapters for the ready ones
```

The extension **detects + guides**; one click scaffolds adapters for whatever's ready. The
**user** performs installs/auth (per the credential boundary).

### 5.3 Discovery — an Intake seat running the skill protocol

The key insight: the extension doesn't need its own LLM. It seats **one of the user's own
CLIs** for discovery — the same CLIs it will later seat for the run.

- **Engine (new): an Intake/Scope mode.** Seat one CLI (the user's pick), run the skill's
  scoping protocol, stream the conversation, and **end by emitting a run spec** (§5.1). This
  reuses the engine's existing adapter/session machinery (L0–L2 ladder) — the extension does
  **not** reimplement CLI spawning or turn management.
- **Skill (formalize): the discovery protocol.** A portable scoping prompt + one hard rule:
  *finish by emitting a clean run-spec block.* The **same** artifact runs in the chat agent
  and in the extension's Intake seat.
- **Extension (new): a discovery panel** — an input box, the relayed Q&A, an **editable
  proposed spec**, and a Launch button.

**Two front doors, one protocol:**
- **Chat-native** (the skill in your coding agent) — repo-aware, scopes with full codebase
  context. Best for IDE power users.
- **Extension-native** (the Intake seat) — self-contained in the panel, on the user's subs.
  Best for standalone/GUI users.

Give the Intake seat the workspace path + read access so it isn't blind, but keep the chat
door as the "scope with full repo context" path.

### 5.4 Direct start (C1)

A first-class **Start** affordance in the Conclave sidebar / welcome view (input + button),
not the command palette. Small, high ROI, independent of the rest.

### 5.5 Auto-detect (C2)

The extension runs an always-on **`collab watch --all`** (runs-changed) listener. On a new
run it surfaces it and offers to attach / opens the cockpit. This is what makes a
chat-started run **light up live** without a manual Attach. Small; the engine channel
already exists.

---

## 6. The fresh-user journey (target)

```
Install extension
  → Set up Conclave        (wizard: Node · engine · detect CLIs · scaffold adapters · auth)
  → agents ready (>= 2 vendors)
  → Discover               (panel Intake seat, or chat skill — same protocol, same spec)
  → review / edit run spec
  → Run                    (collab run start)
  → Cockpit                (auto-detected; live Kanban, gates, takeover)
```

---

## 7. Phased backlog

| Phase | Item | Engine | Extension | Skill |
|---|---|:--:|:--:|:--:|
| **1 — friction** (small, high ROI) | C1 direct-start affordance | | ● | |
| | C2 auto-detect via `watch --all` | (exists) | ● | |
| **2 — onboarding** | `collab init` / `doctor`: detect CLIs, check auth, scaffold adapters from templates, status JSON | ● | | |
| | "Set up Conclave" welcome wizard + auth guidance + Recheck | | ● | |
| **3 — discovery bridge** | Intake/Scope mode (seat a CLI, run protocol, emit spec) | ● | | |
| | Formalize the discovery protocol + run-spec contract | | | ● |
| | Discovery panel (input · relayed Q&A · editable spec · Launch) | | ● | |
| | Wire the chat front door to the same protocol/spec | | | ● |
| **4 — marketplace** (see `REVIEW-BACKLOG.md`, E5–E7) | Engine acquisition/bundling/provisioning | ● | ● | |
| | Cross-editor (VS Code + Cursor) onboarding QA | | ● | |
| | Windows-safe takeover (adapter env in `seat pause`) | ● | ● | |
| | Publish to VS Code Marketplace + Open VSX | | ● | |

---

## 8. Open questions / risks

- **Interactive session handling for Intake.** Reuse the adapter L0–L2 ladder; decide
  headless-resume vs PTY-interactive per adapter (codex resume is unwired — L1 today).
- **Structured-output reliability.** The whole bridge depends on the skill emitting a clean
  run-spec block; the editable-spec step is the safety net.
- **Repo-awareness.** The chat door beats the panel here; give the Intake seat workspace
  read, and be explicit that the panel scopes with less context.
- **Engine acquisition.** Bundle vs `git clone` vs `npm` — affects A1 and provisioning.
- **Token cost.** Discovery spends on the chosen sub; expected and fine, but surface it.
- **Cross-platform.** The Windows-shell takeover item (`REVIEW-BACKLOG.md`) intersects the
  "seat a CLI" work — the engine returning adapter env unblocks both.

---

## 9. Related docs

- `docs/ENGINE-GAPS.md` — engine contract gaps (closed).
- `docs/REVIEW-BACKLOG.md` — consciously deferred findings (Windows shell, run+seat keying).
- `docs/TESTING.md` — install + exercise guide.
