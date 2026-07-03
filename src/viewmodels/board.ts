/**
 * Board view-model — the run's work units grouped by status column. A native-tree
 * precursor to E3's Kanban. Columns: Queued / Building / Review / Done / Blocked.
 * Each unit shows title + owning seat + phase. Pure.
 */
import type { RunMeta, UnitVM } from "./model.js";
import type { ConclaveTreeNode } from "./tree.js";
import { placeholder } from "./tree.js";

export type BoardColumn = "Queued" | "Building" | "Review" | "Done" | "Blocked";

export const BOARD_COLUMNS: BoardColumn[] = ["Queued", "Building", "Review", "Done", "Blocked"];

const COLUMN_ICON: Record<BoardColumn, string> = {
  Queued: "circle-outline",
  Building: "tools",
  Review: "eye",
  Done: "pass-filled",
  Blocked: "error"
};

/** Map a unit status (ExecItem or report vocabulary) to a board column. */
export function unitColumn(status: string): BoardColumn {
  switch (status) {
    case "pending":
    case "queued":
    case "unclaimed":
      return "Queued";
    case "claimed":
    case "implementing":
    case "building":
    case "in_progress":
    case "fixed":
    case "qa_fail":
      return "Building";
    case "implemented":
    case "review":
    case "in_review":
    case "qa":
      return "Review";
    case "qa_pass":
    case "merged":
    case "done":
    case "complete":
      return "Done";
    case "blocked":
    case "failed":
    case "excused":
      return "Blocked";
    default:
      return "Queued";
  }
}

export function groupUnits(units: UnitVM[]): Record<BoardColumn, UnitVM[]> {
  const cols: Record<BoardColumn, UnitVM[]> = {
    Queued: [],
    Building: [],
    Review: [],
    Done: [],
    Blocked: []
  };
  for (const u of units) cols[unitColumn(u.status)].push(u);
  for (const c of BOARD_COLUMNS) cols[c].sort((a, b) => a.seq - b.seq);
  return cols;
}

export function boardTree(units: UnitVM[], run: RunMeta | null): ConclaveTreeNode[] {
  if (units.length === 0) {
    return [placeholder("board.empty", "No work units yet (decompose starts after plan approval)")];
  }
  const grouped = groupUnits(units);
  const phase = run?.phase ?? "?";
  return BOARD_COLUMNS.map((col) => {
    const items = grouped[col];
    return {
      key: `board.${col}`,
      label: col,
      description: String(items.length),
      icon: COLUMN_ICON[col],
      contextValue: "conclaveBoardColumn",
      collapse: items.length > 0 ? "expanded" : "none",
      children: items.map((u) => ({
        key: `board.${col}.unit.${u.seq}`,
        label: `#${u.seq} ${u.title}`,
        description: [u.author ? `@${u.author}` : null, phase].filter(Boolean).join(" · "),
        tooltip: [
          `#${u.seq} ${u.title}`,
          `status: ${u.status}`,
          u.author ? `author: ${u.author}` : null,
          u.reviewer ? `reviewer: ${u.reviewer}` : null,
          u.tier ? `tier: ${u.tier}` : null
        ]
          .filter(Boolean)
          .join("\n"),
        icon: "circle-small-filled",
        collapse: "none"
      }))
    };
  });
}
