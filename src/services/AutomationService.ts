/**
 * Vibe Board - Automation Service
 * Orchestrates the hybrid task automation loop:
 *   1. Send task to Copilot Chat
 *   2. Monitor file changes (file system watcher + debounce)
 *   3. Capture git diff
 *   4. Verify completion via LM API
 *   5. Pause at checkpoint for user approval
 *   6. Advance to next task or finish
 */

import * as vscode from 'vscode';
import {
  AutomationState,
  AutomationStepStatus,
  AutomationQueueItem,
  AutomationProgress,
  VBTask,
} from '../storage/models';
import { StorageProvider } from '../storage/StorageProvider';
import { TaskManager } from '../tasks/TaskManager';
import { CopilotAIService } from './index';
import { getGitDiff, getChangedFiles, getDiffStat } from '../utils/git';
import { MAX_RETRY_COUNT } from '../storage/models';

/** How long to wait after the last file change before capturing (ms). */
const CHANGE_DEBOUNCE_MS = 8000;

/** Maximum time to wait for changes after sending to Copilot (ms). */
const CHANGE_TIMEOUT_MS = 120_000; // 2 minutes

/** Minimum confidence to auto-approve without checkpoint (read from settings). */
function getAutoApproveThreshold(): number {
  return vscode.workspace.getConfiguration('vibeboard').get<number>('automationAutoApproveThreshold', 85);
}

export class AutomationService {
  private state: AutomationState = 'idle';
  private queue: AutomationQueueItem[] = [];
  private currentIndex = 0;
  private startedAt: string | undefined;

  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private docChangeListener: vscode.Disposable | undefined;
  private changeTimer: ReturnType<typeof setTimeout> | undefined;
  private timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  /** Callback to broadcast progress to the webview. */
  private onProgress: ((progress: AutomationProgress) => void) | undefined;

  /** Callback to send a prompt to Copilot Chat. */
  private sendToCopilot: ((prompt: string, attachments: never[], tag?: string) => Promise<void>) | undefined;

  constructor(
    private storage: StorageProvider,
    private taskManager: TaskManager,
    private aiService: CopilotAIService
  ) {}

  // ── Public API ───────────────────────────────────────────────

  /** Register the progress callback. */
  setProgressHandler(handler: (progress: AutomationProgress) => void): void {
    this.onProgress = handler;
  }

  /** Register the send-to-copilot callback (from MessageHandler). */
  setSendToCopilotHandler(handler: (prompt: string, attachments: never[], tag?: string) => Promise<void>): void {
    this.sendToCopilot = handler;
  }

  /** Start automation with the given task IDs. */
  async start(taskIds: string[]): Promise<void> {
    if (this.state !== 'idle') {
      vscode.window.showWarningMessage('Automation is already running.');
      return;
    }

    const data = this.storage.getData();
    const tasks = taskIds
      .map((id) => data.tasks.find((t) => t.id === id))
      .filter((t): t is VBTask => t !== undefined && t.status !== 'completed');

    if (tasks.length === 0) {
      vscode.window.showWarningMessage('No incomplete tasks selected for automation.');
      return;
    }

    this.queue = tasks.map((t) => ({
      taskId: t.id,
      status: 'pending' as AutomationStepStatus,
    }));
    this.currentIndex = 0;
    this.state = 'running';
    this.startedAt = new Date().toISOString();

    vscode.window.showInformationMessage(
      `Vibe Board: Automation started with ${tasks.length} task${tasks.length === 1 ? '' : 's'}.`
    );

    this.broadcastProgress();
    await this.processNext();
  }

  /** Pause automation after the current task's checkpoint. */
  pause(): void {
    if (this.state !== 'running' && this.state !== 'reviewing') { return; }
    this.cleanup(); // Clear any lingering timers
    this.state = 'paused';
    this.broadcastProgress();
    vscode.window.showInformationMessage('Vibe Board: Automation paused.');
  }

  /** Resume a paused automation run. */
  async resume(): Promise<void> {
    if (this.state !== 'paused') { return; }
    this.state = 'running';
    this.broadcastProgress();
    vscode.window.showInformationMessage('Vibe Board: Automation resumed.');
    await this.processNext();
  }

  /** Cancel the automation run entirely. */
  cancel(): void {
    this.cleanup();
    // Mark remaining pending tasks as skipped
    for (const item of this.queue) {
      if (item.status === 'pending' || item.status === 'sending' || item.status === 'waiting') {
        item.status = 'skipped';
      }
    }
    this.state = 'idle';
    this.broadcastProgress();
    vscode.window.showInformationMessage('Vibe Board: Automation cancelled.');
  }

