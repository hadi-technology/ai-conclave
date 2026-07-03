/**
 * Conclave — VS Code / Cursor extension entry point.
 *
 * Thin client. Owns lifecycle (activate/deactivate), reads settings, resolves an
 * EngineClient through the single seam (src/engine/*), wires the E2 native UX
 * (sidebar tree views, status bar, gate notifications, guided start-run flow that
 * drives an orchestrate child), and registers the commands. No orchestration
 * logic lives here — every read/action flows through the engine client + the
 * `collab watch --json` feed. Long-lived driving is delegated to a managed
 * `collab orchestrate` child (OrchestrateController), never reimplemented.
 */
import * as vscode from "vscode";

import { EngineClient, type ClientConfig } from "./engine/client.js";
import { EngineError } from "./engine/errors.js";
import { provision, type EngineConfig, type ProvisionResult } from "./engine/provision.js";
import { WatchClient } from "./engine/watch.js";
import { StateBus } from "./statebus.js";
import { OrchestrateController } from "./orchestrate.js";
import { presentGate } from "./gates.js";
import { registerViews, type ViewData } from "./views.js";
import { registerCommands, openReportForRun } from "./commands.js";
import { CockpitPanel } from "./cockpit.js";
import { FindingsManager } from "./findings.js";
import { reviewUnit, openIntegrationDiff, revealBuildTarget } from "./diffReview.js";
import { takeoverSeat } from "./takeover.js";
import { emptyModel, type RunModel } from "./viewmodels/model.js";
import { planCancelRun, planStopWatching } from "./viewmodels/stop.js";
import { planBuildTarget } from "./viewmodels/startRun.js";
import { prepareBuildTarget } from "./buildTarget.js";
import { scratchRoot } from "./startRunFlow.js";
import { join } from "node:path";
import type { RunSummary } from "./engine/contract.js";

/** Shared context handed to command handlers. */
export interface ConclaveContext {
  readonly output: vscode.OutputChannel;
  /** Live watch attachments, keyed by run ref — so Stop watching can detach them. */
  readonly watchers: Map<string, WatchClient>;
  /** Managed orchestrate children, keyed by run ref — so Stop tears them down. */
  readonly orchestrators: Map<string, OrchestrateController>;
  /** Build targets (the fleet's scratch clone) per run ref — populated when a run
   *  is driven this session; E4 diff/jump/takeover resolve file paths + git here. */
  readonly targets: Map<string, string>;
  /** The build target a run's produced code lives in. Falls back to the
   *  configured targetDir, then the workspace root, for runs not driven here.
   *  Callers that need PROVENANCE (e.g. jumping into produced code) must use
   *  {@link knownBuildTargetFor} instead — the fallback here can point at an
   *  arbitrary same-named tree. */
  buildTargetFor(runRef: string): string;
  /** The build target ONLY when it is provenance-known (the run was driven this
   *  session, tracked in `targets`); null otherwise. No fallback tree. */
  knownBuildTargetFor(runRef: string): string | null;
  /** Resolve a ready-to-drive engine client. */
  resolveClient(): Promise<EngineClient>;
  /** The resolved ClientConfig (nodePath/enginePath/cwd/adaptersDir). */
  resolveClientConfig(): Promise<ClientConfig>;
  /** Provision only (version/compat check). */
  ensureProvisioned(): Promise<ProvisionResult>;
  /** The live state bus (built lazily on first use). */
  ensureBus(): Promise<StateBus>;
  /** Focus a run in the views + attach its live feed. */
  focusRun(runRef: string): Promise<void>;
  /** Spawn the orchestrate child that drives a run. `target` is the pre-prepared
   *  build dir (from the start-run flow); when absent, a safe one is resolved. */
  driveRun(runRef: string, opts?: { fullAuto?: boolean; target?: string }): Promise<void>;
  /** CANCEL a run: engine-side terminal stop (`collab run stop`, so a resume never
   *  re-drives it) + SIGTERM the managed orchestrate child. Leaves the viewer. */
  cancelRun(runRef: string): Promise<void>;
  /** Detach the live watch viewer only — the run (and any driving) keeps going. */
  stopWatching(runRef: string): void;
}

