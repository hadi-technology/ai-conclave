# Conclave

**Convene a multi-model AI fleet inside VS Code and Cursor.** Conclave is the editor
extension that drives the [`wrk2gthr`](https://github.com/hadi-technology) engine — start a
run, watch it deliberate, approve gates, and read the report, all from your editor.

Where the field ships plugins that fetch *second opinions* for a single lead agent, Conclave
convenes the models as peers and **gets work done** — built and verified, not just advised.

> This is **E1 — the extension spine**: a properly structured, installable extension that
> connects to the engine and exposes the core commands. The rich sidebar, live cockpit
> webview, native diffs, and onboarding arrive in later milestones (E2–E7). The brand name,
> icon, and publisher here are placeholders.

## Architecture — a thin client

Conclave contains **no orchestration logic**. It drives the engine by spawning the `collab`
CLI and reads state **only** through the CLI's JSON surface (`collab … --json` and the
`collab watch --json` event feed). It never opens the engine's SQLite store, never tails raw
files, and never knows the schema. There is exactly one contract: the CLI JSON shape,
versioned via `schemaVersion`. Every engine access flows through a single seam
(`src/engine/`), so the engine's internals can change without touching the extension.

## Requirements

- **VS Code 1.85+** or **Cursor** (any recent build — Conclave targets only the stable API).
- **The wrk2gthr engine** — a local checkout (its `bin/collab.mjs`).
- **Node.js 25 or newer** — the engine imports TypeScript directly and requires Node ≥25.
  Your default `node` is often an older version (e.g. Node 20 from Anaconda), which fails with
  `ERR_UNKNOWN_FILE_EXTENSION`. Conclave locates a Node ≥25 automatically, or you point it at one.

## Configuration

Open **Settings → Extensions → Conclave** (or edit `settings.json`):

| Setting | What it does |
|---|---|
| `conclave.enginePath` | Absolute path to the engine's `bin/collab.mjs`. Blank = auto-detect a local checkout. |
| `conclave.nodePath` | Absolute path to a **Node ≥25** binary. Blank = auto-detect (PATH, Homebrew, nvm). |
| `conclave.adaptersDir` | Directory of `<seat>.json` vendor adapters. Blank = engine default. |
| `conclave.defaultSeats` | Default seats for new runs, e.g. `claude,glm,codex`. |
| `conclave.defaultDomain` | Default job domain: `coding` \| `writing` \| `research`. |
| `conclave.defaultApproval` | Default approval policy: `plan-only` \| `plan+risky-deliver` \| `final`. |
| `conclave.defaultBudget` | Default spend ceiling (USD). Blank = no ceiling. |
| `conclave.defaultRouting` | Default routing: `usage-aware` \| `efficiency` \| `auto`. |

### Node ≥25 detection

Conclave resolves the engine runtime in this order:

1. `conclave.nodePath`, if set (validated to be Node ≥25).
2. `node` on your `PATH`, if it reports Node ≥25.
3. Common locations: `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `/usr/bin/node`, and
   the newest `~/.nvm/versions/node/*/bin/node`.
4. If none is ≥25, a clear, actionable error:
   *"Conclave needs Node 25+ to run the engine — set `conclave.nodePath` or install Node 25."*

The engine path resolves as: `conclave.enginePath` → a detected local checkout → a clear error.

## Commands

Run any of these from the Command Palette (all under the **Conclave:** category):

- **Conclave: Start run** — an input-box flow (goal, criteria, seats) that starts a run.
- **Conclave: Show status** — the run's phase, seats, and any pending gate.
- **Conclave: Open report** — the structured execution report in a Markdown document.
- **Conclave: Show ledger** — per-seat/model cost rollup and budget.
- **Conclave: Approve gate** — approve the pending gate (tie gates ask for a winner).
- **Conclave: Attach to run (watch-only)** — stream a run's live events to the Output channel.
- **Conclave: Stop run** — detach the extension's live feed for a run.

If the engine is missing or incompatible (version or schema), you get a friendly, fixable
message with a hint — never a stack trace.

## Development

```bash
npm install
npm run compile      # esbuild bundle → dist/extension.js
npm run typecheck    # tsc --noEmit
npm test             # vitest — engine client unit tests against a real seeded store
npm run package      # esbuild + vsce package → conclave.vsix
```

Then install `conclave.vsix` in VS Code / Cursor via *Extensions → … → Install from VSIX*.

---

Built by **HADI Technology**. Free and open-source.
