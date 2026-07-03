/**
 * The vscode-facing view layer: four TreeDataProviders (Runs / Seats / Board /
 * Ledger) and the status-bar item. Each provider is a thin adapter — it asks a
 * pure view-model for `ConclaveTreeNode`s and maps them to `vscode.TreeItem`s.
 * All refresh is driven by the StateBus "change" event.
 */
import * as vscode from "vscode";

import type { RunSummary } from "./engine/contract.js";
import type { RunModel } from "./viewmodels/model.js";
import type { ConclaveTreeNode } from "./viewmodels/tree.js";
import { runsTree } from "./viewmodels/runs.js";
import { seatsTree } from "./viewmodels/seats.js";
import { boardTree } from "./viewmodels/board.js";
import { ledgerTree } from "./viewmodels/ledger.js";
import { statusBarModel } from "./viewmodels/statusbar.js";

/** The data the views read. Backed by the StateBus once it is wired; renders
 *  empty placeholders before then. */
export interface ViewData {
  runs(): RunSummary[];
  model(): RunModel;
  activeRunRef(): string | null;
  activeSummary(): RunSummary | null;
  onChange: vscode.Event<void>;
}

function toTreeItem(node: ConclaveTreeNode): vscode.TreeItem {
  const collapsibleState =
    node.collapse === "expanded"
      ? vscode.TreeItemCollapsibleState.Expanded
      : node.collapse === "collapsed"
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
  const item = new vscode.TreeItem(node.label, collapsibleState);
  if (node.description !== undefined) item.description = node.description;
  if (node.tooltip !== undefined) item.tooltip = node.tooltip;
  if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
  if (node.contextValue) item.contextValue = node.contextValue;
  item.id = node.key;
  if (node.runRef) {
    item.command = {
      command: "conclave.openRun",
      title: "Open run",
      arguments: [node.runRef]
    };
  }
  return item;
}

/** Base provider over a `() => ConclaveTreeNode[]` producer. */
class NodeTreeProvider implements vscode.TreeDataProvider<ConclaveTreeNode> {
  private readonly _onDidChange = new vscode.EventEmitter<ConclaveTreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private readonly produce: () => ConclaveTreeNode[]) {}

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  getTreeItem(node: ConclaveTreeNode): vscode.TreeItem {
    return toTreeItem(node);
  }

  getChildren(node?: ConclaveTreeNode): ConclaveTreeNode[] {
    if (!node) return this.produce();
    return node.children ?? [];
  }
}

export interface ConclaveViews {
  refreshAll(): void;
  dispose(): void;
}

export function registerViews(context: vscode.ExtensionContext, data: ViewData): ConclaveViews {
  const runsProvider = new NodeTreeProvider(() => runsTree(data.runs(), data.activeRunRef()));
  const seatsProvider = new NodeTreeProvider(() => seatsTree(data.model().seats));
  const boardProvider = new NodeTreeProvider(() => boardTree(data.model().units, data.model().run));
  const ledgerProvider = new NodeTreeProvider(() => ledgerTree(data.model().ledger));

  const runsView = vscode.window.createTreeView("conclave.runsView", { treeDataProvider: runsProvider });
  context.subscriptions.push(
    runsView,
    vscode.window.createTreeView("conclave.seatsView", { treeDataProvider: seatsProvider }),
    vscode.window.createTreeView("conclave.boardView", { treeDataProvider: boardProvider }),
    vscode.window.createTreeView("conclave.ledgerView", { treeDataProvider: ledgerProvider })
  );

  // ── Status bar ─────────────────────────────────────────────────────────────
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = "conclave.focusRun";
  context.subscriptions.push(statusItem);

  const refreshAll = () => {
    runsProvider.refresh();
    seatsProvider.refresh();
    boardProvider.refresh();
    ledgerProvider.refresh();
    const sb = statusBarModel(data.model(), data.activeSummary());
    statusItem.text = sb.text;
    statusItem.tooltip = sb.tooltip;
    statusItem.backgroundColor = sb.warning
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    if (sb.visible) statusItem.show();
    else statusItem.hide();
  };

  context.subscriptions.push(data.onChange(refreshAll));
  refreshAll();

  return {
    refreshAll,
    dispose: () => {
      statusItem.dispose();
    }
  };
}