  /** Skip the current task and move to the next. */
  async skipCurrent(): Promise<void> {
    const current = this.queue[this.currentIndex];
    if (current) {
      current.status = 'skipped';
    }
    this.cleanup();
    this.currentIndex++;
    this.broadcastProgress();
    await this.processNext();
  }

  /** User approves the current checkpoint — mark done and advance. */
  async approveCurrent(): Promise<void> {
    const current = this.queue[this.currentIndex];
    if (!current) { return; }

    this.cleanup(); // Clear any lingering timers from waitForChanges

    current.status = 'done';
    current.completedAt = new Date().toISOString();

    // Mark task as completed in the board
    const data = this.storage.getData();
    const task = data.tasks.find((t) => t.id === current.taskId);
    if (task) {
      task.sentToCopilot = false;
    }
    this.storage.setData(data);
    this.taskManager.completeTask(current.taskId);

    this.currentIndex++;
    this.broadcastProgress();
    await this.processNext();
  }

  /** User rejects the current checkpoint — mark failed and pause. */
  rejectCurrent(): void {
    const current = this.queue[this.currentIndex];
    if (!current) { return; }

    this.cleanup(); // Clear any lingering timers from waitForChanges

    current.status = 'failed';
    current.completedAt = new Date().toISOString();
    current.result = 'Rejected by user';

    this.state = 'paused';
    this.currentIndex++;
    this.broadcastProgress();
    vscode.window.showInformationMessage('Vibe Board: Task rejected. Automation paused — resume to continue with next task.');
  }

  /** Retry a failed task by re-queuing it with an enhanced prompt. */
  async retryTask(queueIndex: number): Promise<void> {
    if (queueIndex < 0 || queueIndex >= this.queue.length) { return; }
    const item = this.queue[queueIndex];
    if (item.status !== 'failed') { return; }

    const retries = item.retryCount || 0;
    if (retries >= MAX_RETRY_COUNT) {
      vscode.window.showWarningMessage(`Vibe Board: Maximum retries (${MAX_RETRY_COUNT}) reached for this task.`);
      return;
    }

    // Reset the item for retry
    item.status = 'pending';
    item.retryCount = retries + 1;
    item.result = undefined;
    item.diffSummary = undefined;
    item.changedFiles = undefined;
    item.completedAt = undefined;
    item.startedAt = undefined;

    // Move it to just after the current position so it runs next
    this.queue.splice(queueIndex, 1);
    const insertAt = Math.min(this.currentIndex, this.queue.length);
    this.queue.splice(insertAt, 0, item);

    // If automation is paused or idle-ish from finishing, restart it
    if (this.state === 'paused' || this.state === 'idle') {
      // Adjust currentIndex to point to the retried item
      this.currentIndex = insertAt;
      this.state = 'running';
      this.broadcastProgress();
      await this.processNext();
    } else {
      this.broadcastProgress();
    }
  }

  /** Called when a task is completed outside of automation (e.g. via checkbox).
   *  If the task is the current automation target, auto-advance. */
  async notifyTaskCompleted(taskId: string): Promise<void> {
    if (this.state === 'idle') { return; }

    const current = this.queue[this.currentIndex];
    if (current && current.taskId === taskId) {
      // Current automation task was completed externally — treat as approved
      current.status = 'done';
      current.completedAt = new Date().toISOString();
      current.result = 'Completed manually';
      this.cleanup();
      this.currentIndex++;

      // If we were reviewing, switch back to running to continue
      if (this.state === 'reviewing') {
        this.state = 'running';
      }

      this.broadcastProgress();
      await this.processNext();
      return;
    }

    // Check if the task is elsewhere in the queue
    for (const item of this.queue) {
      if (item.taskId === taskId && item.status === 'pending') {
        item.status = 'done';
        item.completedAt = new Date().toISOString();
        item.result = 'Completed manually';
      }
    }

    // If all tasks in queue are now done/skipped/failed, finish
    const allResolved = this.queue.every((q) =>
      q.status === 'done' || q.status === 'skipped' || q.status === 'failed'
    );
    if (allResolved) {
      this.finish();
    } else {
      this.broadcastProgress();
    }
  }