let cachedProvision: { signature: string; result: ProvisionResult } | undefined;

function readEngineConfig(): EngineConfig {
  const cfg = vscode.workspace.getConfiguration("conclave");
  return {
    nodePath: cfg.get<string>("nodePath", ""),
    enginePath: cfg.get<string>("enginePath", "")
  };
}

function workspaceCwd(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new EngineError(
      "no_workspace",
      "No folder is open",
      "Open the folder that holds (or will hold) the run's .collab store, then try again."
    );
  }
  return folder.uri.fsPath;
}

async function ensureProvisioned(): Promise<ProvisionResult> {
  const engineConfig = readEngineConfig();
  const signature = `${engineConfig.nodePath ?? ""}|${engineConfig.enginePath ?? ""}`;
  if (cachedProvision && cachedProvision.signature === signature) {
    return cachedProvision.result;
  }
  const result = await provision(engineConfig);
  cachedProvision = { signature, result };
  return result;
}

async function resolveClientConfig(): Promise<ClientConfig> {
  const cwd = workspaceCwd();
  const prov = await ensureProvisioned();
  const cfg = vscode.workspace.getConfiguration("conclave");
  const adaptersDir = cfg.get<string>("adaptersDir", "").trim();
  return { nodePath: prov.nodePath, enginePath: prov.enginePath, cwd, adaptersDir: adaptersDir || undefined };
}

