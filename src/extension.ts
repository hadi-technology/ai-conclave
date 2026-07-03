/**
 * Conclave — VS Code / Cursor extension entry point.
 *
 * Thin client. Owns lifecycle (activate/deactivate), reads settings, resolves an
 * EngineClient through the single seam (src/engine/*), and registers the E1 core
 * commands. No orchestration logic lives here — every read/action flows through
 * the engine client, which spawns `collab` and speaks only the JSON contract.
 */
import * as vscode from "vscode";

import { EngineClient, type ClientConfig } from "./engine/client.js";
import { EngineError } from "./engine/errors.js";
import { provision, type EngineConfig, type ProvisionResult } from "./engine/provision.js";
import { WatchClient } from "./engine/watch.js";
import { registerCommands } from "./commands.js";

/** Shared context handed to command handlers. */
export interface ConclaveContext {
  readonly output: vscode.OutputChannel;
  /** Live watch attachments, keyed by run ref — so Stop run can detach them. */
  readonly watchers: Map<string, WatchClient>;
  /** Resolve a ready-to-drive engine client (locates Node ≥25 + engine, checks schema). */
  resolveClient(): Promise<EngineClient>;
  /** Provision only (version/compat check) without building a client. */
  ensureProvisioned(): Promise<ProvisionResult>;
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

async function resolveClient(): Promise<EngineClient> {
  const cwd = workspaceCwd();
  const prov = await ensureProvisioned();
  const cfg = vscode.workspace.getConfiguration("conclave");
  const adaptersDir = cfg.get<string>("adaptersDir", "").trim();
  const clientConfig: ClientConfig = {
    nodePath: prov.nodePath,
    enginePath: prov.enginePath,
    cwd,
    adaptersDir: adaptersDir || undefined
  };
  return new EngineClient(clientConfig);
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Conclave");
  context.subscriptions.push(output);

  const watchers = new Map<string, WatchClient>();

  // Invalidate the provisioning cache when engine/node settings change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("conclave.nodePath") ||
        e.affectsConfiguration("conclave.enginePath")
      ) {
        cachedProvision = undefined;
        output.appendLine("[conclave] engine/node settings changed — will re-provision on next command.");
      }
    })
  );

  const ctx: ConclaveContext = {
    output,
    watchers,
    resolveClient,
    ensureProvisioned
  };

  registerCommands(context, ctx);

  output.appendLine("[conclave] activated. Run a command from the palette (Conclave: …).");
}

export function deactivate(): void {
  // Nothing persistent to tear down; watchers are disposed via subscriptions.
}
