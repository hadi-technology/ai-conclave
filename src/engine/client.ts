/**
 * EngineClient — THE single seam between Conclave and the wrk2gthr engine.
 *
 * It spawns `collab` (via a located Node ≥25 + the engine entrypoint), runs
 * `--json` commands, and parses the typed envelopes. It NEVER opens the SQLite
 * store, tails files, or knows the schema — every read is a `--json` command and
 * every action is a `collab` invocation. The `watch` feed lives in ./watch.ts,
 * also spawned only through this module's config.
 *
 * Pure Node (no `vscode` import) so it is unit-testable headlessly.
 */
import { execFile } from "node:child_process";

import { EngineError } from "./errors.js";
import type {
  AdaptersResponse,
  BudgetRaiseResult,
  BudgetShow,
  ErrorEnvelope,
  GateApproveResult,
  GateRejectResult,
  GateShow,
  Ledger,
  Report,
  RunStartResult,
  RunStatus,
  RunStopResult,
  RunsResponse,
  SeatPauseResult,
  SeatPauseSuccess,
  SeatResumeResult,
  SeatResumeSuccess,
  VersionInfo
} from "./contract.js";

export interface ClientConfig {
  /** Located Node ≥25 binary. */
  nodePath: string;
  /** Engine entrypoint (bin/collab.mjs). */
  enginePath: string;
  /** Working directory for the engine (the workspace root holding .collab/). */
  cwd: string;
  /** Optional explicit store path (global --store). Defaults to ./.collab/store.db in cwd. */
  storePath?: string;
  /** Optional adapters dir passed to commands that accept it. */
  adaptersDir?: string;
}

/** Options for starting a run (wraps `collab run start`). */
export interface StartRunOptions {
  problem: string;
  criteria?: string;
  seats?: string;
  domain?: string;
  approval?: string;
  routing?: string;
  budgetUsd?: number | null;
  epsilon?: number;
}

interface RawResult {
  stdout: string;
  stderr: string;
  code: number | null;
  spawnError?: Error;
}

export class EngineClient {
  constructor(private readonly config: ClientConfig) {}

  /** Global args that precede every subcommand (`--store` is a root option). */
  private globalArgs(): string[] {
    return this.config.storePath ? ["--store", this.config.storePath] : [];
  }

