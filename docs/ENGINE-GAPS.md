# Engine contract gaps (found building E4)

E4 (native VS Code integration) is a thin client of the `wrk2gthr` engine's JSON
contract (`docs/JSON-CONTRACT.md` in the engine repo). Building it surfaced places
where the contract does not yet expose what an editor-native experience needs. Each
gap below states **what E4 wanted**, **what the contract exposes today**, **how E4
copes honestly right now**, and **the precise engine addition** that would let E4
stop coping. None of these are worked around by touching the store — the extension
never opens the DB (principle 2).

---

## Gap 1 — QA findings carry no `file` / `line`

**Wanted:** click a cross-QA finding → jump to the exact `file:line`; show findings
as native diagnostics/squiggles in the offending file.

**Contract today:** `report --json` `qaFindings[]` are
`{unitSeq, verdict, severity, reviewer, claim, evidence}` — verified against the
engine's `src/orchestrator/report.ts` `reportData()` and the store's QA-finding row
(`verdict, severity, reviewer_seat, claim, evidence`). **No `file`, no `line`.**

**How E4 copes:** a pure parser (`src/viewmodels/findings.ts` `parseLocationFromText`)
recovers a `file:line` heuristically from the free-text `evidence`/`claim` (e.g. a
`src/foo.ts:42` token, or `src/foo.ts line 42`). Findings that match become
clickable QuickPick entries and `DiagnosticCollection` squiggles resolved against the
run's build target. Findings with no recoverable token are still listed but are
**not navigable and get no squiggle** — the count is reported to the user so the
limitation is visible, not silent.

**Engine addition needed:** add optional structured location to each finding —
`file` (path relative to the run's build target) and `line` (1-based), e.g.
`qaFindings[]: { …, file?: string, line?: number, endLine?: number }`. This is an
**additive** field (no schemaVersion bump). The reviewer already cites a location in
prose; capturing it structurally at QA time removes all heuristics.

---

## Gap 2 — the run's build target / working dir is not in the contract

**Wanted:** resolve a finding's `file:line`, run `git` for a native diff, and open
produced code — all of which need the absolute path of the **build target** (the
scratch clone the fleet built in) and/or the run's `working_dir`.

**Contract today:** neither `run status --json`, `report --json`, nor the watch
snapshot exposes the run's `working_dir` or the execution `--target`. (The engine
knows it — `run.working_dir` in the store, `--target` on `orchestrate` — but does not
surface it.)

**How E4 copes:** the extension **tracks the target itself** for runs it drives this
session (`targets` map in `extension.ts`, populated from E2's build-target
resolution). For a run it did **not** start in this window (e.g. attach-only, or a
run from a previous session), it falls back to `conclave.targetDir` then the
workspace root — so diff/jump/takeover degrade gracefully with a clear error
("Conclave only knows the target of runs it drove") instead of pointing at the wrong
tree.

**Engine addition needed:** expose the build target + working dir on the run reads,
e.g. `run status --json` and `report --json` gain
`target: string` (absolute execution target) and `workingDir: string`. Additive.
Then E4 can resolve produced-code paths for **any** run, not only ones it launched.

---

## Gap 3 — takeover has no pause/resume action (the big one)

**Wanted (roadmap E4):** "Take over seat" → open interactive
`claude --resume <session>` in an integrated terminal after signalling the harness to
**pause** that seat; "Release" → resume the seat headless. The M0-proven round-trip,
in-editor.

**Contract today — assessed carefully:**
- The seat's **`session` IS exposed** — watch snapshot `state.seats[].session` and
  `status --json` roster `session`. So the extension **can** build the exact
  `<cli> --resume <session>` command.
- The seat's **`paused` flag IS readable** — watch snapshot `state.seats[].paused`.
- **BUT there is NO action command to SET pause/resume or run the takeover.** The
  engine's real takeover (`beginTakeover` / `endTakeover` in
  `src/cockpit/fleet.ts`) calls `store.setSeatPaused(seat, …)` and reads
  `store.getSeat(seat).session_id` **directly, in-process** — it is only reachable
  from the terminal cockpit's own keypress, never surfaced as a `collab …` command.
  The extension must not touch the store (principle 2), so it **cannot** pause the
  harness, and therefore cannot safely own the round-trip.

**How E4 copes (honest, not faked):** `Conclave: Take over seat` reads the seat's
`session`/`status` from the live snapshot, reads the adapter's `command` from the
seat's adapter JSON, and opens an integrated Terminal **in the build target** that:
1. echoes a clear banner explaining the state + **the contract gap**;
2. **stages** the real `<cli> --resume <session>` on the prompt — it does **not**
   auto-run it — so the user reviews and presses Enter to attach;
3. **warns about double-attach** when the seat is mid-turn (Conclave can't pause it,
   so attaching now would double-attach the session);
4. reports honestly when there's no session yet, or the adapter command is
   unreadable — never a silent no-op.

This is real and useful (you land in an interactive session in the right cwd with the
right command) but it is **not** the safe, one-click pause→steer→release round-trip
the roadmap ultimately wants, because the engine won't let an out-of-process client
pause the harness.

**Engine additions needed (to make takeover a true one-click round-trip):**
1. `collab seat pause --seat <s> [--run <ref>] --json` and
   `collab seat resume --seat <s> [--run <ref>] --json` — action-envelope commands
   that set/clear the store pause flag (wrapping the existing `setSeatPaused`), and,
   ideally, block on pause until the seat's current turn drains (as `beginTakeover`
   already does internally) so it's safe to attach.
2. A `collab seat takeover-spec --seat <s> [--run <ref>] --json` read that returns
   the ready-to-run spec `{ command, args, cwd, sessionId }` (mirroring
   `beginTakeover`'s return) so the client doesn't have to read adapter JSON or guess
   the session cwd. Equivalently, add `sessionCwd` to the snapshot seat rows
   (`session_cwd` exists in the store) so the client can build it itself.
3. Optionally a `takeover_start` / `takeover_end` pair already exists as store
   events; surfacing them on the watch feed would let the UI reflect an in-progress
   takeover.

With (1)+(2) the extension can: call `seat pause` (envelope confirms drained) →
open the terminal with the returned spec → on terminal close call `seat resume`. All
through the contract, no store access. Until then E4 ships the honest terminal hatch
above.
