# Engine contract gaps (found building E4)

E4 (native VS Code integration) is a thin client of the `wrk2gthr` engine's JSON
contract (`docs/JSON-CONTRACT.md` in the engine repo). Building it surfaced places
where the contract did not expose what an editor-native experience needs. Each gap
below states **what E4 wanted**, **what the contract exposes**, **how E4 copes**, and
**the precise engine addition** that would let E4 stop coping. None of these are
worked around by touching the store — the extension never opens the DB (principle 2).

**Status (schema 2).** The engine's schema-2 bump **CLOSED gaps 1 and 2**, plus the
two smaller gaps that were noted only in `TESTING.md` — **per-seat `tier`** (Seats
column) and **`collab run stop`** (real engine-side cancel). The extension now
consumes all of them (structured `file`/`line`, `workingDir`/`target`, roster `tier`,
`run stop`). **Gap 3 — takeover pause/resume — remains the one open gap.**

---

## Gap 1 — QA findings carry no `file` / `line` — ✅ CLOSED (schema 2)

**Wanted:** click a cross-QA finding → jump to the exact `file:line`; show findings
as native diagnostics/squiggles in the offending file.

**Contract now (schema 2):** `report --json` `qaFindings[]` gained `file` (string|null)
and `line` (number|null), parsed conservatively by the engine at QA time
(`src/orchestrator/report.ts` `parseFindingLocation` over `evidence`, fallback
`claim`). Both are `null` when the reviewer cited no `path:line`.

**How E4 consumes it:** `src/viewmodels/findings.ts` `findingLocation` now **prefers
the structured `file`/`line`** — authoritative, no guessing — and only falls back to
the free-text heuristic (`parseLocationFromText`) when the contract omits a location.
Jump-to-finding and the `DiagnosticCollection` squiggles are now reliable. Findings
where the reviewer cited nothing are still listed (count surfaced), simply not
navigable — nothing to point at, not a bug.

---

## Gap 2 — the run's build target / working dir is not in the contract — ✅ CLOSED (schema 2)

**Wanted:** resolve a finding's `file:line`, run `git` for a native diff, and open
produced code — all of which need the absolute path of the **build target** (the
scratch clone the fleet built in) and/or the run's `working_dir`.

**Contract now (schema 2):** `run status --json` and `report --json` gained
`workingDir` (the run's absolute working dir) and `target` (the effective build
target, or `null` when no `--target` was pinned) — authoritative, from the store.

**How E4 consumes it:** `src/viewmodels/findings.ts` `resolveBuildTarget` resolves a
run's produced-code target **provenance-correctly**: the session `targets` map (runs
this window drove) **OR** the engine-reported `target` (fallback `workingDir`). Both
are authoritative, so findings/diffs now work for **ATTACHED (non-driven) runs too**
— without the wrong-tree risk. When neither is available the shells (findings + diff)
**refuse** with a clear message; they **never** fall back to `conclave.targetDir` or
the workspace root (a same-named file there would be a silent wrong-tree jump). The
wrong-tree provenance guard (`navigableTarget`) is retained.

---

## Gap 3 — takeover has no pause/resume action (the big one) — ⏳ STILL OPEN

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
