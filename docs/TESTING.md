# Testing Conclave

A step-by-step guide to install and exercise the Conclave extension on **VS Code** and **Cursor**. This covers the testable core (milestones E0a–E4): the engine JSON contract, the extension spine, native run-control + gates, the live-Kanban cockpit, and native diffs/findings/takeover.

## 0. Prerequisites

- **Node ≥ 25** somewhere on your machine (the engine imports `.ts` directly). Your default `node` may be Node 20 (anaconda) — that's fine; the extension auto-detects a Node 25 (checks PATH, `/opt/homebrew/bin/node`, nvm). It's at `/opt/homebrew/bin/node` on this machine.
- **The engine** — the `wrk2gthr` checkout at `/Users/Baba/Documents/wrk2gthr` (the extension's default engine path).
- **At least two adapters** wired (`claude`, `glm`, `codex` are in `wrk2gthr/adapters/`).

## 1. Install the extension

```bash
# from the extension repo
cd /Users/Baba/Documents/ai-conclave
```

**VS Code:** `code --install-extension conclave.vsix`
**Cursor:** `cursor --install-extension conclave.vsix`
(or in either editor: Extensions view → `…` menu → *Install from VSIX…* → pick `conclave.vsix`)

Reload the window. You should see a **Conclave** icon in the Activity Bar (left rail).

## 2. Configure (Settings → search "Conclave")

| Setting | Value for this machine |
|---|---|
| `conclave.enginePath` | `/Users/Baba/Documents/wrk2gthr/bin/collab.mjs` (default) |
| `conclave.nodePath` | leave blank (auto-detects Node 25) — or `/opt/homebrew/bin/node` |
| `conclave.adaptersDir` | `/Users/Baba/Documents/wrk2gthr/adapters` |
| `conclave.defaultSeats` | `claude,glm` (or `claude,glm,codex`) |
| `conclave.targetDir` | **leave blank** → the fleet builds in an isolated scratch clone (never your live repo) |

## 3. Smoke test — the engine connects (no spend)

Open the Command Palette (`Cmd-Shift-P`) → **Conclave: Show status**.
- ✅ You should see engine status / run info in the *Conclave* output channel.
- If you see a friendly "engine not found" or "Node ≥25" message, fix the setting it names — that's the provisioning working.

Then **Conclave: Show runs** — lists recent runs from the engine (there are several from last night's dogfooding, e.g. `royal-raven`).

## 4. Watch an existing run (read-only, no spend)

- **Conclave: Attach to run** → pick a past run (e.g. `royal-raven`).
- The sidebar **Runs / Seats / Board / Ledger** views populate.
- **Conclave: Open Cockpit** → the live **Kanban board** (units across Queued → Building → Review → Done, with a Blocked/Excused lane), per-seat streaming panes, votes, and cost. This is watch-only — gate buttons are disabled (you're observing, not driving).

## 5. Drive a real run (spends on your subscriptions — capped by preflight)

- **Conclave: Start run** → guided flow: goal → criteria → seats → domain → approval → routing → budget → autonomy.
- A **preflight** appears naming the seats, budget, and **the scratch build target** ("Fleet will build in: …"). Spend does not begin until you confirm (full-auto is the only explicit skip).
- Confirm → the fleet runs. Watch the **cockpit Kanban** fill and flow live.
- When a **gate** pends (plan approval, decide-tie, budget), a **notification with buttons** appears — approve/reject/pick-winner/raise right from the editor. No terminal needed.

## 6. Native integration (after a run has built something)

- Click a **QA finding** → jumps to the exact `file:line` in the build target (findings also appear in the **Problems** panel). *Schema 2: the engine now emits structured `file`/`line` per finding, so the jump is reliable — the prose heuristic is only a fallback when the reviewer cited no location.*
- Findings and diffs now resolve for **attached (non-driven) runs too**: the engine reports each run's `target`/`workingDir`, so Conclave can locate produced code even for runs it didn't start this session (still refusing — never guessing a wrong tree — when neither a session target nor an engine-reported one exists).
- **Conclave: Open integration diff** → the produced change in VS Code's native diff viewer.
- **Conclave: Stop run (cancel)** → terminally cancels the run engine-side (`collab run stop`, so a resume won't re-drive it) and SIGTERMs the driving child. Distinct from **Conclave: Stop watching run**, which only detaches the live viewer (the run keeps going).
- The **Seats** view now shows each seat's **tier** (schema 2 roster/snapshot field).
- **Conclave: Take over seat** → opens an integrated terminal and *stages* the seat's `--resume` command (doesn't auto-run). *Full pause/resume takeover still needs an engine addition — the one remaining gap; see `ENGINE-GAPS.md`.*

## What's verified vs what needs your eyes

- **Verified headlessly (this build):** every pure logic path — engine-client envelope parsing (incl. schema-agnostic compat + `run stop`), watch feed, view-models, gate wiring, spend-preflight, scratch-target safety, Kanban column mapping, webview isolation, diff-ref resolution, finding location (structured-first + heuristic fallback), provenance-correct build-target resolution, seat-tier mapping, stop-vs-detach logic, takeover honesty — **175 automated tests across the extension + the engine contract**, plus valid `.vsix` packaging.
- **Needs your GUI test (can't be done headlessly):** actual rendering and interaction in a live editor on **both VS Code and Cursor** — the sidebar views, the cockpit Kanban animations, notification buttons resolving a real gate, the diff viewer, the takeover terminal. Everything is wired over tested cores; this confirms the pixels and clicks.

## Known engine gaps (see `docs/ENGINE-GAPS.md`)

Schema 2 **closed** most of the earlier gaps — structured `file`/`line` on QA findings, the run's `target`/`workingDir` in the read JSON, per-seat `tier` on the roster/snapshot (Seats "tier" column), and a real `collab run stop` cancel — all now consumed by the extension. **One gap remains:** a `collab seat pause/resume` action for the full one-click takeover round-trip (today's takeover is the honest terminal hatch that stages the `--resume` command). See `docs/ENGINE-GAPS.md`.
