/**
 * Runs view-model — active/recent runs as an expandable tree. Pure.
 */
import type { RunSummary } from "../engine/contract.js";
import type { ConclaveTreeNode } from "./tree.js";
import { placeholder } from "./tree.js";

function money(n: number): string {
  return `$${n.toFixed(n >= 1 ? 2 : 4)}`;
}

export function runsTree(runs: RunSummary[], activeRunRef?: string | null): ConclaveTreeNode[] {
  if (runs.length === 0) {
    return [placeholder("runs.empty", "No runs yet — Start a run")];
  }
  // Active first, then by id descending (recency).
  const ordered = [...runs].sort(
    (a, b) => Number(b.active) - Number(a.active) || b.id - a.id
  );
  return ordered.map((r) => {
    const isActive = activeRunRef === r.name || activeRunRef === String(r.id);
    const icon = r.active ? (isActive ? "debug-start" : "play-circle") : "history";
    return {
      key: `run.${r.id}`,
      label: r.name,
      description: `${r.phase} · ${r.status} · ${money(r.spend)}`,
      tooltip: r.problem ? `#${r.id} — ${r.problem}` : `#${r.id}`,
      icon,
      contextValue: r.active ? "conclaveRunActive" : "conclaveRun",
      runRef: r.name,
      collapse: "collapsed",
      children: [
        { key: `run.${r.id}.phase`, label: `Phase: ${r.phase}`, icon: "milestone", collapse: "none" },
        { key: `run.${r.id}.status`, label: `Status: ${r.status}`, icon: "pulse", collapse: "none" },
        { key: `run.${r.id}.spend`, label: `Spend: ${money(r.spend)}`, icon: "credit-card", collapse: "none" }
      ]
    };
  });
}
