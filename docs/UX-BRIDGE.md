# Conclave — Onboarding & the Discovery Bridge

**Status: design only. No code yet.** This captures two related gaps — (1) a fresh
user can't get set up, and (2) the tool expects an already-scoped problem — and the
plan to close them so Conclave feels like one product instead of "a CLI plus a viewer."

> **v2 — reviewed by an independent pass (codex), incorporated below.** Directionally the
> architecture holds (discovery is engine-seated; the run spec is the contract), but the
> review caught a real contract bug, corrected the ownership split, re-sequenced the phases
> (engine acquisition + `doctor` are fresh-user blockers, not polish), and hardened the
> onboarding/auth and auto-detect designs. The three required-before-code changes are in §10.

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
| The engine (`wrk2gthr`) | absent (not bundled); `provision.ts` has a machine-specific default path | ❌ none — manual clone |
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
   own CLIs, **seated by the engine**. The extension already treats `collab` as the only
   execution boundary (`EngineClient` is deliberately just a JSON-command wrapper); keep it.
2. **Ownership is three-way** (the review corrected this — don't say "the engine or the skill"):
   - **Skill** owns *dialogue policy* — how the scoping conversation is run.
   - **Engine** owns *adapter execution, transcript streaming, cancellation, validation, and
     final run-spec emission*.
   - **Extension** owns *review / edit / launch UI and status*.
3. **Vendor-neutral, on the user's own subscriptions.** Everything runs through CLIs the
   user already pays for.
4. **The run spec is the seam** between discovery and execution (see §5.1), and it is a
   **versioned engine contract with engine-side validation** — not just "the LLM emits JSON."
5. **Credential boundary — stated honestly.** "We never collect credentials" is true. "We can
   reliably detect that a vendor is authenticated" is **not** true. The extension detects best
   effort, guides login, and re-probes; the **user** installs + authenticates; the run itself
   is the real proof of readiness.

---

## 4. The gaps

### A — Onboarding (fresh user)
- **A1 Engine acquisition** — `wrk2gthr` isn't bundled; `provision.ts` still defaults to a
  machine-specific path. **This is a blocker, not polish.**
- **A2 Node ≥ 25** — detected + guided, but not installed.
- **A3 Vendor-CLI detection** — is `claude`/`codex`/`glm` on PATH? Authenticated? Not checked —
  and *reliable* detection is hard (see §5.2).
- **A4 Adapter scaffolding** — the shipped `claude/glm/codex.json` are hand-written with
  **machine-specific paths**; there's no auto-generate for a new machine.
- **A5 Auth guidance** — missing auth isn't detected or explained; and auth state is only
  knowable as a tri-state, not a boolean.
- **A6 No welcome/setup surface** — no wizard ties the above together.

### B — Discovery / scoping
- **B1 No intake/brainstorming phase.** The engine's Intake is "human types goal + criteria";
  there's no model-assisted scoping of a fuzzy idea.
- **B2 The skill (the scoping brain) isn't reachable from the extension.** It lives in
  `wrk2gthr/skills/w2g` and only runs when a chat agent invokes it.

### C — Entry & visibility
- **C1 No direct start input** — starting a run means `Cmd-P` → command list → describe.
  (Note: `startRunFlow` already collects inputs, warns on spend, prepares a scratch target,
  starts, and drives — so this is **mostly discoverability**, a button over existing logic.)
- **C2 No auto-detect** — a run started outside the extension doesn't surface until you
  manually **Attach**. The engine channel exists (`watch --all` / `runs-changed`), but the
  extension side is **not** small (see §5.5).

---

## 5. The design

### 5.1 The run spec — the seam (RunSpec v1, a versioned + validated contract)

Produced by discovery, consumed by `collab run start`. It must be a real engine contract,
not an ad-hoc JSON blob. **Bug caught in review:** the client's `runStart` takes
`criteria?: string`, so criteria is a **string**, not an array — match the contract.

```jsonc
{
  "schemaVersion": 1,
  "origin": "skill:w2g@1.2.0",     // provenance: which skill/version, or "panel"
  "runName": "rate-limiter",        // optional human handle
  "goal": "…",                      // the scoped problem statement
  "criteria": "…",                  // STRING — matches `collab run start --criteria`
  "seats": ["claude", "glm"],       // NORMALIZED adapter ids (not display names); >=2 vendors
  "domain": "coding",               // coding | writing | research
  "approval": "plan-only",          // plan-only | plan+risky-deliver | final
  "autonomy": { "fullAuto": false },// gate autonomy (explicit, not implied by approval)
  "routing": "usage-aware",
  "budgetUsd": 5,                   // optional ceiling
  "ceremony": "full",              // full | editorial | lightweight
  "buildTargetMode": "scratch",     // scratch | explicit — where the fleet builds
  "workspaceRoot": "/abs/path",     // repo-context policy for discovery + build target
  "repoContext": "read",            // read | none
  "checkCommands": ["npm test", "tsc --noEmit"], // the falsifiable "done", machine-runnable
  "expectedArtifacts": [],          // optional
  "maxTurns": 40                    // or a wall-clock ceiling
}
```

**Harden it (the editable-spec UI is NOT the validator).** The failure mode isn't only "bad
JSON" — it's *almost-right* JSON: stale/renamed adapter ids, impossible budgets, vague
criteria, unsafe build assumptions. So:
- engine-side **`collab run-spec validate --json`** with a JSON Schema (single source of truth),
- **strict extraction markers** — the skill wraps the spec in fenced sentinels so it's parsed
  unambiguously, not scraped from prose,
- a **repair-attempt limit** (ask the seat to fix a failed spec N times, then surface errors),
- a **user-visible validation error list**; the editable spec is a convenience, the validator
  is the gate.

### 5.2 Onboarding — "Set up Conclave" (and why detection is hard)

**Engine (new): `collab doctor --json` / `collab init`.** Probe for the vendor CLIs it has
templates for, report status, and **preview then scaffold** adapters from built-in templates
using the *detected* local paths. Reality the design must handle (per review):
- **PATH mismatch:** the VS Code/Cursor extension-host PATH is often **not** the user's login
  shell PATH. nvm/asdf/Homebrew shims, npm-global installs, multiple `codex` binaries,
  app-bundled CLIs, Windows PATH, and stale symlinks all produce bad scaffolds. `doctor` must
  resolve the user's real shell environment / known install locations, and **preview** the
  exact resolved command paths before writing anything.
- **Auth is a tri-state, not a boolean:** `unknown | probably_ready | failed_probe`.
  `claude --version` proves *install*, not *login*. Per-vendor env like GLM's `ZAI_API_KEY` /
  `ANTHROPIC_*` may exist in a login shell but not in the extension process. Some vendors can
  only be verified by a real command that **spends quota** — that probe must be **opt-in**.
- **Adapter scaffolds run arbitrary local commands**, so scaffolding is a reviewable action:
  show the resolved commands; don't silently write+execute.

**Extension (new): a welcome view** — a checklist with tri-state status, fix actions, and a
Recheck button:

```
Node ≥ 25        ✓  /opt/homebrew/bin/node
Engine           ✓  wrk2gthr located          ( or [ Get the engine ] )
Agents
  claude         ✓  found · probably ready     → seated
  codex          ⚠  found · auth unknown       → run: codex login, then Recheck
  glm            ✗  not found / no ZAI_API_KEY  → install + set key, then Recheck
[ Preview & set up my agents ]   → collab init: shows resolved commands, scaffolds ready ones
```

Honest copy: readiness is best-effort; **the first run is the real auth test**, and failures
must be legible (which seat, which vendor, what to run).

### 5.3 Discovery — an Intake seat running the skill protocol *(Phase 3 — after doctor + spec validation)*

The extension doesn't need its own LLM — it seats **one of the user's own CLIs** for
discovery, through the engine, the same way the run will.

- **Engine (new): an Intake/Scope mode.** Seat one CLI (the user's pick), run the skill's
  scoping *dialogue*, stream the transcript, support **cancel/abort**, and end by emitting a
  **validated** RunSpec v1. Reuses the adapter/session machinery (L0–L2) — the extension does
  **not** reimplement CLI spawning or turn management.
- **Skill:** owns the dialogue policy + the "emit a spec inside sentinels" contract. Same
  artifact in the chat agent and the Intake seat.
- **Extension:** a discovery panel — input, relayed Q&A, **cost preview**, an **editable +
  validated** proposed spec, Launch, and a clean **abort/partial-transcript** path.

**Two front doors, one protocol:** chat-native (repo-aware, via the agent) and extension-native
(the Intake seat). Give the Intake seat workspace read access, but keep the chat door as the
"scope with full repo context" path.

### 5.4 Direct start (C1)

A first-class **Start** affordance in the sidebar / welcome view that launches the **existing**
`startRunFlow`. Small; mostly discoverability.

### 5.5 Auto-detect (C2) — a *separate* lifecycle component

The engine channel exists (`WatchClient` supports `--all`; emits `runs-changed`), so the engine
side is small. The **extension side is not**: `StateBus` is built around one active run, one
run-scoped watcher, and an explicit `detached` latch (and `refreshRuns()` auto-attaches unless
detached). Bolting global watch into it risks **surprise re-attach after the user detached**.

So: implement a standalone **`GlobalRunsWatcher`** in extension lifecycle, scoped per
workspace/store, that runs `collab watch --all` and **only refreshes the run list + prompts /
offers to attach**. It must **never** mutate active-run attach/detach state. Note the
multi-root ambiguity: the extension currently collapses to `workspaceFolders[0]`, so global
watch needs a deliberate per-store scoping decision.

---

## 6. The fresh-user journey (target)

```
Install extension
  → Set up Conclave        (locate/get engine · Node · doctor: detect CLIs · preview + scaffold adapters · auth guidance)
  → agents ready (>= 2 vendors)
  → Discover               (panel Intake seat, or chat skill — same protocol, same validated spec)
  → review / edit run spec (validated by the engine)
  → Run                    (collab run start)
  → Cockpit                (auto-detected via GlobalRunsWatcher; live Kanban, gates, takeover)
```

---

## 7. Phased backlog (re-sequenced per review)

| Phase | Item | Engine | Extension | Skill |
|---|---|:--:|:--:|:--:|
| **1 — Fresh-user unblock** (the real MVP) | Engine locator + install/acquisition guidance (kill the machine-specific default path in `provision.ts`) | ● | ● | |
| | `collab doctor --json`: robust CLI detection, auth **tri-state**, **preview + scaffold** adapters from templates | ● | | |
| | "Set up Conclave" welcome view + auth guidance + Recheck | | ● | |
| | Direct-start affordance (button over existing `startRunFlow`) | | ● | |
| **2 — Contract + visibility** | **RunSpec v1** as a versioned engine contract + `collab run-spec validate --json` (JSON Schema) | ● | | |
| | `GlobalRunsWatcher` (separate lifecycle component; never touches active-run state) | (exists) | ● | |
| **3 — Discovery bridge** (only after 1 + 2 solid) | Intake/Scope mode: seat a CLI, run the dialogue, stream, cancel, emit a **validated** spec | ● | | |
| | Formalize the discovery **dialogue protocol** + sentinel-wrapped spec emission | | | ● |
| | Discovery panel: input · relayed Q&A · cost preview · editable+validated spec · abort · Launch | | ● | |
| | Wire the chat front door to the same protocol/spec | | | ● |
| **4 — Marketplace** (see `REVIEW-BACKLOG.md`, E5–E7) | Engine bundling/provisioning; telemetry policy; version compat (extension/engine/skill) | ● | ● | |
| | Windows-safe takeover (adapter env in `seat pause`) + env redaction | ● | ● | |
| | Cross-editor (VS Code + Cursor) onboarding QA; publish to Marketplace + Open VSX | | ● | |

---

## 8. Risks / must-consider (expanded per review)

- **Auth is not reliably detectable.** Tri-state only; the first run is the real test; some
  probes spend quota (opt-in).
- **PATH / environment reality.** Extension-host PATH ≠ login shell; shims, multiple binaries,
  Windows, app-bundled CLIs → bad scaffolds unless `doctor` resolves the real env and previews.
- **RunSpec drift.** Almost-right JSON, stale adapter ids, impossible budgets — needs engine
  validation + repair loop + visible errors, not just an editable field.
- **Global watch lifecycle.** Surprise re-attach after detach; multi-root/multi-store ambiguity;
  run-stop and workspace-switch races. Keep it isolated from `StateBus`.
- **Discovery cancel/abort + partial transcript recovery.** Users will bail mid-interview.
- **Offline / engine-absent** handling at every step (not just Node).
- **Cost preview before Intake**, not only before the run — the interview itself spends.
- **Security:** scaffolded adapters execute arbitrary local commands; treat scaffold as a
  reviewable action, and redact env values in any surfaced spec/log.
- **Version compatibility** across extension / engine / skill (schemaVersion already exists on
  the JSON contract; extend the discipline to RunSpec + the skill protocol).
- **Telemetry policy** — decide before any usage signal is added.
- **Stale-adapter migration** when a CLI moves, updates, or a new install shadows the old path.

---

## 9. Over-engineering check (review)

The **Discovery panel is premature.** Most of the fresh-user value comes from **reliable setup**
(`doctor` + engine acquisition) and **making the existing start flow visible**. Intake is worth
building — but only *after* `doctor` and RunSpec validation are solid. Don't build the panel first.

---

## 10. The three changes required before any code (review)

1. **Make `collab doctor`/`init` + engine acquisition Phase 1.** Provisioning still hard-codes a
   machine-specific engine path — that's a fresh-user blocker, not marketplace polish.
2. **Formalize `RunSpec v1` with engine-side validation *before* building Intake.** Fix
   `criteria` to a string, add the missing fields (§5.1), ship `collab run-spec validate --json`.
3. **Split global `watch --all` into a separate lifecycle component** that never mutates
   active-run attach/detach state.

---

## 11. Related docs

- `docs/ENGINE-GAPS.md` — engine contract gaps (closed).
- `docs/REVIEW-BACKLOG.md` — consciously deferred findings (Windows shell env, run+seat keying).
- `docs/TESTING.md` — install + exercise guide.
