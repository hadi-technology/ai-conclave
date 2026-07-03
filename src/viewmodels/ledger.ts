/**
 * Ledger view-model — per-seat/model, per-tier, per-phase cost rollups, exact vs
 * estimated. Pure. Subscription (estimated) spend is never shown as exact.
 */
import type { LedgerVM, RollupVM } from "./model.js";
import type { ConclaveTreeNode } from "./tree.js";

export function money(n: number): string {
  return `$${n.toFixed(n >= 1 ? 2 : 4)}`;
}

function rollupChildren(prefix: string, rows: RollupVM[]): ConclaveTreeNode[] {
  return rows.map((r) => ({
    key: `${prefix}.${r.key}`,
    label: r.key,
    description: `${money(r.cost)} · ${r.turns} turns${r.estimated > 0 ? ` (est ${money(r.estimated)})` : ""}`,
    tooltip: `exact ${money(r.exact)} · estimated ${money(r.estimated)}`,
    icon: "circle-small-filled",
    collapse: "none"
  }));
}

export function ledgerTree(ledger: LedgerVM): ConclaveTreeNode[] {
  const nodes: ConclaveTreeNode[] = [];

  const budgetDesc =
    ledger.budgetUsd != null
      ? `${money(ledger.total)} / ${money(ledger.budgetUsd)}${ledger.fracUsed != null ? ` (${Math.round(ledger.fracUsed * 100)}%)` : ""}`
      : `${money(ledger.total)} · no budget`;
  nodes.push({
    key: "ledger.total",
    label: "Total",
    description: budgetDesc,
    tooltip: `exact ${money(ledger.exact)} · estimated ${money(ledger.estimated)}`,
    icon: "credit-card",
    contextValue: "conclaveLedgerTotal",
    collapse: "none"
  });

  nodes.push({
    key: "ledger.perSeatModel",
    label: "Per seat / model",
    description: String(ledger.perSeatModel.length),
    icon: "account",
    collapse: ledger.perSeatModel.length > 0 ? "expanded" : "none",
    children: ledger.perSeatModel.map((r) => ({
      key: `ledger.sm.${r.seat}.${r.model}`,
      label: `${r.seat} · ${r.model}`,
      description: `${money(r.cost)} · ${r.turns} turns · ${r.mode}`,
      icon: r.mode === "exact" ? "verified" : "dashboard",
      collapse: "none"
    }))
  });

  nodes.push({
    key: "ledger.perTier",
    label: "Per tier",
    description: String(ledger.perTier.length),
    icon: "layers",
    collapse: ledger.perTier.length > 0 ? "collapsed" : "none",
    children: rollupChildren("ledger.tier", ledger.perTier)
  });

  nodes.push({
    key: "ledger.perPhase",
    label: "Per phase",
    description: String(ledger.perPhase.length),
    icon: "milestone",
    collapse: ledger.perPhase.length > 0 ? "collapsed" : "none",
    children: rollupChildren("ledger.phase", ledger.perPhase)
  });

  return nodes;
}
