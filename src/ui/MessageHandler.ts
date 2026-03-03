import * as vscode from 'vscode';
import { WebviewToExtensionMessage, TASK_TEMPLATES, createDefaultWorkspaceData, ExportTimePeriod, VBAttachment } from '../storage/models';
import { SessionManager } from '../session/SessionManager';
import { TaskManager } from '../tasks/TaskManager';
import { StorageProvider } from '../storage/StorageProvider';
import { CopilotAIService } from '../services/index';
import { generateId } from '../utils/uuid';

/**
 * MessageHandler processes messages from the webview and dispatches
 * to the appropriate manager. It also sends state updates back.
 */
export class MessageHandler {
  private webview: vscode.Webview | null = null;
  private aiService: CopilotAIService;

  constructor(
    private storage: StorageProvider,
    private sessionManager: SessionManager,
    private taskManager: TaskManager
  ) {
    this.aiService = new CopilotAIService();
  }

  /**
   * Bind to a webview to send/receive messages.
   */
  setWebview(webview: vscode.Webview): void {
    this.webview = webview;
  }

  /**
   * Handle an incoming message from the webview.
   */
  async handleMessage(message: WebviewToExtensionMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.sendStateUpdate();
        break;

      case 'addTask': {
        const session = this.sessionManager.getActiveSession();
        if (!session) {
          vscode.window.showWarningMessage('Start a session before adding tasks.');
          return;
        }
        this.taskManager.addTask({
          title: message.payload.title,
          tag: message.payload.tag,
          status: message.payload.status,
          priority: message.payload.priority,
          description: message.payload.description,
          sessionId: session.id,
        });

        // If quick-add included pending attachments, apply them to the newly created task
        const quickAddAttachments = (message.payload as { attachments?: VBAttachment[] }).attachments;
        if (quickAddAttachments && quickAddAttachments.length > 0) {
          const data = this.storage.getData();
          const newTask = data.tasks[data.tasks.length - 1]; // just added
          if (newTask) {
            newTask.attachments = quickAddAttachments;
            this.storage.setData(data);
          }
        }

        this.sendStateUpdate();
        break;
      }

      case 'updateTask':
        this.taskManager.updateTask(message.payload.id, message.payload.changes);
        this.sendStateUpdate();
        break;

      case 'moveTask':
        this.taskManager.moveTask(
          message.payload.id,
          message.payload.newStatus,
          message.payload.newOrder
        );
        this.sendStateUpdate();
        break;

      case 'completeTask': {
        // Clear sentToCopilot flag when completing
        const cData = this.storage.getData();
        const cTask = cData.tasks.find((t) => t.id === message.payload.id);
        if (cTask) { cTask.sentToCopilot = false; this.storage.setData(cData); }
        this.taskManager.completeTask(message.payload.id);
        this.sendStateUpdate();
        break;
      }

      case 'deleteTask':
        this.taskManager.deleteTask(message.payload.id);
        this.sendStateUpdate();
        break;

      case 'undo': {
        const action = this.taskManager.undo();
        if (action) {
          vscode.window.showInformationMessage(`Vibe Board: Undid "${action}"`);
        } else {
          vscode.window.showInformationMessage('Vibe Board: Nothing to undo');
        }
        this.sendStateUpdate();
        break;
      }

      case 'redo': {
        const redoAction = this.taskManager.redo();
        if (redoAction) {
          vscode.window.showInformationMessage(`Vibe Board: Redid "${redoAction}"`);
        } else {
          vscode.window.showInformationMessage('Vibe Board: Nothing to redo');
        }
        this.sendStateUpdate();
        break;
      }

      case 'toggleTimer': {
        this.taskManager.toggleTimer(message.payload.id);
        this.sendStateUpdate();
        break;
      }

      case 'addFromTemplate': {
        const session = this.sessionManager.getActiveSession();
        if (!session) {
          vscode.window.showWarningMessage('Start a session before adding tasks.');
          return;
        }
        const tmpl = TASK_TEMPLATES[message.payload.templateIndex];
        if (!tmpl) { return; }
        this.taskManager.addTask({
          title: tmpl.title,
          description: tmpl.description,
          tag: tmpl.tag,
          priority: tmpl.priority,
          status: tmpl.status,
          sessionId: session.id,
        });
        this.sendStateUpdate();
        break;
      }

      case 'createBoard': {
        const data = this.storage.getData();
        if (!data.boards) { data.boards = []; }
        const board = { id: generateId(), name: message.payload.name, createdAt: new Date().toISOString(), pausedAt: null, totalPausedMs: 0 };
        data.boards.push(board);
        data.activeBoardId = board.id;
        this.storage.setData(data);
        this.sendStateUpdate();
        break;
      }

      case 'switchBoard': {
        const data = this.storage.getData();
        data.activeBoardId = message.payload.boardId;
        this.storage.setData(data);
        this.sendStateUpdate();
        break;
      }

      case 'deleteBoard': {
        const data = this.storage.getData();
        if (!data.boards) { break; }
        data.boards = data.boards.filter((b) => b.id !== message.payload.boardId);
        if (data.activeBoardId === message.payload.boardId) {
          data.activeBoardId = data.boards[0]?.id ?? 'default';
        }
        this.storage.setData(data);
        this.sendStateUpdate();
        break;
      }

      case 'renameBoard': {
        const data = this.storage.getData();
        const board = data.boards?.find((b) => b.id === message.payload.boardId);
        if (board) {
          board.name = message.payload.name;
          this.storage.setData(data);
          this.sendStateUpdate();
        }
        break;
      }

      case 'closeBoards': {
        const { boardIds } = message.payload as { boardIds: string[] };
        const data = this.storage.getData();

        // Remove selected boards (but keep tasks for history & carry-over)
        for (const boardId of boardIds) {
          if (data.boards) {
            data.boards = data.boards.filter((b) => b.id !== boardId);
          }
        }

        // If no boards remain, end the session entirely
        if (!data.boards || data.boards.length === 0) {
          this.storage.setData(data);
          const summary = data.activeSessionId
            ? this.sessionManager.endSession()
            : null;
          this.sendStateUpdate();
          if (summary) {
            const duration = this.formatDuration(summary.duration);
            vscode.window.showInformationMessage(
              `Session ended! Duration: ${duration} | Tasks completed: ${summary.tasksCompleted} | Carried over: ${summary.tasksCarriedOver}`
            );
            this.webview?.postMessage({ type: 'sessionSummary', payload: summary });
          }
        } else {
          // Switch to a remaining board if the active one was closed
          if (boardIds.includes(data.activeBoardId || '')) {
            data.activeBoardId = data.boards[0]?.id ?? 'default';
          }
          this.storage.setData(data);
          this.sendStateUpdate();
        }
        break;
      }

      case 'aiSummarize': {
        const data = this.storage.getData();
        const tasks = data.tasks.filter((t) => t.sessionId === data.activeSessionId);
        this.webview?.postMessage({ type: 'aiResult', payload: { action: 'summarize', result: '...' } });
        this.aiService.generateSummary(tasks).then((result) => {
          this.webview?.postMessage({ type: 'aiResult', payload: { action: 'summarize', result } });
        });
        break;
      }

      case 'aiBreakdown': {
        const data = this.storage.getData();
        const task = data.tasks.find((t) => t.id === message.payload.taskId);
        if (!task) { break; }
        this.webview?.postMessage({ type: 'aiResult', payload: { action: 'breakdown', result: '...', taskId: task.id } });
        this.aiService.breakdownTask(task.title, task.description).then((subtasks) => {
          // Create subtasks as real tasks
          const session = this.sessionManager.getActiveSession();
          if (session && subtasks.length > 0) {
            for (const title of subtasks) {
              if (title) {
                this.taskManager.addTask({
                  title,
                  tag: task.tag,
                  priority: task.priority,
                  status: 'up-next',
                  sessionId: session.id,
                });
              }
            }
            this.sendStateUpdate();
          }
          this.webview?.postMessage({ type: 'aiResult', payload: { action: 'breakdown', result: subtasks, taskId: task.id } });
        });
        break;
      }

      case 'aiRewriteTitle': {
        this.webview?.postMessage({ type: 'aiResult', payload: { action: 'rewriteTitle', result: '...' } });
        this.aiService.rewriteTask(message.payload.title).then((rewritten) => {
          this.webview?.postMessage({ type: 'aiResult', payload: { action: 'rewriteTitle', result: JSON.stringify(rewritten) } });
        });
        break;
      }

      case 'sendToCopilot': {
        const data = this.storage.getData();
        const task = data.tasks.find((t) => t.id === message.payload.taskId);
        if (!task) { break; }

        // Build the prompt from task content
        let prompt = task.title;
        if (task.description) {
          prompt += '\n\n' + task.description;
        }

        // Send to Copilot using the shared helper
        await this.sendPromptToCopilot(prompt, task.attachments || []);

        // Auto-move task to In Progress when sent to Copilot
        if (task.status !== 'completed' && task.status !== 'in-progress') {
          this.taskManager.moveTask(task.id, 'in-progress', 0);
        }

        // Mark task as sent to Copilot (persistent — buttons stay on card until user acts)
        task.sentToCopilot = true;
        this.storage.setData(data);
        this.sendStateUpdate();
        break;
      }

      case 'sendFollowUp': {
        const followUpTaskId = message.payload.taskId;
        const followUpPrompt = message.payload.prompt || '';
        const followUpAttachments: VBAttachment[] = message.payload.attachments || [];

        // Append follow-up to the task's copilot log
        const fuData = this.storage.getData();
        const fuTask = fuData.tasks.find((t) => t.id === followUpTaskId);
        if (!fuTask) { break; }

        if (!fuTask.copilotLog) { fuTask.copilotLog = []; }
        fuTask.copilotLog.push({ prompt: followUpPrompt, timestamp: new Date().toISOString() });

        // Also append follow-up attachments to task attachments
        if (followUpAttachments.length > 0) {
          if (!fuTask.attachments) { fuTask.attachments = []; }
          fuTask.attachments.push(...followUpAttachments);
        }

        this.storage.setData(fuData);
        this.sendStateUpdate();

        // Send the follow-up to Copilot Chat
        await this.sendPromptToCopilot(followUpPrompt, followUpAttachments);
        // Buttons remain on the card (sentToCopilot is still true)
        break;
      }

      case 'pickFilesForFollowUp': {
        const fuTaskId = message.payload.taskId;
        const fuFiles = await vscode.window.showOpenDialog({
          canSelectMany: true,
          filters: { 'Images': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'], 'All Files': ['*'] },
          title: 'Attach files to follow-up',
        });
        if (fuFiles && fuFiles.length > 0) {
          const pickedFiles: VBAttachment[] = [];
          for (const fileUri of fuFiles) {
            try {
              const fileData = await vscode.workspace.fs.readFile(fileUri);
              const ext = fileUri.path.split('.').pop()?.toLowerCase() || '';
              const mimeMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };
              const mime = mimeMap[ext] || 'application/octet-stream';
              const base64 = Buffer.from(fileData).toString('base64');
              const dataUri = `data:${mime};base64,${base64}`;
              const filename = fileUri.path.split('/').pop() || 'file';
              pickedFiles.push({ id: `fu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, filename, mimeType: mime, dataUri, addedAt: new Date().toISOString() });
            } catch { /* skip */ }
          }
          if (pickedFiles.length > 0) {
            this.webview?.postMessage({ type: 'followUpFiles', payload: { taskId: fuTaskId, files: pickedFiles } });
          }
        }
        break;
      }

      case 'copilotDismiss': {
        // Clear the Copilot pending state without completing
        const dData = this.storage.getData();
        const dTask = dData.tasks.find((t) => t.id === message.payload.taskId);
        if (dTask) {
          dTask.sentToCopilot = false;
          this.storage.setData(dData);
          this.sendStateUpdate();
        }
        break;
      }

      case 'addAttachment': {
        // Open file dialog and add the selected image(s) to the task
        const files = await vscode.window.showOpenDialog({
          canSelectMany: true,
          filters: {
            'Images': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'],
            'All Files': ['*'],
          },
          title: 'Attach files to task',
        });
        if (!files || files.length === 0) { break; }

        const data = this.storage.getData();
        const task = data.tasks.find((t) => t.id === message.payload.taskId);
        if (!task) { break; }
        if (!task.attachments) { task.attachments = []; }

        for (const fileUri of files) {
          try {
            const fileBytes = await vscode.workspace.fs.readFile(fileUri);
            const filename = fileUri.path.split('/').pop() || 'attachment';
            const ext = filename.split('.').pop()?.toLowerCase() || '';
            const mimeMap: Record<string, string> = {
              png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
              gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
              svg: 'image/svg+xml',
            };
            const mimeType = mimeMap[ext] || 'application/octet-stream';
            const base64 = Buffer.from(fileBytes).toString('base64');
            const dataUri = `data:${mimeType};base64,${base64}`;

            const attachment: VBAttachment = {
              id: generateId(),
              filename,
              mimeType,
              dataUri,
              addedAt: new Date().toISOString(),
            };
            task.attachments!.push(attachment);
          } catch (err) {
            vscode.window.showErrorMessage(`Failed to attach ${fileUri.path}: ${err}`);
          }
        }
        this.storage.setData(data);
        this.sendStateUpdate();
        break;
      }

      case 'removeAttachment': {
        const data = this.storage.getData();
        const task = data.tasks.find((t) => t.id === message.payload.taskId);
        if (!task || !task.attachments) { break; }
        task.attachments = task.attachments.filter((a) => a.id !== message.payload.attachmentId);
        this.storage.setData(data);
        this.sendStateUpdate();
        break;
      }

      case 'pasteAttachment': {
        // Handle pasted image data from the webview (base64 data URI)
        const data = this.storage.getData();
        const task = data.tasks.find((t) => t.id === message.payload.taskId);
        if (!task) { break; }
        if (!task.attachments) { task.attachments = []; }

        const { dataUri, filename } = message.payload as { taskId: string; dataUri: string; filename: string };
        const mimeMatch = dataUri.match(/^data:([^;]+);/);
        const mimeType = mimeMatch ? mimeMatch[1] : 'application/octet-stream';

        const attachment: VBAttachment = {
          id: generateId(),
          filename: filename || `paste-${Date.now()}.png`,
          mimeType,
          dataUri,
          addedAt: new Date().toISOString(),
        };
        task.attachments.push(attachment);
        this.storage.setData(data);
        this.sendStateUpdate();
        break;
      }

      case 'pickFilesForQuickAdd': {
        // Open file dialog for quick-add attachments (before task exists)
        const files = await vscode.window.showOpenDialog({
          canSelectMany: true,
          filters: {
            'Images': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'],
            'All Files': ['*'],
          },
          title: 'Attach files to new task',
        });
        if (!files || files.length === 0) { break; }

        const pickedFiles: VBAttachment[] = [];
        for (const fileUri of files) {
          try {
            const fileBytes = await vscode.workspace.fs.readFile(fileUri);
            const filename = fileUri.path.split('/').pop() || 'attachment';
            const ext = filename.split('.').pop()?.toLowerCase() || '';
            const mimeMap: Record<string, string> = {
              png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
              gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
              svg: 'image/svg+xml',
            };
            const mimeType = mimeMap[ext] || 'application/octet-stream';
            const base64 = Buffer.from(fileBytes).toString('base64');
            const dataUri = `data:${mimeType};base64,${base64}`;

            pickedFiles.push({
              id: generateId(),
              filename,
              mimeType,
              dataUri,
              addedAt: new Date().toISOString(),
            });
          } catch { /* skip failed reads */ }
        }
        if (pickedFiles.length > 0) {
          this.webview?.postMessage({ type: 'quickAddFiles', payload: { files: pickedFiles } });
        }
        break;
      }

      case 'startSession': {
        const projectPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const config = vscode.workspace.getConfiguration('vibeboard');
        const carryOver = config.get<boolean>('carryOverTasks', true);
        const sessionName = (message.payload as { name?: string }).name;

        // startSession() internally ends the active session first
        const newSession = this.sessionManager.startSession(projectPath, sessionName);

        // Ensure at least one board exists, named after the session
        {
          const updatedData = this.storage.getData();
          if (!updatedData.boards || updatedData.boards.length === 0) {
            const boardName = sessionName || 'Main Board';
            updatedData.boards = [{ id: 'default', name: boardName, createdAt: new Date().toISOString(), pausedAt: null, totalPausedMs: 0 }];
            updatedData.activeBoardId = 'default';
            this.storage.setData(updatedData);
          }
        }

        // Carry over incomplete tasks from ALL ended sessions (runs after
        // startSession has ended the previous session, so nothing is missed)
        if (carryOver) {
          const carried = this.taskManager.carryOverAllTasks(newSession.id);
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

        this.sendStateUpdate();
        break;
      }

      case 'endSession': {
        const summary = this.sessionManager.endSession();
        this.sendStateUpdate();
        if (summary) {
          const duration = this.formatDuration(summary.duration);
          vscode.window.showInformationMessage(
            `Session ended! Duration: ${duration} | Tasks completed: ${summary.tasksCompleted} | Carried over: ${summary.tasksCarriedOver}`
          );
          this.webview?.postMessage({ type: 'sessionSummary', payload: summary });
        }
        break;
      }

      case 'pauseSession': {
        const data = this.storage.getData();
        const board = data.boards?.find((b) => b.id === data.activeBoardId);
        if (board && !board.pausedAt) {
          board.pausedAt = new Date().toISOString();
          this.storage.setData(data);
          vscode.window.showInformationMessage('Vibe Board: Board timer paused.');
        }
        this.sendStateUpdate();
        break;
      }

      case 'resumeSession': {
        const data = this.storage.getData();
        const board = data.boards?.find((b) => b.id === data.activeBoardId);
        if (board && board.pausedAt) {
          const pauseDuration = Date.now() - new Date(board.pausedAt).getTime();
          board.totalPausedMs = (board.totalPausedMs || 0) + pauseDuration;
          board.pausedAt = null;
          this.storage.setData(data);
          vscode.window.showInformationMessage('Vibe Board: Board timer resumed.');
        }
        this.sendStateUpdate();
        break;
      }

      case 'endSessions': {
        const { sessionIds } = message.payload as { sessionIds: string[] };
        let activeSummary: import('../storage/models').VBSessionSummary | null = null;

        for (const sid of sessionIds) {
          const result = this.sessionManager.endSessionById(sid);
          if (result) { activeSummary = result; }
        }

        this.sendStateUpdate();

        if (activeSummary) {
          const duration = this.formatDuration(activeSummary.duration);
          vscode.window.showInformationMessage(
            `Session ended! Duration: ${duration} | Tasks completed: ${activeSummary.tasksCompleted} | Carried over: ${activeSummary.tasksCarriedOver}`
          );
          this.webview?.postMessage({ type: 'sessionSummary', payload: activeSummary });
        }
        break;
      }

      case 'requestHistory': {
        const history = this.sessionManager.getSessionHistory();
        this.webview?.postMessage({ type: 'sessionHistory', payload: history });
        break;
      }

      case 'exportData': {
        this.exportData(message.payload.format, message.payload.timePeriod, message.payload.customStart, message.payload.customEnd);
        break;
      }

      case 'importData': {
        this.importData();
        break;
      }

      case 'clearAllData': {
        this.clearAllData();
        break;
      }
    }
  }

  /**
   * Push the full state to the webview.
   */
  sendStateUpdate(): void {
    if (!this.webview) {
      return;
    }
    const data = this.storage.getData();
    this.webview.postMessage({ type: 'stateUpdate', payload: data });
  }

  /**
   * Send a prompt (with optional image attachments) to Copilot Chat.
   * Extracted so it can be reused for initial send and follow-ups.
   */
  private async sendPromptToCopilot(prompt: string, attachments: VBAttachment[] = []): Promise<void> {
    const imageAttachments = attachments.filter((a) => a.mimeType.startsWith('image/'));
    const savedImagePaths: vscode.Uri[] = [];

    if (imageAttachments.length > 0) {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (workspaceFolder) {
        const tempDir = vscode.Uri.joinPath(workspaceFolder.uri, '.vibeboard', 'temp');
        try { await vscode.workspace.fs.createDirectory(tempDir); } catch { /* exists */ }
        for (const att of imageAttachments) {
          try {
            const base64Data = att.dataUri.replace(/^data:[^;]+;base64,/, '');
            const bytes = Buffer.from(base64Data, 'base64');
            const tempFile = vscode.Uri.joinPath(tempDir, att.filename);
            await vscode.workspace.fs.writeFile(tempFile, bytes);
            savedImagePaths.push(tempFile);
          } catch { /* skip */ }
        }
      }
    }

    let chatOpened = false;
    try {
      const chatOptions: Record<string, unknown> = { query: prompt };
      if (savedImagePaths.length > 0) {
        chatOptions.attachFiles = savedImagePaths;
        chatOptions.isPartialQuery = true;
      }
      await vscode.commands.executeCommand('workbench.action.chat.open', chatOptions);
      chatOpened = true;
    } catch {
      try {
        await vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus');
        await vscode.env.clipboard.writeText(prompt);
        vscode.window.showInformationMessage('Vibe Board: Prompt copied to clipboard. Paste it in the chat.');
      } catch {
        await vscode.env.clipboard.writeText(prompt);
        vscode.window.showInformationMessage('Vibe Board: Prompt copied to clipboard. Open Copilot Chat and paste.');
      }
    }

    if (chatOpened && savedImagePaths.length > 0) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        await vscode.commands.executeCommand('workbench.action.chat.submit');
      } catch {
        try {
          await vscode.commands.executeCommand('workbench.action.edits.submit');
        } catch { /* user can press Enter manually */ }
      }
    }
  }

  /**
   * Compute a date range from a time period selection.
   */
  private getDateRange(period: ExportTimePeriod, customStart?: string, customEnd?: string): { start: Date; end: Date } | null {
    if (period === 'all') { return null; }

    const now = new Date();
    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

    switch (period) {
      case 'day': {
        return { start: startOfDay(now), end: endOfDay(now) };
      }
      case 'week': {
        const dayOfWeek = now.getDay();
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - dayOfWeek);
        return { start: startOfDay(weekStart), end: endOfDay(now) };
      }
      case 'month': {
        return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: endOfDay(now) };
      }
      case 'year': {
        return { start: new Date(now.getFullYear(), 0, 1), end: endOfDay(now) };
      }
      case 'current-month': {
        const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: endOfDay(monthEnd) };
      }
      case 'last-month': {
        const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
        return { start: lastMonthStart, end: endOfDay(lastMonthEnd) };
      }
      case 'custom': {
        if (!customStart || !customEnd) { return null; }
        return { start: new Date(customStart), end: endOfDay(new Date(customEnd)) };
      }
      default:
        return null;
    }
  }

  /**
   * Filter tasks by a date range (based on createdAt).
   */
  private filterTasksByDateRange(
    tasks: ReturnType<StorageProvider['getData']>['tasks'],
    range: { start: Date; end: Date } | null
  ) {
    if (!range) { return tasks; }
    return tasks.filter((t) => {
      const created = new Date(t.createdAt).getTime();
      return created >= range.start.getTime() && created <= range.end.getTime();
    });
  }

  /**
   * Get a human-readable label for a time period.
   */
  private getTimePeriodLabel(period: ExportTimePeriod, customStart?: string, customEnd?: string): string {
    switch (period) {
      case 'all': return 'All Time';
      case 'day': return `Today (${new Date().toLocaleDateString()})`;
      case 'week': return 'This Week';
      case 'month': return 'This Month';
      case 'year': return 'This Year';
      case 'current-month': {
        const now = new Date();
        return now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      }
      case 'last-month': {
        const last = new Date();
        last.setMonth(last.getMonth() - 1);
        return last.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      }
      case 'custom': return `${customStart || '?'} to ${customEnd || '?'}`;
      default: return 'All Time';
    }
  }

  /**
   * Export workspace data to a file (JSON, CSV, or Markdown).
   */
  private async exportData(
    format: 'json' | 'csv' | 'markdown',
    timePeriod?: ExportTimePeriod,
    customStart?: string,
    customEnd?: string
  ): Promise<void> {
    const data = this.storage.getData();
    const history = this.sessionManager.getSessionHistory();
    const period = timePeriod || 'all';
    const dateRange = this.getDateRange(period, customStart, customEnd);
    const filteredTasks = this.filterTasksByDateRange(data.tasks, dateRange);
    const periodLabel = this.getTimePeriodLabel(period, customStart, customEnd);

    // For totals computation, use filtered tasks
    const filteredData = { ...data, tasks: filteredTasks };
    const totals = this.computeExportTotals(filteredData);
    let content: string;
    let defaultName: string;
    let filterLabel: string;
    let ext: string;

    // Use local date for filename (toISOString gives UTC which can be the wrong day)
    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    if (format === 'json') {
      // JSON is always a full backup — no time filtering
      const allTotals = this.computeExportTotals(data);
      const exportObj = {
        exportedAt: new Date().toISOString(),
        summary: allTotals,
        sessions: history.sessions.map((s, i) => ({
          ...s,
          summary: history.summaries[i],
        })),
        activeSession: data.activeSessionId ? {
          id: data.activeSessionId,
          session: data.sessions.find((s) => s.id === data.activeSessionId),
          tasks: data.tasks.filter((t) => t.sessionId === data.activeSessionId),
        } : null,
        tasks: data.tasks,
      };
      content = JSON.stringify(exportObj, null, 2);
      ext = 'json';
      defaultName = `vibeboard-export-${localDate}.json`;
      filterLabel = 'JSON';
    } else if (format === 'csv') {
      content = this.generateCsv(filteredData, totals, periodLabel);
      ext = 'csv';
      defaultName = `vibeboard-export-${localDate}.csv`;
      filterLabel = 'CSV';
    } else {
      // Markdown export
      content = this.generateMarkdown(filteredData, history, totals, periodLabel);
      ext = 'md';
      defaultName = `vibeboard-export-${localDate}.md`;
      filterLabel = 'Markdown';
    }

    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultName),
      filters: { [filterLabel]: [ext] },
      title: 'Export Vibe Board Data',
    });

    if (uri) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
      vscode.window.showInformationMessage(`Vibe Board: Exported to ${uri.fsPath}`);
    }
  }

  /**
   * Clear all data and reset to a fresh state.
   */
  private async clearAllData(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      'Are you sure you want to delete ALL Vibe Board data? This will permanently remove all sessions, tasks, and boards. This cannot be undone.',
      { modal: true },
      'Delete Everything'
    );

    if (confirm !== 'Delete Everything') return;

    const freshData = createDefaultWorkspaceData();
    this.storage.setData(freshData);
    this.sendStateUpdate();
    vscode.window.showInformationMessage('Vibe Board: All data has been cleared.');
  }

  /**
   * Import data from a JSON file.
   */
  private async importData(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'JSON': ['json'] },
      title: 'Import Vibe Board Data',
      openLabel: 'Import',
    });

    if (!uris || uris.length === 0) return;

    try {
      const raw = await vscode.workspace.fs.readFile(uris[0]);
      const text = Buffer.from(raw).toString('utf-8');
      const imported = JSON.parse(text);

      // Validate the structure
      if (!imported || typeof imported !== 'object') {
        vscode.window.showErrorMessage('Import failed: file does not contain valid JSON.');
        return;
      }

      // Support two formats:
      // 1. Vibe Board export JSON (has .sessions array with .summary, .tasks array)
      // 2. Raw workspace data (has .version, .sessions, .tasks)

      let sessions: any[] = [];
      let tasks: any[] = [];
      let boards: any[] | undefined;

      if (imported.version === 1 && Array.isArray(imported.sessions) && Array.isArray(imported.tasks)) {
        // Raw workspace data format (direct copy of data.json)
        sessions = imported.sessions;
        tasks = imported.tasks;
        boards = imported.boards;
      } else if (Array.isArray(imported.sessions) && Array.isArray(imported.tasks)) {
        // Export format — sessions may have .summary attached
        sessions = imported.sessions.map((s: any) => {
          const { summary, ...sessionData } = s;
          return sessionData;
        });
        tasks = imported.tasks;
      } else {
        vscode.window.showErrorMessage('Import failed: unrecognized file format. Use a Vibe Board JSON export or data.json backup.');
        return;
      }

      // Validate sessions and tasks have required fields
      for (const s of sessions) {
        if (!s.id || !s.startedAt || !s.status) {
          vscode.window.showErrorMessage('Import failed: one or more sessions are missing required fields (id, startedAt, status).');
          return;
        }
      }
      for (const t of tasks) {
        if (!t.id || !t.title || !t.status || !t.tag) {
          vscode.window.showErrorMessage('Import failed: one or more tasks are missing required fields (id, title, status, tag).');
          return;
        }
      }

      const taskCount = tasks.length;
      const sessionCount = sessions.length;

      // Ask user whether to replace or merge
      const choice = await vscode.window.showQuickPick(
        [
          { label: 'Replace', description: `Replace all current data with ${sessionCount} sessions and ${taskCount} tasks from the import` },
          { label: 'Merge', description: `Add ${sessionCount} sessions and ${taskCount} tasks to your existing data (skips duplicates)` },
        ],
        { title: 'How would you like to import?', placeHolder: 'Choose import mode' }
      );

      if (!choice) return;

      const data = this.storage.getData();

      if (choice.label === 'Replace') {
        // Full replacement
        data.sessions = sessions;
        data.tasks = tasks;
        data.activeSessionId = null;
        data.undoStack = [];
        if (boards && Array.isArray(boards)) {
          data.boards = boards;
          data.activeBoardId = boards[0]?.id || 'default';
        } else {
          data.boards = [{ id: 'default', name: 'Main Board', createdAt: new Date().toISOString() }];
          data.activeBoardId = 'default';
        }
      } else {
        // Merge — add non-duplicate sessions and tasks
        const existingSessionIds = new Set(data.sessions.map((s) => s.id));
        const existingTaskIds = new Set(data.tasks.map((t) => t.id));

        let addedSessions = 0;
        let addedTasks = 0;

        for (const s of sessions) {
          if (!existingSessionIds.has(s.id)) {
            data.sessions.push(s);
            addedSessions++;
          }
        }
        for (const t of tasks) {
          if (!existingTaskIds.has(t.id)) {
            data.tasks.push(t);
            addedTasks++;
          }
        }

        if (boards && Array.isArray(boards)) {
          const existingBoardIds = new Set((data.boards || []).map((b) => b.id));
          for (const b of boards) {
            if (!existingBoardIds.has(b.id)) {
              data.boards = data.boards || [];
              data.boards.push(b);
            }
          }
        }

        vscode.window.showInformationMessage(`Vibe Board: Merged ${addedSessions} sessions and ${addedTasks} tasks (${sessionCount - addedSessions} sessions and ${taskCount - addedTasks} tasks were duplicates).`);
      }

      this.storage.setData(data);
      this.sendStateUpdate();

      if (choice.label === 'Replace') {
        vscode.window.showInformationMessage(`Vibe Board: Imported ${sessionCount} sessions and ${taskCount} tasks.`);
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Import failed: ${err.message || err}`);
    }
  }

  /**
   * Compute aggregate totals for export.
   */
  private computeExportTotals(data: ReturnType<StorageProvider['getData']>) {
    const allTasks = data.tasks;
    const totalSessions = data.sessions.length;
    const activeSessions = data.sessions.filter((s) => s.status === 'active').length;
    const endedSessions = data.sessions.filter((s) => s.status === 'ended').length;

    const totalTasks = allTasks.length;
    const byStatus: Record<string, number> = { 'in-progress': 0, 'up-next': 0, backlog: 0, completed: 0, notes: 0 };
    const byTag: Record<string, number> = { feature: 0, bug: 0, refactor: 0, note: 0 };
    const byPriority: Record<string, number> = { low: 0, medium: 0, high: 0 };
    let totalTimeMs = 0;
    let carriedOverCount = 0;

    for (const t of allTasks) {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;
      byTag[t.tag] = (byTag[t.tag] || 0) + 1;
      byPriority[t.priority || 'medium'] = (byPriority[t.priority || 'medium'] || 0) + 1;
      totalTimeMs += t.timeSpentMs || 0;
      if (t.carriedFromSessionId) carriedOverCount++;
    }

    // Sum all session durations (subtracting paused time)
    let totalSessionMs = 0;
    for (const s of data.sessions) {
      const end = s.endedAt ? new Date(s.endedAt).getTime() : Date.now();
      const raw = end - new Date(s.startedAt).getTime();
      const paused = s.totalPausedMs || 0;
      totalSessionMs += Math.max(0, raw - paused);
    }

    return {
      totalSessions,
      activeSessions,
      endedSessions,
      totalTasks,
      byStatus,
      byTag,
      byPriority,
      totalTimeSpent: this.formatDuration(totalTimeMs),
      totalTimeMs,
      totalSessionTime: this.formatDuration(totalSessionMs),
      totalSessionMs,
      carriedOverCount,
    };
  }

  /**
   * Generate a CSV export with all tasks and a summary section.
   */
  private generateCsv(
    data: ReturnType<StorageProvider['getData']>,
    totals: ReturnType<MessageHandler['computeExportTotals']>,
    periodLabel?: string
  ): string {
    const csvEsc = (s: string) => `"${s.replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`;
    const lines: string[] = [];

    // Period header
    if (periodLabel && periodLabel !== 'All Time') {
      lines.push(`Time Period,${csvEsc(periodLabel)}`);
      lines.push('');
    }

    // Tasks grouped by tag
    const tagOrder: Array<{ tag: string; label: string }> = [
      { tag: 'feature', label: 'FEATURES' },
      { tag: 'bug', label: 'BUGS' },
      { tag: 'refactor', label: 'REFACTORS' },
      { tag: 'note', label: 'NOTES' },
    ];

    for (const { tag, label } of tagOrder) {
      const tagTasks = data.tasks.filter((t) => t.tag === tag);
      if (tagTasks.length === 0) { continue; }

      lines.push('');
      lines.push(label);
      lines.push('Session,Session Date,Session Duration,Task Title,Description,Priority,Status,Board,Carried Over,Created,Completed');
      for (const task of tagTasks) {
        const session = data.sessions.find((s) => s.id === task.sessionId);
        const sessionName = session?.name || '';
        const sessionDate = session ? new Date(session.startedAt).toLocaleDateString() : '';
        const sessionDur = session ? this.formatDuration(
          Math.max(0, ((session.endedAt ? new Date(session.endedAt).getTime() : Date.now()) - new Date(session.startedAt).getTime()) - (session.totalPausedMs || 0))
        ) : '';
        const board = data.boards?.find((b) => b.id === task.boardId);
        const boardName = board?.name || task.boardId;
        const carriedOver = task.carriedFromSessionId ? 'Yes' : 'No';
        lines.push([
          csvEsc(sessionName),
          sessionDate,
          sessionDur,
          csvEsc(task.title),
          csvEsc(task.description),
          task.priority || 'medium',
          task.status,
          csvEsc(boardName),
          carriedOver,
          new Date(task.createdAt).toLocaleString(),
          task.completedAt ? new Date(task.completedAt).toLocaleString() : '',
        ].join(','));
      }
    }

    // Blank separator + summary section
    lines.push('');
    lines.push('SUMMARY');
    lines.push(`Total Sessions,${totals.totalSessions}`);
    lines.push(`Active Sessions,${totals.activeSessions}`);
    lines.push(`Ended Sessions,${totals.endedSessions}`);
    lines.push(`Total Tasks,${totals.totalTasks}`);
    lines.push(`Completed,${totals.byStatus['completed'] || 0}`);
    lines.push(`In Progress,${totals.byStatus['in-progress'] || 0}`);
    lines.push(`Up Next,${totals.byStatus['up-next'] || 0}`);
    lines.push(`Backlog,${totals.byStatus['backlog'] || 0}`);
    lines.push(`Notes,${totals.byStatus['notes'] || 0}`);
    lines.push(`Carried Over,${totals.carriedOverCount}`);
    lines.push(`Features,${totals.byTag['feature'] || 0}`);
    lines.push(`Bugs,${totals.byTag['bug'] || 0}`);
    lines.push(`Refactors,${totals.byTag['refactor'] || 0}`);
    lines.push(`Note Tags,${totals.byTag['note'] || 0}`);
    lines.push(`High Priority,${totals.byPriority['high'] || 0}`);
    lines.push(`Medium Priority,${totals.byPriority['medium'] || 0}`);
    lines.push(`Low Priority,${totals.byPriority['low'] || 0}`);
    lines.push(`Total Session Time,${totals.totalSessionTime}`);

    return lines.join('\n');
  }

  /**
   * Generate a Markdown document from session/task data.
   */
  private generateMarkdown(
    data: ReturnType<StorageProvider['getData']>,
    history: ReturnType<SessionManager['getSessionHistory']>,
    totals: ReturnType<MessageHandler['computeExportTotals']>,
    periodLabel?: string
  ): string {
    const lines: string[] = [];
    lines.push('# Vibe Board Export');
    lines.push('');
    lines.push(`*Exported: ${new Date().toLocaleString()}*`);
    if (periodLabel && periodLabel !== 'All Time') {
      lines.push('');
      lines.push(`**Time Period:** ${periodLabel}`);
    }
    lines.push('');

    // Summary / Totals
    lines.push('## Summary');
    lines.push('');
    lines.push('| Metric | Count |');
    lines.push('|--------|-------|');
    lines.push(`| Total Sessions | ${totals.totalSessions} |`);
    lines.push(`| Active Sessions | ${totals.activeSessions} |`);
    lines.push(`| Ended Sessions | ${totals.endedSessions} |`);
    lines.push(`| Total Tasks | ${totals.totalTasks} |`);
    lines.push(`| Completed | ${totals.byStatus['completed'] || 0} |`);
    lines.push(`| In Progress | ${totals.byStatus['in-progress'] || 0} |`);
    lines.push(`| Up Next | ${totals.byStatus['up-next'] || 0} |`);
    lines.push(`| Backlog | ${totals.byStatus['backlog'] || 0} |`);
    lines.push(`| Notes | ${totals.byStatus['notes'] || 0} |`);
    lines.push(`| Carried Over | ${totals.carriedOverCount} |`);
    lines.push(`| Total Session Time | ${totals.totalSessionTime} |`);
    lines.push('');
    lines.push('**By Tag:** ');
    lines.push(`Feature: ${totals.byTag['feature'] || 0} · Bug: ${totals.byTag['bug'] || 0} · Refactor: ${totals.byTag['refactor'] || 0} · Note: ${totals.byTag['note'] || 0}`);
    lines.push('');
    lines.push('**By Priority:** ');
    lines.push(`High: ${totals.byPriority['high'] || 0} · Medium: ${totals.byPriority['medium'] || 0} · Low: ${totals.byPriority['low'] || 0}`);
    lines.push('');

    // Active session
    if (data.activeSessionId) {
      const session = data.sessions.find((s) => s.id === data.activeSessionId);
      if (session) {
        lines.push('## Active Session');
        lines.push('');
        lines.push(`**${session.name}** — Started: ${new Date(session.startedAt).toLocaleString()}`);
        lines.push('');

        for (const col of ['in-progress', 'up-next', 'backlog', 'completed', 'notes'] as const) {
          const colTasks = data.tasks
            .filter((t) => t.sessionId === data.activeSessionId && t.status === col)
            .sort((a, b) => a.order - b.order);
          if (colTasks.length > 0) {
            const label = col === 'in-progress' ? 'In Progress' : col === 'up-next' ? 'Up Next' : col === 'backlog' ? 'Backlog' : col === 'completed' ? 'Completed' : 'Notes';
            lines.push(`### ${label}`);
            lines.push('');
            for (const t of colTasks) {
              const check = t.status === 'completed' ? '[x]' : '[ ]';
              const prio = t.priority ? ` \`${t.priority}\`` : '';
              const tag = ` \`${t.tag}\``;
              const time = t.timeSpentMs ? ` (${this.formatDuration(t.timeSpentMs)})` : '';
              const carried = t.carriedFromSessionId ? ' ↺' : '';
              lines.push(`- ${check} **${t.title}**${prio}${tag}${time}${carried}`);
              if (t.description) {
                for (const descLine of t.description.split('\n')) {
                  lines.push(`  ${descLine}`);
                }
              }
            }
            lines.push('');
          }
        }
      }
    }

    // Session history
    if (history.sessions.length > 0) {
      lines.push('## Session History');
      lines.push('');
      lines.push('| # | Date | Name | Duration | Tasks | Completed | Carried Over |');
      lines.push('|---|------|------|----------|-------|-----------|-------------|');
      for (let i = 0; i < history.sessions.length; i++) {
        const s = history.sessions[i];
        const sum = history.summaries[i];
        const date = new Date(s.startedAt).toLocaleDateString();
        const dur = this.formatDuration(sum.duration);
        const totalTasks = data.tasks.filter((t) => t.sessionId === s.id).length;
        lines.push(`| ${i + 1} | ${date} | ${s.name} | ${dur} | ${totalTasks} | ${sum.tasksCompleted} | ${sum.tasksCarriedOver} |`);
      }
      lines.push('');
    }

    // All tasks grouped by tag
    const tagGroups: Array<{ tag: string; label: string }> = [
      { tag: 'feature', label: 'Features' },
      { tag: 'bug', label: 'Bugs' },
      { tag: 'refactor', label: 'Refactors' },
      { tag: 'note', label: 'Notes' },
    ];

    for (const { tag, label } of tagGroups) {
      const tasks = data.tasks
        .filter((t) => t.tag === tag)
        .sort((a, b) => {
          // Completed first, then by date
          if (a.status === 'completed' && b.status !== 'completed') { return -1; }
          if (a.status !== 'completed' && b.status === 'completed') { return 1; }
          if (a.status === 'completed' && b.status === 'completed') {
            return new Date(b.completedAt ?? b.createdAt).getTime() - new Date(a.completedAt ?? a.createdAt).getTime();
          }
          return a.order - b.order;
        });

      if (tasks.length === 0) { continue; }

      const completedCount = tasks.filter((t) => t.status === 'completed').length;
      lines.push(`## ${label} (${tasks.length} total, ${completedCount} completed)`);
      lines.push('');
      for (const t of tasks) {
        const check = t.status === 'completed' ? '[x]' : '[ ]';
        const prio = t.priority ? ` \`${t.priority}\`` : '';
        const statusLabel = t.status === 'completed' ? '' : ` \`${t.status}\``;
        const time = t.timeSpentMs ? ` (${this.formatDuration(t.timeSpentMs)})` : '';
        const when = t.completedAt ? ` — ${new Date(t.completedAt).toLocaleDateString()}` : '';
        const carried = t.carriedFromSessionId ? ' ↺' : '';
        const session = data.sessions.find((s) => s.id === t.sessionId);
        const sessionInfo = session ? ` [${session.name}]` : '';
        lines.push(`- ${check} **${t.title}**${prio}${statusLabel}${time}${carried}${when}${sessionInfo}`);
        if (t.description) {
          for (const descLine of t.description.split('\n')) {
            lines.push(`  ${descLine}`);
          }
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Format milliseconds into a human-readable duration.
   */
  private formatDuration(ms: number): string {
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
}
