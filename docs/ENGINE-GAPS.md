# Engine contract gaps (found building E4)

E4 (native VS Code integration) is a thin client of the `wrk2gthr` engine's JSON
contract (`docs/JSON-CONTRACT.md` in the engine repo). Building it surfaced places
where the contract did not expose what an editor-native experience needs. Each gap
below states **what E4 wanted**, **what the contract exposes**, **how E4 copes**, and
**the precise engine addition** that would let E4 stop coping. None of these are
worked around by touching the store — the extension never opens the DB (principle 2).

**Status (schema 3).** The engine's schema-2 bump **CLOSED gaps 1 and 2**, plus the
two smaller gaps that were noted only in `TESTING.md` — **per-seat `tier`** (Seats
column) and **`collab run stop`** (real engine-side cancel). The **schema-3** bump
then **CLOSED gap 3** — the `collab seat pause/resume` command group now drives a real
one-click takeover round-trip. The extension consumes all of them (structured
`file`/`line`, `workingDir`/`target`, roster `tier`, `run stop`, and now `seat
pause`/`seat resume` + snapshot `sessionCwd`). **There are no open contract gaps.**

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

## Gap 3 — takeover pause/resume action (the big one) — ✅ CLOSED (schema 3)

**Wanted (roadmap E4):** "Take over seat" → open interactive
`claude --resume <session>` in an integrated terminal after signalling the harness to
**pause** that seat; "Release" → resume the seat headless. The M0-proven round-trip,
in-editor.

**Contract now (schema 3):** the engine ships a `collab seat` command group plus a
snapshot addition:
- `collab seat pause <seat> --run <ref> [--adapters-dir <dir>] [--wait-ms <n>] --json`
  → **SETS** the seat's pause flag, **WAITS** (bounded by `--wait-ms`, default 60000)
  for the seat to leave `working`, then returns the authoritative interactive resume
  spec: `{ seat, session, sessionCwd, resumeCommand, resumeArgs, ready }`. `ready:true`
  guarantees the seat is paused **AND** idle, so the client can **auto-run** the resume
  command safely (no double-attach). On failure (no session yet / still mid-turn past
  wait / no such seat) it exits 2 with `{ok:false,error:{code,message,hint}}` and
  **atomic-fails** (clears its own pause flag) — the client needs no cleanup.
- `collab seat resume <seat> --run <ref> --json` → `{seat, resumed:true}`; clears the
  pause flag so the orchestrator resumes headless driving.
- The watch/`--json` snapshot `SeatView` now also carries `sessionCwd` (the seat's
  worktree) alongside `paused` and `session`.

**How E4 consumes it (real one-click round-trip):** `Conclave: Take over seat` calls
`engine.pauseSeat(seat, run, {adaptersDir})`. On the ok spec it opens an integrated
Terminal **in `sessionCwd`** and **auto-runs** `resumeCommand resumeArgs` (safe —
`ready:true`). The user drives the seat by hand. **Release** — via a "Release seat"
button on the info toast, a `conclave.releaseSeat` command, OR simply closing the
terminal — calls `engine.resumeSeat(seat, run)` and headless driving resumes; the
release path is guarded to resume **exactly once**. On pause failure the extension
surfaces `message` (+ ` — hint`) and does nothing else (the engine atomic-failed). The
extension **prefers the engine's authoritative spec** over the old snapshot
projection; the snapshot is used only for the pre-flight "no session yet → nothing to
take over" check. All through the contract, no store access.