  /** Get current progress snapshot. */
  getProgress(): AutomationProgress {
    return {
      state: this.state,
      queue: [...this.queue],
      currentIndex: this.currentIndex,
      totalTasks: this.queue.length,
      completedTasks: this.queue.filter((q) => q.status === 'done').length,
      startedAt: this.startedAt,
    };
  }

  /** Whether automation is active (running or paused). */
  isActive(): boolean {
    return this.state !== 'idle';
  }

  // ── Internal Loop ────────────────────────────────────────────

  private async processNext(): Promise<void> {
    if (this.state === 'paused') { return; }

    // Check if we're done
    if (this.currentIndex >= this.queue.length) {
      this.finish();
      return;
    }

    const item = this.queue[this.currentIndex];
    const data = this.storage.getData();
    const task = data.tasks.find((t) => t.id === item.taskId);

    if (!task) {
      item.status = 'skipped';
      item.result = 'Task not found';
      this.currentIndex++;
      this.broadcastProgress();
      await this.processNext();
      return;
    }

    // Already completed outside automation
    if (task.status === 'completed') {
      item.status = 'done';
      item.result = 'Already completed';
      this.currentIndex++;
      this.broadcastProgress();
      await this.processNext();
      return;
    }

    // Step 1: Send to Copilot Chat
    item.status = 'sending';
    item.startedAt = new Date().toISOString();
    this.broadcastProgress();

    // Build prompt — include retry context if this is a retry
    let prompt = task.title;
    if (task.description) {
      prompt += '\n\n' + task.description;
    }
    if (item.retryCount && item.retryCount > 0) {
      prompt += `\n\n[RETRY ${item.retryCount}/${MAX_RETRY_COUNT}] The previous attempt was rejected. Please try a different approach or fix the issues from the last attempt.`;
    }

    // Move task to in-progress
    if (task.status !== 'in-progress') {
      this.taskManager.moveTask(task.id, 'in-progress', 0);
    }
    task.sentToCopilot = true;
    this.storage.setData(data);

    // Record baseline for change detection
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    // Send to Copilot
    if (this.sendToCopilot) {
      await this.sendToCopilot(prompt, [], task.tag);
    }

    // Step 2: Watch for file changes
    item.status = 'waiting';
    this.broadcastProgress();

    if (cwd) {
      await this.waitForChanges(cwd, item, task);
    } else {
      // No workspace — go straight to checkpoint
      item.status = 'checkpoint';
      item.result = 'No workspace folder — cannot verify changes.';
      this.state = 'reviewing';
      this.broadcastProgress();
    }
  }

