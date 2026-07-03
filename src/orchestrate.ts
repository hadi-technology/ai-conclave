/**
 * OrchestrateController — spawns `collab orchestrate` as a managed child so a
 * "Start run" actually DRIVES the run (not just creates it), mirroring the
 * cockpit's fleet spawn (src/cockpit/fleet.ts). The orchestrate child runs the
 * real phase machine until it idles on a gate (exits) or the run completes; the
 * controller re-spawns after each gate is resolved. Live progress is read through
 * the watch feed, not this child's stdout — stdout is only a rolling log.
 *
 * The arg builder is pure (unit-testable). The spawn is injectable so lifecycle
 * (start / gate-driven re-spawn / stop teardown) is testable with a fake.
 */
import { spawn as nodeSpawn } from "node:child_process";

export interface OrchestrateConfig {
  nodePath: string;
  enginePath: string;
  cwd: string;
  storePath?: string;
  adaptersDir?: string;
  /** The target git repo the fleet builds in (defaults to cwd). */
  target?: string;
  /** Continue into the execution spine after plan approval. */
  execute?: boolean;
  implementTier?: string;
  minUnits?: number;
  routing?: string;
  domain?: string;
  approval?: string;
  budgetUsd?: number | null;
}

/**
 * Build the argv passed to Node (engine path first, then subcommand). Pure — this
 * is the exact contract the controller hands the child. Keep in sync with the
 * `collab orchestrate` CLI flags.
 */
export function buildOrchestrateArgs(cfg: OrchestrateConfig, runId: number): string[] {
  const args: string[] = [cfg.enginePath];
  if (cfg.storePath) args.push("--store", cfg.storePath);
  args.push("orchestrate", "--run", String(runId));
  args.push("--adapters-dir", cfg.adaptersDir ?? `${cfg.cwd}/adapters`);
  if (cfg.execute) {
    // Repo-safety invariant: executing creates git worktrees/branches/commits in
    // `--target`, so we NEVER silently fall back to the workspace root. The caller
    // must resolve a safe (isolated scratch, or explicit) target first.
    if (!cfg.target) {
      throw new Error("buildOrchestrateArgs: --execute requires an explicit build target (never the workspace root)");
    }
    args.push("--execute");
    args.push("--target", cfg.target);
    args.push("--implement-tier", cfg.implementTier ?? "cheap");
    args.push("--min-units", String(cfg.minUnits ?? 4));
  }
  if (cfg.routing) args.push("--routing", cfg.routing);
  if (cfg.domain) args.push("--domain", cfg.domain);
  if (cfg.approval) args.push("--approval", cfg.approval);
  if (cfg.budgetUsd != null) args.push("--budget", String(cfg.budgetUsd));
  return args;
}

/** Minimal child handle the controller needs (subset of ChildProcess). */
export interface SpawnedChild {
  on(event: "exit", listener: (code: number | null) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): void } | null;
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): void } | null;
  kill(signal?: NodeJS.Signals): void;
}

export type SpawnFn = (command: string, args: string[], cwd: string) => SpawnedChild;

const defaultSpawn: SpawnFn = (command, args, cwd) =>
  nodeSpawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });

export interface OrchestrateHooks {
  onLog?: (line: string) => void;
  /** Child exited — `idleOnGate` is our best guess when a gate is pending. */
  onExit?: (info: { code: number | null; stopped: boolean }) => void;
}

/**
 * Manages a single run's orchestrate child. `.start()` spawns it; when it exits
 * (idled on a gate or done) `onExit` fires — the extension resolves the gate then
 * calls `.resume()` to re-spawn. `.stop()` tears the child down (SIGTERM) and
 * marks the controller stopped so a late exit doesn't re-fire.
 */
export class OrchestrateController {
  private child: SpawnedChild | null = null;
  private stopped = false;
  private running = false;

  constructor(
    private readonly cfg: OrchestrateConfig,
    private readonly runId: number,
    private readonly hooks: OrchestrateHooks = {},
    private readonly spawnFn: SpawnFn = defaultSpawn
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    this.stopped = false;
    this.spawnChild();
  }

  /** Re-spawn after a gate was resolved (no-op if stopped). */
  resume(): void {
    if (this.stopped || this.running) return;
    this.spawnChild();
  }

  stop(): void {
    this.stopped = true;
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
    this.running = false;
  }

  private spawnChild(): void {
    const args = buildOrchestrateArgs(this.cfg, this.runId);
    let child: SpawnedChild;
    try {
      child = this.spawnFn(this.cfg.nodePath, args, this.cfg.target ?? this.cfg.cwd);
    } catch (err) {
      this.running = false;
      this.hooks.onLog?.(`[orchestrate] spawn failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.child = child;
    this.running = true;
    const feed = (chunk: Buffer | string) => {
      for (const line of String(chunk).split("\n")) if (line.trim()) this.hooks.onLog?.(line.trim());
    };
    child.stdout?.on("data", feed);
    child.stderr?.on("data", feed);
    child.on("error", (err) => this.hooks.onLog?.(`[orchestrate] error: ${err.message}`));
    child.on("exit", (code) => {
      this.child = null;
      this.running = false;
      const stopped = this.stopped;
      this.hooks.onExit?.({ code, stopped });
    });
  }
}
