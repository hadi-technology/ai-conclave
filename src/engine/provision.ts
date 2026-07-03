/**
 * Provisioning: locate a Node ≥25 binary and the wrk2gthr engine entrypoint,
 * then verify engine + schema-version compatibility via `collab version --json`.
 *
 * Pure Node (no `vscode` import) so it is unit-testable headlessly. The extension
 * passes in the resolved settings; this module turns them into a ready-to-drive
 * engine handle or a clear, actionable EngineError.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { EngineError } from "./errors.js";
import { CLIENT_SCHEMA_VERSION, type VersionInfo } from "./contract.js";

const execFileAsync = promisify(execFile);

/** Minimum Node major the engine requires (it imports .ts directly). */
export const MIN_NODE_MAJOR = 25;

/** Default engine location: a local wrk2gthr checkout on this machine. */
export const DEFAULT_ENGINE_PATH =
  "/Users/Baba/Documents/wrk2gthr/bin/collab.mjs";

export interface EngineConfig {
  /** conclave.nodePath — explicit Node ≥25 binary, or "" to auto-detect. */
  nodePath?: string;
  /** conclave.enginePath — explicit engine entrypoint, or "" to auto-detect. */
  enginePath?: string;
}

export interface ProvisionResult {
  status: "ready";
  nodePath: string;
  enginePath: string;
  engineVersion: string;
  schemaVersion: number;
  minClientSchema: number;
}

/** Parse a `node --version` string ("v25.9.0") to its major integer. */
export function parseNodeMajor(version: string): number | null {
  const m = /v?(\d+)\./.exec(version.trim());
  return m ? Number(m[1]) : null;
}

/** Run `<candidate> --version`; return its major, or null if it isn't runnable. */
async function nodeMajorOf(candidate: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(candidate, ["--version"], {
      timeout: 5000
    });
    return parseNodeMajor(stdout);
  } catch {
    return null;
  }
}

/** Ordered candidate Node binaries to probe when none is configured. */
function nodeCandidates(): string[] {
  const list: string[] = ["node", "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
  // nvm — newest installed version first.
  try {
    const nvmDir = join(homedir(), ".nvm", "versions", "node");
    if (existsSync(nvmDir)) {
      const versions = readdirSync(nvmDir)
        .filter((v) => v.startsWith("v"))
        .sort()
        .reverse();
      for (const v of versions) list.push(join(nvmDir, v, "bin", "node"));
    }
  } catch {
    /* ignore */
  }
  return list;
}

/**
 * Locate a Node ≥25 binary. Order: configured override → PATH `node` → common
 * locations (homebrew, /usr/local, nvm) → clear error.
 */
export async function locateNode(config: EngineConfig): Promise<string> {
  const configured = config.nodePath?.trim();
  if (configured) {
    if (!existsSync(configured)) {
      throw new EngineError(
        "node_not_found",
        `Configured Node binary not found at ${configured}`,
        "Fix conclave.nodePath or clear it to auto-detect."
      );
    }
    const major = await nodeMajorOf(configured);
    if (major === null) {
      throw new EngineError(
        "node_unrunnable",
        `Configured Node at ${configured} could not be run`,
        "Point conclave.nodePath at a working Node 25+ binary."
      );
    }
    if (major < MIN_NODE_MAJOR) {
      throw new EngineError(
        "node_too_old",
        `Configured Node at ${configured} is v${major}, but Conclave needs Node ${MIN_NODE_MAJOR}+`,
        `Set conclave.nodePath to a Node ${MIN_NODE_MAJOR}+ binary or install Node ${MIN_NODE_MAJOR}.`
      );
    }
    return configured;
  }

  for (const candidate of nodeCandidates()) {
    const major = await nodeMajorOf(candidate);
    if (major !== null && major >= MIN_NODE_MAJOR) return candidate;
  }

  throw new EngineError(
    "node_too_old",
    `Conclave needs Node ${MIN_NODE_MAJOR}+ to run the engine, but none was found`,
    `Set conclave.nodePath to a Node ${MIN_NODE_MAJOR}+ binary or install Node ${MIN_NODE_MAJOR} (e.g. 'brew install node').`
  );
}

/**
 * Locate the engine entrypoint. Order: configured override → default local
 * checkout → clear error.
 */
export function locateEngine(config: EngineConfig): string {
  const configured = config.enginePath?.trim();
  if (configured) {
    if (!existsSync(configured)) {
      throw new EngineError(
        "engine_not_found",
        `Configured engine not found at ${configured}`,
        "Fix conclave.enginePath or clear it to auto-detect."
      );
    }
    return configured;
  }
  if (existsSync(DEFAULT_ENGINE_PATH)) return DEFAULT_ENGINE_PATH;

  throw new EngineError(
    "engine_not_found",
    "Could not locate the wrk2gthr engine",
    "Set conclave.enginePath to the engine's bin/collab.mjs."
  );
}

/**
 * Full provisioning: locate Node + engine, run `version --json`, verify schema
 * compatibility. Returns a ready handle or throws a friendly EngineError.
 */
export async function provision(config: EngineConfig): Promise<ProvisionResult> {
  const nodePath = await locateNode(config);
  const enginePath = locateEngine(config);

  let raw: string;
  try {
    const { stdout } = await execFileAsync(nodePath, [enginePath, "version", "--json"], {
      timeout: 15000
    });
    raw = stdout.trim();
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new EngineError(
      "engine_unrunnable",
      `The engine could not be run: ${detail}`,
      `Check conclave.enginePath and that conclave.nodePath is Node ${MIN_NODE_MAJOR}+.`
    );
  }

  let info: VersionInfo;
  try {
    info = JSON.parse(raw) as VersionInfo;
  } catch {
    throw new EngineError(
      "bad_version_output",
      "The engine's version output was not valid JSON",
      "The engine may be too old or incompatible. Update wrk2gthr."
    );
  }

  const engineSchema = info.schemaVersion;
  const minClient = info.minClientSchema;
  const compatible = minClient <= CLIENT_SCHEMA_VERSION && CLIENT_SCHEMA_VERSION <= engineSchema;
  if (!compatible) {
    throw new EngineError(
      "schema_incompatible",
      `Engine schema v${engineSchema} (min client v${minClient}) is not compatible with Conclave client schema v${CLIENT_SCHEMA_VERSION}`,
      CLIENT_SCHEMA_VERSION < minClient
        ? "Update the Conclave extension."
        : "Update the wrk2gthr engine."
    );
  }

  return {
    status: "ready",
    nodePath,
    enginePath,
    engineVersion: info.engineVersion,
    schemaVersion: engineSchema,
    minClientSchema: minClient
  };
}
