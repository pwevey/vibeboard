import * as vscode from 'vscode';
import { MessageHandler } from './MessageHandler';
import { WebviewToExtensionMessage } from '../storage/models';

/**
 * WebviewProvider implements WebviewViewProvider for the sidebar panel.
 */
export class WebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'vibeboard.boardView';

  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly messageHandler: MessageHandler
  ) {}

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

    // Bind the message handler to this webview
    this.messageHandler.setWebview(webviewView.webview);

    // Listen for messages from the webview
    webviewView.webview.onDidReceiveMessage(
      (message: WebviewToExtensionMessage) => {
        this.messageHandler.handleMessage(message);
      }
    );

    // Re-send state when the view becomes visible again
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.messageHandler.sendStateUpdate();
      }
    });

    // Set the HTML content
    webviewView.webview.html = this.getHtmlContent(webviewView.webview);
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
    if (this.view?.visible) {
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
