import * as vscode from 'vscode';
import type { MessageHandler } from './MessageHandler';
import type { WebviewToExtensionMessage } from '../storage/models';

/**
 * WebviewProvider implements WebviewViewProvider for the sidebar panel.
 * Supports lazy initialization — the MessageHandler is set after storage loads.
 */
export class WebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'vibeboard.boardView';

  private view: vscode.WebviewView | undefined;
  private messageHandler: MessageHandler | null = null;
  private ensureInit: () => Promise<boolean>;

  constructor(
    private readonly extensionUri: vscode.Uri,
    ensureInitialized: () => Promise<boolean>
  ) {
    this.ensureInit = ensureInitialized;
  }

  /** Called by the lazy init in extension.ts once the handler is ready. */
  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler;
    if (this.view) {
      handler.setWebview(this.view.webview);
      handler.sendInitialState();
    }
  }

  /**
   * Called when the webview view is first shown.
   */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this.extensionUri, 'media'),
      ],
    };

    // Set the HTML content immediately (shows the UI shell before data loads)
    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    // Listen for messages — queue or forward to handler
    webviewView.webview.onDidReceiveMessage(
      (message: WebviewToExtensionMessage) => {
        if (this.messageHandler) {
          this.messageHandler.handleMessage(message);
        }
      }
    );

    // Re-send state when the view becomes visible again
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && this.messageHandler) {
        this.messageHandler.sendStateUpdate();
      }
    });

    // If handler is already set (unlikely on first open), bind it now
    if (this.messageHandler) {
      this.messageHandler.setWebview(webviewView.webview);
      this.messageHandler.sendInitialState();
    } else {
      // Kick off lazy init — once done, setMessageHandler will be called
      this.ensureInit();
    }
  }

  /**
   * Generate the webview HTML document.
   */
  private getHtmlContent(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'main.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'styles.css')
    );

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; media-src 'self';">
  <link href="${styleUri}" rel="stylesheet">
  <title>Vibe Board</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  /**
   * Trigger a state update to the webview (called externally).
   */
  refresh(): void {
    if (this.view?.visible && this.messageHandler) {
      this.messageHandler.sendStateUpdate();
    }
  }
}

/**
 * Generate a random nonce for CSP.
 */
function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
