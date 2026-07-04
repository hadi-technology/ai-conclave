# Review backlog — consciously deferred findings

The extension was audited by an independent adversarial reviewer (OpenAI Codex,
`gpt-5.5`, read-only) across **five** passes. Rounds 1–4 findings (a stalled-gate
BLOCKER, takeover races, a watch-feed leak, dishonest cancel/stop reporting,
schema-honesty, an all-reads-fail model wipe, a thin-client contract violation,
and more) were all **fixed and confirmed closed** by re-review.

Two genuine findings are **deliberately deferred** — not missed. Both are real;
neither blocks the current (macOS) test target. Rationale + the intended fix are
recorded here so they aren't silently dropped.

---

## 1. [MAJOR] Cross-platform takeover command quoting (Windows shells)

**Where:** `src/takeover.ts` (auto-run) + `src/viewmodels/takeover.ts` `posixQuote`.

**What:** the takeover terminal auto-runs the resume command by composing a
POSIX-quoted shell string and `sendText`-ing it into the user's integrated shell.
That is correct on zsh/bash (the supported dev/test platform, macOS). On Windows
PowerShell / `cmd.exe`, POSIX single-quote escaping is invalid — a path with
spaces breaks and metacharacters aren't neutralized.

**Why deferred (not a macOS blocker):** the clean cross-platform fix is to create
the terminal with `shellPath: resumeCommand` + `shellArgs: resumeArgs` (argv —
zero shell parsing, injection-proof on every OS). But that bypasses the user's
interactive shell, which today is what supplies each vendor's environment — in
particular **glm** needs `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`. Doing the
switch naively would break glm takeover on the user's own machine. The correct,
complete fix therefore also needs the **engine** to return the adapter's resolved
`env` from `collab seat pause` (it already computes it in `beginTakeover`'s spec;
it just isn't emitted in the CLI JSON), and the extension to pass that `env` into
`createTerminal({ shellPath, shellArgs, env })`. Secret-handling in the JSON
envelope needs a deliberate decision (which vars to surface, redaction in logs).

**Intended fix (E7, marketplace hardening — needs both repos):**
1. Engine: `collab seat pause --json` emits `env` (the adapter env), with a policy
   on which keys are surfaced.
2. Extension: create the takeover terminal via `shellPath`/`shellArgs`/`env` — no
   shell string, no `posixQuote`, correct per-vendor environment, safe on Windows.

Until then the values are engine-controlled (adapter command path + a UUID session
id), and `posixQuote` is correct on the supported POSIX shells.

---

## 2. [MINOR] Takeover state keyed by seat, not by run+seat

**Where:** `src/takeover.ts` — `activeTakeovers` / `pendingTakeovers` keyed by
seat name.

**What:** if run A's `claude` seat is taken over, focusing run B and taking over
*its* `claude` seat collides on the key — the extension focuses run A's terminal
and reports "already driving seat" instead of pausing B's seat.

**Why deferred:** takeover is always active-run-scoped and users drive one run at
a time, so concurrent same-named-seat takeovers across two runs is a
low-probability edge. The fix (compound `{run, seat}` key) touches the
release-once paths (`release`, `releaseSeatCommand`, `onDidCloseTerminal`,
`disposeAllTakeovers`) that were hardened across three review rounds; changing
them carries more regression risk than the edge case warrants right before a test
handoff.

**Intended fix:** key both maps by `${run}␟${seat}`; store `seat` on the
`ActiveTakeover` entry; include the run in the release picker labels and the
terminal-close lookup.