  /** Wait for file changes, then verify. */
  private waitForChanges(cwd: string, item: AutomationQueueItem, task: VBTask): Promise<void> {
    return new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) { return; }
        resolved = true;
        this.disposeWatcher();
        if (this.changeTimer) { clearTimeout(this.changeTimer); this.changeTimer = undefined; }
        if (this.timeoutTimer) { clearTimeout(this.timeoutTimer); this.timeoutTimer = undefined; }
        resolve();
      };

      // Set up file watcher
      const pattern = new vscode.RelativePattern(
        vscode.workspace.workspaceFolders![0],
        '**/*'
      );
      this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

      const resetDebounce = () => {
        if (this.changeTimer) { clearTimeout(this.changeTimer); }
        this.changeTimer = setTimeout(async () => {
          // Changes settled — capture and verify
          done();
          await this.captureAndVerify(cwd, item, task);
        }, CHANGE_DEBOUNCE_MS);
      };

      // Watch on-disk file changes
      this.fileWatcher.onDidChange(() => resetDebounce());
      this.fileWatcher.onDidCreate(() => resetDebounce());
      this.fileWatcher.onDidDelete(() => resetDebounce());

      // Watch in-memory document edits (Copilot Agent uses WorkspaceEdit)
      this.docChangeListener = vscode.workspace.onDidChangeTextDocument((e) => {
        // Ignore output/debug panels, our own data file, and git internals
        const scheme = e.document.uri.scheme;
        if (scheme === 'output' || scheme === 'debug') { return; }
        const fsPath = e.document.uri.fsPath || '';
        if (fsPath.includes('.vibeboard') || fsPath.includes('.git')) { return; }
        if (e.contentChanges.length > 0) {
          resetDebounce();
        }
      });

      // Timeout: if no changes within CHANGE_TIMEOUT_MS, go to checkpoint anyway
      this.timeoutTimer = setTimeout(async () => {
        if (resolved) { return; }
        done();
        item.status = 'checkpoint';
        item.result = 'No file changes detected within timeout. Please verify manually.';
        this.state = 'reviewing';
        this.broadcastProgress();
      }, CHANGE_TIMEOUT_MS);
    });
  }

  /** Capture git diff and verify with LM API. */
  private async captureAndVerify(cwd: string, item: AutomationQueueItem, task: VBTask): Promise<void> {
    item.status = 'verifying';
    this.broadcastProgress();

    try {
      // Capture changes
      const [diff, changedFiles, diffStat] = await Promise.all([
        getGitDiff(cwd),
        getChangedFiles(cwd),
        getDiffStat(cwd),
      ]);

      item.changedFiles = changedFiles;
      item.diffSummary = diffStat;

      // If git shows nothing, also check for dirty (unsaved) documents
      if (changedFiles.length === 0) {
        const dirtyDocs = vscode.workspace.textDocuments.filter(
          (d) => d.isDirty && d.uri.scheme === 'file'
        );
        if (dirtyDocs.length > 0) {
          for (const d of dirtyDocs) {
            changedFiles.push(vscode.workspace.asRelativePath(d.uri));
          }
        }
      }

      // Also check untitled (new unsaved) documents
      const untitledDocs = vscode.workspace.textDocuments.filter(
        (d) => d.uri.scheme === 'untitled' && d.getText().trim().length > 0
      );
      for (const d of untitledDocs) {
        const name = d.uri.path || d.uri.fsPath || 'Untitled';
        if (!changedFiles.includes(name)) {
          changedFiles.push(name);
        }
      }

      if (changedFiles.length === 0) {
        item.status = 'checkpoint';
        item.result = 'No file changes detected. Verify manually.';
        this.state = 'reviewing';
        this.broadcastProgress();
        return;
      }

      // Truncate diff to avoid token limits
      const truncatedDiff = diff.length > 8000 ? diff.substring(0, 8000) + '\n... (truncated)' : diff;

      // Verify with LM API
      const verification = await this.aiService.verifyTaskCompletion(
        task.title,
        task.description,
        truncatedDiff,
        changedFiles
      );

      item.result = `${verification.explanation} (Confidence: ${verification.confidence}%)`;

      if (verification.completed && verification.confidence >= getAutoApproveThreshold()) {
        // High confidence — auto-complete
        item.status = 'done';
        item.completedAt = new Date().toISOString();

        // Mark task completed
        const data = this.storage.getData();
        const t = data.tasks.find((x) => x.id === item.taskId);
        if (t) { t.sentToCopilot = false; }
        this.storage.setData(data);
        this.taskManager.completeTask(item.taskId);

        vscode.window.showInformationMessage(
          `Vibe Board: Auto-completed "${task.title}" (${verification.confidence}% confidence).`
        );

        this.currentIndex++;
        this.broadcastProgress();

        // Check for pause before next
        if (this.state === 'paused') { return; }
        await this.processNext();
      } else {
        // Low confidence or not completed — checkpoint for user review
        item.status = 'checkpoint';
        this.state = 'reviewing';
        this.broadcastProgress();
      }
    } catch {
      item.status = 'checkpoint';
      item.result = 'Verification error — please review manually.';
      this.state = 'reviewing';
      this.broadcastProgress();
    }
  }

  /** Automation run complete. */
  private finish(): void {
    this.cleanup();
    const completed = this.queue.filter((q) => q.status === 'done').length;
    const failed = this.queue.filter((q) => q.status === 'failed').length;
    const skipped = this.queue.filter((q) => q.status === 'skipped').length;

    this.state = 'idle';
    this.broadcastProgress();

    vscode.window.showInformationMessage(
      `Vibe Board: Automation complete! ${completed} done, ${failed} failed, ${skipped} skipped.`
    );
  }

  /** Clean up watchers and timers. */
  private cleanup(): void {
    this.disposeWatcher();
    if (this.changeTimer) { clearTimeout(this.changeTimer); this.changeTimer = undefined; }
    if (this.timeoutTimer) { clearTimeout(this.timeoutTimer); this.timeoutTimer = undefined; }
  }

  private disposeWatcher(): void {
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
      this.fileWatcher = undefined;
    }
    if (this.docChangeListener) {
      this.docChangeListener.dispose();
      this.docChangeListener = undefined;
    }
  }

  /** Broadcast current progress to the webview. */
  private broadcastProgress(): void {
    if (this.onProgress) {
      this.onProgress(this.getProgress());
    }
  }
}
