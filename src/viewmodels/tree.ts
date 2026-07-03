/**
 * ConclaveTreeNode — a vscode-free description of a tree item. The pure
 * view-models emit these; the vscode TreeDataProvider layer (src/views.ts) maps
 * them to `vscode.TreeItem`s. Keeping the node shape vscode-free is what makes
 * every view-model unit-testable headlessly.
 */
export type NodeCollapse = "expanded" | "collapsed" | "none";

export interface ConclaveTreeNode {
  /** Stable identity for this node (for selection + reveal). */
  key: string;
  label: string;
  description?: string;
  tooltip?: string;
  /** A `vscode.ThemeIcon` id (e.g. "play", "warning"). */
  icon?: string;
  contextValue?: string;
  /** Run ref this node points at (for click-through commands). */
  runRef?: string;
  collapse?: NodeCollapse;
  children?: ConclaveTreeNode[];
}

/** A single "nothing here yet" placeholder node. */
export function placeholder(key: string, label: string): ConclaveTreeNode {
  return { key, label, icon: "info", collapse: "none" };
}
