/**
 * Build Board - Automation Service
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
import { getGitDiff, getChangedFiles, getDiffStat, getCurrentBranch, createAndCheckoutBranch, checkoutBranch, mergeBranch, deleteBranch, commitAll, stashChanges, stashPop, slugifyForBranch } from '../utils/git';
import { MAX_RETRY_COUNT } from '../storage/models';

/** How long to wait after the last file change before capturing (ms). */
const CHANGE_DEBOUNCE_MS = 8000;

/** Maximum time to wait for the first file change after sending to Copilot (ms).
 *  If no workspace file changes are detected within this period, we assume
 *  Copilot responded without making edits and move straight to checkpoint.
 *  Configurable via buildboard.automationNoActivityTimeout (seconds). */
function getNoActivityTimeoutMs(): number {
  const seconds = vscode.workspace.getConfiguration('buildboard').get<number>('automationNoActivityTimeout', 30);
  return seconds * 1000;
}

/** Absolute maximum time to wait for changes after the first change is detected (ms).
 *  This covers cases where Copilot agent makes slow, incremental edits. */
const CHANGE_TIMEOUT_MS = 90_000; // 90 seconds

/** Minimum confidence to auto-approve without checkpoint (read from settings). */
function getAutoApproveThreshold(): number {
  return vscode.workspace.getConfiguration('buildboard').get<number>('automationAutoApproveThreshold', 85);
}

/** Whether per-task git branching is enabled (read from settings). */
function isBranchingEnabled(): boolean {
  return vscode.workspace.getConfiguration('buildboard').get<boolean>('automationBranching', false);
}

export class AutomationService {
  private state: AutomationState = 'idle';
  private queue: AutomationQueueItem[] = [];
  private currentIndex = 0;
  private startedAt: string | undefined;
  /** Monotonic counter incremented on each start/cancel to invalidate stale async flows. */
  private runId = 0;
  /** The branch the user was on when automation started (used to return after branching). */
  private baseBranch: string | undefined;

  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private docChangeListener: vscode.Disposable | undefined;
  private changeTimer: ReturnType<typeof setTimeout> | undefined;
  private timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  /** Resolver to cancel waitForChanges from outside (e.g. skip/cancel). */
  private cancelWait: (() => void) | undefined;

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
    this.runId++;

    // Capture the current branch so we can return to it after branching operations
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (cwd && isBranchingEnabled()) {
      try {
        this.baseBranch = await getCurrentBranch(cwd);
      } catch {
        this.baseBranch = undefined;
      }
    }

    vscode.window.showInformationMessage(
      `Build Board: Automation started with ${tasks.length} task${tasks.length === 1 ? '' : 's'}.`
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
    vscode.window.showInformationMessage('Build Board: Automation paused.');
  }

  /** Resume a paused automation run. */
  async resume(): Promise<void> {
    if (this.state !== 'paused') { return; }
    this.state = 'running';
    this.broadcastProgress();
    vscode.window.showInformationMessage('Build Board: Automation resumed.');

    // If paused mid-task while waiting for changes, restart the file watch
    // instead of re-sending the task to Copilot
    const current = this.queue[this.currentIndex];
    if (current && current.status === 'waiting') {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const data = this.storage.getData();
      const task = data.tasks.find((t) => t.id === current.taskId);
      if (cwd && task) {
        await this.waitForChanges(cwd, current, task, this.runId);
        return;
      }
    }

    await this.processNext();
  }

  /** Cancel the automation run entirely. */
  async cancel(): Promise<void> {
    this.runId++;
    this.cleanup();

    // If branching is enabled, return to the base branch and clean up task branches
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (cwd && this.baseBranch && isBranchingEnabled()) {
      try {
        await checkoutBranch(cwd, this.baseBranch);
        // Delete all task branches that weren't merged
        for (const item of this.queue) {
          if (item.branchName && item.status !== 'done') {
            await deleteBranch(cwd, item.branchName);
          }
        }
      } catch {
        // Best-effort cleanup
      }
    }

    // Mark remaining pending tasks as skipped
    for (const item of this.queue) {
      if (item.status === 'pending' || item.status === 'sending' || item.status === 'waiting') {
        item.status = 'skipped';
      }
    }
    this.state = 'idle';
    this.broadcastProgress();
    vscode.window.showInformationMessage('Build Board: Automation cancelled.');
  }

