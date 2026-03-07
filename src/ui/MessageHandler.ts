import * as vscode from 'vscode';
import { WebviewToExtensionMessage, TASK_TEMPLATES, createDefaultWorkspaceData, ExportTimePeriod, VBAttachment, VBProject, VBTask, TaskTag, TaskStatus } from '../storage/models';
import { SessionManager } from '../session/SessionManager';
import { TaskManager } from '../tasks/TaskManager';
import { StorageProvider } from '../storage/StorageProvider';
import { CopilotAIService } from '../services/index';
import { AutomationService } from '../services/AutomationService';
import { JiraService } from '../services/JiraService';
import { SecretStorageService } from '../services/SecretStorageService';
import { generateId } from '../utils/uuid';
import { getCurrentBranch, createAndCheckoutBranch, slugifyForBranch } from '../utils/git';

/**
 * MessageHandler processes messages from the webview and dispatches
 * to the appropriate manager. It also sends state updates back.
 */
export class MessageHandler {
  private webview: vscode.Webview | null = null;
  private aiService: CopilotAIService;
  private automationService: AutomationService;
  private jiraService: JiraService;
  private secretStorage: SecretStorageService;

  constructor(
    private storage: StorageProvider,
    private sessionManager: SessionManager,
    private taskManager: TaskManager,
    secretStorage: SecretStorageService
  ) {
    this.secretStorage = secretStorage;
    this.aiService = new CopilotAIService();
    this.jiraService = new JiraService(secretStorage);
    this.automationService = new AutomationService(storage, taskManager, this.aiService);

    // Wire automation progress to webview
    this.automationService.setProgressHandler((progress) => {
      this.webview?.postMessage({ type: 'automationProgress', payload: progress });
      // Also send state update so task statuses refresh
      this.sendStateUpdate();
    });

    // Wire automation's send-to-copilot to our helper (agent mode, or ask mode for plan tasks)
    this.automationService.setSendToCopilotHandler(async (prompt, attachments, tag) => {
      const isplan = tag === 'plan';
      if (isplan) {
        prompt = 'Create a detailed implementation plan for the following. Do not make any changes yet \u2014 just outline the steps, files involved, and approach:\n\n' + prompt;
      }
      await this.sendPromptToCopilot(prompt, attachments, !isplan, isplan);
    });
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
        // Send automation progress if active
        if (this.automationService.isActive()) {
          this.webview?.postMessage({ type: 'automationProgress', payload: this.automationService.getProgress() });
        }
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
        // If automation is active, notify it so it can advance
        if (this.automationService.isActive()) {
          await this.automationService.notifyTaskCompleted(message.payload.id);
        }
        // Auto-complete parent when all subtasks are done
        if (cTask?.parentTaskId) {
          const parentData = this.storage.getData();
          const siblings = parentData.tasks.filter(t => t.parentTaskId === cTask.parentTaskId);
          const allDone = siblings.length > 0 && siblings.every(t => t.status === 'completed');
          if (allDone) {
            const parent = parentData.tasks.find(t => t.id === cTask.parentTaskId);
            if (parent && parent.status !== 'completed') {
              this.taskManager.completeTask(parent.id);
              vscode.window.showInformationMessage(`Build Board: All subtasks done — "${parent.title}" auto-completed.`);
            }
          }
        }
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
          vscode.window.showInformationMessage(`Build Board: Undid "${action}"`);
        } else {
          vscode.window.showInformationMessage('Build Board: Nothing to undo');
        }
        this.sendStateUpdate();
        break;
      }

      case 'redo': {
        const redoAction = this.taskManager.redo();
        if (redoAction) {
          vscode.window.showInformationMessage(`Build Board: Redid "${redoAction}"`);
        } else {
          vscode.window.showInformationMessage('Build Board: Nothing to redo');
        }
        this.sendStateUpdate();
        break;
      }

      case 'toggleTimer': {
        this.taskManager.toggleTimer(message.payload.id);
        this.sendStateUpdate();
        break;
      }

      case 'createBranchFromTask': {
        const data = this.storage.getData();
        const task = data.tasks.find((t) => t.id === message.payload.taskId);
        if (!task) { break; }
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!cwd) {
          vscode.window.showWarningMessage('No workspace folder open — cannot create a branch.');
          break;
        }
        try {
          const branchName = slugifyForBranch(task.tag, task.title);
          await createAndCheckoutBranch(cwd, branchName);
          task.branchName = branchName;
          this.storage.setData(data);
          this.sendStateUpdate();
          vscode.window.showInformationMessage(`Switched to branch: ${branchName}`);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Failed to create branch: ${errMsg}`);
        }
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
          // Create subtasks as real tasks linked to the parent via parentTaskId
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
                  parentTaskId: task.id,
                });
              }
            }
            this.sendStateUpdate();
          }
          this.webview?.postMessage({ type: 'aiResult', payload: { action: 'breakdown', result: subtasks, taskId: task.id } });
        });
        break;
      }

      case 'addSubtask': {
        // Manually add a subtask linked to the parent task
        const session = this.sessionManager.getActiveSession();
        if (!session) {
          vscode.window.showWarningMessage('Start a session before adding tasks.');
          break;
        }
        const parentData = this.storage.getData();
        const parentTask = parentData.tasks.find((t) => t.id === message.payload.parentTaskId);
        if (!parentTask) { break; }
        this.taskManager.addTask({
          title: message.payload.title,
          tag: parentTask.tag,
          priority: parentTask.priority,
          status: 'up-next',
          sessionId: session.id,
          parentTaskId: parentTask.id,
        });
        this.sendStateUpdate();
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

        // Prepend context instructions (project-level then task-level)
        const contextPrefix = this.buildContextPrefix(data, task);
        if (contextPrefix) {
          prompt = contextPrefix + '\n\n' + prompt;
        }

        // Plan tasks: prefix with planning instructions and open in Ask mode
        const useAskMode = task.tag === 'plan';
        if (useAskMode) {
          prompt = 'Create a detailed implementation plan for the following. Do not make any changes yet — just outline the steps, files involved, and approach:\n\n' + prompt;
        }
        await this.sendPromptToCopilot(prompt, task.attachments || [], false, useAskMode);

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
        const followUpIncludeContext = message.payload.includeProjectContext !== false;

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

        // Prepend context instructions to follow-up
        const fuContextPrefix = this.buildContextPrefix(fuData, fuTask, !followUpIncludeContext);
        const fullFollowUp = fuContextPrefix ? fuContextPrefix + '\n\n' + followUpPrompt : followUpPrompt;

        // Send the follow-up to Copilot Chat
        await this.sendPromptToCopilot(fullFollowUp, followUpAttachments);
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

      case 'startAutomation': {
        const { taskIds, threshold, timeout } = message.payload as { taskIds: string[]; threshold?: number; timeout?: number };
        if (threshold !== undefined) {
          await vscode.workspace.getConfiguration('buildboard').update('automationAutoApproveThreshold', threshold, vscode.ConfigurationTarget.Global);
        }
        if (timeout !== undefined) {
          await vscode.workspace.getConfiguration('buildboard').update('automationNoActivityTimeout', timeout, vscode.ConfigurationTarget.Global);
        }
        await this.automationService.start(taskIds);
        break;
      }

      case 'pauseAutomation': {
        this.automationService.pause();
        break;
      }

      case 'resumeAutomation': {
        await this.automationService.resume();
        break;
      }

      case 'cancelAutomation': {
        await this.automationService.cancel();
        break;
      }

      case 'skipAutomationTask': {
        await this.automationService.skipCurrent();
        break;
      }

      case 'skipQueuedTask': {
        const { queueIndex } = (message as { type: 'skipQueuedTask'; payload: { queueIndex: number } }).payload;
        this.automationService.skipQueued(queueIndex);
        break;
      }

      case 'approveAutomationTask': {
        await this.automationService.approveCurrent();
        break;
      }

      case 'rejectAutomationTask': {
        await this.automationService.rejectCurrent();
        break;
      }

      case 'reviseAutomationTask': {
        const { feedback } = (message as { type: 'reviseAutomationTask'; payload: { feedback: string } }).payload;
        await this.automationService.reviseCurrent(feedback);
        break;
      }

      case 'retryAutomationTask': {
        const { queueIndex } = (message as { type: 'retryAutomationTask'; payload: { queueIndex: number } }).payload;
        await this.automationService.retryTask(queueIndex);
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
        const config = vscode.workspace.getConfiguration('buildboard');
        const carryOver = config.get<boolean>('carryOverTasks', true);
        const sessionName = (message.payload as { name?: string; projectId?: string }).name;
        const projectId = (message.payload as { name?: string; projectId?: string }).projectId;

        // startSession() internally ends the active session first
        const newSession = this.sessionManager.startSession(projectPath, sessionName);

        // Link session to project if one was selected
        if (projectId) {
          const d = this.storage.getData();
          const sess = d.sessions.find((s) => s.id === newSession.id);
          if (sess) { sess.projectId = projectId; }
          d.activeProjectId = projectId;
          this.storage.setData(d);
        }

        // Reset board timers for the new session
        {
          const updatedData = this.storage.getData();
          const boardName = sessionName || 'Main Board';
          if (!updatedData.boards || updatedData.boards.length === 0) {
            updatedData.boards = [{ id: 'default', name: boardName, createdAt: new Date().toISOString(), pausedAt: null, totalPausedMs: 0 }];
            updatedData.activeBoardId = 'default';
          } else {
            // Boards exist from a previous session — reset all timers
            const now = new Date().toISOString();
            for (const board of updatedData.boards) {
              board.createdAt = now;
              board.pausedAt = null;
              board.totalPausedMs = 0;
            }
          }
          this.storage.setData(updatedData);
        }

        // Carry over incomplete tasks from ended sessions, scoped to project
        // (runs after startSession has ended the previous session, so nothing is missed)
        if (carryOver) {
          const carried = this.taskManager.carryOverAllTasks(newSession.id, projectId);
          if (carried > 0) {
            vscode.window.showInformationMessage(
              `Build Board: Session started! ${carried} task${carried === 1 ? '' : 's'} carried over.`
            );
          } else {
            vscode.window.showInformationMessage('Build Board: Session started!');
          }
        } else {
          vscode.window.showInformationMessage('Build Board: Session started!');
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
          vscode.window.showInformationMessage('Build Board: Board timer paused.');
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
          vscode.window.showInformationMessage('Build Board: Board timer resumed.');
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
        const resolvedProjectIds = message.payload.projectIds ?? (message.payload.projectId ? [message.payload.projectId] : undefined);
        await this.exportData(message.payload.format, message.payload.timePeriod, message.payload.customStart, message.payload.customEnd, resolvedProjectIds);
        break;
      }

      case 'importData': {
        await this.importData();
        break;
      }

      case 'clearAllData': {
        await this.clearAllData();
        break;
      }

      case 'createProject': {
        const d = this.storage.getData();
        if (!d.projects) { d.projects = []; }
        // Use the workspace/group value the user explicitly provided (if any)
        const workspace = message.payload.workspace || '';
        const project = {
          id: message.payload.id || generateId(),
          name: message.payload.name,
          createdAt: new Date().toISOString(),
          color: message.payload.color,
          workspace: workspace || undefined,
          copilotContext: message.payload.copilotContext || undefined,
        };
        d.projects.push(project);
        d.activeProjectId = project.id;
        this.storage.setData(d);
        this.sendStateUpdate();
        break;
      }

      case 'renameProject': {
        const d = this.storage.getData();
        const proj = d.projects?.find((p) => p.id === message.payload.projectId);
        if (proj) {
          proj.name = message.payload.name;
          this.storage.setData(d);
          this.sendStateUpdate();
        }
        break;
      }

      case 'updateProject': {
        const d = this.storage.getData();
        const proj = d.projects?.find((p) => p.id === message.payload.projectId);
        if (proj) {
          const changes = message.payload.changes;
          if (changes.name !== undefined) { proj.name = changes.name; }
          if (changes.color !== undefined) { proj.color = changes.color; }
          if (changes.workspace !== undefined) { proj.workspace = changes.workspace || undefined; }
          if (changes.copilotContext !== undefined) { proj.copilotContext = changes.copilotContext || undefined; }
          if (changes.copilotContextEnabled !== undefined) { proj.copilotContextEnabled = changes.copilotContextEnabled; }
          this.storage.setData(d);
          this.sendStateUpdate();
        }
        break;
      }

      case 'deleteProject': {
        const d = this.storage.getData();
        if (d.projects) {
          d.projects = d.projects.filter((p) => p.id !== message.payload.projectId);
          // Unlink sessions from this project
          for (const s of d.sessions) {
            if (s.projectId === message.payload.projectId) { s.projectId = undefined; }
          }
          if (d.activeProjectId === message.payload.projectId) { d.activeProjectId = null; }
          this.storage.setData(d);
          this.sendStateUpdate();
        }
        break;
      }

      case 'setActiveProject': {
        const d = this.storage.getData();
        d.activeProjectId = message.payload.projectId;
        this.storage.setData(d);
        this.sendStateUpdate();
        break;
      }

      case 'updateSetting': {
        const { key, value } = message.payload as { key: string; value: unknown };
        const allowedKeys = ['autoBackup', 'autoBackupMaxCount', 'autoBackupIntervalMin', 'autoPromptSession', 'carryOverTasks', 'jiraBaseUrl', 'storageScope', 'automationAutoApproveThreshold', 'automationNoActivityTimeout', 'automationBranching'];
        if (allowedKeys.includes(key)) {
          await vscode.workspace.getConfiguration('buildboard').update(key, value, vscode.ConfigurationTarget.Global);
          this.invalidateSettingsCache();

          // Storage scope change — also show a VS Code notification as a fallback
          if (key === 'storageScope') {
            const action = await vscode.window.showInformationMessage(
              `Build Board: Storage scope changed to "${value}". Reload window to apply.`,
              'Reload Now'
            );
            if (action === 'Reload Now') {
              vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
          }
        }
        break;
      }

      case 'saveJiraCredentials': {
        const { baseUrl, email, token } = message.payload as { baseUrl: string; email: string; token: string };
        await this.secretStorage.saveJiraCredentials(baseUrl, email, token);
        // Invalidate cache and send updated settings so webview reflects the new state
        this.invalidateSettingsCache();
        break;
      }

      case 'reloadWindow': {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
        break;
      }

      case 'exportHelpDocs': {
        const { content } = message.payload as { content: string };
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file('build-board-help.md'),
          filters: { 'Markdown': ['md'], 'Text': ['txt'] },
          title: 'Export Help Documentation'
        });
        if (uri) {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
          vscode.window.showInformationMessage('Help documentation exported successfully.');
        }
        break;
      }

      case 'clearJiraCredentials': {
        await this.secretStorage.clearJiraCredentials();
        this.invalidateSettingsCache();
        break;
      }

      case 'setJiraProjectMapping': {
        const { vbProjectId, jiraProjectKey } = message.payload as { vbProjectId: string; jiraProjectKey: string };
        const d = this.storage.getData();
        if (!d.jiraProjectMapping) { d.jiraProjectMapping = {}; }
        if (jiraProjectKey) {
          d.jiraProjectMapping[vbProjectId] = jiraProjectKey;
        } else {
          delete d.jiraProjectMapping[vbProjectId];
        }
        this.storage.setData(d);
        this.sendStateUpdate();
        break;
      }

      case 'setJiraEpicMapping': {
        const { vbProjectId: epicVbId, epicKey: mappedEpicKey } = message.payload as { vbProjectId: string; epicKey: string };
        const ed = this.storage.getData();
        if (!ed.jiraEpicMapping) { ed.jiraEpicMapping = {}; }
        if (mappedEpicKey) {
          ed.jiraEpicMapping[epicVbId] = mappedEpicKey;
        } else {
          delete ed.jiraEpicMapping[epicVbId];
        }
        this.storage.setData(ed);
        this.sendStateUpdate();
        break;
      }

      case 'setJiraPromptDismissed': {
        const { dismissed } = message.payload as { dismissed: boolean };
        const d = this.storage.getData();
        d.jiraPromptDismissed = dismissed;
        this.storage.setData(d);
        break;
      }

      case 'setJiraStatusMapping': {
        const { jiraProjectKey, direction, mapping } = message.payload as {
          jiraProjectKey: string;
          direction: 'export' | 'import';
          mapping: Record<string, string>;
        };
        const d = this.storage.getData();
        if (!d.jiraStatusMapping) { d.jiraStatusMapping = {}; }
        if (!d.jiraStatusMapping[jiraProjectKey]) {
          d.jiraStatusMapping[jiraProjectKey] = { export: {}, import: {} };
        }
        d.jiraStatusMapping[jiraProjectKey][direction] = mapping;
        this.storage.setData(d);
        this.sendStateUpdate();
        break;
      }

      case 'getJiraProjects': {
        try {
          const result = await this.jiraService.getProjects();
          this.webview?.postMessage({ type: 'jiraProjects', payload: result });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.webview?.postMessage({ type: 'jiraProjects', payload: { projects: [], error: `Unexpected error: ${msg}` } });
        }
        break;
      }

      case 'getJiraEpics': {
        try {
          const { projectKey: epicsProjectKey } = message.payload as { projectKey: string };
          const epicResult = await this.jiraService.searchEpics(epicsProjectKey);
          this.webview?.postMessage({ type: 'jiraEpics', payload: epicResult });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.webview?.postMessage({ type: 'jiraEpics', payload: { epics: [], error: `Unexpected error: ${msg}` } });
        }
        break;
      }

      case 'createJiraEpic': {
        try {
          const { projectKey: epicProjectKey, epicName } = message.payload as { projectKey: string; epicName: string };
          const createResult = await this.jiraService.createEpic(epicProjectKey, epicName);
          if (createResult.error || !createResult.key) {
            this.webview?.postMessage({ type: 'jiraEpics', payload: { epics: [], error: createResult.error || 'Failed to create epic.' } });
          } else {
            // Re-fetch epics so the new one appears in the list, and pass newEpicKey for auto-select
            const refreshed = await this.jiraService.searchEpics(epicProjectKey);
            this.webview?.postMessage({ type: 'jiraEpics', payload: { ...refreshed, newEpicKey: createResult.key } });
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.webview?.postMessage({ type: 'jiraEpics', payload: { epics: [], error: `Unexpected error: ${msg}` } });
        }
        break;
      }

      case 'getJiraStatuses': {
        try {
          const { projectKey: statusProjectKey } = message.payload as { projectKey: string };
          const statusResult = await this.jiraService.getStatuses(statusProjectKey);
          this.webview?.postMessage({ type: 'jiraStatuses', payload: statusResult });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.webview?.postMessage({ type: 'jiraStatuses', payload: { statuses: [], error: `Unexpected error: ${msg}` } });
        }
        break;
      }

      case 'testJiraConnection': {
        try {
          const result = await this.jiraService.testConnection();
          this.webview?.postMessage({ type: 'jiraConnectionTest', payload: result });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.webview?.postMessage({ type: 'jiraConnectionTest', payload: { success: false, error: `Unexpected error: ${msg}` } });
        }
        break;
      }

      case 'exportToJira': {
        try {
          const data = this.storage.getData();
          const { projectKey, taskIds, issueType, statusMapping, epicKey } = message.payload as {
            projectKey: string;
            taskIds?: string[];
            issueType?: string;
            statusMapping?: Record<string, string>;
            epicKey?: string;
          };

          // If taskIds provided, export those; otherwise export all tasks in active session
          let tasksToExport: VBTask[];
          if (taskIds && taskIds.length > 0) {
            tasksToExport = data.tasks.filter((t) => taskIds.includes(t.id));
          } else if (data.activeSessionId) {
            tasksToExport = data.tasks.filter((t) => t.sessionId === data.activeSessionId);
          } else {
            tasksToExport = data.tasks;
          }

          if (tasksToExport.length === 0) {
            this.webview?.postMessage({
              type: 'jiraExportResult',
              payload: { success: false, created: 0, failed: 0, issues: [], errors: ['No tasks to export.'] },
            });
            break;
          }

          const { created, errors } = await this.jiraService.createIssues(
            tasksToExport,
            projectKey,
            issueType || 'Task',
            undefined,
            statusMapping,
            epicKey
          );

          const success = created.length > 0 && errors.length === 0;

          // Stamp exported tasks with Jira issue keys (per-project)
          if (created.length > 0) {
            const d = this.storage.getData();
            const now = new Date().toISOString();
            for (const issue of created) {
              const task = d.tasks.find((t) => t.id === issue.taskId);
              if (task) {
                // Legacy fields (last export)
                task.jiraIssueKey = issue.issueKey;
                task.jiraExportedAt = now;
                // Per-project tracking
                if (!task.jiraExports) { task.jiraExports = {}; }
                const projKey = issue.issueKey.replace(/-\d+$/, '');
                task.jiraExports[projKey] = { issueKey: issue.issueKey, exportedAt: now };
              }
            }
            this.storage.setData(d);
          }

          this.webview?.postMessage({
            type: 'jiraExportResult',
            payload: {
              success,
              created: created.length,
              failed: errors.length,
              issues: created,
              errors,
            },
          });

          if (created.length > 0) {
            vscode.window.showInformationMessage(
              `Build Board: Created ${created.length} Jira issue${created.length === 1 ? '' : 's'}${errors.length > 0 ? ` (${errors.length} failed)` : ''}.`
            );
            // Refresh webview state so exported badges appear
            this.sendStateUpdate();
          } else {
            vscode.window.showErrorMessage('Build Board: Failed to create Jira issues. Check the export results for details.');
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.webview?.postMessage({
            type: 'jiraExportResult',
            payload: { success: false, created: 0, failed: 0, issues: [], errors: [`Unexpected error: ${msg}`] },
          });
          vscode.window.showErrorMessage(`Build Board: Jira export failed — ${msg}`);
        }
        break;
      }

      case 'searchJiraIssues': {
        try {
          const { projectKey, jql, maxResults } = message.payload as {
            projectKey: string;
            jql?: string;
            maxResults?: number;
          };
          const result = await this.jiraService.searchIssues(projectKey, jql, maxResults);
          this.webview?.postMessage({ type: 'jiraSearchResults', payload: result });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.webview?.postMessage({ type: 'jiraSearchResults', payload: { issues: [], total: 0, error: `Unexpected error: ${msg}` } });
        }
        break;
      }

      case 'importFromJira': {
        try {
          const { issues, statusMapping } = message.payload as {
            issues: {
              key: string; summary: string; description: string; status: string;
              priority: string; issueType: string; labels: string[];
              attachments?: { id: string; filename: string; mimeType: string; contentUrl: string }[];
              comments?: { author: string; body: string; created: string }[];
            }[];
            statusMapping?: Record<string, string>;
          };

          const data = this.storage.getData();
          if (!data.activeSessionId) {
            this.webview?.postMessage({ type: 'jiraImportResult', payload: { success: false, imported: 0, error: 'No active session. Start a session first.' } });
            break;
          }

          const mapPriority = (jiraPriority: string): 'high' | 'medium' | 'low' => {
            const p = jiraPriority.toLowerCase();
            if (p === 'highest' || p === 'high' || p === 'critical' || p === 'blocker') { return 'high'; }
            if (p === 'lowest' || p === 'low' || p === 'trivial') { return 'low'; }
            return 'medium';
          };

          const mapTag = (issueType: string, labels: string[]): TaskTag => {
            const it = issueType.toLowerCase();
            if (it === 'bug') { return 'bug'; }
            if (it === 'epic' || it === 'story' || it === 'feature') { return 'feature'; }
            if (labels.some((l) => l.toLowerCase() === 'refactor')) { return 'refactor'; }
            if (labels.some((l) => l.toLowerCase() === 'plan' || l.toLowerCase() === 'spike')) { return 'plan'; }
            if (it === 'sub-task' || it === 'subtask') { return 'todo'; }
            return 'todo';
          };

          const resolveStatus = (jiraStatus: string): TaskStatus => {
            // Use the provided mapping (Jira status name → VB status)
            if (statusMapping && statusMapping[jiraStatus]) {
              const mapped = statusMapping[jiraStatus] as TaskStatus;
              if (['in-progress', 'up-next', 'backlog', 'completed', 'notes'].includes(mapped)) {
                return mapped;
              }
            }
            return 'up-next';
          };

          let importCount = 0;
          for (const issue of issues) {
            const tag = mapTag(issue.issueType, issue.labels);
            const priority = mapPriority(issue.priority);
            const vbStatus = resolveStatus(issue.status);
            const importedAt = new Date().toLocaleString();
            const description = issue.description
              ? `${issue.description}\n\n— Imported from Jira: ${issue.key} on ${importedAt} —`
              : `— Imported from Jira: ${issue.key} on ${importedAt} —`;

            const task = this.taskManager.addTask({
              title: issue.summary.slice(0, 300),
              tag,
              status: vbStatus,
              sessionId: data.activeSessionId,
              description,
              priority,
            });

            // Download image attachments from Jira and store as VBAttachments
            const vbAttachments: VBAttachment[] = [];
            if (issue.attachments && issue.attachments.length > 0) {
              for (const att of issue.attachments) {
                try {
                  const result = await this.jiraService.downloadAttachment(att.contentUrl, att.mimeType);
                  if (result.dataUri) {
                    vbAttachments.push({
                      id: `jira-${att.id}`,
                      filename: att.filename,
                      mimeType: att.mimeType,
                      dataUri: result.dataUri,
                      addedAt: new Date().toISOString(),
                    });
                  }
                } catch {
                  // Skip failed attachment downloads — don't block the import
                }
              }
            }

            // Map Jira comments to copilotLog entries (follow-up log format)
            const copilotLog: { prompt: string; timestamp: string }[] = [];
            if (issue.comments && issue.comments.length > 0) {
              for (const comment of issue.comments) {
                copilotLog.push({
                  prompt: `[${comment.author}] ${comment.body}`,
                  timestamp: comment.created,
                });
              }
            }

            // Attach downloaded images and comments to the newly created task
            if (vbAttachments.length > 0 || copilotLog.length > 0) {
              const d = this.storage.getData();
              const t = d.tasks.find((x) => x.id === task.id);
              if (t) {
                if (vbAttachments.length > 0) { t.attachments = vbAttachments; }
                if (copilotLog.length > 0) { t.copilotLog = copilotLog; }
                this.storage.setData(d);
              }
            }

            importCount++;
          }

          this.webview?.postMessage({ type: 'jiraImportResult', payload: { success: true, imported: importCount } });
          vscode.window.showInformationMessage(
            `Build Board: Imported ${importCount} issue${importCount === 1 ? '' : 's'} from Jira.`
          );
          this.sendStateUpdate();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.webview?.postMessage({ type: 'jiraImportResult', payload: { success: false, imported: 0, error: `Unexpected error: ${msg}` } });
        }
        break;
      }
    }
  }

  /**
   * Push the full state to the webview.
   * Strips undo/redo stacks to keep the payload lean — the webview only
   * needs their lengths (sent as numbers) to enable/disable toolbar buttons.
   */
  sendStateUpdate(): void {
    if (!this.webview) {
      return;
    }
    const data = this.storage.getData();

    // If the active session belongs to a different workspace folder,
    // end it automatically and notify the user.
    if (data.activeSessionId) {
      const currentWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      const activeSession = data.sessions.find(s => s.id === data.activeSessionId);
      if (activeSession && activeSession.projectPath && currentWorkspace &&
          activeSession.projectPath.toLowerCase() !== currentWorkspace.toLowerCase()) {
        const oldName = activeSession.name || 'previous session';
        const oldFolder = activeSession.projectPath.split(/[\\/]/).pop() || activeSession.projectPath;
        this.sessionManager.endSession();
        vscode.window.showInformationMessage(
          `Build Board: "${oldName}" from ${oldFolder} was ended because you switched folders.`
        );
        // Re-read data after ending the session
        const freshData = this.storage.getData();
        const { undoStack, redoStack, ...rest } = freshData;
        const payload = {
          ...rest,
          undoCount: undoStack?.length ?? 0,
          redoCount: redoStack?.length ?? 0,
        };
        this.webview.postMessage({ type: 'stateUpdate', payload });
        return;
      }
    }

    // Build a lightweight payload — replace heavy stacks with counts
    const { undoStack, redoStack, ...rest } = data;
    const payload = {
      ...rest,
      undoCount: undoStack?.length ?? 0,
      redoCount: redoStack?.length ?? 0,
    };
    this.webview.postMessage({ type: 'stateUpdate', payload });
  }

  /**
   * Send initial state + settings to the webview (called once on first connect).
   * State is sent synchronously; settings are sent async (may involve keychain reads).
   */
  sendInitialState(): void {
    this.sendStateUpdate();
    // Fire-and-forget — don't block on keychain I/O
    this.sendSettingsUpdate();
  }

  /**
   * Send settings (including Jira credential summary from SecretStorage) to webview.
   * Caches the result so subsequent calls don't hit the keychain.
   */
  private settingsCache: Record<string, unknown> | null = null;
  private async sendSettingsUpdate(): Promise<void> {
    if (!this.webview) { return; }
    // Return cached settings immediately if available (skip keychain reads)
    if (this.settingsCache) {
      this.webview.postMessage({ type: 'settingsUpdate', payload: this.settingsCache });
      return;
    }
    const config = vscode.workspace.getConfiguration('buildboard');
    const jiraSummary = await this.secretStorage.getJiraSummary();
    this.settingsCache = {
      autoBackup: config.get<boolean>('autoBackup', true),
      autoBackupMaxCount: config.get<number>('autoBackupMaxCount', 10),
      autoBackupIntervalMin: config.get<number>('autoBackupIntervalMin', 5),
      autoPromptSession: config.get<boolean>('autoPromptSession', true),
      carryOverTasks: config.get<boolean>('carryOverTasks', true),
      storageScope: this.storage.getStorageScope(),
      workspaceName: vscode.workspace.workspaceFolders?.[0]?.name || '',
      jiraBaseUrl: config.get<string>('jiraBaseUrl', ''),
      jiraEmail: jiraSummary.email,
      jiraConfigured: jiraSummary.configured,
      jiraApiTokenLength: jiraSummary.tokenLength,
      automationAutoApproveThreshold: config.get<number>('automationAutoApproveThreshold', 100),
      automationNoActivityTimeout: config.get<number>('automationNoActivityTimeout', 30),
      automationBranching: config.get<boolean>('automationBranching', false),
    };
    this.webview.postMessage({ type: 'settingsUpdate', payload: this.settingsCache });
  }

  /**
   * Invalidate settings cache and re-send to webview.
   * Call this when credentials or settings change.
   */
  invalidateSettingsCache(): void {
    this.settingsCache = null;
    this.sendSettingsUpdate();
  }

  /**
   * Build a context instruction prefix from project-level and task-level context.
   * Returns an empty string if no context is set.
   */
  private buildContextPrefix(data: { projects?: { id: string; copilotContext?: string; copilotContextEnabled?: boolean }[]; activeProjectId?: string | null; sessions?: { id: string; projectId?: string }[] }, task?: { sessionId: string }, skipProjectContext = false): string {
    const parts: string[] = [];

    // Project-level context: find the project for the task's session
    if (!skipProjectContext && task && data.projects && data.sessions) {
      const session = data.sessions.find((s) => s.id === task.sessionId);
      const project = session?.projectId ? data.projects.find((p) => p.id === session.projectId) : null;
      if (project?.copilotContext?.trim() && project.copilotContextEnabled !== false) {
        parts.push(`[Project Context]\n${project.copilotContext.trim()}`);
      }
    }

    return parts.join('\n\n');
  }

  /**
   * Send a prompt (with optional image attachments) to Copilot Chat.
   * Extracted so it can be reused for initial send and follow-ups.
   * @param useAgentMode If true, opens chat in Agent mode (for automation).
   */
  private async sendPromptToCopilot(prompt: string, attachments: VBAttachment[] = [], useAgentMode = false, useAskMode = false): Promise<void> {
    const imageAttachments = attachments.filter((a) => a.mimeType.startsWith('image/'));
    const savedImagePaths: vscode.Uri[] = [];

    if (imageAttachments.length > 0) {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (workspaceFolder) {
        const tempDir = vscode.Uri.joinPath(workspaceFolder.uri, '.buildboard', 'temp');
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
      if (useAgentMode) {
        chatOptions.mode = 'agent';
      } else if (useAskMode) {
        chatOptions.mode = 'ask';
      }
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
        vscode.window.showInformationMessage('Build Board: Prompt copied to clipboard. Paste it in the chat.');
      } catch {
        await vscode.env.clipboard.writeText(prompt);
        vscode.window.showInformationMessage('Build Board: Prompt copied to clipboard. Open Copilot Chat and paste.');
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
    customEnd?: string,
    projectIds?: string[]
  ): Promise<void> {
    const data = this.storage.getData();
    const history = this.sessionManager.getSessionHistory();
    const period = timePeriod || 'all';
    const dateRange = this.getDateRange(period, customStart, customEnd);

    // Determine project-scoped session IDs (supports multiple projects)
    const projectSessionIds = projectIds && projectIds.length > 0
      ? new Set(data.sessions.filter((s) => s.projectId && projectIds.includes(s.projectId)).map((s) => s.id))
      : null;

    // Filter tasks by date range, then optionally by project
    let filteredTasks = this.filterTasksByDateRange(data.tasks, dateRange);
    if (projectSessionIds) {
      filteredTasks = filteredTasks.filter((t) => projectSessionIds.has(t.sessionId));
    }

    const periodLabel = this.getTimePeriodLabel(period, customStart, customEnd);
    const projectNames = projectIds && projectIds.length > 0
      ? projectIds.map((id) => data.projects?.find((p) => p.id === id)?.name).filter(Boolean)
      : [];
    const scopeLabel = projectNames.length === 1 ? ` — ${projectNames[0]}` : projectNames.length > 1 ? ` — ${projectNames.length} projects` : '';

    // Build filtered sessions for project scope
    const filteredSessions = projectSessionIds
      ? data.sessions.filter((s) => projectSessionIds.has(s.id))
      : data.sessions;

    const filteredData = { ...data, tasks: filteredTasks, sessions: filteredSessions };
    const totals = this.computeExportTotals(filteredData);

    const localDate = new Date().toISOString().slice(0, 10);
    let content: string;
    let ext: string;
    let defaultName: string;
    let filterLabel: string;
    const nameSuffix = projectNames.length === 1 ? `-${projectNames[0]!.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : projectNames.length > 1 ? '-multi' : '';

    // Collect relevant project objects for the export
    const exportProjects = projectIds && projectIds.length > 0
      ? (data.projects || []).filter((p) => projectIds.includes(p.id))
      : (data.projects || []);

    if (format === 'json') {
      // JSON is always a full backup (but project-scoped if selected)
      const jsonData = projectSessionIds ? filteredData : data;
      const allTotals = this.computeExportTotals(jsonData);
      const jsonSessions = projectSessionIds
        ? history.sessions.filter((s) => projectSessionIds.has(s.id)).map((s) => ({
            ...s,
            summary: history.summaries[history.sessions.indexOf(s)],
          }))
        : history.sessions.map((s, i) => ({ ...s, summary: history.summaries[i] }));
      const exportObj = {
        exportedAt: new Date().toISOString(),
        projects: exportProjects,
        activeProjectId: data.activeProjectId || null,
        jiraProjectMapping: data.jiraProjectMapping || {},
        jiraEpicMapping: data.jiraEpicMapping || {},
        jiraStatusMapping: data.jiraStatusMapping || {},
        jiraPromptDismissed: data.jiraPromptDismissed || false,
        boards: data.boards || [],
        activeBoardId: data.activeBoardId || null,
        summary: allTotals,
        sessions: jsonSessions,
        activeSession: data.activeSessionId ? {
          id: data.activeSessionId,
          session: data.sessions.find((s) => s.id === data.activeSessionId),
          tasks: data.tasks.filter((t) => t.sessionId === data.activeSessionId),
        } : null,
        tasks: jsonData.tasks,
      };
      content = JSON.stringify(exportObj, null, 2);
      ext = 'json';
      defaultName = `buildboard-export${nameSuffix}-${localDate}.json`;
      filterLabel = 'JSON';
    } else if (format === 'csv') {
      content = this.generateCsv(filteredData, totals, periodLabel + scopeLabel, exportProjects);
      ext = 'csv';
      defaultName = `buildboard-export${nameSuffix}-${localDate}.csv`;
      filterLabel = 'CSV';
    } else {
      // Markdown export
      const mdHistory = projectSessionIds
        ? { sessions: history.sessions.filter((s) => projectSessionIds.has(s.id)), summaries: history.summaries.filter((_, i) => projectSessionIds.has(history.sessions[i].id)) }
        : history;
      content = this.generateMarkdown(filteredData, mdHistory, totals, periodLabel + scopeLabel, exportProjects);
      ext = 'md';
      defaultName = `buildboard-export${nameSuffix}-${localDate}.md`;
      filterLabel = 'Markdown';
    }

    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultName),
      filters: { [filterLabel]: [ext] },
      title: 'Export Build Board Data',
    });

    if (uri) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
      vscode.window.showInformationMessage(`Build Board: Exported to ${uri.fsPath}`);
    }
  }

  /**
   * Clear all data and reset to a fresh state.
   */
  private async clearAllData(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      'Are you sure you want to delete ALL Build Board data? This will permanently remove all sessions, tasks, and boards. This cannot be undone.',
      { modal: true },
      'Delete Everything'
    );

    if (confirm !== 'Delete Everything') return;

    const freshData = createDefaultWorkspaceData();
    this.storage.setData(freshData);
    this.sendStateUpdate();
    vscode.window.showInformationMessage('Build Board: All data has been cleared.');
  }

  /**
   * Import data from a JSON file.
   */
  private async importData(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'JSON': ['json'] },
      title: 'Import Build Board Data',
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
      // 1. Build Board export JSON (has .sessions array with .summary, .tasks array)
      // 2. Raw workspace data (has .version, .sessions, .tasks)

      let sessions: any[] = [];
      let tasks: any[] = [];
      let boards: any[] | undefined;
      let projects: any[] | undefined;
      let jiraProjectMapping: Record<string, string> | undefined;
      let jiraEpicMapping: Record<string, string> | undefined;
      let jiraStatusMapping: Record<string, { export: Record<string, string>; import: Record<string, string> }> | undefined;
      let jiraPromptDismissed: boolean | undefined;

      if (imported.version === 1 && Array.isArray(imported.sessions) && Array.isArray(imported.tasks)) {
        // Raw workspace data format (direct copy of data.json)
        sessions = imported.sessions;
        tasks = imported.tasks;
        boards = imported.boards;
        projects = imported.projects;
        jiraProjectMapping = imported.jiraProjectMapping;
        jiraEpicMapping = imported.jiraEpicMapping;
        jiraStatusMapping = imported.jiraStatusMapping;
        if (typeof imported.jiraPromptDismissed === 'boolean') { jiraPromptDismissed = imported.jiraPromptDismissed; }
      } else if (Array.isArray(imported.sessions) && Array.isArray(imported.tasks)) {
        // Export format — sessions may have .summary attached
        sessions = imported.sessions.map((s: any) => {
          const { summary, ...sessionData } = s;
          return sessionData;
        });
        tasks = imported.tasks;
        // Import projects and mappings from export format
        if (Array.isArray(imported.projects)) {
          projects = imported.projects;
        }
        if (imported.jiraProjectMapping && typeof imported.jiraProjectMapping === 'object') {
          jiraProjectMapping = imported.jiraProjectMapping;
        }
        if (imported.jiraEpicMapping && typeof imported.jiraEpicMapping === 'object') {
          jiraEpicMapping = imported.jiraEpicMapping;
        }
        if (imported.jiraStatusMapping && typeof imported.jiraStatusMapping === 'object') {
          jiraStatusMapping = imported.jiraStatusMapping;
        }
        if (typeof imported.jiraPromptDismissed === 'boolean') {
          jiraPromptDismissed = imported.jiraPromptDismissed;
        }
        if (Array.isArray(imported.boards)) {
          boards = imported.boards;
        }
      } else {
        vscode.window.showErrorMessage('Import failed: unrecognized file format. Use a Build Board JSON export or data.json backup.');
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
        if (projects && Array.isArray(projects)) {
          data.projects = projects;
          data.activeProjectId = null;
        } else {
          data.projects = [];
          data.activeProjectId = null;
        }
        if (jiraProjectMapping) {
          data.jiraProjectMapping = jiraProjectMapping;
        } else {
          data.jiraProjectMapping = {};
        }
        if (jiraEpicMapping) {
          data.jiraEpicMapping = jiraEpicMapping;
        } else {
          data.jiraEpicMapping = {};
        }
        if (jiraStatusMapping) {
          data.jiraStatusMapping = jiraStatusMapping;
        } else {
          data.jiraStatusMapping = {};
        }
        if (jiraPromptDismissed !== undefined) {
          data.jiraPromptDismissed = jiraPromptDismissed;
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

        if (projects && Array.isArray(projects)) {
          const existingProjectIds = new Set((data.projects || []).map((p) => p.id));
          for (const p of projects) {
            if (!existingProjectIds.has(p.id)) {
              data.projects = data.projects || [];
              data.projects.push(p);
            }
          }
        }

        // Merge Jira project mappings (imported values fill gaps, don't overwrite existing)
        if (jiraProjectMapping) {
          data.jiraProjectMapping = data.jiraProjectMapping || {};
          for (const [vbId, jiraKey] of Object.entries(jiraProjectMapping)) {
            if (!data.jiraProjectMapping[vbId]) {
              data.jiraProjectMapping[vbId] = jiraKey;
            }
          }
        }

        // Merge Jira epic mappings (imported values fill gaps)
        if (jiraEpicMapping) {
          data.jiraEpicMapping = data.jiraEpicMapping || {};
          for (const [vbId, epicKey] of Object.entries(jiraEpicMapping)) {
            if (!data.jiraEpicMapping[vbId]) {
              data.jiraEpicMapping[vbId] = epicKey;
            }
          }
        }

        // Merge Jira status mappings (imported values fill gaps per project key)
        if (jiraStatusMapping) {
          data.jiraStatusMapping = data.jiraStatusMapping || {};
          for (const [projectKey, directions] of Object.entries(jiraStatusMapping)) {
            if (!data.jiraStatusMapping[projectKey]) {
              data.jiraStatusMapping[projectKey] = directions;
            }
          }
        }

        // Merge jiraPromptDismissed (imported value fills gap)
        if (jiraPromptDismissed !== undefined && data.jiraPromptDismissed === undefined) {
          data.jiraPromptDismissed = jiraPromptDismissed;
        }

        vscode.window.showInformationMessage(`Build Board: Merged ${addedSessions} sessions and ${addedTasks} tasks (${sessionCount - addedSessions} sessions and ${taskCount - addedTasks} tasks were duplicates).`);
      }

      this.storage.setData(data);
      this.sendStateUpdate();

      if (choice.label === 'Replace') {
        vscode.window.showInformationMessage(`Build Board: Imported ${sessionCount} sessions and ${taskCount} tasks.`);
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
    const byTag: Record<string, number> = { feature: 0, bug: 0, refactor: 0, note: 0, plan: 0, todo: 0 };
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
    let longestSessionMs = 0;
    let longestSessionName = '';
    let mostProductiveCount = 0;
    let mostProductiveName = '';

    for (const s of data.sessions) {
      const end = s.endedAt ? new Date(s.endedAt).getTime() : Date.now();
      const raw = end - new Date(s.startedAt).getTime();
      const paused = s.totalPausedMs || 0;
      const dur = Math.max(0, raw - paused);
      totalSessionMs += dur;
      if (dur > longestSessionMs) {
        longestSessionMs = dur;
        longestSessionName = s.name;
      }
      const completed = allTasks.filter((t) => t.sessionId === s.id && t.status === 'completed').length;
      if (completed > mostProductiveCount) {
        mostProductiveCount = completed;
        mostProductiveName = s.name;
      }
    }

    // Completion rate
    const completedCount = byStatus['completed'] || 0;
    const completionRate = totalTasks > 0 ? Math.round((completedCount / totalTasks) * 100) : 0;

    // Carry-over rate
    const carryOverRate = totalTasks > 0 ? Math.round((carriedOverCount / totalTasks) * 100) : 0;

    // Average session duration
    const avgSessionMs = endedSessions > 0 ? Math.round(totalSessionMs / endedSessions) : 0;

    // Tasks completed per session
    const tasksPerSession = endedSessions > 0 ? (completedCount / endedSessions).toFixed(1) : '0';

    // Average turnaround (creation to completion)
    let totalTurnaroundMs = 0;
    let turnaroundCount = 0;
    for (const t of allTasks) {
      if (t.status === 'completed' && t.completedAt) {
        const turnaround = new Date(t.completedAt).getTime() - new Date(t.createdAt).getTime();
        if (turnaround > 0) {
          totalTurnaroundMs += turnaround;
          turnaroundCount++;
        }
      }
    }
    const avgTurnaroundMs = turnaroundCount > 0 ? Math.round(totalTurnaroundMs / turnaroundCount) : 0;

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
      completionRate,
      carryOverRate,
      avgSessionDuration: this.formatDuration(avgSessionMs),
      tasksPerSession,
      avgTurnaround: this.formatDuration(avgTurnaroundMs),
      longestSession: longestSessionName ? `${longestSessionName} (${this.formatDuration(longestSessionMs)})` : 'N/A',
      mostProductive: mostProductiveName ? `${mostProductiveName} (${mostProductiveCount} completed)` : 'N/A',
    };
  }

  /**
   * Generate a CSV export with all tasks and a summary section.
   */
  private generateCsv(
    data: ReturnType<StorageProvider['getData']>,
    totals: ReturnType<MessageHandler['computeExportTotals']>,
    periodLabel?: string,
    projects?: VBProject[]
  ): string {
    const csvEsc = (s: string) => `"${s.replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`;
    const lines: string[] = [];

    // Build project groupings
    const hasProjects = projects && projects.length > 0;
    const sessionProjectMap = new Map<string, string>();
    if (hasProjects) {
      for (const s of data.sessions) {
        if (s.projectId) { sessionProjectMap.set(s.id, s.projectId); }
      }
    }

    // Period header
    if (periodLabel && periodLabel !== 'All Time') {
      lines.push(`Time Period,${csvEsc(periodLabel)}`);
      lines.push('');
    }

    // Summary section (at top)
    lines.push('SUMMARY');
    lines.push('');
    lines.push('Sessions');
    lines.push(`Total Sessions,${totals.totalSessions}`);
    lines.push(`Active Sessions,${totals.activeSessions}`);
    lines.push(`Ended Sessions,${totals.endedSessions}`);
    lines.push(`Total Session Time,${totals.totalSessionTime}`);

    // Per-project session breakdown
    if (hasProjects) {
      lines.push('');
      lines.push('Sessions by Project');
      const projectGroups = [...projects!, null];
      for (const project of projectGroups) {
        const projId = project?.id;
        const projName = project?.name || 'Unassigned';
        const projSessions = data.sessions.filter((s) => {
          return projId ? s.projectId === projId : !s.projectId;
        });
        if (projSessions.length === 0) { continue; }
        const projSessionTime = projSessions.reduce((sum, s) => {
          const dur = Math.max(0, ((s.endedAt ? new Date(s.endedAt).getTime() : Date.now()) - new Date(s.startedAt).getTime()) - (s.totalPausedMs || 0));
          return sum + dur;
        }, 0);
        const projTasks = data.tasks.filter((t) => projSessions.some((s) => s.id === t.sessionId));
        lines.push(`${csvEsc(projName)},${projSessions.length} sessions,${projTasks.length} tasks,${this.formatDuration(projSessionTime)}`);
      }
    }

    lines.push('');
    lines.push('Tasks');
    lines.push(`Total Tasks,${totals.totalTasks}`);
    lines.push(`Completed,${totals.byStatus['completed'] || 0}`);
    lines.push(`In Progress,${totals.byStatus['in-progress'] || 0}`);
    lines.push(`Up Next,${totals.byStatus['up-next'] || 0}`);
    lines.push(`Backlog,${totals.byStatus['backlog'] || 0}`);
    lines.push(`Notes,${totals.byStatus['notes'] || 0}`);
    lines.push(`Carried Over,${totals.carriedOverCount}`);
    lines.push('');
    lines.push('By Tag');
    lines.push(`Features,${totals.byTag['feature'] || 0}`);
    lines.push(`Bugs,${totals.byTag['bug'] || 0}`);
    lines.push(`Refactors,${totals.byTag['refactor'] || 0}`);
    lines.push(`Notes,${totals.byTag['note'] || 0}`);
    lines.push(`Plans,${totals.byTag['plan'] || 0}`);
    lines.push(`Todos,${totals.byTag['todo'] || 0}`);
    lines.push('');
    lines.push('By Priority');
    lines.push(`High,${totals.byPriority['high'] || 0}`);
    lines.push(`Medium,${totals.byPriority['medium'] || 0}`);
    lines.push(`Low,${totals.byPriority['low'] || 0}`);
    lines.push('');
    lines.push('Performance');
    lines.push(`Completion Rate,${totals.completionRate}%`);
    lines.push(`Carry-over Rate,${totals.carryOverRate}%`);
    lines.push(`Avg Session Duration,${totals.avgSessionDuration}`);
    lines.push(`Tasks Completed per Session,${totals.tasksPerSession}`);
    lines.push(`Avg Task Turnaround,${totals.avgTurnaround}`);
    lines.push(`Longest Session,${totals.longestSession}`);
    lines.push(`Most Productive Session,${totals.mostProductive}`);

    // Tasks grouped by tag
    const tagOrder: Array<{ tag: string; label: string }> = [
      { tag: 'feature', label: 'FEATURES' },
      { tag: 'bug', label: 'BUGS' },
      { tag: 'refactor', label: 'REFACTORS' },
      { tag: 'note', label: 'NOTES' },
      { tag: 'plan', label: 'PLANS' },
      { tag: 'todo', label: 'TODOS' },
    ];

    const csvTaskRow = (task: VBTask) => {
      const session = data.sessions.find((s) => s.id === task.sessionId);
      const sessionName = session?.name || '';
      const sessionDate = session ? new Date(session.startedAt).toLocaleDateString() : '';
      const sessionDur = session ? this.formatDuration(
        Math.max(0, ((session.endedAt ? new Date(session.endedAt).getTime() : Date.now()) - new Date(session.startedAt).getTime()) - (session.totalPausedMs || 0))
      ) : '';
      const board = data.boards?.find((b) => b.id === task.boardId);
      const boardName = board?.name || task.boardId;
      const carriedOver = task.carriedFromSessionId ? 'Yes' : 'No';
      return [
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
      ].join(',');
    };

    const csvTaskHeader = 'Session,Session Date,Session Duration,Task Title,Description,Priority,Status,Board,Carried Over,Created,Completed';

    if (hasProjects) {
      // Group by project, then by tag within each project
      const projectGroups = [...projects!, null]; // null = unassigned tasks
      for (const project of projectGroups) {
        const projId = project?.id;
        const projName = project?.name || 'Unassigned';
        const projSessions = data.sessions.filter((s) => {
          return projId ? s.projectId === projId : !s.projectId;
        });
        const projTasks = data.tasks.filter((t) => {
          const taskProjId = sessionProjectMap.get(t.sessionId);
          return projId ? taskProjId === projId : !taskProjId;
        });
        // Show project if it has sessions or tasks
        if (projSessions.length === 0 && projTasks.length === 0) { continue; }

        lines.push('');
        lines.push(`PROJECT: ${projName}`);

        // List sessions for this project
        if (projSessions.length > 0) {
          lines.push('');
          lines.push('  SESSIONS');
          lines.push('Session,Date,Duration,Tasks,Completed,Carried Over');
          for (const s of projSessions) {
            const date = new Date(s.startedAt).toLocaleDateString();
            const dur = this.formatDuration(Math.max(0, ((s.endedAt ? new Date(s.endedAt).getTime() : Date.now()) - new Date(s.startedAt).getTime()) - (s.totalPausedMs || 0)));
            const sTasks = data.tasks.filter((t) => t.sessionId === s.id);
            const sCompleted = sTasks.filter((t) => t.status === 'completed').length;
            const sCarried = sTasks.filter((t) => t.carriedFromSessionId).length;
            lines.push(`${csvEsc(s.name)},${date},${dur},${sTasks.length},${sCompleted},${sCarried}`);
          }
        }

        if (projTasks.length > 0) {
          for (const { tag, label } of tagOrder) {
            const tagTasks = projTasks.filter((t) => t.tag === tag);
            if (tagTasks.length === 0) { continue; }
            lines.push('');
            lines.push(`  ${label}`);
            lines.push(csvTaskHeader);
            for (const task of tagTasks) {
              lines.push(csvTaskRow(task));
            }
          }
        } else {
          lines.push('');
          lines.push('  No tasks');
        }
      }
    } else {
      // No projects — flat tag grouping (original behavior)
      for (const { tag, label } of tagOrder) {
        const tagTasks = data.tasks.filter((t) => t.tag === tag);
        if (tagTasks.length === 0) { continue; }
        lines.push('');
        lines.push(label);
        lines.push(csvTaskHeader);
        for (const task of tagTasks) {
          lines.push(csvTaskRow(task));
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Generate a Markdown document from session/task data.
   */
  private generateMarkdown(
    data: ReturnType<StorageProvider['getData']>,
    history: ReturnType<SessionManager['getSessionHistory']>,
    totals: ReturnType<MessageHandler['computeExportTotals']>,
    periodLabel?: string,
    projects?: VBProject[]
  ): string {
    const lines: string[] = [];
    lines.push('# Build Board Export');

    // Build project lookup for session → project mapping
    const hasProjects = projects && projects.length > 0;
    const sessionProjectMap = new Map<string, string>();
    if (hasProjects) {
      for (const s of data.sessions) {
        if (s.projectId) { sessionProjectMap.set(s.id, s.projectId); }
      }
    }

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

    // Per-project breakdown in summary
    if (hasProjects) {
      lines.push('### By Project');
      lines.push('');
      lines.push('| Project | Sessions | Tasks | Session Time | Copilot Context |');
      lines.push('|---------|----------|-------|-------------|-----------------|');
      const projectGroups = [...projects!, null];
      for (const project of projectGroups) {
        const projId = project?.id;
        const projName = project?.name || 'Unassigned';
        const projSessions = data.sessions.filter((s) => projId ? s.projectId === projId : !s.projectId);
        if (projSessions.length === 0) { continue; }
        const projSessionTime = projSessions.reduce((sum, s) => {
          const dur = Math.max(0, ((s.endedAt ? new Date(s.endedAt).getTime() : Date.now()) - new Date(s.startedAt).getTime()) - (s.totalPausedMs || 0));
          return sum + dur;
        }, 0);
        const projTasks = data.tasks.filter((t) => projSessions.some((s) => s.id === t.sessionId));
        const projContext = project?.copilotContext ? project.copilotContext.replace(/[\r\n]+/g, ' ').slice(0, 80) : '';
        lines.push(`| ${projName} | ${projSessions.length} | ${projTasks.length} | ${this.formatDuration(projSessionTime)} | ${projContext} |`);
      }
      lines.push('');
    }

    lines.push('**By Tag:** ');
    lines.push(`Feature: ${totals.byTag['feature'] || 0} · Bug: ${totals.byTag['bug'] || 0} · Refactor: ${totals.byTag['refactor'] || 0} · Note: ${totals.byTag['note'] || 0} · Plan: ${totals.byTag['plan'] || 0} · Todo: ${totals.byTag['todo'] || 0}`);
    lines.push('');
    lines.push('**By Priority:** ');
    lines.push(`High: ${totals.byPriority['high'] || 0} · Medium: ${totals.byPriority['medium'] || 0} · Low: ${totals.byPriority['low'] || 0}`);
    lines.push('');
    lines.push('## Performance');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Completion Rate | ${totals.completionRate}% |`);
    lines.push(`| Carry-over Rate | ${totals.carryOverRate}% |`);
    lines.push(`| Avg Session Duration | ${totals.avgSessionDuration} |`);
    lines.push(`| Tasks Completed per Session | ${totals.tasksPerSession} |`);
    lines.push(`| Avg Task Turnaround | ${totals.avgTurnaround} |`);
    lines.push(`| Longest Session | ${totals.longestSession} |`);
    lines.push(`| Most Productive Session | ${totals.mostProductive} |`);
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

    // Build project lookup for session → project mapping
    // (hasProjects and sessionProjectMap declared at top of function)

    // Session history
    if (history.sessions.length > 0) {
      lines.push('## Session History');
      lines.push('');

      if (hasProjects) {
        // Group sessions by project
        const projectGroups = [...projects, null];
        for (const project of projectGroups) {
          const projId = project?.id;
          const projName = project?.name || 'Unassigned';
          const projSessions = history.sessions.filter((s) => {
            const sProjId = (s as any).projectId;
            return projId ? sProjId === projId : !sProjId;
          });
          if (projSessions.length === 0) { continue; }

          lines.push(`### ${projName}`);
          lines.push('');
          lines.push('| # | Date | Name | Duration | Tasks | Completed | Carried Over |');
          lines.push('|---|------|------|----------|-------|-----------|-------------|');
          for (let i = 0; i < projSessions.length; i++) {
            const s = projSessions[i];
            const origIdx = history.sessions.indexOf(s);
            const sum = history.summaries[origIdx];
            const date = new Date(s.startedAt).toLocaleDateString();
            const dur = this.formatDuration(sum.duration);
            const totalTasks = data.tasks.filter((t) => t.sessionId === s.id).length;
            lines.push(`| ${i + 1} | ${date} | ${s.name} | ${dur} | ${totalTasks} | ${sum.tasksCompleted} | ${sum.tasksCarriedOver} |`);
          }
          lines.push('');
        }
      } else {
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
    }

    // All tasks grouped by tag
    const tagGroups: Array<{ tag: string; label: string }> = [
      { tag: 'feature', label: 'Features' },
      { tag: 'bug', label: 'Bugs' },
      { tag: 'refactor', label: 'Refactors' },
      { tag: 'note', label: 'Notes' },
      { tag: 'plan', label: 'Plans' },
      { tag: 'todo', label: 'Todos' },
    ];

    const renderTaskLine = (t: VBTask) => {
      const check = t.status === 'completed' ? '[x]' : '[ ]';
      const prio = t.priority ? ` \`${t.priority}\`` : '';
      const statusLbl = t.status === 'completed' ? '' : ` \`${t.status}\``;
      const time = t.timeSpentMs ? ` (${this.formatDuration(t.timeSpentMs)})` : '';
      const when = t.completedAt ? ` — ${new Date(t.completedAt).toLocaleDateString()}` : '';
      const carried = t.carriedFromSessionId ? ' ↺' : '';
      const session = data.sessions.find((s) => s.id === t.sessionId);
      const sessionInfo = session ? ` [${session.name}]` : '';
      lines.push(`- ${check} **${t.title}**${prio}${statusLbl}${time}${carried}${when}${sessionInfo}`);
      if (t.description) {
        for (const descLine of t.description.split('\n')) {
          lines.push(`  ${descLine}`);
        }
      }
    };

    const sortTasks = (tasks: VBTask[]) => tasks.sort((a, b) => {
      if (a.status === 'completed' && b.status !== 'completed') { return -1; }
      if (a.status !== 'completed' && b.status === 'completed') { return 1; }
      if (a.status === 'completed' && b.status === 'completed') {
        return new Date(b.completedAt ?? b.createdAt).getTime() - new Date(a.completedAt ?? a.createdAt).getTime();
      }
      return a.order - b.order;
    });

    if (hasProjects) {
      // Group by project, then by tag within each project
      lines.push('## Tasks by Project');
      lines.push('');

      const projectGroups = [...projects!, null];
      for (const project of projectGroups) {
        const projId = project?.id;
        const projName = project?.name || 'Unassigned';
        const projSessions = data.sessions.filter((s) => projId ? s.projectId === projId : !s.projectId);
        const projTasks = data.tasks.filter((t) => {
          const taskProjId = sessionProjectMap.get(t.sessionId);
          return projId ? taskProjId === projId : !taskProjId;
        });
        // Show project if it has sessions or tasks
        if (projSessions.length === 0 && projTasks.length === 0) { continue; }

        const projCompleted = projTasks.filter((t) => t.status === 'completed').length;
        lines.push(`### ${projName} (${projSessions.length} sessions, ${projTasks.length} tasks, ${projCompleted} completed)`);
        if (project?.copilotContext) {
          lines.push(`*Project Context: ${project.copilotContext.replace(/[\r\n]+/g, ' ')}*`);
        }
        lines.push('');

        if (projTasks.length > 0) {
          for (const { tag, label } of tagGroups) {
            const tasks = sortTasks(projTasks.filter((t) => t.tag === tag));
            if (tasks.length === 0) { continue; }
            const completedCount = tasks.filter((t) => t.status === 'completed').length;
            lines.push(`#### ${label} (${tasks.length} total, ${completedCount} completed)`);
            lines.push('');
            for (const t of tasks) { renderTaskLine(t); }
            lines.push('');
          }
        } else {
          lines.push('*No tasks*');
          lines.push('');
        }
      }
    } else {
      // No projects — flat tag grouping (original behavior)
      for (const { tag, label } of tagGroups) {
        const tasks = sortTasks(data.tasks.filter((t) => t.tag === tag));
        if (tasks.length === 0) { continue; }
        const completedCount = tasks.filter((t) => t.status === 'completed').length;
        lines.push(`## ${label} (${tasks.length} total, ${completedCount} completed)`);
        lines.push('');
        for (const t of tasks) { renderTaskLine(t); }
        lines.push('');
      }
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
