/**
 * CockpitPanel — the extension-host half of E3's live cockpit. It owns a single
 * webview panel and is the ONLY side that touches the engine: it subscribes to
 * the StateBus (which itself owns the `collab watch --json` feed) and posts
 * normalized state / stream / event / gate messages down to the sandboxed
 * webview; the webview posts action *requests* back up, which this class turns
 * into real `EngineClient` calls (reusing E2's gate view-model + resolver).
 *
 * Thin-client (principles 1/2, item 6): the webview holds no engine access. In a
 * watch-only attach (no orchestrate child driving the active run) the gate is
 * posted with `driver:false` so its action buttons render disabled.
 */
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";

import type { ConclaveContext } from "./extension.js";
import type { StateBus } from "./statebus.js";
import { gateNotificationSpec, resolveGateCall } from "./viewmodels/gate.js";
import { dispatchResolution } from "./gates.js";
import { openReportForRun } from "./commands.js";
import {
  gateMessage,
  stateMessage,
  streamMessage,
  eventMessage,
  type CockpitEvent,
  type CockpitSnapshot,
  type ExtensionToWebview,
  type TallyVM,
  type WebviewToExtension
} from "./webview/protocol.js";

export class CockpitPanel {
  private static current: CockpitPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly ctx: ConclaveContext,
    private readonly bus: StateBus
  ) {
    this.panel.webview.html = this.html();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (m: WebviewToExtension) => void this.onMessage(m),
      null,
      this.disposables
    );

    // Live wiring: the bus is the one source of truth; forward its signals down.
    const onChange = () => this.postState();
    const onStream = (seat: string, line: string) => this.post(streamMessage(seat, line));
    const onEvent = (event: CockpitEvent) => this.post(eventMessage(event));
    bus.on("change", onChange);
    bus.on("stream", onStream);
    bus.on("event", onEvent);
    this.disposables.push({
      dispose: () => {
        bus.off("change", onChange);
        bus.off("stream", onStream);
        bus.off("event", onEvent);
      }
    });

    // Theme changes: the webview re-reads live CSS vars, but signal a repaint.
    this.disposables.push(
      vscode.window.onDidChangeActiveColorTheme((t) =>
        this.post({ type: "theme", kind: themeKindName(t.kind) })
      )
    );
  }

  static async createOrShow(context: vscode.ExtensionContext, ctx: ConclaveContext): Promise<void> {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active;
    if (CockpitPanel.current) {
      CockpitPanel.current.panel.reveal(column);
      return;
    }
    const bus = await ctx.ensureBus();
    const panel = vscode.window.createWebviewPanel("conclaveCockpit", "Conclave Cockpit", column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, "dist"),
        vscode.Uri.joinPath(context.extensionUri, "media")
      ]
    });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
    CockpitPanel.current = new CockpitPanel(panel, context, ctx, bus);
  }

  // ── outbound ────────────────────────────────────────────────────────────────

  private post(msg: ExtensionToWebview): void {
    if (this.ready || msg.type === "state") void this.panel.webview.postMessage(msg);
  }

  private driving(): boolean {
    const run = this.bus.activeRunRef;
    return run != null && this.ctx.orchestrators.has(run);
  }

  private postState(): void {
    const model = this.bus.runModel;
    const snapshot: CockpitSnapshot = {
      model,
      tally: this.bus.tally as TallyVM | null,
      driver: this.driving()
    };
    void this.panel.webview.postMessage(stateMessage(snapshot));
    const gate = model.gate ? gateNotificationSpec(model.gate) : null;
    void this.panel.webview.postMessage(gateMessage(gate, this.driving()));
  }

  // ── inbound ───────────────────────────────────────────────────────────────

  private async onMessage(msg: WebviewToExtension): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.ready = true;
        this.postState();
        this.post({ type: "theme", kind: themeKindName(vscode.window.activeColorTheme.kind) });
        return;
      case "focus":
        this.ctx.output.appendLine(`[cockpit] focus ${msg.view}`);
        return;
      case "resolveGate":
        await this.resolveGate(msg);
        return;
    }
  }

  private async resolveGate(
    msg: Extract<WebviewToExtension, { type: "resolveGate" }>
  ): Promise<void> {
    const run = this.bus.activeRunRef;
    if (!run) return;
    if (!this.driving()) {
      // Watch-only attach: never issue an engine mutation (principle 6).
      vscode.window.showWarningMessage("Conclave: this run is watch-only — gate actions are read-only.");
      return;
    }
    const gateVM = this.bus.runModel.gate;
    if (!gateVM) return;
    const spec = gateNotificationSpec(gateVM);
    const action = spec.actions.find((a) => a.id === msg.actionId);
    if (!action) return;

    const client = await this.ctx.resolveClient();
    try {
      const resolution = resolveGateCall(
        { ...action, winner: msg.winner ?? action.winner },
        { run, feedback: msg.feedback, amount: msg.amount }
      );
      await dispatchResolution(resolution, {
        client,
        runRef: run,
        log: (l) => this.ctx.output.appendLine(`[cockpit gate] ${l}`),
        openReport: (r) => openReportForRun(this.ctx, r),
        stop: (r) => {
          void this.ctx.cancelRun(r);
        }
      });
    } catch (err) {
      vscode.window.showErrorMessage(`Conclave: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── html ────────────────────────────────────────────────────────────────────

  private html(): string {
    const w = this.panel.webview;
    const nonce = randomBytes(16).toString("base64");
    const scriptUri = w.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview", "app.js")
    );
    const styleUri = w.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "cockpit.css")
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${w.cspSource} data:`,
      `style-src ${w.cspSource}`,
      `font-src ${w.cspSource}`,
      `script-src 'nonce-${nonce}'`
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Conclave Cockpit</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    CockpitPanel.current = undefined;
    for (const d of this.disposables.splice(0)) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    this.panel.dispose();
  }
}

function themeKindName(kind: vscode.ColorThemeKind): string {
  switch (kind) {
    case vscode.ColorThemeKind.Light:
      return "light";
    case vscode.ColorThemeKind.HighContrast:
      return "high-contrast";
    case vscode.ColorThemeKind.HighContrastLight:
      return "high-contrast-light";
    default:
      return "dark";
  }
}
