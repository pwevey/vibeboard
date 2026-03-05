import * as vscode from 'vscode';
import { StorageProvider } from './storage/StorageProvider';
import { TaskTag } from './storage/models';
import { SessionManager } from './session/SessionManager';
import { TaskManager } from './tasks/TaskManager';
import { MessageHandler } from './ui/MessageHandler';
import { WebviewProvider } from './ui/WebviewProvider';
import { SecretStorageService } from './services/SecretStorageService';

let storageProvider: StorageProvider | null = null;
let sessionManager: SessionManager | null = null;
let taskManager: TaskManager | null = null;
let messageHandler: MessageHandler | null = null;
let webviewProvider: WebviewProvider | null = null;
let secretStorageService: SecretStorageService | null = null;
let globalState: vscode.Memento | null = null;
let initPromise: Promise<boolean> | null = null;

/**
 * Lazy initialization — called on first use (command or webview resolve).
 * Returns true if initialization succeeded, false otherwise.
 * Multiple callers safely share the same promise.
 */
function ensureInitialized(): Promise<boolean> {
  if (initPromise) { return initPromise; }
  initPromise = (async () => {
    storageProvider = new StorageProvider();
    try {
      await storageProvider.initialize();
    } catch (err) {
      console.error('[VB] Failed to initialize storage:', err);
      vscode.window.showErrorMessage('Vibe Board: Failed to initialize storage. Make sure a workspace folder is open.');
      return false;
    }

    // Migrate any plain-text Jira credentials to secure storage (one-time)
    if (secretStorageService && !globalState?.get<boolean>('jiraMigrated')) {
      await secretStorageService.migrateFromSettings();
      globalState?.update('jiraMigrated', true);
    }

    sessionManager = new SessionManager(storageProvider);
    taskManager = new TaskManager(storageProvider);
    messageHandler = new MessageHandler(storageProvider, sessionManager, taskManager, secretStorageService!);
    if (webviewProvider) {
      webviewProvider.setMessageHandler(messageHandler);
    }
    return true;
  })();
  return initPromise;
}

export function activate(context: vscode.ExtensionContext): void {
  // Create the secure storage service early so it's available for lazy init
  secretStorageService = new SecretStorageService(context.secrets);
  globalState = context.globalState;

  // Register the sidebar webview provider immediately (lightweight — no I/O).
  // Actual storage init happens lazily when the webview resolves or a command runs.
  webviewProvider = new WebviewProvider(context.extensionUri, ensureInitialized);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(WebviewProvider.viewType, webviewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Register commands (handlers call ensureInitialized on demand)
  context.subscriptions.push(
    vscode.commands.registerCommand('vibeboard.startSession', async () => {
      if (!(await ensureInitialized())) { return; }
      const projectPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      const config = vscode.workspace.getConfiguration('vibeboard');
      const carryOver = config.get<boolean>('carryOverTasks', true);

      const newSession = sessionManager!.startSession(projectPath);

      const activeProjectId = storageProvider!.getData().activeProjectId;
      if (carryOver) {
        const carried = taskManager!.carryOverAllTasks(newSession.id, activeProjectId ?? undefined);
        if (carried > 0) {
          vscode.window.showInformationMessage(
            `Vibe Board: Session started! ${carried} task${carried === 1 ? '' : 's'} carried over.`
          );
        } else {
          vscode.window.showInformationMessage('Vibe Board: Session started!');
        }
      } else {
        vscode.window.showInformationMessage('Vibe Board: Session started!');
      }

      webviewProvider!.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibeboard.endSession', async () => {
      if (!(await ensureInitialized())) { return; }
      const summary = sessionManager!.endSession();
      if (summary) {
        const duration = formatDuration(summary.duration);
        vscode.window.showInformationMessage(
          `Vibe Board: Session ended! Duration: ${duration} | Completed: ${summary.tasksCompleted} | Carried over: ${summary.tasksCarriedOver}`
        );
      } else {
        vscode.window.showInformationMessage('Vibe Board: No active session.');
      }
      webviewProvider!.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibeboard.addTask', async () => {
      if (!(await ensureInitialized())) { return; }
      if (!sessionManager!.hasActiveSession()) {
        const start = await vscode.window.showInformationMessage(
          'No active session. Start one?',
          'Start Session'
        );
        if (start === 'Start Session') {
          await vscode.commands.executeCommand('vibeboard.startSession');
        }
        return;
      }

      const title = await vscode.window.showInputBox({
        prompt: 'Task title',
        placeHolder: 'What are you thinking about?',
      });

      if (!title) {
        return;
      }

      const tagPick = await vscode.window.showQuickPick(
        [
          { label: 'Feature', value: 'feature' },
          { label: 'Bug', value: 'bug' },
          { label: 'Refactor', value: 'refactor' },
          { label: 'Note', value: 'note' },
          { label: 'Plan', value: 'plan' },
          { label: 'Todo', value: 'todo' },
        ],
        { placeHolder: 'Select a tag' }
      );

      const tag = (tagPick?.value ?? 'feature') as TaskTag;

      const session = sessionManager!.getActiveSession()!;
      taskManager!.addTask({
        title,
        tag,
        status: 'up-next',
        sessionId: session.id,
      });

      webviewProvider!.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibeboard.exportMarkdown', async () => {
      if (!(await ensureInitialized())) { return; }
      messageHandler!.handleMessage({ type: 'exportData', payload: { format: 'markdown' } });
    })
  );

  // Cleanup
  context.subscriptions.push({
    dispose: () => {
      if (storageProvider) {
        storageProvider.flush();
        storageProvider.dispose();
      }
    },
  });

  // Auto-prompt for session on startup (deferred — let extension host finish loading first)
  setTimeout(() => {
    ensureInitialized().then((ok) => {
      if (!ok) { return; }
      const config = vscode.workspace.getConfiguration('vibeboard');
      const autoPrompt = config.get<boolean>('autoPromptSession', true);

      if (autoPrompt && !sessionManager!.hasActiveSession()) {
        vscode.window.showInformationMessage(
          'Vibe Board: Start a new session?',
          'Start Session',
          'Not Now'
        ).then((action) => {
          if (action === 'Start Session') {
            vscode.commands.executeCommand('vibeboard.startSession');
          }
        });
      }
    });
  }, 2000);
}

export function deactivate(): void {
  if (storageProvider) {
    // Use flushSync to ensure data is written before the process exits
    storageProvider.flushSync();
    storageProvider.dispose();
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}
