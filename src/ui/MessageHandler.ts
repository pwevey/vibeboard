import * as vscode from 'vscode';
import { WebviewToExtensionMessage, TASK_TEMPLATES } from '../storage/models';
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
  handleMessage(message: WebviewToExtensionMessage): void {
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

      case 'completeTask':
        this.taskManager.completeTask(message.payload.id);
        this.sendStateUpdate();
        break;

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
        const board = { id: generateId(), name: message.payload.name, createdAt: new Date().toISOString() };
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

        // Remove selected boards and their tasks
        for (const boardId of boardIds) {
          if (data.boards) {
            data.boards = data.boards.filter((b) => b.id !== boardId);
          }
          // Remove tasks belonging to this board (treat missing boardId as 'default')
          data.tasks = data.tasks.filter((t) => {
            const taskBoard = t.boardId || 'default';
            return taskBoard !== boardId;
          });
        }

        // If no boards remain, end the session entirely
        if (!data.boards || data.boards.length === 0) {
          const summary = data.activeSessionId
            ? this.sessionManager.endSession()
            : null;
          this.sendStateUpdate();
          if (summary) {
            const duration = this.formatDuration(summary.duration);
            vscode.window.showInformationMessage(
              `Session ended! Duration: ${duration} | Tasks completed: ${summary.tasksCompleted}`
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

      case 'startSession': {
        const projectPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const config = vscode.workspace.getConfiguration('vibeboard');
        const carryOver = config.get<boolean>('carryOverTasks', true);
        const sessionName = (message.payload as { name?: string }).name;

        // Find the most recently ended session to carry over tasks from
        const data = this.storage.getData();
        const lastEnded = data.sessions
          .filter((s) => s.status === 'ended')
          .sort((a, b) => new Date(b.endedAt!).getTime() - new Date(a.endedAt!).getTime())[0];

        const newSession = this.sessionManager.startSession(projectPath, sessionName);

        // Ensure at least one board exists, named after the session
        {
          const updatedData = this.storage.getData();
          if (!updatedData.boards || updatedData.boards.length === 0) {
            const boardName = sessionName || 'Main Board';
            updatedData.boards = [{ id: 'default', name: boardName, createdAt: new Date().toISOString() }];
            updatedData.activeBoardId = 'default';
            this.storage.setData(updatedData);
          }
        }

        if (carryOver && lastEnded) {
          const carried = this.taskManager.carryOverTasks(lastEnded.id, newSession.id);
          if (carried > 0) {
            vscode.window.showInformationMessage(
              `Vibe Board: Session started! ${carried} tasks carried over.`
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
        this.exportData(message.payload.format);
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
   * Export workspace data to a file (JSON, CSV, or Markdown).
   */
  private async exportData(format: 'json' | 'csv' | 'markdown'): Promise<void> {
    const data = this.storage.getData();
    const history = this.sessionManager.getSessionHistory();
    let content: string;
    let defaultName: string;
    let filterLabel: string;
    let ext: string;

    // Use local date for filename (toISOString gives UTC which can be the wrong day)
    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    if (format === 'json') {
      const exportObj = {
        exportedAt: new Date().toISOString(),
        sessions: history.sessions.map((s, i) => ({
          ...s,
          summary: history.summaries[i],
        })),
        tasks: data.tasks,
      };
      content = JSON.stringify(exportObj, null, 2);
      ext = 'json';
      defaultName = `vibeboard-export-${localDate}.json`;
      filterLabel = 'JSON';
    } else if (format === 'csv') {
      const lines = ['Session Date,Session Duration,Task Title,Description,Tag,Priority,Status,Time Spent,Created,Completed'];
      for (const task of data.tasks) {
        const session = data.sessions.find((s) => s.id === task.sessionId);
        const sessionDate = session ? new Date(session.startedAt).toLocaleDateString() : '';
        const sessionDur = session ? this.formatDuration(
          (session.endedAt ? new Date(session.endedAt).getTime() : Date.now()) - new Date(session.startedAt).getTime()
        ) : '';
        const csvEsc = (s: string) => `"${s.replace(/"/g, '""')}"`;
        const timeSpent = this.formatDuration(task.timeSpentMs || 0);
        lines.push([
          sessionDate,
          sessionDur,
          csvEsc(task.title),
          csvEsc(task.description),
          task.tag,
          task.priority || 'medium',
          task.status,
          timeSpent,
          new Date(task.createdAt).toLocaleString(),
          task.completedAt ? new Date(task.completedAt).toLocaleString() : '',
        ].join(','));
      }
      content = lines.join('\n');
      ext = 'csv';
      defaultName = `vibeboard-export-${localDate}.csv`;
      filterLabel = 'CSV';
    } else {
      // Markdown export
      content = this.generateMarkdown(data, history);
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
   * Generate a Markdown document from session/task data.
   */
  private generateMarkdown(
    data: ReturnType<StorageProvider['getData']>,
    history: ReturnType<SessionManager['getSessionHistory']>
  ): string {
    const lines: string[] = [];
    lines.push('# Vibe Board Export');
    lines.push('');
    lines.push(`*Exported: ${new Date().toLocaleString()}*`);
    lines.push('');

    // Current session tasks
    if (data.activeSessionId) {
      const session = data.sessions.find((s) => s.id === data.activeSessionId);
      if (session) {
        lines.push('## Active Session');
        lines.push('');
        lines.push(`Started: ${new Date(session.startedAt).toLocaleString()}`);
        lines.push('');

        for (const col of ['up-next', 'backlog', 'completed', 'notes']) {
          const colTasks = data.tasks
            .filter((t) => t.sessionId === data.activeSessionId && t.status === col)
            .sort((a, b) => a.order - b.order);
          if (colTasks.length > 0) {
            const label = col === 'up-next' ? 'Up Next' : col === 'backlog' ? 'Backlog' : col === 'completed' ? 'Completed' : 'Notes';
            lines.push(`### ${label}`);
            lines.push('');
            for (const t of colTasks) {
              const check = t.status === 'completed' ? '[x]' : '[ ]';
              const prio = t.priority ? ` \`${t.priority}\`` : '';
              const tag = ` \`${t.tag}\``;
              const time = t.timeSpentMs ? ` (${this.formatDuration(t.timeSpentMs)})` : '';
              lines.push(`- ${check} **${t.title}**${prio}${tag}${time}`);
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
      lines.push('| Date | Duration | Completed | Carried Over |');
      lines.push('|------|----------|-----------|-------------|');
      for (let i = 0; i < history.sessions.length; i++) {
        const s = history.sessions[i];
        const sum = history.summaries[i];
        const date = new Date(s.startedAt).toLocaleDateString();
        const dur = this.formatDuration(sum.duration);
        lines.push(`| ${date} | ${dur} | ${sum.tasksCompleted} | ${sum.tasksCarriedOver} |`);
      }
      lines.push('');
    }

    // All completed tasks
    const completed = data.tasks
      .filter((t) => t.status === 'completed')
      .sort((a, b) => new Date(b.completedAt ?? b.createdAt).getTime() - new Date(a.completedAt ?? a.createdAt).getTime());

    if (completed.length > 0) {
      lines.push('## All Completed Tasks');
      lines.push('');
      for (const t of completed) {
        const when = t.completedAt ? new Date(t.completedAt).toLocaleDateString() : '';
        const time = t.timeSpentMs ? ` (${this.formatDuration(t.timeSpentMs)})` : '';
        lines.push(`- [x] **${t.title}** \`${t.tag}\`${time} — ${when}`);
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