  /** Skip the current task and move to the next. */
  async skipCurrent(): Promise<void> {
    const current = this.queue[this.currentIndex];
    if (!current) { return; }

    // Guard: only skip if in an active processing state
    if (current.status !== 'sending' && current.status !== 'waiting' &&
        current.status !== 'verifying' && current.status !== 'checkpoint') {
      return;
    }

    // If branching is enabled, return to base and delete the task branch
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (cwd && current.branchName && this.baseBranch && isBranchingEnabled()) {
      try {
        await checkoutBranch(cwd, this.baseBranch);
        await deleteBranch(cwd, current.branchName);
        current.branchName = undefined;
      } catch {
        // Best-effort cleanup
      }
    }

    current.status = 'skipped';
    this.cleanup();
    this.currentIndex++;
    this.broadcastProgress();
    await this.processNext();
  }

  /** Skip a specific queued (future) task by index without affecting the current task.
   *  Also allows skipping the task at currentIndex if automation is paused (hasn't started yet). */
  skipQueued(index: number): void {
    const item = this.queue[index];
    if (!item) { return; }
    // Allow skipping current-index item only when paused (it hasn't started processing)
    if (index < this.currentIndex) { return; }
    if (index === this.currentIndex && this.state !== 'paused') { return; }
    if (item.status !== 'pending') { return; }
    item.status = 'skipped';
    // If we skipped the current item while paused, advance the pointer
    if (index === this.currentIndex) {
      this.currentIndex++;
    }
    this.broadcastProgress();
  }