  /** Run one `--json` command and return the raw stdout/stderr/exit. `timeoutMs`
   *  bounds how long the client waits before SIGTERM-ing the engine; it defaults to
   *  60000 but a long-blocking command (e.g. `seat pause`, which waits for a seat to
   *  idle) MUST raise it above the engine's own wait so the client never kills the
   *  engine mid-operation (FIX D). */
  private spawnRaw(subArgs: string[], timeoutMs = 60000): Promise<RawResult> {
    const args = [this.config.enginePath, ...this.globalArgs(), ...subArgs, "--json"];
    return new Promise((resolve) => {
      execFile(
        this.config.nodePath,
        args,
        { cwd: this.config.cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code =
            error && typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code: number }).code as number)
              : error
                ? 1
                : 0;
          // ENOENT / spawn failures surface as a string code (e.g. "ENOENT").
          const spawnError =
            error && typeof (error as { code?: unknown }).code === "string"
              ? (error as Error)
              : undefined;
          resolve({ stdout, stderr, code, spawnError });
        }
      );
    });
  }

  /**
   * Run a `--json` command and parse it into T. Throws EngineError on the engine's
   * `{ok:false,error}` envelope, on spawn failure, or on unparseable output.
   */
  async runJson<T>(subArgs: string[], timeoutMs?: number): Promise<T> {
    const { stdout, stderr, code, spawnError } = await this.spawnRaw(subArgs, timeoutMs);

    if (spawnError) {
      throw new EngineError(
        "spawn_failed",
        `Could not launch the engine: ${spawnError.message}`,
        "Check conclave.nodePath and conclave.enginePath."
      );
    }

    // Prefer stdout (success / read payloads); fall back to stderr (error envelope).
    const stdoutTrim = stdout.trim();
    const stderrTrim = stderr.trim();
    const candidate = stdoutTrim || stderrTrim;

    if (!candidate) {
      throw new EngineError(
        "empty_output",
        `The engine produced no output (exit ${code})`,
        "The engine may have crashed. Check the engine install."
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(lastJsonLine(candidate));
    } catch {
      throw new EngineError(
        "bad_json",
        `The engine did not return JSON (exit ${code}): ${truncate(candidate)}`,
        "This engine may not support --json for this command. Update wrk2gthr."
      );
    }

    if (isErrorEnvelope(parsed)) {
      const { code: ecode, message, hint } = parsed.error;
      throw new EngineError(ecode, message, hint);
    }

    if (code !== 0) {
      throw new EngineError(
        "engine_error",
        `The engine exited ${code}: ${truncate(candidate)}`,
        null
      );
    }

    return parsed as T;
  }

  // ── Read commands ──────────────────────────────────────────────────────────

  version(): Promise<VersionInfo> {
    return this.runJson<VersionInfo>(["version"]);
  }

  runs(): Promise<RunsResponse> {
    return this.runJson<RunsResponse>(["runs"]);
  }

  /** List the seat adapters the engine can actually load (authoritative — only
   *  adapters that pass the engine's validation). Wraps `collab adapters
   *  [--adapters-dir] --json`. Used to enumerate seat names without the thin client
   *  reaching into the engine's adapters dir on disk. */
  adapters(): Promise<AdaptersResponse> {
    const args = ["adapters"];
    if (this.config.adaptersDir) args.push("--adapters-dir", this.config.adaptersDir);
    return this.runJson<AdaptersResponse>(args);
  }

  runStatus(run?: string): Promise<RunStatus> {
    return this.runJson<RunStatus>(run ? ["run", "status", run] : ["run", "status"]);
  }

  report(run?: string): Promise<Report> {
    return this.runJson<Report>(run ? ["report", run] : ["report"]);
  }

  ledger(run?: string): Promise<Ledger> {
    return this.runJson<Ledger>(run ? ["ledger", run] : ["ledger"]);
  }

  budgetShow(run?: string): Promise<BudgetShow> {
    return this.runJson<BudgetShow>(run ? ["budget", "show", "--run", run] : ["budget", "show"]);
  }

  gateShow(run?: string): Promise<GateShow> {
    return this.runJson<GateShow>(run ? ["gate", "show", "--run", run] : ["gate", "show"]);
  }

  // ── Action commands ────────────────────────────────────────────────────────

  runStart(opts: StartRunOptions): Promise<RunStartResult> {
    const args = ["run", "start", opts.problem];
    if (opts.criteria) args.push("--criteria", opts.criteria);
    if (opts.seats) args.push("--seats", opts.seats);
    if (opts.domain) args.push("--domain", opts.domain);
    if (opts.approval) args.push("--approval", opts.approval);
    if (opts.routing) args.push("--routing", opts.routing);
    if (opts.budgetUsd != null) args.push("--budget", String(opts.budgetUsd));
    if (opts.epsilon != null) args.push("--epsilon", String(opts.epsilon));
    return this.runJson<RunStartResult>(args);
  }

  gateApprove(opts: { run?: string; winner?: string; feedback?: string }): Promise<GateApproveResult> {
    const args = ["gate", "approve"];
    if (opts.winner) args.push("--winner", opts.winner);
    if (opts.feedback) args.push("--feedback", opts.feedback);
    if (opts.run) args.push("--run", opts.run);
    return this.runJson<GateApproveResult>(args);
  }

  /** Mark a run terminally stopped (engine-side cancel) so a later resume won't
   *  re-drive it. Wraps `collab run stop [run] --json`. The separately-running
   *  orchestrate child is the caller's own to SIGTERM. */
  runStop(run?: string): Promise<RunStopResult> {
    return this.runJson<RunStopResult>(run ? ["run", "stop", run] : ["run", "stop"]);
  }

  gateReject(opts: { run?: string; feedback: string }): Promise<GateRejectResult> {
    const args = ["gate", "reject", "--feedback", opts.feedback];
    if (opts.run) args.push("--run", opts.run);
    return this.runJson<GateRejectResult>(args);
  }

  /** Lift the spend ceiling and clear any pending budget_exceeded gate. Wraps `collab budget raise --to <usd>`. */
  budgetRaise(opts: { run?: string; toUsd: number }): Promise<BudgetRaiseResult> {
    const args = ["budget", "raise", "--to", String(opts.toUsd)];
    if (opts.run) args.push("--run", opts.run);
    return this.runJson<BudgetRaiseResult>(args);
  }

  /** Take over a seat (schema 3). SETS the seat's pause flag and blocks (bounded by
   *  `waitMs`) until the seat leaves `working`, then returns the authoritative
   *  interactive resume spec (`session`, `sessionCwd`, `resumeCommand`,
   *  `resumeArgs`, `ready`). On engine failure the envelope surfaces as
   *  `{ok:false,error}` — the engine ATOMIC-FAILS (clears its own pause flag), so
   *  the caller needs no cleanup, just surface the message + hint. Wraps
   *  `collab seat pause <seat> [--run] [--adapters-dir] [--wait-ms] --json`. */
  async pauseSeat(
    seat: string,
    run?: string,
    opts?: { adaptersDir?: string; waitMs?: number }
  ): Promise<SeatPauseResult> {
    const args = ["seat", "pause", seat];
    if (run) args.push("--run", run);
    const adaptersDir = opts?.adaptersDir ?? this.config.adaptersDir;
    if (adaptersDir) args.push("--adapters-dir", adaptersDir);
    // FIX D: pin the engine's seat-idle wait to an explicit bound (default 60000 —
    // the engine's own default) and give the client timeout a +30s margin over it,
    // so the client can NEVER SIGTERM `seat pause` mid-wait (which would leave the
    // seat stuck paused, its atomic-fail cleanup never reached). Client 90s > wait 60s.
    const waitMs = opts?.waitMs ?? 60000;
    args.push("--wait-ms", String(waitMs));
    try {
      return await this.runJson<SeatPauseSuccess>(args, waitMs + 30000);
    } catch (err) {
      if (err instanceof EngineError) {
        return { ok: false, error: { code: err.code, message: err.message, hint: err.hint } };
      }
      throw err;
    }
  }

  /** Release a taken-over seat (schema 3) — clears the pause flag so the
   *  orchestrator resumes headless driving. Wraps `collab seat resume <seat>
   *  [--run] --json`. */
  async resumeSeat(seat: string, run?: string): Promise<SeatResumeResult> {
    const args = ["seat", "resume", seat];
    if (run) args.push("--run", run);
    try {
      return await this.runJson<SeatResumeSuccess>(args);
    } catch (err) {
      if (err instanceof EngineError) {
        return { ok: false, error: { code: err.code, message: err.message, hint: err.hint } };
      }
      throw err;
    }
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function isErrorEnvelope(v: unknown): v is ErrorEnvelope {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { ok?: unknown }).ok === false &&
    typeof (v as { error?: unknown }).error === "object" &&
    (v as { error?: unknown }).error !== null
  );
}

/** The engine prints one JSON line; guard against banner/log noise by taking the last non-empty line. */
function lastJsonLine(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.length ? lines[lines.length - 1] : text;
}

function truncate(s: string, n = 200): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
