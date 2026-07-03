import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { provision, type ProvisionResult } from "../src/engine/provision.js";

const execFileAsync = promisify(execFile);

export interface SeededStore {
  prov: ProvisionResult;
  dir: string;
  storePath: string;
  runName: string;
  runId: number;
}

/** Provision (locate Node ≥25 + engine) once for the suite. */
export async function provisionForTests(): Promise<ProvisionResult> {
  return provision({});
}

/**
 * Init a temp store and start one run against it — the real seeded fixture the
 * client tests read through the JSON contract.
 */
export async function seedStore(prov: ProvisionResult): Promise<SeededStore> {
  const dir = mkdtempSync(join(tmpdir(), "conclave-test-"));
  const storePath = join(dir, ".collab", "store.db");
  const engine = (args: string[]) =>
    execFileAsync(prov.nodePath, [prov.enginePath, "--store", storePath, ...args], {
      cwd: dir,
      timeout: 30000
    });

  await engine(["init"]);
  const { stdout } = await engine([
    "run",
    "start",
    "Seed problem for the client test",
    "--criteria",
    "the client parses it",
    "--seats",
    "a,b",
    "--json"
  ]);
  const started = JSON.parse(stdout.trim()) as { run: string; id: number };
  return { prov, dir, storePath, runName: started.run, runId: started.id };
}
