/**
 * Status-bar view-model — active run name + phase + live spend. Pure.
 */
import type { RunSummary } from "../engine/contract.js";
import type { RunModel } from "./model.js";

export interface StatusBarModel {
  /** Text shown in the status bar (with a leading codicon). */
  text: string;
  tooltip: string;
  /** Whether to show the item at all. */
  visible: boolean;
  /** True when a gate pends — the item should use a warning background. */
  warning: boolean;
}

function money(n: number): string {
  return `$${n.toFixed(n >= 1 ? 2 : 4)}`;
}

/** Prefer the live snapshot model; fall back to the run-list summary. */
export function statusBarModel(
  model: RunModel | null,
  fallback?: RunSummary | null
): StatusBarModel {
  const run = model?.run;
  if (run) {
    const spend = model!.ledger.total;
    const gatePending = !!model!.gate;
    return {
      text: `$(organization) ${run.name} · ${run.phase} · ${money(spend)}`,
      tooltip: gatePending
        ? `Conclave: ${run.name} — ${run.phase}/${run.status}. A gate needs attention. Click to open.`
        : `Conclave: ${run.name} — ${run.phase}/${run.status}, spend ${money(spend)}. Click to focus the run.`,
      visible: true,
      warning: gatePending
    };
  }
  if (fallback) {
    return {
      text: `$(organization) ${fallback.name} · ${fallback.phase} · ${money(fallback.spend)}`,
      tooltip: `Conclave: ${fallback.name} — ${fallback.phase}/${fallback.status}. Click to focus the run.`,
      visible: true,
      warning: false
    };
  }
  return { text: "$(organization) Conclave", tooltip: "Conclave: no active run. Click to start one.", visible: false, warning: false };
}