async function resolveClient(): Promise<EngineClient> {
  return new EngineClient(await resolveClientConfig());
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Conclave");
  context.subscriptions.push(output);

  const watchers = new Map<string, WatchClient>();
  const orchestrators = new Map<string, OrchestrateController>();
  const targets = new Map<string, string>();

  function buildTargetFor(runRef: string): string {
    const tracked = targets.get(runRef);
    if (tracked) return tracked;
    const cfg = vscode.workspace.getConfiguration("conclave");
    const configured = cfg.get<string>("targetDir", "").trim();
    if (configured) return configured;
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  function knownBuildTargetFor(runRef: string): string | null {
    return targets.get(runRef) ?? null;
  }

  // Invalidate the provisioning cache when engine/node settings change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("conclave.nodePath") || e.affectsConfiguration("conclave.enginePath")) {
        cachedProvision = undefined;
        output.appendLine("[conclave] engine/node settings changed — will re-provision on next command.");
      }
    })
  );

  // A change signal the views subscribe to, backed by the bus once it exists.
  const onChangeEmitter = new vscode.EventEmitter<void>();
  context.subscriptions.push(onChangeEmitter);

  let bus: StateBus | null = null;
  let busInit: Promise<StateBus> | null = null;

  async function ensureBus(): Promise<StateBus> {
    if (bus) return bus;
    if (busInit) return busInit;
    busInit = (async () => {
      const clientConfig = await resolveClientConfig();
      const client = new EngineClient(clientConfig);
      const makeWatch = (run: string) => new WatchClient(clientConfig, { run });
      const b = new StateBus(client, makeWatch);
      b.on("change", () => onChangeEmitter.fire());
      b.on("log", (line) => output.appendLine(`[bus] ${line}`));
      b.on("gate", (gate, runRef) => {
        void presentGate(gate, {
          client,
          runRef,
          log: (l) => output.appendLine(`[gate] ${l}`),
          openReport: (r) => openReportForRun(ctx, r),
          stop: (r) => {
            void cancelRun(r);
          }
        });
      });
      bus = b;
      await b.refreshRuns();
      return b;
    })();
    return busInit;
  }

  async function focusRun(runRef: string): Promise<void> {
    const b = await ensureBus();
    b.attach(runRef);
    onChangeEmitter.fire();
    await vscode.commands.executeCommand("conclave.runsView.focus");
  }

  async function driveRun(runRef: string, opts?: { fullAuto?: boolean; target?: string }): Promise<void> {
    if (orchestrators.has(runRef)) return; // already driving
    const clientConfig = await resolveClientConfig();
    const client = new EngineClient(clientConfig);
    const runsResp = await client.runs();
    const summary = runsResp.runs.find((r) => r.name === runRef || String(r.id) === runRef);
    if (!summary) throw new EngineError("run_not_found", `No run named "${runRef}"`, "Refresh the Runs view.");

    // Resolve a SAFE build target. When start-run already prepared one, use it;
    // otherwise (the standalone "Drive run" command) plan + confirm + prepare one,
    // so we never build in the live workspace root silently.
    let target = opts?.target;
    if (!target) {
      const cfg = vscode.workspace.getConfiguration("conclave");
      const plan = planBuildTarget({
        configuredTargetDir: cfg.get<string>("targetDir", ""),
        workspaceRoot: clientConfig.cwd,
        scratchRoot: scratchRoot(),
        runLabel: `${runRef}-${Date.now()}`
      });
      const where = plan.mode === "scratch" ? "an isolated scratch copy of your repo" : plan.target;
      const warn = plan.warnLiveRepo ? " WARNING: that is your LIVE workspace repo (worktrees/branches/commits land there)." : "";
      const ok = await vscode.window.showWarningMessage(
        `Drive "${runRef}"? The fleet will build in: ${plan.target} (${where}).${warn} This spends real money/quota on your subscriptions.`,
        { modal: true },
        "Drive run"
      );
      if (ok !== "Drive run") return;
      target = await prepareBuildTarget(plan, clientConfig.cwd);
    }
    // Track the build target so E4 diff/jump/takeover can resolve this run's
    // produced code + git (the target path is not in the JSON contract).
    targets.set(runRef, target);

    // Pin the store to the WORKSPACE store — the orchestrate child runs with cwd =
    // the (scratch) target, so without this it would look for .collab there.
    const storePath = clientConfig.storePath ?? join(clientConfig.cwd, ".collab", "store.db");

    const controller = new OrchestrateController(
      { ...clientConfig, storePath, execute: true, target },
      summary.id,
      {
        onLog: (line) => output.appendLine(`[orchestrate ${runRef}] ${line}`),
        onExit: ({ code, stopped }) => {
          output.appendLine(`[orchestrate ${runRef}] exited (code ${code}, ${stopped ? "stopped" : "idle/done"}).`);
          // The bus's gate handler resolves any pending gate; resolving it fires a
          // change and the user (or full-auto) can resume driving.
        }
      }
    );
    orchestrators.set(runRef, controller);
    controller.start();
    output.appendLine(
      `[conclave] driving "${runRef}" (#${summary.id}) via orchestrate child in ${target}${opts?.fullAuto ? " (full-auto)" : ""}.`
    );
  }

  /** CANCEL a run — engine-side terminal stop + tear down the orchestrate child.
   *  Per {@link planCancelRun}: always asks the engine (idempotent, works for
   *  attached-only runs); kills the child only when we're driving; leaves the
   *  viewer attached so the user watches it wind down. */
  async function cancelRun(runRef: string): Promise<void> {
    const plan = planCancelRun({ driving: orchestrators.has(runRef), watching: watchers.has(runRef) });
    if (plan.engineStop) {
      try {
        const client = new EngineClient(await resolveClientConfig());
        const res = await client.runStop(runRef);
        output.appendLine(`[conclave] engine marked "${runRef}" ${res.status} (won't resume).`);
      } catch (err) {
        output.appendLine(
          `[conclave] engine run stop for "${runRef}" failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    if (plan.killOrchestrate) {
      const controller = orchestrators.get(runRef);
      if (controller) {
        controller.stop();
        orchestrators.delete(runRef);
        output.appendLine(`[conclave] stopped driving "${runRef}" (SIGTERM).`);
      }
    }
  }

  /** Detach the live watch viewer only (per {@link planStopWatching}). */
  function stopWatching(runRef: string): void {
    const plan = planStopWatching({ driving: orchestrators.has(runRef), watching: watchers.has(runRef) });
    if (plan.detachWatch) {
      const w = watchers.get(runRef);
      if (w) {
        w.stop();
        watchers.delete(runRef);
        output.appendLine(`[conclave] detached live watch for "${runRef}".`);
      }
    }
  }

  const ctx: ConclaveContext = {
    output,
    watchers,
    orchestrators,
    targets,
    buildTargetFor,
    knownBuildTargetFor,
    resolveClient,
    resolveClientConfig,
    ensureProvisioned,
    ensureBus,
    focusRun,
    driveRun,
    cancelRun,
    stopWatching
  };

  // ── Views + status bar ───────────────────────────────────────────────────────
  const viewData: ViewData = {
    runs: () => bus?.runs ?? ([] as RunSummary[]),
    model: () => bus?.runModel ?? (emptyModel() as RunModel),
    activeRunRef: () => bus?.activeRunRef ?? null,
    activeSummary: () => bus?.activeRunSummary() ?? null,
    onChange: onChangeEmitter.event
  };
  const views = registerViews(context, viewData);
  context.subscriptions.push({ dispose: () => views.dispose() });

  // Kick the bus so the views populate (best-effort; tolerates no engine yet).
  void ensureBus().catch((err) => {
    output.appendLine(`[conclave] engine not ready yet: ${err instanceof Error ? err.message : String(err)}`);
  });

  registerCommands(context, ctx);

  // The live Cockpit webview (E3). Needs `context` for extensionUri + subscriptions,
  // so it's registered here rather than in the vscode-free command module.
  context.subscriptions.push(
    vscode.commands.registerCommand("conclave.openCockpit", () =>
      CockpitPanel.createOrShow(context, ctx).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        output.appendLine(`[conclave] cockpit failed: ${message}`);
        void vscode.window.showErrorMessage(`Conclave: ${message}`);
      })
    )
  );

  // ── E4: native code integration (findings, diffs, takeover) ──────────────────
  const findings = new FindingsManager(ctx);
  context.subscriptions.push({ dispose: () => findings.dispose() });

  // Resolve a run ref for an E4 command: explicit arg → active run → pick one.
  async function resolveRunArg(arg: unknown): Promise<string | null> {
    if (typeof arg === "string") return arg;
    if (arg && typeof arg === "object" && typeof (arg as { runRef?: unknown }).runRef === "string") {
      return (arg as { runRef: string }).runRef;
    }
    const b = await ensureBus();
    if (b.activeRunRef) return b.activeRunRef;
    const { runs } = await new EngineClient(await resolveClientConfig()).runs();
    if (runs.length === 0) return null;
    if (runs.length === 1) return runs[0].name;
    const pick = await vscode.window.showQuickPick(
      runs.map((r) => ({ label: r.name, description: `#${r.id} · ${r.phase}`, run: r })),
      { placeHolder: "Which run?" }
    );
    return pick ? pick.run.name : null;
  }

  const e4 = (id: string, fn: (run: string, arg: unknown) => Promise<void>) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (arg?: unknown) => {
        try {
          const run = await resolveRunArg(arg);
          if (!run) {
            vscode.window.showInformationMessage("Conclave: no run available. Start one first.");
            return;
          }
          await fn(run, arg);
        } catch (err) {
          const shown = err instanceof EngineError ? err.toDisplay() : err instanceof Error ? err.message : String(err);
          output.appendLine(`[conclave] E4 command ${id} failed: ${shown}`);
          void vscode.window.showErrorMessage(`Conclave: ${shown}`);
        }
      })
    );

  e4("conclave.showFindings", (run) => findings.showFindings(run));
  e4("conclave.reviewUnit", (run) => reviewUnit(ctx, run));
  e4("conclave.openIntegrationDiff", (run) => openIntegrationDiff(ctx, run));
  e4("conclave.revealBuildTarget", (run) => revealBuildTarget(ctx, run));
  e4("conclave.takeoverSeat", () => takeoverSeat(ctx));

  // Keep the Problems panel in sync as findings change on the watch feed (throttled).
  let findingsRefreshAt = 0;
  context.subscriptions.push(
    onChangeEmitter.event(() => {
      const now = Date.now();
      if (now - findingsRefreshAt < 2000) return;
      findingsRefreshAt = now;
      void findings.refreshActive(bus?.activeRunRef ?? null);
    })
  );

  context.subscriptions.push({
    dispose: () => {
      for (const c of orchestrators.values()) c.stop();
      orchestrators.clear();
      for (const w of watchers.values()) w.stop();
      watchers.clear();
      bus?.dispose();
    }
  });

  output.appendLine("[conclave] activated.");
}

export function deactivate(): void {
  // Watchers/orchestrators/bus are torn down via subscriptions.
}
