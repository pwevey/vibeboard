import * as vscode from 'vscode';
import { StorageProvider } from './storage/StorageProvider';
import { TaskTag } from './storage/models';
import { SessionManager } from './session/SessionManager';
import { TaskManager } from './tasks/TaskManager';
import { MessageHandler } from './ui/MessageHandler';
import { WebviewProvider } from './ui/WebviewProvider';

let storageProvider: StorageProvider;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Initialize storage
  storageProvider = new StorageProvider();

  try {
    await storageProvider.initialize();
  } catch (err) {
    console.error('[VB] Failed to initialize storage:', err);
    vscode.window.showErrorMessage('Vibe Board: Failed to initialize storage. Make sure a workspace folder is open.');
    return;
  }

  // Create managers
  const sessionManager = new SessionManager(storageProvider);
  const taskManager = new TaskManager(storageProvider);
  const messageHandler = new MessageHandler(storageProvider, sessionManager, taskManager);

  // Register the sidebar webview provider (retainContextWhenHidden keeps the
  // webview alive when the user switches to another sidebar panel)
  const webviewProvider = new WebviewProvider(context.extensionUri, messageHandler);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(WebviewProvider.viewType, webviewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('vibeboard.startSession', () => {
      const projectPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      const config = vscode.workspace.getConfiguration('vibeboard');
      const carryOver = config.get<boolean>('carryOverTasks', true);

      // startSession() internally ends the active session first
      const newSession = sessionManager.startSession(projectPath);

      // Carry over incomplete tasks from ended sessions (scoped to project if set)
      const activeProjectId = storage.getData().activeProjectId;
      if (carryOver) {
        const carried = taskManager.carryOverAllTasks(newSession.id, activeProjectId ?? undefined);
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

      webviewProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibeboard.endSession', () => {
      const summary = sessionManager.endSession();
      if (summary) {
        const duration = formatDuration(summary.duration);
        vscode.window.showInformationMessage(
          `Vibe Board: Session ended! Duration: ${duration} | Completed: ${summary.tasksCompleted} | Carried over: ${summary.tasksCarriedOver}`
        );
      } else {
        vscode.window.showInformationMessage('Vibe Board: No active session.');
      }
      webviewProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibeboard.addTask', async () => {
      if (!sessionManager.hasActiveSession()) {
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

      const session = sessionManager.getActiveSession()!;
      taskManager.addTask({
        title,
        tag,
        status: 'up-next',
        sessionId: session.id,
      });

      webviewProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vibeboard.exportMarkdown', () => {
      // Trigger export through message handler
      messageHandler.handleMessage({ type: 'exportData', payload: { format: 'markdown' } });
    })
  );

  // Cleanup
  context.subscriptions.push({
    dispose: () => {
      storageProvider.flush();
      storageProvider.dispose();
    },
  });

  // Auto-prompt for session on startup
  const config = vscode.workspace.getConfiguration('vibeboard');
  const autoPrompt = config.get<boolean>('autoPromptSession', true);

  if (autoPrompt && !sessionManager.hasActiveSession()) {
    const action = await vscode.window.showInformationMessage(
      'Vibe Board: Start a new session?',
      'Start Session',
      'Not Now'
    );
    if (action === 'Start Session') {
      await vscode.commands.executeCommand('vibeboard.startSession');
    }
  }
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