  /** User approves the current checkpoint — mark done and advance. */
  async approveCurrent(): Promise<void> {
    const current = this.queue[this.currentIndex];
    if (!current) { return; }

    this.cleanup(); // Clear any lingering timers from waitForChanges

    // If branching is enabled, commit changes on the task branch, then merge into base
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (cwd && current.branchName && this.baseBranch && isBranchingEnabled()) {
      try {
        const data2 = this.storage.getData();
        const t2 = data2.tasks.find((t) => t.id === current.taskId);
        const commitMsg = t2 ? `feat: ${t2.title}` : `feat: automation task`;
        await commitAll(cwd, commitMsg);
        await checkoutBranch(cwd, this.baseBranch);
        await mergeBranch(cwd, current.branchName);
        await deleteBranch(cwd, current.branchName);
      } catch (err) {
        vscode.window.showWarningMessage(`Build Board: Branch merge failed — ${err instanceof Error ? err.message : 'unknown error'}. Changes remain on branch "${current.branchName}".`);
      }
    }

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
  async rejectCurrent(): Promise<void> {
    const current = this.queue[this.currentIndex];
    if (!current) { return; }

    this.cleanup(); // Clear any lingering timers from waitForChanges

    // If branching is enabled, discard the task branch and return to base
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (cwd && current.branchName && this.baseBranch && isBranchingEnabled()) {
      try {
        await checkoutBranch(cwd, this.baseBranch);
        await deleteBranch(cwd, current.branchName);
        current.branchName = undefined;
      } catch {
        // Best-effort cleanup
      }
    }

    current.status = 'failed';
    current.completedAt = new Date().toISOString();
    current.result = 'Rejected by user';

    // Don't advance currentIndex — keep the play arrow on the rejected task
    // so the user can see they can retry it. processNext() will skip over it.

    // If all remaining tasks are resolved, finish instead of pausing
    const allResolved = this.queue.every((q) =>
      q.status === 'done' || q.status === 'skipped' || q.status === 'failed'
    );
    if (allResolved) {
      this.runId++;
      await this.finish();
    } else {
      this.state = 'paused';
      this.broadcastProgress();
      vscode.window.showInformationMessage('Build Board: Task rejected. Automation paused — resume to continue with next task.');
    }
  }

  /** User sends revision feedback — stay on same task/branch, send feedback to Copilot. */
  async reviseCurrent(feedback: string): Promise<void> {
    const current = this.queue[this.currentIndex];
    if (!current) { return; }

    // Only allow revise from reviewing or waiting states
    if (this.state !== 'reviewing' && !(this.state === 'running' && current.status === 'waiting')) {
      return;
    }

    this.cleanup(); // Clear any lingering timers

    const data = this.storage.getData();
    const task = data.tasks.find((t) => t.id === current.taskId);
    if (!task) { return; }

    // Stay on the same branch — just re-send with feedback
    current.status = 'sending';
    this.state = 'running';
    this.broadcastProgress();

    const myRunId = this.runId;
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    // Build a revision prompt that includes context and feedback
    let prompt = `[REVISION] The previous changes for "${task.title}" need adjustments.\n\n`;
    prompt += `Feedback: ${feedback}`;
    if (task.description) {
      prompt += `\n\nOriginal task description:\n${task.description}`;
    }

    // Send revision to Copilot
    if (this.sendToCopilot) {
      await this.sendToCopilot(prompt, [], task.tag);
    }

    // Guard: if this run was superseded while awaiting sendToCopilot, bail out
    if (this.runId !== myRunId) { return; }

    // Guard: if paused while awaiting sendToCopilot, mark as waiting and bail
    if (this.state === 'paused') {
      current.status = 'waiting';
      this.broadcastProgress();
      return;
    }

    // Watch for new changes from Copilot's revision
    current.status = 'waiting';
    this.broadcastProgress();

    if (cwd) {
      await this.waitForChanges(cwd, current, task, myRunId);
    } else {
      current.status = 'checkpoint';
      current.result = 'No workspace folder — cannot verify changes.';
      this.state = 'reviewing';
      this.broadcastProgress();
    }
  }

  /** Retry a failed task by re-queuing it with an enhanced prompt. */
  async retryTask(queueIndex: number): Promise<void> {
    if (queueIndex < 0 || queueIndex >= this.queue.length) { return; }
    const item = this.queue[queueIndex];
    if (item.status !== 'failed') { return; }

    const retries = item.retryCount || 0;
    if (retries >= MAX_RETRY_COUNT) {
      vscode.window.showWarningMessage(`Build Board: Maximum retries (${MAX_RETRY_COUNT}) reached for this task.`);
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

    // If branching is enabled, delete the old task branch so a fresh one is created
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (cwd && item.branchName && this.baseBranch && isBranchingEnabled()) {
      try {
        await checkoutBranch(cwd, this.baseBranch);
        await deleteBranch(cwd, item.branchName);
        item.branchName = undefined;
      } catch {
        // Best-effort cleanup
      }
    }

    // Remove it from its current position
    this.queue.splice(queueIndex, 1);

    // Adjust currentIndex if the removed item was before it
    if (queueIndex < this.currentIndex) {
      this.currentIndex--;
    }

    // Insert right at currentIndex so it's the next task to process
    this.queue.splice(this.currentIndex, 0, item);

    // If automation is paused or idle from finishing, restart processing
    if (this.state === 'paused' || this.state === 'idle') {
      this.state = 'running';
      this.broadcastProgress();
      await this.processNext();
    } else if (this.state === 'reviewing') {
      // If at a checkpoint for another task, just update the queue — this retry
      // will be picked up when the user approves/rejects the current checkpoint
      this.broadcastProgress();
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
      await this.finish();
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
    const myRunId = this.runId;

    // Check if we're done
    if (this.currentIndex >= this.queue.length) {
      await this.finish();
      return;
    }

    const item = this.queue[this.currentIndex];

    // Skip items that were pre-skipped or previously failed/rejected
    if (item.status === 'skipped' || item.status === 'failed') {
      this.currentIndex++;
      this.broadcastProgress();
      await this.processNext();
      return;
    }

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

    // Prepend context instructions (project-level then task-level)
    const contextParts: string[] = [];
    if (data.projects && data.sessions) {
      const session = data.sessions.find((s) => s.id === task.sessionId);
      const project = session?.projectId ? data.projects.find((p) => p.id === session.projectId) : null;
      if (project?.copilotContext?.trim() && project.copilotContextEnabled !== false) {
        contextParts.push(`[Project Context]\n${project.copilotContext.trim()}`);
      }
    }
    if (contextParts.length > 0) {
      prompt = contextParts.join('\n\n') + '\n\n' + prompt;
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

    // If branching is enabled, create and switch to a per-task branch
    if (cwd && this.baseBranch && isBranchingEnabled()) {
      try {
        // Ensure we're on the base branch before creating the task branch
        await checkoutBranch(cwd, this.baseBranch);
        const branchName = slugifyForBranch(task.tag, task.title);
        await createAndCheckoutBranch(cwd, branchName);
        item.branchName = branchName;
      } catch (err) {
        vscode.window.showWarningMessage(`Build Board: Failed to create branch — ${err instanceof Error ? err.message : 'unknown error'}. Continuing without branching.`);
      }
    }

    // Send to Copilot
    if (this.sendToCopilot) {
      await this.sendToCopilot(prompt, [], task.tag);
    }

    // Guard: if this run was superseded while awaiting sendToCopilot, bail out
    if (this.runId !== myRunId) { return; }

    // Guard: if paused while awaiting sendToCopilot, mark as waiting and bail
    // — resume() will restart the file watch
    if (this.state === 'paused') {
      item.status = 'waiting';
      this.broadcastProgress();
      return;
    }

    // Step 2: Watch for file changes
    item.status = 'waiting';
    this.broadcastProgress();

    if (cwd) {
      await this.waitForChanges(cwd, item, task, myRunId);
    } else {
      // No workspace — go straight to checkpoint
      item.status = 'checkpoint';
      item.result = 'No workspace folder — cannot verify changes.';
      this.state = 'reviewing';
      this.broadcastProgress();
    }
  }

  /** Wait for file changes, then verify. */
  private waitForChanges(cwd: string, item: AutomationQueueItem, task: VBTask, myRunId: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let resolved = false;
      let sawWorkspaceChange = false;
      const done = () => {
        if (resolved) { return; }
        resolved = true;
        this.cancelWait = undefined;
        this.disposeWatcher();
        if (this.changeTimer) { clearTimeout(this.changeTimer); this.changeTimer = undefined; }
        if (this.timeoutTimer) { clearTimeout(this.timeoutTimer); this.timeoutTimer = undefined; }
        resolve();
      };

      // Allow external cancellation (skip/cancel) to resolve immediately
      this.cancelWait = done;

      // Set up file watcher
      const pattern = new vscode.RelativePattern(
        vscode.workspace.workspaceFolders![0],
        '**/*'
      );
      this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

      const resetDebounce = () => {
        // First workspace change — extend to the full timeout
        if (!sawWorkspaceChange) {
          sawWorkspaceChange = true;
          if (this.timeoutTimer) { clearTimeout(this.timeoutTimer); }
          this.timeoutTimer = setTimeout(async () => {
            if (resolved) { return; }
            done();
            if (this.runId !== myRunId) { return; }
            await this.handleNoChanges(item, task, myRunId);
          }, CHANGE_TIMEOUT_MS);
        }
        if (this.changeTimer) { clearTimeout(this.changeTimer); }
        this.changeTimer = setTimeout(async () => {
          // Changes settled — capture and verify
          done();
          if (this.runId !== myRunId) { return; }
          await this.captureAndVerify(cwd, item, task, myRunId);
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
        if (fsPath.includes('.buildboard') || fsPath.includes('.git')) { return; }
        if (e.contentChanges.length > 0) {
          resetDebounce();
        }
      });

      // Initial timeout: if no workspace changes at all within the no-activity timeout,
      // Copilot likely responded without making edits — go to checkpoint or auto-approve.
      this.timeoutTimer = setTimeout(async () => {
        if (resolved) { return; }
        done();
        // Guard: don't modify state if this run was superseded
        if (this.runId !== myRunId) { return; }
        await this.handleNoChanges(item, task, myRunId);
      }, getNoActivityTimeoutMs());
    });
  }

  /** Capture git diff and verify with LM API. */
  private async captureAndVerify(cwd: string, item: AutomationQueueItem, task: VBTask, myRunId: number): Promise<void> {
    if (this.runId !== myRunId) { return; }
    item.status = 'verifying';
    this.broadcastProgress();

    try {
      // Capture changes
      const [diff, changedFiles, diffStat] = await Promise.all([
        getGitDiff(cwd),
        getChangedFiles(cwd),
        getDiffStat(cwd),
      ]);

      // Guard: if this run was superseded while awaiting git operations, bail out
      if (this.runId !== myRunId) { return; }

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
        if (this.runId !== myRunId) { return; }
        await this.handleNoChanges(item, task, myRunId);
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

      // Guard: if this run was superseded while awaiting verification, bail out
      if (this.runId !== myRunId) { return; }

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
          `Build Board: Auto-completed "${task.title}" (${verification.confidence}% confidence).`
        );

        this.currentIndex++;
        this.broadcastProgress();

        // Check for pause before next
        if (this.state === 'paused' || this.runId !== myRunId) { return; }
        await this.processNext();
      } else {
        // Low confidence or not completed — checkpoint for user review
        if (this.runId !== myRunId) { return; }
        item.status = 'checkpoint';
        this.state = 'reviewing';
        this.broadcastProgress();
      }
    } catch {
      if (this.runId !== myRunId) { return; }
      item.status = 'checkpoint';
      item.result = 'Verification error — please review manually.';
      this.state = 'reviewing';
      this.broadcastProgress();
    }
  }

  /**
   * Handle the "no file changes detected" scenario.
   * If the auto-approve threshold is 0%, treat it as auto-complete (confidence 0%).
   * Otherwise, checkpoint for manual review.
   */
  private async handleNoChanges(
    item: AutomationQueueItem,
    task: { id: string; title: string },
    myRunId: number
  ): Promise<void> {
    const threshold = getAutoApproveThreshold();

    if (threshold === 0) {
      // 0% threshold means "always auto-approve" — treat no-changes as 0% confidence pass
      item.status = 'done';
      item.result = 'No file changes detected. (Confidence: 0%)';
      item.completedAt = new Date().toISOString();

      const data = this.storage.getData();
      const t = data.tasks.find((x) => x.id === item.taskId);
      if (t) { t.sentToCopilot = false; }
      this.storage.setData(data);
      this.taskManager.completeTask(item.taskId);

      vscode.window.showInformationMessage(
        `Build Board: Auto-completed "${task.title}" — no changes detected (0% threshold).`
      );

      this.currentIndex++;
      this.broadcastProgress();

      if (this.state === 'paused' || this.runId !== myRunId) { return; }
      await this.processNext();
    } else {
      // Threshold > 0 — require human review
      item.status = 'checkpoint';
      item.result = 'No file changes detected. (Confidence: 0%) — verify manually.';
      this.state = 'reviewing';
      this.broadcastProgress();
    }
  }

  /** Automation run complete. */
  private async finish(): Promise<void> {
    this.cleanup();
    const completed = this.queue.filter((q) => q.status === 'done').length;
    const failed = this.queue.filter((q) => q.status === 'failed').length;
    const skipped = this.queue.filter((q) => q.status === 'skipped').length;

    // Return to base branch if branching was used
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (cwd && this.baseBranch && isBranchingEnabled()) {
      try {
        await checkoutBranch(cwd, this.baseBranch);
        // Clean up any remaining unmerged task branches
        for (const item of this.queue) {
          if (item.branchName && item.status !== 'done') {
            await deleteBranch(cwd, item.branchName);
          }
        }
      } catch {
        // Best-effort cleanup
      }
    }

    this.state = 'idle';
    this.broadcastProgress();

    vscode.window.showInformationMessage(
      `Build Board: Automation complete! ${completed} done, ${failed} failed, ${skipped} skipped.`
    );
  }

  /** Clean up watchers, timers, and cancel any pending waitForChanges. */
  private cleanup(): void {
    this.disposeWatcher();
    if (this.changeTimer) { clearTimeout(this.changeTimer); this.changeTimer = undefined; }
    if (this.timeoutTimer) { clearTimeout(this.timeoutTimer); this.timeoutTimer = undefined; }
    if (this.cancelWait) { this.cancelWait(); this.cancelWait = undefined; }
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
