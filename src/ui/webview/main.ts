/**
 * Vibe Board — Webview Frontend (v2)
 * Features: priorities, time tracking, undo, templates, multi-board,
 * markdown export, inline editing, context menus, drag-drop, search,
 * keyboard navigation, accessibility.
 */

// ============================================================
// Types
// ============================================================

interface VBTask {
  id: string;
  title: string;
  description: string;
  tag: 'feature' | 'bug' | 'refactor' | 'note' | 'plan' | 'todo';
  priority: 'high' | 'medium' | 'low';
  status: 'in-progress' | 'up-next' | 'backlog' | 'completed' | 'notes';
  createdAt: string;
  completedAt: string | null;
  order: number;
  sessionId: string;
  boardId: string;
  timeSpentMs: number;
  timerStartedAt: string | null;
  carriedFromSessionId?: string;
  attachments?: { id: string; filename: string; mimeType: string; dataUri: string; addedAt: string }[];
  copilotLog?: { prompt: string; timestamp: string }[];
  sentToCopilot?: boolean;
}

interface JiraImportIssue {
  key: string;
  summary: string;
  description: string;
  status: string;
  priority: string;
  issueType: string;
  labels: string[];
  epicKey?: string;
  epicName?: string;
  attachments?: { id: string; filename: string; mimeType: string; contentUrl: string }[];
  comments?: { author: string; body: string; created: string }[];
}

interface VBSession {
  id: string;
  name: string;
  projectPath: string;
  startedAt: string;
  endedAt: string | null;
  status: 'active' | 'ended';
  pausedAt?: string | null;
  totalPausedMs?: number;
}

interface VBBoard {
  id: string;
  name: string;
  createdAt: string;
  pausedAt?: string | null;
  totalPausedMs?: number;
}

interface VBWorkspaceData {
  version: 1;
  activeSessionId: string | null;
  sessions: VBSession[];
  tasks: VBTask[];
  /** Count of undo entries (stacks themselves are not sent to webview). */
  undoCount?: number;
  /** Count of redo entries (stacks themselves are not sent to webview). */
  redoCount?: number;
  activeBoardId?: string;
  boards?: VBBoard[];
}

interface VBSessionSummary {
  sessionId: string;
  duration: number;
  tasksCompleted: number;
  tasksByTag: Record<string, number>;
  tasksCarriedOver: number;
}

type TaskStatus = VBTask['status'];
type TaskTag = VBTask['tag'];
type TaskPriority = VBTask['priority'];

// ============================================================
// VSCode API
// ============================================================

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

// Track dismissed carried-over banners per session so they stay hidden across re-renders
const carriedOverDismissed = new Set<string>();

// ============================================================
// Constants
// ============================================================

const COLUMNS: { id: TaskStatus; label: string }[] = [
  { id: 'in-progress', label: 'In Progress' },
  { id: 'up-next', label: 'Up Next' },
  { id: 'backlog', label: 'Backlog' },
  { id: 'completed', label: 'Completed' },
  { id: 'notes', label: 'Notes' },
];

const TAG_LABELS: Record<TaskTag, string> = { feature: 'Feature', bug: 'Bug', refactor: 'Refactor', note: 'Note', plan: 'Plan', todo: 'Todo' };
const TAG_OPTIONS: TaskTag[] = ['feature', 'bug', 'refactor', 'note', 'plan', 'todo'];
const PRIORITY_LABELS: Record<TaskPriority, string> = { high: 'High', medium: 'Medium', low: 'Low' };
const PRIORITY_OPTIONS: TaskPriority[] = ['high', 'medium', 'low'];

const TEMPLATES = [
  { name: 'Bug Report', icon: '🐛', title: 'Bug: ', description: 'Steps to reproduce:\n1. \n\nExpected:\nActual:', tag: 'bug', priority: 'high', col: 'up-next' },
  { name: 'Feature Spike', icon: '💡', title: 'Spike: ', description: 'Goal:\n\nApproach:\n\nQuestions:', tag: 'feature', priority: 'medium', col: 'up-next' },
  { name: 'Refactor Plan', icon: '🔧', title: 'Refactor: ', description: 'Current state:\n\nDesired state:\n\nRisks:', tag: 'refactor', priority: 'medium', col: 'backlog' },
  { name: 'Quick Note', icon: '📝', title: '', description: '', tag: 'note', priority: 'low', col: 'notes' },
  { name: 'AI Prompt Idea', icon: '🤖', title: 'Prompt: ', description: 'Context:\n\nPrompt:\n\nExpected output:', tag: 'note', priority: 'medium', col: 'notes' },
  { name: 'Plan', icon: '📋', title: 'Plan: ', description: 'Objective:\n\nSteps:\n1. \n2. \n3. \n\nSuccess criteria:', tag: 'plan', priority: 'medium', col: 'up-next' },
  { name: 'Todo List', icon: '✅', title: 'Todo: ', description: '1. \n2. \n3. ', tag: 'todo', priority: 'medium', col: 'up-next' },
];

// ============================================================
// App State
// ============================================================

let state: VBWorkspaceData | null = null;
let timerInterval: ReturnType<typeof setInterval> | null = null;
let taskTimerInterval: ReturnType<typeof setInterval> | null = null;
let collapsedColumns: Set<string> = new Set();
let draggedTaskId: string | null = null;
let searchQuery = '';
let filterTag: TaskTag | 'all' = 'all';
let filterPriority: TaskPriority | 'all' = 'all';
let activeView: 'board' | 'history' = 'board';
let renamingBoardId: string | null = null;
let boardClickTimer: ReturnType<typeof setTimeout> | null = null;
let sessionHistoryData: { sessions: VBSession[]; summaries: VBSessionSummary[] } | null = null;
let editingTaskId: string | null = null;
let contextMenuTaskId: string | null = null;
let pendingAIDescription: string = '';
let voiceRecognition: unknown = null;
let isVoiceRecording = false;
let pendingQuickAddAttachments: { id: string; filename: string; mimeType: string; dataUri: string; addedAt: string }[] = [];
let followUpTaskId: string | null = null;
let pendingFollowUpAttachments: { id: string; filename: string; mimeType: string; dataUri: string; addedAt: string }[] = [];
let voiceTargetId: string = 'quick-add-input'; // which textarea voice recording targets
let pendingAIClassification: { tag: string; priority: string; status: string } | null = null;
let quickAddTag: string = 'feature';
let quickAddPriority: string = 'medium';
let quickAddCol: string = 'up-next';

// Pre-AI form snapshot for undo/redo support
let preAIFormSnapshot: { text: string; tag: string; priority: string; col: string } | null = null;
let redoAIFormSnapshot: { text: string; tag: string; priority: string; col: string } | null = null;

// Settings (synced from extension)
interface VBSettings {
  autoBackup: boolean;
  autoBackupMaxCount: number;
  autoBackupIntervalMin: number;
  autoPromptSession: boolean;
  carryOverTasks: boolean;
  jiraConfigured: boolean;
  jiraBaseUrl: string;
  jiraEmail: string;
  jiraApiTokenLength: number;
}
let extensionSettings: VBSettings = {
  autoBackup: true,
  autoBackupMaxCount: 10,
  autoBackupIntervalMin: 5,
  autoPromptSession: true,
  carryOverTasks: true,
  jiraConfigured: false,
  jiraBaseUrl: '',
  jiraEmail: '',
  jiraApiTokenLength: 0,
};

// Automation state
interface AutomationProgress {
  state: 'idle' | 'running' | 'paused' | 'reviewing';
  queue: { taskId: string; status: string; result?: string; diffSummary?: string; changedFiles?: string[]; startedAt?: string; completedAt?: string }[];
  currentIndex: number;
  totalTasks: number;
  completedTasks: number;
  startedAt?: string;
}
let automationProgress: AutomationProgress | null = null;

// ============================================================
// Initialization
// ============================================================

const app = document.getElementById('app')!;

window.addEventListener('message', (event) => {
  const message = event.data;
  switch (message.type) {
    case 'stateUpdate':
      state = message.payload as VBWorkspaceData;
      render();
      // Execute any pending Jira import now that a session is active
      if (pendingJiraImport && state.activeSessionId) {
        const pending = pendingJiraImport;
        pendingJiraImport = null;
        vscode.postMessage({ type: 'importFromJira', payload: pending });
      }
      break;
    case 'sessionSummary':
      showSummary(message.payload as VBSessionSummary);
      break;
    case 'sessionHistory':
      sessionHistoryData = message.payload;
      renderHistory();
      break;
    case 'aiResult':
      handleAIResult(message.payload);
      break;
    case 'quickAddFiles':
      // Files picked for quick-add — store as pending attachments
      pendingQuickAddAttachments = pendingQuickAddAttachments.concat(message.payload.files);
      render();
      break;
    case 'showFollowUp':
      followUpTaskId = message.payload.taskId;
      pendingFollowUpAttachments = [];
      render();
      break;
    case 'followUpFiles':
      if (message.payload.taskId === followUpTaskId) {
        pendingFollowUpAttachments = pendingFollowUpAttachments.concat(message.payload.files);
        render();
      }
      break;
    case 'automationProgress':
      automationProgress = message.payload as AutomationProgress;
      if (automationProgress.state === 'idle') { automationProgress = null; }
      // Safety: clear bar if all tasks are resolved
      if (automationProgress && automationProgress.queue.every(
        (q: { status: string }) => q.status === 'done' || q.status === 'skipped' || q.status === 'failed'
      )) { automationProgress = null; }
      render();
      break;
    case 'settingsUpdate':
      extensionSettings = message.payload as VBSettings;
      render();
      break;
    case 'jiraProjects':
      handleJiraProjectsResponse(message.payload);
      break;
    case 'jiraStatuses':
      handleJiraStatusesResponse(message.payload);
      break;
    case 'jiraEpics':
      handleJiraEpicsResponse(message.payload);
      break;
    case 'jiraExportResult':
      handleJiraExportResult(message.payload);
      break;
    case 'jiraConnectionTest':
      handleJiraConnectionTestResult(message.payload);
      break;
    case 'jiraSearchResults':
      if (jiraSearchCallback) { jiraSearchCallback(message.payload); }
      break;
    case 'jiraImportResult':
      if (jiraImportCallback) { jiraImportCallback(message.payload); }
      break;
  }
});

// Global keyboard shortcuts
document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    closeAllOverlays();
    if (editingTaskId) { editingTaskId = null; render(); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
    e.preventDefault();
    (document.getElementById('quick-add-input') as HTMLTextAreaElement | null)?.focus();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    if (undoAIImprove()) { return; }
    vscode.postMessage({ type: 'undo', payload: {} });
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
    e.preventDefault();
    if (redoAIImprove()) { return; }
    vscode.postMessage({ type: 'redo', payload: {} });
    return;
  }
  if (e.key === 'F1') {
    e.preventDefault();
    showHelp();
    return;
  }
});

document.addEventListener('click', () => {
  const menu = document.getElementById('context-menu');
  if (menu) { menu.remove(); contextMenuTaskId = null; }
});

vscode.postMessage({ type: 'ready', payload: {} });

// ============================================================
// Main Render
// ============================================================

function render(): void {
  if (renamingBoardId) { return; }
  if (!state) { app.innerHTML = renderEmptyState(); return; }
  if (activeView === 'history') {
    vscode.postMessage({ type: 'requestHistory', payload: {} });
    return;
  }

  const activeSession = getActiveSession();
  let html = '';

  html += renderSessionBar(activeSession);

  if (activeSession) {
    html += renderCarriedOverBanner();
    html += renderAutomationBar();
    html += renderStatsBar();
    html += renderSearchBar();
    html += renderQuickAdd();
    html += '<div class="board">';
    for (const col of COLUMNS) {
      html += renderColumn(col, getColumnTasks(col.id));
    }
    html += '</div>';
  } else {
    html += renderNoSessionState();
  }

  // Preserve quick-add textarea value across re-renders
  const prevInput = (document.getElementById('quick-add-input') as HTMLTextAreaElement | null)?.value ?? '';
  // Capture current dropdown values into state variables (so renderQuickAdd uses them)
  const curTag = (document.getElementById('quick-add-tag') as HTMLSelectElement | null)?.value;
  const curPriority = (document.getElementById('quick-add-priority') as HTMLSelectElement | null)?.value;
  const curCol = (document.getElementById('quick-add-col') as HTMLSelectElement | null)?.value;
  if (curTag) { quickAddTag = curTag; }
  if (curPriority) { quickAddPriority = curPriority; }
  if (curCol) { quickAddCol = curCol; }
  const prevFollowUp = (document.getElementById('follow-up-input') as HTMLTextAreaElement | null)?.value ?? '';

  app.innerHTML = html;

  // Restore quick-add values
  const restoredInput = document.getElementById('quick-add-input') as HTMLTextAreaElement | null;
  if (restoredInput && prevInput) { restoredInput.value = prevInput; }
  // Restore follow-up textarea value
  const restoredFollowUp = document.getElementById('follow-up-input') as HTMLTextAreaElement | null;
  if (restoredFollowUp && prevFollowUp) { restoredFollowUp.value = prevFollowUp; }

  bindEvents();
  startTimer(activeSession);
  startTaskTimers();
}

// ============================================================
// State Helpers
// ============================================================

function getActiveSession(): VBSession | null {
  if (!state || !state.activeSessionId) { return null; }
  return state.sessions.find((s) => s.id === state!.activeSessionId) ?? null;
}

function getColumnTasks(status: TaskStatus): VBTask[] {
  if (!state) { return []; }
  const activeBoardId = state.activeBoardId || 'default';
  let tasks = state.tasks
    .filter((t) => t.status === status && t.sessionId === state!.activeSessionId && (t.boardId === activeBoardId || !t.boardId))
    .sort((a, b) => a.order - b.order);

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    tasks = tasks.filter((t) => t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q));
  }
  if (filterTag !== 'all') { tasks = tasks.filter((t) => t.tag === filterTag); }
  if (filterPriority !== 'all') { tasks = tasks.filter((t) => t.priority === filterPriority); }
  return tasks;
}

function getActiveSessionTasks(): VBTask[] {
  if (!state || !state.activeSessionId) { return []; }
  const activeBoardId = state.activeBoardId || 'default';
  return state.tasks.filter((t) => t.sessionId === state!.activeSessionId && (t.boardId === activeBoardId || !t.boardId));
}

function findTask(id: string): VBTask | undefined {
  return state?.tasks.find((t) => t.id === id);
}

// ============================================================
// Session Bar
// ============================================================

function renderSessionBar(session: VBSession | null): string {
  const hasUndo = !!(preAIFormSnapshot || (state?.undoCount && state.undoCount > 0));
  const hasRedo = !!(redoAIFormSnapshot || (state?.redoCount && state.redoCount > 0));
  const undoDisabled = hasUndo ? '' : ' disabled';
  const redoDisabled = hasRedo ? '' : ' disabled';
  const undoBtn = `<button class="icon-btn undo-redo-btn" id="btn-undo" title="Undo (Ctrl+Z)" aria-label="Undo last action"${undoDisabled}>&#8630;</button>`;
  const redoBtn = `<button class="icon-btn undo-redo-btn" id="btn-redo" title="Redo (Ctrl+Y)" aria-label="Redo last action"${redoDisabled}>&#8631;</button>`;
  const helpBtn = `<button class="icon-btn help-btn" id="btn-help" title="Help (F1)" aria-label="Open help">&#63;</button>`;
  const aiBtn = session ? `<button class="icon-btn ai-btn" id="btn-ai-summarize" title="AI Summarize Session" aria-label="AI summarize session">&#10024;</button>` : '';
  const autoBtn = session ? `<button class="auto-btn" id="btn-start-automation" title="Run Automation (process tasks via Copilot)" aria-label="Start automation">&#9654; Automate</button>` : '';

  const boardSwitcher = session ? renderBoardSwitcher() : '';

  const settingsBtn = `<button class="icon-btn settings-btn" id="btn-settings" title="Settings" aria-label="Open settings">&#9881;</button>`;

  if (!session) {
    return `<div class="session-bar" role="toolbar" aria-label="Session controls">
      <div class="session-info"><span style="font-size:12px;font-weight:600;">Vibe Board</span></div>
      <div class="session-actions"><button class="btn-start-session">Start Session</button>${settingsBtn}${helpBtn}</div>
    </div>`;
  }

  const activeBoardName = state?.boards?.find((b) => b.id === state?.activeBoardId)?.name || 'Session';
  const activeBoard = state?.boards?.find((b) => b.id === state?.activeBoardId);
  const isPaused = !!activeBoard?.pausedAt;
  const pausePlayBtn = isPaused
    ? `<button class="icon-btn session-play-btn" id="btn-resume-session" title="Resume Board Timer" aria-label="Resume board timer">&#9654;</button>`
    : `<button class="icon-btn session-pause-btn" id="btn-pause-session" title="Pause Board Timer" aria-label="Pause board timer">&#9208;</button>`;
  const timerClass = isPaused ? 'session-timer paused' : 'session-timer';

  // Show project name if session belongs to one
  const sessionProject = session.projectId ? (state?.projects || []).find((p) => p.id === session.projectId) : null;
  const projectLabel = sessionProject
    ? `<span class="session-project-label" id="session-project-edit" data-project-id="${sessionProject.id}" title="Click to edit project" style="cursor:pointer;${sessionProject.color ? `border-color:${sessionProject.color};color:${sessionProject.color}` : ''}">${escapeHtml(sessionProject.name)} <span style="font-size:10px;opacity:0.7;">&#9998;</span></span>`
    : '';

  return `<div class="session-bar" role="toolbar" aria-label="Session controls">
    <div class="session-info">
      ${projectLabel}<span class="session-name">${escapeHtml(activeBoardName)}</span>
      <span class="${timerClass}" id="session-timer" aria-live="polite">00:00:00</span>
      ${pausePlayBtn}
    </div>
    <div class="session-actions">${aiBtn}${autoBtn}${undoBtn}${redoBtn}<button class="secondary" id="btn-end-session">End Session</button>${settingsBtn}${helpBtn}</div>
  </div>
  ${boardSwitcher}`;
}

// ============================================================
// Automation Bar
// ============================================================

function renderAutomationBar(): string {
  if (!automationProgress) { return ''; }

  const { state: autoState, queue, currentIndex, totalTasks, completedTasks } = automationProgress;
  const pct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
  const currentItem = queue[currentIndex];
  const currentTask = currentItem ? findTask(currentItem.taskId) : null;
  const currentTitle = currentTask ? escapeHtml(currentTask.title) : 'Unknown task';

  // Status label
  let statusLabel = '';
  let statusIcon = '';
  if (autoState === 'running') {
    const stepStatus = currentItem?.status || 'pending';
    const stepLabels: Record<string, string> = {
      pending: 'Queued',
      sending: 'Sending to Copilot…',
      waiting: 'Waiting for changes…',
      verifying: 'Verifying completion…',
      checkpoint: 'Review needed',
      done: 'Done',
      skipped: 'Skipped',
      failed: 'Failed',
    };
    statusLabel = stepLabels[stepStatus] || stepStatus;
    statusIcon = '&#9654;'; // play
  } else if (autoState === 'paused') {
    statusLabel = 'Paused';
    statusIcon = '&#9208;'; // pause
  } else if (autoState === 'reviewing') {
    statusLabel = 'Review needed';
    statusIcon = '&#9888;'; // warning
  }

  // Action buttons based on state
  let actions = '';
  if (autoState === 'running') {
    actions = `<button class="auto-bar-btn" id="btn-auto-pause" title="Pause">&#9208;</button>
      <button class="auto-bar-btn" id="btn-auto-skip" title="Skip this task">Skip</button>
      <button class="auto-bar-btn danger" id="btn-auto-cancel" title="Cancel automation">Cancel</button>`;
  } else if (autoState === 'paused') {
    actions = `<button class="auto-bar-btn primary" id="btn-auto-resume" title="Resume">&#9654; Resume</button>
      <button class="auto-bar-btn danger" id="btn-auto-cancel" title="Cancel automation">Cancel</button>`;
  } else if (autoState === 'reviewing') {
    actions = `<button class="auto-bar-btn success" id="btn-auto-approve" title="Approve and complete task">&#10003; Approve</button>
      <button class="auto-bar-btn danger" id="btn-auto-reject" title="Reject and skip">&#10007; Reject</button>
      <button class="auto-bar-btn" id="btn-auto-skip" title="Skip without rejecting">Skip</button>`;
  }

  // Checkpoint detail (verification result)
  let checkpointDetail = '';
  if (autoState === 'reviewing' && currentItem) {
    const result = currentItem.result || '';
    const changedFiles = currentItem.changedFiles || [];
    const fileList = changedFiles.length > 0
      ? `<div class="auto-files"><strong>Changed files:</strong> ${changedFiles.map((f) => escapeHtml(f)).join(', ')}</div>`
      : '';
    checkpointDetail = `<div class="auto-checkpoint-detail">
      ${result ? `<div class="auto-verdict">${escapeHtml(result)}</div>` : ''}
      ${fileList}
    </div>`;
  }

  // Queue mini-list
  const queueItems = queue.map((item, i) => {
    const task = findTask(item.taskId);
    const name = task ? escapeHtml(task.title.length > 40 ? task.title.slice(0, 40) + '…' : task.title) : '?';
    const statusDot = item.status === 'done' ? '&#10003;'
      : item.status === 'failed' ? '&#10007;'
      : item.status === 'skipped' ? '&#8211;'
      : i === currentIndex ? '&#9654;'
      : '&#9675;';
    const cls = item.status === 'done' ? 'done' : item.status === 'failed' ? 'failed' : item.status === 'skipped' ? 'skipped' : i === currentIndex ? 'current' : '';
    const retryCount = (item as any).retryCount || 0;
    const maxRetries = 3;
    const retryBtn = item.status === 'failed' && retryCount < maxRetries
      ? ` <button class="auto-retry-btn" data-retry-index="${i}" title="Retry (${retryCount}/${maxRetries})">&circlearrowright; Retry</button>`
      : item.status === 'failed' && retryCount >= maxRetries
      ? ' <span class="auto-retry-exhausted" title="Max retries reached">(max retries)</span>'
      : '';
    return `<div class="auto-queue-item ${cls}"><span class="auto-queue-dot">${statusDot}</span> <span class="auto-queue-name">${name}</span>${retryBtn}</div>`;
  }).join('');

  return `<div class="automation-bar" role="region" aria-label="Automation progress">
    <div class="auto-header">
      <span class="auto-status-icon">${statusIcon}</span>
      <span class="auto-status-label">${statusLabel}</span>
      <span class="auto-progress-text">${completedTasks}/${totalTasks} (${pct}%)</span>
      <div class="auto-actions">${actions}</div>
    </div>
    <div class="auto-progress-bar"><div class="auto-progress-fill" style="width:${pct}%"></div></div>
    <div class="auto-current">Current: <strong>${currentTitle}</strong></div>
    ${checkpointDetail}
    <div class="auto-queue">${queueItems}</div>
  </div>`;
}

function showAutomationTaskPicker(): void {
  if (!state) { return; }
  const tasks = getActiveSessionTasks().filter((t) => t.status !== 'completed');
  if (tasks.length === 0) {
    showAIToast('No incomplete tasks to automate.', false);
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Select tasks for automation');

  const taskCheckboxes = tasks.map((t, i) => {
    const tagBadge = `<span class="task-tag ${t.tag}" style="font-size:10px;padding:1px 5px;">${TAG_LABELS[t.tag]}</span>`;
    const checkedAttr = t.tag === 'note' ? '' : ' checked';
    return `<div class="auto-pick-item" data-task-id="${t.id}" draggable="true">
      <span class="auto-pick-handle" title="Drag to reorder">&#8942;&#8942;</span>
      <input type="checkbox" value="${t.id}"${checkedAttr} />
      ${tagBadge}
      <span class="auto-pick-title">${escapeHtml(t.title.length > 60 ? t.title.slice(0, 60) + '…' : t.title)}</span>
      <span class="auto-pick-arrows">
        <button class="auto-pick-arrow up" title="Move up"${i === 0 ? ' disabled' : ''}>&#9650;</button>
        <button class="auto-pick-arrow down" title="Move down"${i === tasks.length - 1 ? ' disabled' : ''}>&#9660;</button>
      </span>
    </div>`;
  }).join('');

  overlay.innerHTML = `<div class="modal-card" style="max-width:420px;">
    <h3>&#9881; Run Automation</h3>
    <p style="font-size:12px;color:var(--vscode-descriptionForeground);margin-bottom:8px;">
      Select tasks to process via Copilot. Each task will be sent to Copilot Chat, then verified automatically.
      You'll be asked to approve at checkpoints.
    </p>
    <div class="auto-pick-controls" style="margin-bottom:6px;display:flex;gap:8px;">
      <button class="secondary" id="auto-pick-all" style="font-size:11px;padding:2px 8px;">Select All</button>
      <button class="secondary" id="auto-pick-none" style="font-size:11px;padding:2px 8px;">Select None</button>
    </div>
    <div class="auto-pick-list" style="max-height:250px;overflow-y:auto;margin-bottom:12px;">
      ${taskCheckboxes}
    </div>
    <div class="auto-threshold" style="margin-bottom:12px;padding:8px;background:var(--vscode-editor-background);border-radius:4px;">
      <label style="font-size:12px;display:flex;align-items:center;gap:8px;">
        <span>Auto-approve threshold:</span>
        <input type="range" id="auto-threshold-slider" min="0" max="100" value="100" step="5" style="flex:1;" />
        <span id="auto-threshold-value" style="font-weight:600;min-width:36px;text-align:right;">100%</span>
      </label>
      <p style="font-size:10px;color:var(--vscode-descriptionForeground);margin:4px 0 0;">Tasks verified with confidence &ge; this value are auto-completed. Set to 100% to always review manually.</p>
    </div>
    <div class="modal-actions">
      <button class="secondary" id="auto-pick-cancel">Cancel</button>
      <button class="primary" id="auto-pick-start">&#9654; Start Automation</button>
    </div>
  </div>`;

  document.body.appendChild(overlay);

  // --- Reorder helpers ---
  const pickList = overlay.querySelector('.auto-pick-list') as HTMLElement;

  function updateArrowStates(): void {
    const items = pickList.querySelectorAll<HTMLElement>('.auto-pick-item');
    items.forEach((item, idx) => {
      const up = item.querySelector('.auto-pick-arrow.up') as HTMLButtonElement;
      const down = item.querySelector('.auto-pick-arrow.down') as HTMLButtonElement;
      if (up) { up.disabled = idx === 0; }
      if (down) { down.disabled = idx === items.length - 1; }
    });
  }

  // Arrow buttons
  pickList.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.auto-pick-arrow') as HTMLButtonElement;
    if (!btn || btn.disabled) { return; }
    const item = btn.closest('.auto-pick-item') as HTMLElement;
    if (!item) { return; }
    if (btn.classList.contains('up') && item.previousElementSibling) {
      pickList.insertBefore(item, item.previousElementSibling);
    } else if (btn.classList.contains('down') && item.nextElementSibling) {
      pickList.insertBefore(item.nextElementSibling, item);
    }
    updateArrowStates();
  });

  // Drag-and-drop reorder
  let dragItem: HTMLElement | null = null;
  pickList.addEventListener('dragstart', (e) => {
    dragItem = (e.target as HTMLElement).closest('.auto-pick-item');
    if (dragItem) {
      dragItem.classList.add('auto-pick-dragging');
      e.dataTransfer!.effectAllowed = 'move';
    }
  });
  pickList.addEventListener('dragend', () => {
    if (dragItem) { dragItem.classList.remove('auto-pick-dragging'); }
    dragItem = null;
    pickList.querySelectorAll('.auto-pick-drag-over').forEach((el) => el.classList.remove('auto-pick-drag-over'));
    updateArrowStates();
  });
  pickList.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
    const target = (e.target as HTMLElement).closest('.auto-pick-item') as HTMLElement;
    if (target && target !== dragItem) {
      pickList.querySelectorAll('.auto-pick-drag-over').forEach((el) => el.classList.remove('auto-pick-drag-over'));
      target.classList.add('auto-pick-drag-over');
    }
  });
  pickList.addEventListener('drop', (e) => {
    e.preventDefault();
    const target = (e.target as HTMLElement).closest('.auto-pick-item') as HTMLElement;
    if (target && dragItem && target !== dragItem) {
      const items = Array.from(pickList.querySelectorAll('.auto-pick-item'));
      const dragIdx = items.indexOf(dragItem);
      const targetIdx = items.indexOf(target);
      if (dragIdx < targetIdx) {
        pickList.insertBefore(dragItem, target.nextElementSibling);
      } else {
        pickList.insertBefore(dragItem, target);
      }
    }
    pickList.querySelectorAll('.auto-pick-drag-over').forEach((el) => el.classList.remove('auto-pick-drag-over'));
    updateArrowStates();
  });

  // Threshold slider
  const slider = document.getElementById('auto-threshold-slider') as HTMLInputElement;
  const valueLabel = document.getElementById('auto-threshold-value');
  slider?.addEventListener('input', () => {
    if (valueLabel) { valueLabel.textContent = slider.value + '%'; }
  });

  // Select all / none
  document.getElementById('auto-pick-all')?.addEventListener('click', () => {
    overlay.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => { cb.checked = true; });
  });
  document.getElementById('auto-pick-none')?.addEventListener('click', () => {
    overlay.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
  });

  // Cancel
  document.getElementById('auto-pick-cancel')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); } });

  // Start — collect selected task IDs in display order
  document.getElementById('auto-pick-start')?.addEventListener('click', () => {
    const selected: string[] = [];
    overlay.querySelectorAll<HTMLElement>('.auto-pick-item').forEach((item) => {
      const cb = item.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (cb?.checked) { selected.push(cb.value); }
    });
    const thresholdSlider = document.getElementById('auto-threshold-slider') as HTMLInputElement;
    const threshold = thresholdSlider ? parseInt(thresholdSlider.value, 10) : 100;
    overlay.remove();
    if (selected.length === 0) { return; }
    vscode.postMessage({ type: 'startAutomation', payload: { taskIds: selected, threshold } });
  });

  // Focus start button
  (document.getElementById('auto-pick-start') as HTMLElement)?.focus();
}

// ============================================================
// Board Switcher
// ============================================================

function renderBoardSwitcher(): string {
  if (!state) { return ''; }
  const boards = state.boards ?? [{ id: 'default', name: 'Main Board', createdAt: '' }];
  const activeBoardId = state.activeBoardId || 'default';

  const tabs = boards.map((b) => {
    const isActive = b.id === activeBoardId;
    return `<div class="board-tab ${isActive ? 'active' : ''}" data-board-id="${b.id}" title="${escapeAttr(b.name)}">
      <span class="board-tab-name" data-board-name="${b.id}">${escapeHtml(b.name)}</span>
      <button class="board-tab-close" data-close-board="${b.id}" title="Close" aria-label="Close ${escapeAttr(b.name)}">&times;</button>
    </div>`;
  }).join('');

  return `<div class="board-switcher" role="tablist" aria-label="Board tabs">
    ${tabs}
    <button class="board-tab board-tab-add" id="btn-add-board" title="New board" aria-label="Create new board">+</button>
  </div>`;
}

// ============================================================
// Carried Over Banner
// ============================================================

function renderCarriedOverBanner(): string {
  if (!state) { return ''; }
  const activeSessionId = state.activeSessionId;
  if (activeSessionId && carriedOverDismissed.has(activeSessionId)) { return ''; }
  const tasks = getActiveSessionTasks();
  const carriedTasks = tasks.filter((t) => t.carriedFromSessionId);
  if (carriedTasks.length === 0) { return ''; }

  // Find the session name they came from
  const fromSessionId = carriedTasks[0].carriedFromSessionId;
  const fromSession = state.sessions.find((s) => s.id === fromSessionId);
  const fromName = fromSession ? fromSession.name : 'previous session';

  const taskList = carriedTasks.map((t) => {
    const prio = t.priority === 'high' ? '&#9888; ' : '';
    return `<div class="carried-item">
      <span class="task-tag ${t.tag}">${TAG_LABELS[t.tag]}</span>
      <span class="carried-item-title">${prio}${escapeHtml(t.title)}</span>
      <span class="carried-item-status">${t.status}</span>
    </div>`;
  }).join('');

  return `<div class="carried-over-banner" id="carried-over-banner" role="region" aria-label="Carried over tasks">
    <div class="carried-over-header" id="carried-over-toggle">
      <span>&#8634; ${carriedTasks.length} task${carriedTasks.length === 1 ? '' : 's'} carried over from <strong>${escapeHtml(fromName)}</strong></span>
      <span style="display:flex;gap:2px;align-items:center;">
        <button class="icon-btn carried-over-expand" title="Toggle details" aria-label="Toggle carried over details">&#9660;</button>
        <button class="icon-btn" id="carried-over-dismiss" title="Dismiss" aria-label="Dismiss carried over banner" style="font-size:13px;opacity:0.7;">&#10005;</button>
      </span>
    </div>
    <div class="carried-over-details" id="carried-over-details" style="display:none;">
      ${taskList}
    </div>
  </div>`;
}

// ============================================================
// Live Stats Bar
// ============================================================

function renderStatsBar(): string {
  const tasks = getActiveSessionTasks();
  const total = tasks.length;
  const completed = tasks.filter((t) => t.status === 'completed').length;
  const inProgress = tasks.filter((t) => t.status === 'in-progress').length;
  const upNext = tasks.filter((t) => t.status === 'up-next').length;
  const highPrio = tasks.filter((t) => t.priority === 'high' && t.status !== 'completed').length;
  const carriedOver = tasks.filter((t) => t.carriedFromSessionId).length;

  return `<div class="stats-bar" role="status" aria-label="Task statistics">
    <span class="stat-pill" title="Total tasks">&#128203; ${total}</span>
    <span class="stat-pill completed" title="Completed">&#10003; ${completed}</span>
    ${inProgress > 0 ? `<span class="stat-pill in-progress" title="In Progress">&#9881; ${inProgress}</span>` : ''}
    <span class="stat-pill" title="Up Next">&#9654; ${upNext}</span>
    ${highPrio > 0 ? `<span class="stat-pill high-prio" title="High priority">&#9888; ${highPrio}</span>` : ''}
    ${carriedOver > 0 ? `<span class="stat-pill carried-over" title="Carried over from previous session">&#8634; ${carriedOver}</span>` : ''}
  </div>`;
}

// ============================================================
// Search & Filter Bar
// ============================================================

function renderSearchBar(): string {
  const tagOpts = TAG_OPTIONS.map((t) => `<option value="${t}" ${filterTag === t ? 'selected' : ''}>${TAG_LABELS[t]}</option>`).join('');
  const prioOpts = PRIORITY_OPTIONS.map((p) => `<option value="${p}" ${filterPriority === p ? 'selected' : ''}>${PRIORITY_LABELS[p]}</option>`).join('');

  return `<div class="search-bar" role="search">
    <input type="text" id="search-input" placeholder="&#128269; Search tasks..." value="${escapeAttr(searchQuery)}" aria-label="Search tasks" />
    <select id="filter-tag" aria-label="Filter by tag"><option value="all" ${filterTag === 'all' ? 'selected' : ''}>All Tags</option>${tagOpts}</select>
    <select id="filter-priority" aria-label="Filter by priority"><option value="all" ${filterPriority === 'all' ? 'selected' : ''}>Priority</option>${prioOpts}</select>
  </div>`;
}

// ============================================================
// Quick Add (with templates)
// ============================================================

function renderQuickAdd(): string {
  const templateBtns = TEMPLATES.map((t, i) =>
    `<button class="icon-btn template-btn" data-template="${i}" title="${t.name}" aria-label="Template: ${t.name}">${t.icon}</button>`
  ).join('');

  const pendingThumbs = pendingQuickAddAttachments.length > 0
    ? `<div class="quick-add-attachments">
        ${pendingQuickAddAttachments.map(a => `<div class="quick-add-att-item">
          ${a.mimeType.startsWith('image/')
            ? `<img class="quick-add-att-thumb" src="${a.dataUri}" alt="${escapeAttr(a.filename)}" title="${escapeAttr(a.filename)}" />`
            : `<span class="quick-add-att-file" title="${escapeAttr(a.filename)}">&#128196;</span>`}
          <button class="quick-add-att-remove" data-remove-pending="${a.id}" title="Remove">&#10005;</button>
        </div>`).join('')}
      </div>`
    : '';

  const micSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>`;

  return `<div class="quick-add">
    <textarea id="quick-add-input" placeholder="Add a task... (Enter to submit, Shift+Enter for new line)" rows="2" aria-label="New task title"></textarea>
    ${pendingThumbs}
    <div class="quick-add-controls">
      <select id="quick-add-tag" aria-label="Task tag">
        <option value="feature" ${quickAddTag === 'feature' ? 'selected' : ''}>Feature</option><option value="bug" ${quickAddTag === 'bug' ? 'selected' : ''}>Bug</option>
        <option value="refactor" ${quickAddTag === 'refactor' ? 'selected' : ''}>Refactor</option><option value="note" ${quickAddTag === 'note' ? 'selected' : ''}>Note</option>
        <option value="plan" ${quickAddTag === 'plan' ? 'selected' : ''}>Plan</option>
        <option value="todo" ${quickAddTag === 'todo' ? 'selected' : ''}>Todo</option>
      </select>
      <select id="quick-add-priority" aria-label="Task priority">
        <option value="medium" ${quickAddPriority === 'medium' ? 'selected' : ''}>Medium</option><option value="high" ${quickAddPriority === 'high' ? 'selected' : ''}>High</option><option value="low" ${quickAddPriority === 'low' ? 'selected' : ''}>Low</option>
      </select>
      <select id="quick-add-col" aria-label="Target column">
        <option value="in-progress" ${quickAddCol === 'in-progress' ? 'selected' : ''}>In Progress</option><option value="up-next" ${quickAddCol === 'up-next' ? 'selected' : ''}>Up Next</option><option value="backlog" ${quickAddCol === 'backlog' ? 'selected' : ''}>Backlog</option><option value="notes" ${quickAddCol === 'notes' ? 'selected' : ''}>Notes</option>
      </select>
      <button class="icon-btn ai-suggest-btn" id="btn-ai-rewrite" title="AI improve task" aria-label="AI improve task">&#10024;</button>
      <button class="icon-btn voice-btn ${isVoiceRecording ? 'recording' : ''}" id="btn-voice" title="${isVoiceRecording ? 'Stop recording' : 'Voice input'}" aria-label="${isVoiceRecording ? 'Stop voice recording' : 'Start voice recording'}">${micSvg}</button>
      <button class="icon-btn attach-qa-btn" id="btn-quick-attach" title="Attach file" aria-label="Attach file to new task">&#128206;</button>
      <button id="btn-quick-add">Add</button>
    </div>
    <div class="template-bar">${templateBtns}</div>
  </div>`;
}

// ============================================================
// Columns
// ============================================================

function renderColumn(col: { id: TaskStatus; label: string }, tasks: VBTask[]): string {
  const isCollapsed = collapsedColumns.has(col.id);
  const arrow = isCollapsed ? '&#9654;' : '&#9660;';

  return `<div class="column" data-column="${col.id}" role="region" aria-label="${col.label} column">
    <div class="column-header" data-toggle="${col.id}" role="button" tabindex="0" aria-expanded="${!isCollapsed}" aria-label="Toggle ${col.label}">
      <h3>${arrow} ${col.label}</h3>
      <span class="task-count" aria-label="${tasks.length} tasks">${tasks.length}</span>
    </div>
    <div class="column-body ${isCollapsed ? 'collapsed' : ''}" data-dropzone="${col.id}" data-column-id="${col.id}" role="list" aria-label="${col.label} tasks">
      ${tasks.map(renderTaskCard).join('')}
      ${tasks.length === 0 ? '<div class="drop-placeholder">Drop tasks here</div>' : ''}
    </div>
  </div>`;
}

// ============================================================
// Task Card
// ============================================================

function renderTaskCard(task: VBTask): string {
  if (editingTaskId === task.id) { return renderTaskEditCard(task); }

  const isCompleted = task.status === 'completed';
  const titleClass = isCompleted ? 'task-title completed' : 'task-title';
  const timeAgo = getTimeAgo(task.createdAt);
  const prioClass = `priority-${task.priority || 'medium'}`;
  const timerActive = !!task.timerStartedAt;
  const totalMs = getTaskTotalMs(task);
  const timeStr = totalMs > 0 ? formatDurationCompact(totalMs) : '';
  const timerIcon = timerActive ? '&#9209;' : '&#9654;';
  const carriedBadge = task.carriedFromSessionId ? `<span class="carried-badge" title="Carried over from previous session">&#8634;</span>` : '';
  const attachmentCount = (task.attachments || []).length;
  const attachBadge = attachmentCount > 0 ? `<span class="attach-count" title="${attachmentCount} attachment${attachmentCount > 1 ? 's' : ''}">&#128206;${attachmentCount}</span>` : '';
  const attachmentThumbs = (task.attachments || []).filter(a => a.mimeType.startsWith('image/')).slice(0, 3)
    .map(a => `<img class="task-attachment-thumb" src="${a.dataUri}" alt="${escapeAttr(a.filename)}" title="${escapeAttr(a.filename)}" data-preview-attachment="${a.id}" data-task-id="${task.id}" />`).join('');

  return `<div class="task-card ${prioClass}" draggable="true" data-task-id="${task.id}" role="listitem" tabindex="0" aria-label="${escapeAttr(task.title)}${task.priority === 'high' ? ' - High Priority' : ''}${task.carriedFromSessionId ? ' - Carried over' : ''}" oncontextmenu="return false;">
    <div class="task-header">
      <input type="checkbox" class="task-checkbox" data-complete="${task.id}" ${isCompleted ? 'checked' : ''} title="Mark complete" aria-label="Mark ${escapeAttr(task.title)} complete" />
      ${carriedBadge}<span class="${titleClass}" data-edit-title="${task.id}" title="Double-click to edit">${escapeHtml(task.title)}</span>
      <div class="task-actions">
        <button class="icon-btn timer-btn ${timerActive ? 'active' : ''}" data-timer="${task.id}" title="${timerActive ? 'Stop timer' : 'Start timer'}" aria-label="Toggle timer">${timerIcon}</button>
        <button class="icon-btn copilot-btn" data-send-copilot="${task.id}" title="Send to Copilot" aria-label="Send to Copilot">&#128640;</button>
        <button class="icon-btn attach-btn" data-add-attachment="${task.id}" title="Attach file" aria-label="Attach file">&#128206;</button>
        <button class="icon-btn" data-edit="${task.id}" title="Edit" aria-label="Edit task">&#9998;</button>
        <button class="icon-btn" data-context="${task.id}" title="More" aria-label="More actions">&#8943;</button>
      </div>
    </div>
    ${task.description ? `<div class="task-description">${escapeHtml(task.description)}</div>` : ''}
    ${attachmentThumbs ? `<div class="task-attachments-row">${attachmentThumbs}</div>` : ''}
    <div class="task-meta">
      <span class="task-priority-badge ${prioClass}" aria-label="Priority: ${task.priority || 'medium'}">${(task.priority || 'medium')[0].toUpperCase()}</span>
      <span class="task-tag ${task.tag}">${TAG_LABELS[task.tag]}</span>
      ${attachBadge}
      ${timeStr ? `<span class="task-timer-display ${timerActive ? 'active' : ''}" data-timer-display="${task.id}">${timeStr}</span>` : ''}
      <span class="task-time" title="${new Date(task.createdAt).toLocaleString()}">${timeAgo}</span>
    </div>
    ${renderCopilotLog(task)}
    ${task.sentToCopilot && task.status !== 'completed' ? renderCopilotActions(task.id) : ''}
    ${followUpTaskId === task.id ? renderFollowUpSection(task.id) : ''}
  </div>`;
}

// ============================================================
// Copilot Follow-up
// ============================================================

function renderCopilotLog(task: VBTask): string {
  const log = task.copilotLog;
  if (!log || log.length === 0) { return ''; }
  return `<div class="copilot-log">
    <div class="copilot-log-header">&#128640; Copilot Log (${log.length})</div>
    ${log.map((entry, i) => `<div class="copilot-log-entry">
      <span class="copilot-log-num">#${i + 1}</span>
      <span class="copilot-log-text">${escapeHtml(entry.prompt.length > 80 ? entry.prompt.slice(0, 80) + '…' : entry.prompt)}</span>
      <span class="copilot-log-time">${getTimeAgo(entry.timestamp)}</span>
    </div>`).join('')}
  </div>`;
}

function renderCopilotActions(taskId: string): string {
  return `<div class="copilot-actions">
    <span class="copilot-actions-label">&#128640; Sent to Copilot —</span>
    <button class="btn-copilot-complete" data-copilot-complete="${taskId}">&#10003; Mark Complete</button>
    <button class="btn-copilot-followup" data-copilot-followup="${taskId}">&#128172; Follow Up</button>
    <button class="btn-copilot-dismiss" data-copilot-dismiss="${taskId}" title="Dismiss">&times;</button>
  </div>`;
}

function renderFollowUpSection(taskId: string): string {
  const micSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>`;

  const pendingThumbs = pendingFollowUpAttachments.length > 0
    ? `<div class="quick-add-attachments">
        ${pendingFollowUpAttachments.map(a => `<div class="quick-add-att-item">
          ${a.mimeType.startsWith('image/')
            ? `<img class="quick-add-att-thumb" src="${a.dataUri}" alt="${escapeAttr(a.filename)}" title="${escapeAttr(a.filename)}" />`
            : `<span class="quick-add-att-file" title="${escapeAttr(a.filename)}">&#128196;</span>`}
          <button class="quick-add-att-remove" data-remove-followup-att="${a.id}" title="Remove">&#10005;</button>
        </div>`).join('')}
      </div>`
    : '';

  // Determine if project context is available and enabled for this task
  const fuTask = state?.tasks?.find(t => t.id === taskId);
  const fuSession = fuTask ? state?.sessions?.find(s => s.id === fuTask.sessionId) : null;
  const fuProject = fuSession?.projectId ? state?.projects?.find(p => p.id === fuSession.projectId) : null;
  const hasProjectContext = !!(fuProject?.copilotContext?.trim());
  const projectContextEnabled = fuProject?.copilotContextEnabled !== false;
  const contextCheckbox = hasProjectContext
    ? `<label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--vscode-descriptionForeground);margin-left:auto;cursor:pointer;" title="Include project context in this follow-up">
        <input type="checkbox" id="follow-up-include-context" ${projectContextEnabled ? 'checked' : ''} />
        <span>Project Context</span>
      </label>`
    : '';

  return `<div class="follow-up-section">
    <div class="follow-up-header">&#128172; Copilot needs more info — describe what's next:</div>
    <textarea id="follow-up-input" class="follow-up-textarea" placeholder="What else needs to be done..." rows="2"></textarea>
    ${pendingThumbs}
    <div class="follow-up-controls">
      <button class="icon-btn voice-btn ${isVoiceRecording ? 'recording' : ''}" id="btn-follow-up-voice" title="Voice input">${micSvg}</button>
      <button class="icon-btn attach-qa-btn" id="btn-follow-up-attach" title="Attach file">&#128206;</button>
      <button class="btn-follow-up-send" id="btn-follow-up-send" data-task-id="${taskId}">Send to Copilot</button>
      <button class="btn-follow-up-done secondary" id="btn-follow-up-done" data-task-id="${taskId}">&#10003; Mark Complete</button>
      <button class="btn-follow-up-cancel secondary" id="btn-follow-up-cancel">Cancel</button>
      ${contextCheckbox}
    </div>
  </div>`;
}

// ============================================================
// Task Edit Card
// ============================================================

function renderTaskEditCard(task: VBTask): string {
  const tagOpts = TAG_OPTIONS.map((t) => `<option value="${t}" ${task.tag === t ? 'selected' : ''}>${TAG_LABELS[t]}</option>`).join('');
  const prioOpts = PRIORITY_OPTIONS.map((p) => `<option value="${p}" ${task.priority === p ? 'selected' : ''}>${PRIORITY_LABELS[p]}</option>`).join('');

  const attachments = (task.attachments || []);
  const attachmentHtml = attachments.length > 0
    ? `<div class="edit-attachments">
        <div class="edit-attachments-label">Attachments (${attachments.length}):</div>
        <div class="edit-attachments-grid">
          ${attachments.map(a => `<div class="edit-attachment-item" data-att-id="${a.id}">
            ${a.mimeType.startsWith('image/')
              ? `<img class="edit-attachment-preview" src="${a.dataUri}" alt="${escapeAttr(a.filename)}" />`
              : `<span class="edit-attachment-file">&#128196; ${escapeHtml(a.filename)}</span>`}
            <button class="edit-attachment-remove" data-remove-attachment="${a.id}" data-remove-task="${task.id}" title="Remove">&#10005;</button>
          </div>`).join('')}
        </div>
      </div>`
    : '';

  return `<div class="task-card editing" data-task-id="${task.id}" role="listitem">
    <input type="text" class="edit-title-input" data-save-title="${task.id}" value="${escapeAttr(task.title)}" placeholder="Task title" aria-label="Edit title" />
    <textarea class="edit-desc-input" data-save-desc="${task.id}" placeholder="Description (optional)" rows="3" aria-label="Edit description">${escapeHtml(task.description)}</textarea>
    ${attachmentHtml}
    <div class="edit-controls">
      <select data-save-tag="${task.id}" aria-label="Tag">${tagOpts}</select>
      <select data-save-priority="${task.id}" aria-label="Priority">${prioOpts}</select>
      <div class="edit-buttons">
        <button class="secondary" data-add-attachment="${task.id}" title="Attach file">&#128206; Attach</button>
        <button class="secondary" data-cancel-edit="${task.id}">Cancel</button>
        <button data-save-edit="${task.id}">Save</button>
      </div>
    </div>
  </div>`;
}

// ============================================================
// No Session / Start Page
// ============================================================

function renderNoSessionState(): string {
  const projects = state?.projects || [];
  const activeProjectId = state?.activeProjectId || null;
  const activeProject = projects.find((p) => p.id === activeProjectId) || null;

  let html = `<div class="start-page">
    <div class="start-hero">
      <div class="empty-icon">&#128161;</div>
      <h2>Ready to build?</h2>
      <p>Plan tasks, send them to Copilot, and automate your entire workflow &mdash; all from one board.</p>
      <button class="btn-start-session">Start Session</button>
    </div>`;

  // --- Projects section ---
  html += `<div class="start-section">
    <div class="start-section-header">
      <h3>&#128194; Projects</h3>
      <button class="icon-btn" id="btn-create-project" title="New Project" style="font-size:14px;padding:0 4px;">+</button>
    </div>`;

  if (projects.length === 0) {
    html += `<p style="font-size:11px;color:var(--vscode-descriptionForeground);padding:4px 0;">Group sessions into projects to organize your work. Click <strong>+</strong> to create one.</p>`;
  } else {
    const totalSessionCount = (state?.sessions || []).length;
    html += `<div class="project-list">
      <button class="project-chip${!activeProjectId ? ' active' : ''}" data-project-id="">All Projects <span class="project-count">${totalSessionCount}</span></button>`;
    for (const p of projects) {
      const colorDot = p.color ? `<span class="project-dot" style="background:${p.color};"></span>` : '';
      const sessionCount = (state?.sessions || []).filter((s) => s.projectId === p.id).length;
      html += `<button class="project-chip${activeProjectId === p.id ? ' active' : ''}" data-project-id="${p.id}">
        ${colorDot}${escapeHtml(p.name)} <span class="project-count">${sessionCount}</span>
        <span class="project-actions">
          <span class="project-action-btn project-rename" data-rename-project="${p.id}" title="Edit">&#9998;</span>
          <span class="project-action-btn project-delete" data-delete-project="${p.id}" title="Delete">&#10005;</span>
        </span>
      </button>`;
    }
    html += `</div>`;
  }
  html += `</div>`;

  if (state && state.sessions.length > 0) {
    // Export (always visible at top)
    const exportScope = activeProject ? ` (${escapeHtml(activeProject.name)})` : '';
    html += `<div class="start-section"><div class="start-section-header"><h3>&#128230; Export / Import${exportScope}</h3></div>
      <div class="start-export-actions">
        <button class="secondary" id="btn-export-json" title="Full data backup — all sessions, tasks, and settings in machine-readable format">JSON</button>
        <button class="secondary" id="btn-export-csv" title="Spreadsheet-ready table — ${activeProject ? 'project' : 'all'} tasks with session info, plus summary totals">CSV</button>
        <button class="secondary" id="btn-export-md" title="Human-readable report — ${activeProject ? 'project' : 'all'} summary stats, session history, and tasks">Markdown</button>
        <button class="secondary" id="btn-export-jira" title="Create Jira issues from tasks — requires Jira credentials in Settings">&#127919; Jira</button>
      </div>
      <div class="start-export-hints">
        <span>JSON: Full backup</span>
        <span>CSV: Spreadsheet</span>
        <span>MD: Report</span>
        <span>Jira: Create issues</span>
      </div>
      <div class="start-import-actions">
        <button class="secondary" id="btn-import-data" title="Import data from a Vibe Board JSON export or data.json backup">&#128229; Import JSON</button>
        <button class="secondary" id="btn-import-jira" title="Import issues from Jira into Vibe Board — requires Jira credentials in Settings">&#127919; Import from Jira</button>
      </div></div>`;

    // Session history — filtered by active project
    const allEndedSessions = state.sessions
      .filter((s) => s.status === 'ended')
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    const endedSessions = activeProjectId
      ? allEndedSessions.filter((s) => s.projectId === activeProjectId)
      : allEndedSessions;

    const SESSION_PREVIEW = 5;
    if (endedSessions.length > 0) {
      const historyLabel = activeProject ? `Sessions in ${escapeHtml(activeProject.name)}` : 'Session History';
      const showAllSessions = endedSessions.length > SESSION_PREVIEW;
      html += `<div class="start-section"><div class="start-section-header"><h3>&#128218; ${historyLabel} <span class="start-section-count">(${endedSessions.length})</span></h3></div><div class="start-section-list start-section-scrollable" id="session-history-list">`;
      for (let i = 0; i < endedSessions.length; i++) {
        const s = endedSessions[i];
        const date = new Date(s.startedAt).toLocaleDateString();
        const time = new Date(s.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const endMs = s.endedAt ? new Date(s.endedAt).getTime() : Date.now();
        const totalPaused = s.totalPausedMs || 0;
        const dur = formatDuration(Math.max(0, endMs - new Date(s.startedAt).getTime() - totalPaused));
        const sessionTasks = state!.tasks.filter((t) => t.sessionId === s.id);
        const completed = sessionTasks.filter((t) => t.status === 'completed').length;
        const carried = sessionTasks.filter((t) => t.carriedFromSessionId).length;
        const carriedStr = carried > 0 ? `<span>&#8634; ${carried} carried over</span>` : '';
        // Show project badge if viewing all projects
        const projBadge = !activeProjectId && s.projectId ? (() => {
          const proj = projects.find((p) => p.id === s.projectId);
          return proj ? `<span class="start-history-project" ${proj.color ? `style="border-color:${proj.color};color:${proj.color}"` : ''}>${escapeHtml(proj.name)}</span>` : '';
        })() : '';
        const hiddenClass = showAllSessions && i >= SESSION_PREVIEW ? ' start-hidden-item' : '';
        html += `<div class="start-history-item${hiddenClass}">
          <div class="start-history-row"><span class="start-history-date">${date} ${time}</span>${projBadge}<span class="start-history-dur">${dur}</span></div>
          <div class="start-history-stats"><span>&#10003; ${completed}/${sessionTasks.length} tasks</span>${carriedStr}</div>
        </div>`;
      }
      html += '</div>';
      if (showAllSessions) {
        html += `<button class="start-toggle-btn" data-target="session-history-list" data-count="${endedSessions.length}">Show all ${endedSessions.length} sessions</button>`;
      }
      html += '</div>';
    }

    // Completed tasks — filtered by active project
    const allCompletedTasks = state.tasks
      .filter((t) => t.status === 'completed')
      .sort((a, b) => new Date(b.completedAt ?? b.createdAt).getTime() - new Date(a.completedAt ?? a.createdAt).getTime());

    const completedTasks = activeProjectId
      ? allCompletedTasks.filter((t) => {
          const sess = state!.sessions.find((s) => s.id === t.sessionId);
          return sess?.projectId === activeProjectId;
        })
      : allCompletedTasks;

    const TASK_PREVIEW = 5;
    if (completedTasks.length > 0) {
      const showAllTasks = completedTasks.length > TASK_PREVIEW;
      html += `<div class="start-section"><div class="start-section-header"><h3>&#10003; Completed Tasks <span class="start-section-count">(${completedTasks.length})</span></h3></div><div class="start-section-list start-section-scrollable" id="completed-tasks-list">`;
      for (let i = 0; i < completedTasks.length; i++) {
        const t = completedTasks[i];
        const when = t.completedAt ? getTimeAgo(t.completedAt) : getTimeAgo(t.createdAt);
        const timeStr = (t.timeSpentMs || 0) > 0 ? ` (${formatDurationCompact(t.timeSpentMs)})` : '';
        const hiddenClass = showAllTasks && i >= TASK_PREVIEW ? ' start-hidden-item' : '';
        html += `<div class="start-completed-item${hiddenClass}">
          <span class="start-completed-title">${escapeHtml(t.title)}${timeStr}</span>
          <div class="start-completed-meta"><span class="task-tag ${t.tag}">${TAG_LABELS[t.tag]}</span><span class="start-completed-time">${when}</span></div>
        </div>`;
      }
      html += '</div>';
      if (showAllTasks) {
        html += `<button class="start-toggle-btn" data-target="completed-tasks-list" data-count="${completedTasks.length}">Show all ${completedTasks.length} tasks</button>`;
      }
      html += '</div>';
    }
  }

  // Clear all data (shown when there's data to clear)
  if (state && (state.sessions.length > 0 || state.tasks.length > 0)) {
    html += `<div class="start-section"><div class="start-section-header"><h3>&#128465; Danger Zone</h3></div>
      <p style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:8px;">Permanently delete all sessions, tasks, and boards. This cannot be undone. Consider exporting first.</p>
      <button class="secondary danger-btn" id="btn-clear-all-data">Clear All Data</button>
    </div>`;
  }

  html += '</div>';
  return html;
}

function renderEmptyState(): string { return renderNoSessionState(); }

// ============================================================
// Event Binding
// ============================================================

function bindEvents(): void {
  // Start session
  document.querySelectorAll<HTMLElement>('.btn-start-session').forEach((el) => {
    el.addEventListener('click', () => showStartSessionDialog());
  });

  // End session — show session picker
  document.getElementById('btn-end-session')?.addEventListener('click', () => {
    showEndSessionPicker();
  });

  // Pause session
  document.getElementById('btn-pause-session')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'pauseSession', payload: {} });
  });

  // Resume session
  document.getElementById('btn-resume-session')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'resumeSession', payload: {} });
  });

  // Undo
  document.getElementById('btn-undo')?.addEventListener('click', () => {
    if (undoAIImprove()) { return; }
    vscode.postMessage({ type: 'undo', payload: {} });
  });

  // Redo
  document.getElementById('btn-redo')?.addEventListener('click', () => {
    if (redoAIImprove()) { return; }
    vscode.postMessage({ type: 'redo', payload: {} });
  });

  // Help
  document.getElementById('btn-help')?.addEventListener('click', () => showHelp());

  // Edit project from session bar
  document.getElementById('session-project-edit')?.addEventListener('click', () => {
    const el = document.getElementById('session-project-edit');
    const projectId = el?.dataset.projectId;
    const project = projectId ? state?.projects?.find((p) => p.id === projectId) : null;
    if (project) { showRenameProjectDialog(projectId!, project.name); }
  });

  // Carried-over banner toggle
  document.getElementById('carried-over-toggle')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'carried-over-dismiss') { return; }
    const details = document.getElementById('carried-over-details');
    const expandBtn = document.querySelector('.carried-over-expand');
    if (details) {
      const isHidden = details.style.display === 'none';
      details.style.display = isHidden ? 'block' : 'none';
      if (expandBtn) { expandBtn.innerHTML = isHidden ? '&#9650;' : '&#9660;'; }
    }
  });

  // Carried-over banner dismiss
  document.getElementById('carried-over-dismiss')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const banner = document.getElementById('carried-over-banner');
    if (banner) { banner.style.display = 'none'; }
    if (state?.activeSessionId) { carriedOverDismissed.add(state.activeSessionId); }
  });

  // Start page show all / show less toggles
  document.querySelectorAll<HTMLButtonElement>('.start-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.target;
      const list = targetId ? document.getElementById(targetId) : null;
      if (!list) return;
      const isExpanded = list.classList.toggle('start-expanded');
      const count = btn.dataset.count || '';
      const isSessionList = targetId === 'session-history-list';
      if (isExpanded) {
        list.classList.add('start-scrollable-active');
        btn.textContent = isSessionList ? 'Show less' : 'Show less';
      } else {
        list.classList.remove('start-scrollable-active');
        btn.textContent = isSessionList ? `Show all ${count} sessions` : `Show all ${count} tasks`;
        list.scrollTop = 0;
      }
    });
  });

  // AI Summarize
  document.getElementById('btn-ai-summarize')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'aiSummarize', payload: {} });
  });

  // Automation — open task selection modal
  document.getElementById('btn-start-automation')?.addEventListener('click', () => {
    if (automationProgress) {
      // Already running — do nothing, bar is visible
      return;
    }
    showAutomationTaskPicker();
  });

  // Automation bar buttons
  document.getElementById('btn-auto-pause')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'pauseAutomation', payload: {} });
  });
  document.getElementById('btn-auto-resume')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'resumeAutomation', payload: {} });
  });
  document.getElementById('btn-auto-cancel')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'cancelAutomation', payload: {} });
  });
  document.getElementById('btn-auto-skip')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'skipAutomationTask', payload: {} });
  });
  document.getElementById('btn-auto-approve')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'approveAutomationTask', payload: {} });
  });
  document.getElementById('btn-auto-reject')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'rejectAutomationTask', payload: {} });
  });

  // Retry buttons in automation queue
  document.querySelectorAll<HTMLElement>('.auto-retry-btn').forEach((btn) => {
    const idx = parseInt(btn.dataset.retryIndex || '-1', 10);
    if (idx >= 0) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'retryAutomationTask', payload: { queueIndex: idx } });
      });
    }
  });

  // AI Rewrite Title
  document.getElementById('btn-ai-rewrite')?.addEventListener('click', () => {
    const input = document.getElementById('quick-add-input') as HTMLTextAreaElement | null;
    const title = input?.value.trim();
    if (title) { vscode.postMessage({ type: 'aiRewriteTitle', payload: { title } }); }
  });

  // Board switcher — click name to switch, X to close, double-click to rename
  document.querySelectorAll<HTMLElement>('[data-board-id]').forEach((tab) => {
    const boardId = tab.dataset.boardId!;
    // Click the tab to switch (delayed so dblclick can cancel it)
    tab.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-close-board]')) { return; }
      if (boardClickTimer) { clearTimeout(boardClickTimer); }
      boardClickTimer = setTimeout(() => {
        boardClickTimer = null;
        vscode.postMessage({ type: 'switchBoard', payload: { boardId } });
      }, 250);
    });
    // Double-click the name to rename
    const nameSpan = tab.querySelector<HTMLElement>('[data-board-name]');
    nameSpan?.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (boardClickTimer) { clearTimeout(boardClickTimer); boardClickTimer = null; }
      startBoardRename(boardId, nameSpan);
    });
  });
  // Close board buttons
  document.querySelectorAll<HTMLElement>('[data-close-board]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const boardId = btn.dataset.closeBoard!;
      const board = state?.boards?.find((b) => b.id === boardId);
      const name = board?.name || 'this board';
      showConfirmDialog(`Close "${name}"?`, 'This board and its tasks will be removed.', () => {
        vscode.postMessage({ type: 'closeBoards', payload: { boardIds: [boardId] } });
      });
    });
  });
  document.getElementById('btn-add-board')?.addEventListener('click', () => showNewBoardDialog());

  // Export & Import
  document.getElementById('btn-export-json')?.addEventListener('click', () => showExportProjectPicker('json'));
  document.getElementById('btn-export-csv')?.addEventListener('click', () => showExportProjectPicker('csv'));
  document.getElementById('btn-export-md')?.addEventListener('click', () => showExportProjectPicker('markdown'));
  document.getElementById('btn-export-jira')?.addEventListener('click', () => showJiraExportDialog());
  document.getElementById('btn-import-data')?.addEventListener('click', () => vscode.postMessage({ type: 'importData', payload: {} }));
  document.getElementById('btn-import-jira')?.addEventListener('click', () => showJiraImportDialog());

  // Project management
  document.getElementById('btn-create-project')?.addEventListener('click', () => showCreateProjectDialog());
  document.querySelectorAll<HTMLElement>('[data-project-id]').forEach((el) => {
    el.addEventListener('click', (e) => {
      // Ignore clicks on rename/delete action buttons
      if ((e.target as HTMLElement).closest('.project-action-btn')) { return; }
      const projectId = el.dataset.projectId || null;
      vscode.postMessage({ type: 'setActiveProject', payload: { projectId } });
    });
  });
  document.querySelectorAll<HTMLElement>('[data-rename-project]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const projectId = el.dataset.renameProject!;
      const project = state?.projects?.find((p) => p.id === projectId);
      if (project) { showRenameProjectDialog(projectId, project.name); }
    });
  });
  document.querySelectorAll<HTMLElement>('[data-delete-project]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const projectId = el.dataset.deleteProject!;
      const project = state?.projects?.find((p) => p.id === projectId);
      if (project) {
        showConfirmDialog(`Delete "${project.name}"?`, 'Sessions will be unlinked but not deleted.', () => {
          vscode.postMessage({ type: 'deleteProject', payload: { projectId } });
        });
      }
    });
  });

  // Clear all data
  document.getElementById('btn-clear-all-data')?.addEventListener('click', () => vscode.postMessage({ type: 'clearAllData', payload: {} }));

  // Settings button
  document.getElementById('btn-settings')?.addEventListener('click', () => showSettingsDialog());

  // Templates — populate quick-add textarea instead of auto-creating
  document.querySelectorAll<HTMLElement>('[data-template]').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.template!, 10);
      const tmpl = TEMPLATES[idx];
      if (!tmpl) { return; }
      const input = document.getElementById('quick-add-input') as HTMLTextAreaElement;
      if (!input) { return; }
      const text = tmpl.description ? `${tmpl.title}\n${tmpl.description}` : tmpl.title;
      input.value = text;
      input.style.height = 'auto';
      input.style.height = input.scrollHeight + 'px';
      // Set dropdowns
      quickAddTag = tmpl.tag;
      quickAddPriority = tmpl.priority;
      quickAddCol = tmpl.col;
      const tagSel = document.getElementById('quick-add-tag') as HTMLSelectElement;
      const priSel = document.getElementById('quick-add-priority') as HTMLSelectElement;
      const colSel = document.getElementById('quick-add-col') as HTMLSelectElement;
      if (tagSel) { tagSel.value = tmpl.tag; }
      if (priSel) { priSel.value = tmpl.priority; }
      if (colSel) { colSel.value = tmpl.col; }
      // Focus and place cursor at end of title prefix
      input.focus();
      const titleEnd = tmpl.title.length;
      input.setSelectionRange(titleEnd, titleEnd);
    });
  });

  // Timer toggle
  document.querySelectorAll<HTMLElement>('[data-timer]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'toggleTimer', payload: { id: el.dataset.timer! } });
    });
  });

  // Quick add
  bindQuickAdd();
  bindSearchFilter();

  // Column toggles (click + keyboard)
  document.querySelectorAll<HTMLElement>('[data-toggle]').forEach((el) => {
    const handler = () => {
      const colId = el.dataset.toggle!;
      collapsedColumns.has(colId) ? collapsedColumns.delete(colId) : collapsedColumns.add(colId);
      render();
    };
    el.addEventListener('click', handler);
    el.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); }
    });
  });

  // Checkboxes
  document.querySelectorAll<HTMLInputElement>('[data-complete]').forEach((el) => {
    el.addEventListener('change', () => {
      if (el.checked) {
        vscode.postMessage({ type: 'completeTask', payload: { id: el.dataset.complete! } });
      } else {
        vscode.postMessage({ type: 'moveTask', payload: { id: el.dataset.complete!, newStatus: 'up-next', newOrder: 0 } });
      }
    });
  });

  // Double-click to edit (on card or title)
  document.querySelectorAll<HTMLElement>('.task-card:not(.editing)').forEach((card) => {
    card.addEventListener('dblclick', (e) => {
      // Don't trigger on buttons, checkboxes, or action controls
      const target = e.target as HTMLElement;
      if (target.closest('.task-actions') || target.closest('.task-checkbox')) { return; }
      editingTaskId = card.dataset.taskId!;
      render();
      setTimeout(() => {
        const input = document.querySelector(`[data-save-title="${editingTaskId}"]`) as HTMLInputElement;
        input?.focus(); input?.select();
      }, 0);
    });
  });

  // Edit button
  document.querySelectorAll<HTMLElement>('[data-edit]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      editingTaskId = el.dataset.edit!;
      render();
      setTimeout(() => {
        const input = document.querySelector(`[data-save-title="${editingTaskId}"]`) as HTMLInputElement;
        input?.focus(); input?.select();
      }, 0);
    });
  });

  // Context menu button
  document.querySelectorAll<HTMLElement>('[data-context]').forEach((el) => {
    el.addEventListener('click', (e) => { e.stopPropagation(); showContextMenu(el.dataset.context!, e); });
  });

  // Send to Copilot button
  document.querySelectorAll<HTMLElement>('[data-send-copilot]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'sendToCopilot', payload: { taskId: el.dataset.sendCopilot! } });
    });
  });

  // Attach file button (both on task card actions and in edit form)
  document.querySelectorAll<HTMLElement>('[data-add-attachment]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'addAttachment', payload: { taskId: el.dataset.addAttachment! } });
    });
  });

  // Remove attachment button (in edit form)
  document.querySelectorAll<HTMLElement>('[data-remove-attachment]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const taskId = el.dataset.removeTask!;
      const attachmentId = el.dataset.removeAttachment!;
      vscode.postMessage({ type: 'removeAttachment', payload: { taskId, attachmentId } });
    });
  });

  // Attachment thumbnail preview (click to view full size)
  document.querySelectorAll<HTMLElement>('[data-preview-attachment]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const img = el as HTMLImageElement;
      showImagePreview(img.src, img.alt);
    });
  });

  // Follow-up section bindings
  bindFollowUpEvents();

  // Copilot action buttons (persistent on cards)
  bindCopilotActionButtons();

  // Right-click context menu
  document.querySelectorAll<HTMLElement>('.task-card:not(.editing)').forEach((card) => {
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      showContextMenu(card.dataset.taskId!, e);
    });
  });

  // Keyboard navigation on task cards
  document.querySelectorAll<HTMLElement>('.task-card:not(.editing)').forEach((card) => {
    card.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); editingTaskId = card.dataset.taskId!; render(); }
      if (e.key === 'Delete') { e.preventDefault(); showDeleteConfirm(card.dataset.taskId!, findTask(card.dataset.taskId!)?.title ?? ''); }
    });
  });

  bindEditEvents();
  bindDragAndDrop();
}

function bindQuickAdd(): void {
  const addBtn = document.getElementById('btn-quick-add');
  const addInput = document.getElementById('quick-add-input') as HTMLTextAreaElement | null;
  const addTag = document.getElementById('quick-add-tag') as HTMLSelectElement | null;
  const addPriority = document.getElementById('quick-add-priority') as HTMLSelectElement | null;
  const addCol = document.getElementById('quick-add-col') as HTMLSelectElement | null;

  const doAdd = () => {
    if (!addInput || !addTag || !addCol) { return; }
    const rawText = addInput.value.trim();
    if (!rawText) { return; }

    // First line is the title, everything after is the description
    const lines = rawText.split('\n');
    const title = lines[0].trim();
    const description = lines.slice(1).join('\n').trim() || pendingAIDescription || undefined;

    const payload: Record<string, unknown> = {
      title,
      tag: addTag.value as TaskTag,
      priority: (addPriority?.value ?? 'medium') as TaskPriority,
      status: addCol.value as TaskStatus,
      description,
    };

    // Include pending attachments if any
    if (pendingQuickAddAttachments.length > 0) {
      payload.attachments = pendingQuickAddAttachments;
    }

    vscode.postMessage({ type: 'addTask', payload });
    addInput.value = '';
    pendingAIDescription = '';
    pendingQuickAddAttachments = [];
    pendingAIClassification = null;
    // Reset dropdown state to defaults
    quickAddTag = 'feature';
    quickAddPriority = 'medium';
    quickAddCol = 'up-next';
    addInput.focus();
  };

  addBtn?.addEventListener('click', doAdd);
  addInput?.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doAdd(); }
  });

  // Track dropdown changes in state so they persist across re-renders
  addTag?.addEventListener('change', () => { quickAddTag = addTag.value; pendingAIClassification = null; });
  addPriority?.addEventListener('change', () => { quickAddPriority = addPriority.value; pendingAIClassification = null; });
  addCol?.addEventListener('change', () => { quickAddCol = addCol.value; pendingAIClassification = null; });

  // Paste image into quick-add textarea → pending attachment
  addInput?.addEventListener('paste', (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) { return; }
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (!blob) { continue; }
        const reader = new FileReader();
        reader.onload = () => {
          const dataUri = reader.result as string;
          if (dataUri) {
            const mimeMatch = dataUri.match(/^data:([^;]+);/);
            const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
            pendingQuickAddAttachments.push({
              id: 'qa-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
              filename: `paste-${Date.now()}.png`,
              mimeType,
              dataUri,
              addedAt: new Date().toISOString(),
            });
            render();
          }
        };
        reader.readAsDataURL(blob);
        break;
      }
    }
  });

  // Voice input button
  document.getElementById('btn-voice')?.addEventListener('click', () => {
    toggleVoiceRecording();
  });

  // Attach file to quick-add
  document.getElementById('btn-quick-attach')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'pickFilesForQuickAdd', payload: {} });
  });

  // Remove pending attachment
  document.querySelectorAll<HTMLElement>('[data-remove-pending]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const removeId = el.dataset.removePending!;
      pendingQuickAddAttachments = pendingQuickAddAttachments.filter(a => a.id !== removeId);
      render();
    });
  });
}

function bindSearchFilter(): void {
  const searchInput = document.getElementById('search-input') as HTMLInputElement | null;
  const filterTagSelect = document.getElementById('filter-tag') as HTMLSelectElement | null;
  const filterPrioSelect = document.getElementById('filter-priority') as HTMLSelectElement | null;

  searchInput?.addEventListener('input', () => {
    searchQuery = searchInput.value;
    render();
    setTimeout(() => {
      const input = document.getElementById('search-input') as HTMLInputElement;
      if (input) { input.focus(); input.selectionStart = input.selectionEnd = searchQuery.length; }
    }, 0);
  });

  filterTagSelect?.addEventListener('change', () => { filterTag = filterTagSelect.value as TaskTag | 'all'; render(); });
  filterPrioSelect?.addEventListener('change', () => { filterPriority = filterPrioSelect.value as TaskPriority | 'all'; render(); });
}

// ============================================================
// Voice Input (Speech Recognition)
// ============================================================

function initVoiceRecognition(): void {
  const SpeechRecognition = (window as unknown as Record<string, unknown>).SpeechRecognition
    || (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
  if (!SpeechRecognition) { return; }

  const recognition = new (SpeechRecognition as new () => SpeechRecognitionInstance)();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = (event: SpeechRecognitionEvent) => {
    const input = document.getElementById(voiceTargetId) as HTMLTextAreaElement | null;
    if (!input) { return; }

    let finalTranscript = '';
    let interimTranscript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        finalTranscript += result[0].transcript;
      } else {
        interimTranscript += result[0].transcript;
      }
    }

    if (finalTranscript) {
      const existing = input.value.trim();
      input.value = existing ? existing + ' ' + finalTranscript.trim() : finalTranscript.trim();
    } else if (interimTranscript) {
      const existing = input.value;
      const marker = '|INTERIM|';
      const base = existing.includes(marker) ? existing.split(marker)[0] : existing;
      input.value = base + marker + interimTranscript;
    }
  };

  recognition.onend = () => {
    isVoiceRecording = false;
    const input = document.getElementById(voiceTargetId) as HTMLTextAreaElement | null;
    if (input && input.value.includes('|INTERIM|')) {
      input.value = input.value.split('|INTERIM|')[0];
    }
    updateVoiceButton();
  };

  recognition.onerror = () => {
    isVoiceRecording = false;
    updateVoiceButton();
  };

  voiceRecognition = recognition;
}

function toggleVoiceRecording(targetElement?: HTMLTextAreaElement | null): void {
  // Set voice target based on which textarea we're recording to
  if (targetElement) {
    voiceTargetId = targetElement.id || 'quick-add-input';
  } else {
    voiceTargetId = 'quick-add-input';
  }

  if (!voiceRecognition) { initVoiceRecognition(); }
  if (!voiceRecognition) {
    const input = document.getElementById(voiceTargetId) as HTMLTextAreaElement | null;
    if (input) { input.placeholder = 'Voice input not supported in this environment'; }
    return;
  }

  const recognition = voiceRecognition as SpeechRecognitionInstance;
  if (isVoiceRecording) {
    recognition.stop();
    isVoiceRecording = false;
  } else {
    const input = document.getElementById(voiceTargetId) as HTMLTextAreaElement | null;
    if (input && input.value.includes('|INTERIM|')) {
      input.value = input.value.split('|INTERIM|')[0];
    }
    recognition.start();
    isVoiceRecording = true;
  }
  updateVoiceButton();
}

function updateVoiceButton(): void {
  const btn = document.getElementById('btn-voice');
  const fuBtn = document.getElementById('btn-follow-up-voice');
  for (const b of [btn, fuBtn]) {
    if (!b) { continue; }
    b.classList.toggle('recording', isVoiceRecording);
    b.title = isVoiceRecording ? 'Stop recording' : 'Voice input';
    b.setAttribute('aria-label', isVoiceRecording ? 'Stop voice recording' : 'Start voice recording');
  }
}

// Minimal type shims for SpeechRecognition (not in all TS libs)
interface SpeechRecognitionEvent {
  resultIndex: number;
  results: { length: number; [index: number]: { isFinal: boolean; 0: { transcript: string } } };
}

interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
}

function bindEditEvents(): void {
  document.querySelectorAll<HTMLElement>('[data-save-edit]').forEach((el) => {
    el.addEventListener('click', () => saveEdit(el.dataset.saveEdit!));
  });
  document.querySelectorAll<HTMLElement>('[data-cancel-edit]').forEach((el) => {
    el.addEventListener('click', () => { editingTaskId = null; render(); });
  });
  document.querySelectorAll<HTMLInputElement>('[data-save-title]').forEach((el) => {
    el.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); saveEdit(el.dataset.saveTitle!); }
      if (e.key === 'Escape') { editingTaskId = null; render(); }
    });
  });
  // Auto-resize description textareas to fit content
  document.querySelectorAll<HTMLTextAreaElement>('[data-save-desc]').forEach((ta) => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(Math.max(ta.scrollHeight, 80), 300) + 'px';
    ta.addEventListener('input', () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(Math.max(ta.scrollHeight, 80), 300) + 'px';
    });
    // Paste image support — paste an image from clipboard into the edit form
    ta.addEventListener('paste', (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) { return; }
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (!blob) { continue; }
          const reader = new FileReader();
          reader.onload = () => {
            const dataUri = reader.result as string;
            const taskId = editingTaskId;
            if (taskId && dataUri) {
              vscode.postMessage({
                type: 'pasteAttachment',
                payload: { taskId, dataUri, filename: `paste-${Date.now()}.png` },
              });
            }
          };
          reader.readAsDataURL(blob);
          break;
        }
      }
    });
  });
}

function saveEdit(taskId: string): void {
  const titleInput = document.querySelector(`[data-save-title="${taskId}"]`) as HTMLInputElement;
  const descInput = document.querySelector(`[data-save-desc="${taskId}"]`) as HTMLTextAreaElement;
  const tagSelect = document.querySelector(`[data-save-tag="${taskId}"]`) as HTMLSelectElement;
  const prioSelect = document.querySelector(`[data-save-priority="${taskId}"]`) as HTMLSelectElement;

  if (!titleInput) { return; }
  const title = titleInput.value.trim();
  if (!title) { return; }

  const changes: Record<string, string> = { title };
  if (descInput) { changes.description = descInput.value; }
  if (tagSelect) { changes.tag = tagSelect.value; }
  if (prioSelect) { changes.priority = prioSelect.value; }

  vscode.postMessage({ type: 'updateTask', payload: { id: taskId, changes } });
  editingTaskId = null;
}

// ============================================================
// Copilot Follow-up Bindings
// ============================================================

function bindFollowUpEvents(): void {
  if (!followUpTaskId) { return; }

  const followUpInput = document.getElementById('follow-up-input') as HTMLTextAreaElement | null;
  const sendBtn = document.getElementById('btn-follow-up-send');
  const doneBtn = document.getElementById('btn-follow-up-done');
  const cancelBtn = document.getElementById('btn-follow-up-cancel');
  const voiceBtn = document.getElementById('btn-follow-up-voice');
  const attachBtn = document.getElementById('btn-follow-up-attach');

  // Enter key sends follow-up (Shift+Enter for new line)
  followUpInput?.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBtn?.click();
    }
  });

  // Send follow-up
  sendBtn?.addEventListener('click', () => {
    if (!followUpInput || !followUpTaskId) { return; }
    const prompt = followUpInput.value.trim();
    if (!prompt && pendingFollowUpAttachments.length === 0) { return; }
    const contextCheck = document.getElementById('follow-up-include-context') as HTMLInputElement | null;
    const includeProjectContext = contextCheck ? contextCheck.checked : true;
    const payload: Record<string, unknown> = { taskId: followUpTaskId, prompt: prompt || '(image attachment)', includeProjectContext };
    if (pendingFollowUpAttachments.length > 0) {
      payload.attachments = pendingFollowUpAttachments;
    }
    vscode.postMessage({ type: 'sendFollowUp', payload });
    followUpTaskId = null;
    pendingFollowUpAttachments = [];
    render();
  });

  // Mark complete
  doneBtn?.addEventListener('click', () => {
    if (!followUpTaskId) { return; }
    vscode.postMessage({ type: 'completeTask', payload: { id: followUpTaskId } });
    followUpTaskId = null;
    pendingFollowUpAttachments = [];
    render();
  });

  // Cancel
  cancelBtn?.addEventListener('click', () => {
    followUpTaskId = null;
    pendingFollowUpAttachments = [];
    render();
  });

  // Voice input for follow-up
  voiceBtn?.addEventListener('click', () => {
    toggleVoiceRecording(followUpInput);
  });

  // Attach file for follow-up
  attachBtn?.addEventListener('click', () => {
    if (followUpTaskId) {
      vscode.postMessage({ type: 'pickFilesForFollowUp', payload: { taskId: followUpTaskId } });
    }
  });

  // Paste image into follow-up textarea
  followUpInput?.addEventListener('paste', (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) { return; }
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (!blob) { continue; }
        const reader = new FileReader();
        reader.onload = () => {
          const dataUri = reader.result as string;
          if (dataUri) {
            const mimeMatch = dataUri.match(/^data:([^;]+);/);
            const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
            pendingFollowUpAttachments.push({
              id: 'fu-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
              filename: `paste-${Date.now()}.png`,
              mimeType,
              dataUri,
              addedAt: new Date().toISOString(),
            });
            render();
          }
        };
        reader.readAsDataURL(blob);
        break;
      }
    }
  });

  // Remove pending follow-up attachment
  document.querySelectorAll<HTMLElement>('[data-remove-followup-att]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const removeId = el.dataset.removeFollowupAtt!;
      pendingFollowUpAttachments = pendingFollowUpAttachments.filter(a => a.id !== removeId);
      render();
    });
  });

  // Auto-focus the follow-up textarea
  followUpInput?.focus();
}

function bindCopilotActionButtons(): void {
  // Mark Complete from persistent copilot action bar
  document.querySelectorAll<HTMLElement>('[data-copilot-complete]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const taskId = el.dataset.copilotComplete!;
      followUpTaskId = null;
      pendingFollowUpAttachments = [];
      vscode.postMessage({ type: 'completeTask', payload: { id: taskId } });
    });
  });

  // Follow Up from persistent copilot action bar
  document.querySelectorAll<HTMLElement>('[data-copilot-followup]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const taskId = el.dataset.copilotFollowup!;
      followUpTaskId = taskId;
      pendingFollowUpAttachments = [];
      render();
    });
  });

  // Dismiss copilot pending state
  document.querySelectorAll<HTMLElement>('[data-copilot-dismiss]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const taskId = el.dataset.copilotDismiss!;
      followUpTaskId = null;
      pendingFollowUpAttachments = [];
      vscode.postMessage({ type: 'copilotDismiss', payload: { taskId } });
    });
  });
}

// ============================================================
// Drag & Drop
// ============================================================

function bindDragAndDrop(): void {
  document.querySelectorAll<HTMLElement>('.task-card:not(.editing)').forEach((card) => {
    card.addEventListener('dragstart', (e: DragEvent) => {
      draggedTaskId = card.dataset.taskId ?? null;
      card.classList.add('dragging');
      e.dataTransfer!.effectAllowed = 'move';
      e.dataTransfer?.setData('text/plain', draggedTaskId ?? '');
      document.body.classList.add('is-dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      draggedTaskId = null;
      document.body.classList.remove('is-dragging');
      document.querySelectorAll('.drag-over, .drag-above, .drag-below').forEach((el) => el.classList.remove('drag-over', 'drag-above', 'drag-below'));
    });
  });

  document.querySelectorAll<HTMLElement>('[data-dropzone]').forEach((zone) => {
    zone.addEventListener('dragover', (e: DragEvent) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'move';
      zone.classList.add('drag-over');
      const cards = Array.from(zone.querySelectorAll<HTMLElement>('.task-card'));
      cards.forEach((c) => c.classList.remove('drag-above', 'drag-below'));
      if (cards.length > 0) {
        let closest: HTMLElement | null = null;
        let closestDist = Infinity;
        for (const c of cards) {
          const rect = c.getBoundingClientRect();
          const dist = Math.abs(e.clientY - (rect.top + rect.height / 2));
          if (dist < closestDist) { closestDist = dist; closest = c; }
        }
        if (closest) {
          const rect = closest.getBoundingClientRect();
          if (e.clientY < rect.top + rect.height / 2) { closest.classList.add('drag-above'); }
          else { closest.classList.add('drag-below'); }
        }
      }
    });

    zone.addEventListener('dragleave', (e: DragEvent) => {
      const rect = zone.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
        zone.classList.remove('drag-over');
        zone.querySelectorAll('.drag-above, .drag-below').forEach((el) => el.classList.remove('drag-above', 'drag-below'));
      }
    });

    zone.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      zone.querySelectorAll('.drag-above, .drag-below').forEach((el) => el.classList.remove('drag-above', 'drag-below'));
      const taskId = e.dataTransfer?.getData('text/plain');
      const newStatus = zone.dataset.dropzone as TaskStatus;
      if (!taskId || !newStatus) { return; }
      const cards = Array.from(zone.querySelectorAll<HTMLElement>('.task-card'));
      let newOrder = 0;
      for (let i = 0; i < cards.length; i++) {
        const rect = cards[i].getBoundingClientRect();
        if (e.clientY > rect.top + rect.height / 2) { newOrder = i + 1; }
      }
      vscode.postMessage({ type: 'moveTask', payload: { id: taskId, newStatus, newOrder } });
    });
  });
}

// ============================================================
// Context Menu
// ============================================================

function showContextMenu(taskId: string, event: Event): void {
  const existing = document.getElementById('context-menu');
  if (existing) { existing.remove(); }
  contextMenuTaskId = taskId;
  const task = findTask(taskId);
  if (!task) { return; }

  const mouseEvent = event as MouseEvent;
  const moveOpts = COLUMNS.filter((col) => col.id !== task.status)
    .map((col) => `<div class="ctx-item" data-ctx-move="${col.id}" role="menuitem">Move to ${col.label}</div>`)
    .join('');

  const menu = document.createElement('div');
  menu.id = 'context-menu';
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <div class="ctx-item" data-ctx-edit role="menuitem">&#9998; Edit</div>
    <div class="ctx-separator" role="separator"></div>
    ${moveOpts}
    <div class="ctx-separator" role="separator"></div>
    <div class="ctx-item" data-ctx-complete role="menuitem">${task.status === 'completed' ? '&#8634; Reopen' : '&#10003; Complete'}</div>
    <div class="ctx-item" data-ctx-timer role="menuitem">${task.timerStartedAt ? '&#9209; Stop Timer' : '&#9654; Start Timer'}</div>
    <div class="ctx-separator" role="separator"></div>
    <div class="ctx-item" data-ctx-ai-breakdown role="menuitem">&#10024; AI Breakdown</div>
    <div class="ctx-item" data-ctx-send-copilot role="menuitem">&#128640; Send to Copilot</div>
    <div class="ctx-separator" role="separator"></div>
    <div class="ctx-item danger" data-ctx-delete role="menuitem">&#128465; Delete</div>`;

  const x = Math.min(mouseEvent.clientX, window.innerWidth - 160);
  menu.style.left = `${x}px`;
  menu.style.top = `0px`;
  menu.style.visibility = 'hidden';
  document.body.appendChild(menu);

  // Measure actual menu height and flip upward if it would clip
  const menuRect = menu.getBoundingClientRect();
  const menuHeight = menuRect.height;
  let y = mouseEvent.clientY;
  if (y + menuHeight > window.innerHeight) {
    y = Math.max(0, y - menuHeight);
  }
  menu.style.top = `${y}px`;
  menu.style.visibility = 'visible';

  menu.addEventListener('click', (e) => {
    e.stopPropagation();
    const target = e.target as HTMLElement;
    if (target.hasAttribute('data-ctx-edit')) { editingTaskId = taskId; render(); }
    else if (target.hasAttribute('data-ctx-complete')) {
      if (task.status === 'completed') { vscode.postMessage({ type: 'moveTask', payload: { id: taskId, newStatus: 'up-next', newOrder: 0 } }); }
      else { vscode.postMessage({ type: 'completeTask', payload: { id: taskId } }); }
    }
    else if (target.hasAttribute('data-ctx-timer')) { vscode.postMessage({ type: 'toggleTimer', payload: { id: taskId } }); }
    else if (target.hasAttribute('data-ctx-ai-breakdown')) { vscode.postMessage({ type: 'aiBreakdown', payload: { taskId } }); }
    else if (target.hasAttribute('data-ctx-send-copilot')) { vscode.postMessage({ type: 'sendToCopilot', payload: { taskId } }); }
    else if (target.hasAttribute('data-ctx-delete')) { showDeleteConfirm(taskId, task.title); }
    else if (target.dataset.ctxMove) { vscode.postMessage({ type: 'moveTask', payload: { id: taskId, newStatus: target.dataset.ctxMove as TaskStatus, newOrder: 0 } }); }
    menu.remove();
    contextMenuTaskId = null;
  });
}

// ============================================================
// Settings Dialog
// ============================================================

function showSettingsDialog(): void {
  const existing = document.querySelector('.settings-overlay');
  if (existing) { existing.remove(); return; }

  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Settings');
  overlay.innerHTML = `<div class="modal-card settings-dialog">
    <div class="settings-dialog-header">
      <h3>&#9881; Settings</h3>
      <button class="icon-btn" id="settings-close-btn" aria-label="Close settings">&times;</button>
    </div>
    <div class="start-settings">
      <label class="start-setting-row">
        <input type="checkbox" class="setting-checkbox" data-setting="autoBackup" ${extensionSettings.autoBackup ? 'checked' : ''} />
        <span class="start-setting-label">Auto-Backup</span>
        <span class="start-setting-desc">Automatically back up data to .vibeboard/backups/</span>
      </label>
      <label class="start-setting-row" id="setting-row-backup-count" style="${extensionSettings.autoBackup ? '' : 'opacity:0.5;pointer-events:none;'}">
        <span class="start-setting-label">Max Backup Files</span>
        <input type="number" class="setting-number" data-setting="autoBackupMaxCount" value="${extensionSettings.autoBackupMaxCount}" min="1" max="100" />
      </label>
      <label class="start-setting-row" id="setting-row-backup-interval" style="${extensionSettings.autoBackup ? '' : 'opacity:0.5;pointer-events:none;'}">
        <span class="start-setting-label">Backup Interval</span>
        <input type="number" class="setting-number" data-setting="autoBackupIntervalMin" value="${extensionSettings.autoBackupIntervalMin}" min="1" max="60" />
        <span class="start-setting-desc">minutes</span>
      </label>
      <label class="start-setting-row">
        <input type="checkbox" class="setting-checkbox" data-setting="autoPromptSession" ${extensionSettings.autoPromptSession ? 'checked' : ''} />
        <span class="start-setting-label">Auto-Prompt Session</span>
        <span class="start-setting-desc">Prompt to start a session when VS Code opens</span>
      </label>
      <label class="start-setting-row">
        <input type="checkbox" class="setting-checkbox" data-setting="carryOverTasks" ${extensionSettings.carryOverTasks ? 'checked' : ''} />
        <span class="start-setting-label">Carry-Over Tasks</span>
        <span class="start-setting-desc">Carry over unfinished tasks to the next session</span>
      </label>
    </div>
    <div class="settings-section-divider"></div>
    <h4 class="settings-section-title">&#127919; Jira Integration</h4>
    <p class="settings-section-desc">Export tasks as Jira issues. Your email and API token are stored securely in your OS keychain — never in plain text.</p>
    <div class="start-settings" style="margin-bottom:8px;">
      <label class="start-setting-row">
        <input type="checkbox" id="jira-prompt-toggle" ${!(state as Record<string, unknown>)?.jiraPromptDismissed ? 'checked' : ''} />
        <span class="start-setting-label">End-Session Export Prompt</span>
      </label>
    </div>
    <div class="jira-save-row" style="margin-bottom:8px;">
      <button class="secondary" id="jira-test-btn">&#128267; Test Connection</button>
      <span class="jira-save-status" id="jira-test-status"></span>
    </div>
    <div class="start-settings">
      <label class="start-setting-row setting-text-row">
        <span class="start-setting-label">Base URL</span>
        <input type="text" class="setting-text jira-setting" data-setting="jiraBaseUrl" value="${escapeHtml(extensionSettings.jiraBaseUrl)}" placeholder="https://your-domain.atlassian.net" />
      </label>
      <label class="start-setting-row setting-text-row">
        <span class="start-setting-label">Email</span>
        <input type="text" class="setting-text jira-setting" data-setting="jiraEmail" value="${escapeHtml(extensionSettings.jiraEmail)}" placeholder="you@example.com" />
      </label>
      <label class="start-setting-row setting-text-row">
        <span class="start-setting-label">API Token</span>
        <input type="password" class="setting-text jira-setting" data-setting="jiraApiToken" value="${extensionSettings.jiraConfigured ? '\u2022'.repeat(extensionSettings.jiraApiTokenLength || 8) : ''}" placeholder="Paste your API token" />
      </label>
      <p class="settings-hint" style="margin-top:4px;">Generate a token at <a href="https://id.atlassian.com/manage-profile/security/api-tokens" class="jira-link">id.atlassian.com</a></p>
      <div class="jira-save-row">
        <button class="secondary" id="jira-save-btn">Save</button>
        <span class="jira-save-status" id="jira-save-status"></span>
      </div>
    </div>

  </div>`;
  document.body.appendChild(overlay);

  // Close button
  document.getElementById('settings-close-btn')?.addEventListener('click', () => overlay.remove());

  // Click outside to close
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) { overlay.remove(); }
  });

  // Escape to close
  const escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      overlay.remove();
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);

  // Settings toggles
  overlay.querySelectorAll<HTMLInputElement>('.setting-checkbox').forEach((cb) => {
    cb.addEventListener('change', () => {
      const key = cb.dataset.setting;
      if (!key) { return; }
      vscode.postMessage({ type: 'updateSetting', payload: { key, value: cb.checked } });
      (extensionSettings as Record<string, unknown>)[key] = cb.checked;
      if (key === 'autoBackup') {
        for (const rowId of ['#setting-row-backup-count', '#setting-row-backup-interval']) {
          const row = overlay.querySelector(rowId) as HTMLElement;
          if (row) {
            row.style.opacity = cb.checked ? '1' : '0.5';
            row.style.pointerEvents = cb.checked ? 'auto' : 'none';
          }
        }
      }
    });
  });
  overlay.querySelectorAll<HTMLInputElement>('.setting-number').forEach((input) => {
    input.addEventListener('change', () => {
      const key = input.dataset.setting;
      if (!key) { return; }
      const val = Math.max(Number(input.min) || 1, Math.min(Number(input.max) || 100, parseInt(input.value, 10) || 10));
      input.value = String(val);
      vscode.postMessage({ type: 'updateSetting', payload: { key, value: val } });
      (extensionSettings as Record<string, unknown>)[key] = val;
    });
  });

  // Jira end-session prompt toggle
  document.getElementById('jira-prompt-toggle')?.addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    vscode.postMessage({ type: 'setJiraPromptDismissed', payload: { dismissed: !checked } });
  });

  // Jira Save button — sends credentials via secure saveJiraCredentials message
  let jiraTokenMask = '\u2022'.repeat(extensionSettings.jiraApiTokenLength || 8); // match real token length
  document.getElementById('jira-save-btn')?.addEventListener('click', () => {
    const baseUrlInput = overlay.querySelector('[data-setting="jiraBaseUrl"]') as HTMLInputElement;
    const emailInput = overlay.querySelector('[data-setting="jiraEmail"]') as HTMLInputElement;
    const tokenInput = overlay.querySelector('[data-setting="jiraApiToken"]') as HTMLInputElement;

    const baseUrl = baseUrlInput?.value.trim() || '';
    const email = emailInput?.value.trim() || '';
    const tokenVal = tokenInput?.value.trim() || '';

    // Determine if a real token was entered (not the mask)
    const hasNewToken = !!(tokenVal && tokenVal !== jiraTokenMask);

    // Send to extension — empty token means "keep existing" in SecretStorage
    vscode.postMessage({
      type: 'saveJiraCredentials',
      payload: {
        baseUrl,
        email,
        token: hasNewToken ? tokenVal : '',
      },
    });

    // Update local state
    extensionSettings.jiraBaseUrl = baseUrl;
    if (email) { extensionSettings.jiraEmail = email; }
    if (hasNewToken) {
      jiraTokenMask = '\u2022'.repeat(tokenVal.length);
      extensionSettings.jiraApiTokenLength = tokenVal.length;
    }
    const tokenFilled = hasNewToken || extensionSettings.jiraConfigured;
    extensionSettings.jiraConfigured = !!(baseUrl && email && tokenFilled);

    // Mask the token field after save
    if (hasNewToken && tokenInput) {
      tokenInput.value = jiraTokenMask;
    }

    // Show saved confirmation
    const status = document.getElementById('jira-save-status');
    if (status) {
      status.textContent = '\u2713 Saved securely';
      setTimeout(() => { status.textContent = ''; }, 2500);
    }
  });

  // Clear placeholder dots when user focuses the token field
  const tokenInput = overlay.querySelector('[data-setting="jiraApiToken"]') as HTMLInputElement;
  tokenInput?.addEventListener('focus', () => {
    if (tokenInput.value === jiraTokenMask) {
      tokenInput.value = '';
    }
  });

  // Test Connection button
  document.getElementById('jira-test-btn')?.addEventListener('click', () => {
    const testStatus = document.getElementById('jira-test-status');
    const testBtn = document.getElementById('jira-test-btn') as HTMLButtonElement | null;
    if (testStatus) {
      testStatus.textContent = '\u23f3 Testing\u2026';
      testStatus.style.color = '';
    }
    if (testBtn) { testBtn.disabled = true; }
    vscode.postMessage({ type: 'testJiraConnection', payload: {} });
  });
}

// ============================================================
// Start Session Dialog
// ============================================================

function showStartSessionDialog(): void {
  const activeProjectId = state?.activeProjectId || '';
  const projectSessions = activeProjectId
    ? (state?.sessions || []).filter((s) => s.projectId === activeProjectId)
    : (state?.sessions || []);
  const sessionNumber = projectSessions.length + 1;
  const defaultName = `Session ${sessionNumber}`;
  const projects = state?.projects || [];

  const projectOptions = projects.map((p) =>
    `<option value="${p.id}"${p.id === activeProjectId ? ' selected' : ''}>${escapeHtml(p.name)}</option>`
  ).join('');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Start New Session');
  overlay.innerHTML = `<div class="modal-card">
    <h3>Start New Session</h3>
    <label style="font-size:11px;color:var(--vscode-descriptionForeground);display:block;margin-bottom:2px;">Session Name</label>
    <input type="text" id="session-name-input" placeholder="Session name..." value="${escapeAttr(defaultName)}" style="width:100%;padding:6px;margin:0 0 10px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:2px;" />
    <label style="font-size:11px;color:var(--vscode-descriptionForeground);display:block;margin-bottom:2px;">Project</label>
    <select id="session-project-select" style="width:100%;padding:6px;margin:0 0 4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:2px;">
      <option value="">No Project</option>
      ${projectOptions}
      <option value="__new__">+ New Project</option>
    </select>
    <div id="new-project-inline" style="display:none;margin-bottom:8px;">
      <input type="text" id="new-project-name" placeholder="Project name..." style="width:100%;padding:6px;margin:4px 0;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:2px;" />
      <div class="project-color-picker" style="margin:4px 0 0;">
        ${PROJECT_COLORS.map((c, i) => `<button type="button" class="project-color-btn${i === 0 ? ' selected' : ''}" data-color="${c}" style="background:${c};" aria-label="Color ${c}"></button>`).join('')}
      </div>
    </div>
    <div class="modal-actions" style="margin-top:8px;">
      <button class="secondary" id="modal-cancel">Cancel</button>
      <button id="modal-confirm">Start</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  const input = document.getElementById('session-name-input') as HTMLInputElement;
  input?.focus();
  input?.select();

  const projectSelect = document.getElementById('session-project-select') as HTMLSelectElement;
  const newProjectSection = document.getElementById('new-project-inline') as HTMLElement;
  const newProjectNameInput = document.getElementById('new-project-name') as HTMLInputElement;
  let selectedNewColor = PROJECT_COLORS[0];

  // Toggle inline new-project form when "+ New Project" is selected
  projectSelect.addEventListener('change', () => {
    if (projectSelect.value === '__new__') {
      newProjectSection.style.display = 'block';
      newProjectNameInput.focus();
    } else {
      newProjectSection.style.display = 'none';
    }
  });

  // Color picker in inline form
  newProjectSection.querySelectorAll<HTMLButtonElement>('.project-color-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      newProjectSection.querySelectorAll('.project-color-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedNewColor = btn.dataset.color || PROJECT_COLORS[0];
    });
  });

  const doStart = () => {
    const name = input?.value.trim() || defaultName;
    let projectId: string | undefined = projectSelect?.value || undefined;

    // Create new project inline if selected
    if (projectId === '__new__') {
      const newName = newProjectNameInput?.value.trim();
      if (!newName) { newProjectNameInput?.focus(); return; }
      const newId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
      vscode.postMessage({ type: 'createProject', payload: { name: newName, color: selectedNewColor, id: newId } });
      projectId = newId;
    }

    vscode.postMessage({ type: 'startSession', payload: { name, projectId } });
    overlay.remove();
  };

  document.getElementById('modal-confirm')!.addEventListener('click', doStart);
  input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { doStart(); } });
  document.getElementById('modal-cancel')!.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); } });
}

// ============================================================
// Project Dialogs
// ============================================================

const PROJECT_COLORS = ['#4CAF50', '#2196F3', '#FF9800', '#9C27B0', '#F44336', '#00BCD4'];

function showCreateProjectDialog(): void {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Create Project');

  const colorBtns = PROJECT_COLORS.map((c, i) =>
    `<button class="project-color-btn${i === 0 ? ' selected' : ''}" data-color="${c}" style="background:${c};" title="${c}"></button>`
  ).join('');

  overlay.innerHTML = `<div class="modal-card" style="max-width:380px;">
    <h3>New Project</h3>
    <label style="font-size:11px;color:var(--vscode-descriptionForeground);display:block;margin-bottom:2px;">Name</label>
    <input type="text" id="project-name-input" placeholder="Project name..." style="width:100%;padding:6px;margin:0 0 10px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:2px;" />
    <label style="font-size:11px;color:var(--vscode-descriptionForeground);display:block;margin-bottom:4px;">Color</label>
    <div class="project-color-picker">${colorBtns}</div>
    <label style="font-size:11px;color:var(--vscode-descriptionForeground);display:block;margin-bottom:2px;margin-top:8px;">Copilot Context <span style="opacity:0.6;">(optional)</span></label>
    <textarea id="project-context-input" placeholder="e.g. Always add comments, run tests, update help docs..." rows="3" style="width:100%;padding:6px;margin:0 0 10px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:2px;resize:vertical;font-family:inherit;font-size:12px;"></textarea>
    <p style="font-size:10px;color:var(--vscode-descriptionForeground);margin:0 0 8px;">These instructions are included with every Copilot prompt for tasks in this project.</p>
    <div class="modal-actions">
      <button class="secondary" id="modal-cancel">Cancel</button>
      <button id="modal-confirm">Create</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  let selectedColor = PROJECT_COLORS[0];
  overlay.querySelectorAll<HTMLElement>('.project-color-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      overlay.querySelectorAll('.project-color-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedColor = btn.dataset.color!;
    });
  });

  const input = document.getElementById('project-name-input') as HTMLInputElement;
  input?.focus();

  const doCreate = () => {
    const name = input?.value.trim();
    if (!name) { return; }
    const contextInput = document.getElementById('project-context-input') as HTMLTextAreaElement;
    const copilotContext = contextInput?.value.trim() || undefined;
    vscode.postMessage({ type: 'createProject', payload: { name, color: selectedColor, copilotContext } });
    overlay.remove();
  };

  document.getElementById('modal-confirm')!.addEventListener('click', doCreate);
  input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { doCreate(); } });
  document.getElementById('modal-cancel')!.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); } });
}

function showRenameProjectDialog(projectId: string, currentName: string): void {
  const project = state?.projects?.find((p) => p.id === projectId);
  const currentColor = project?.color || PROJECT_COLORS[0];
  const currentContext = project?.copilotContext || '';
  const contextEnabled = project?.copilotContextEnabled !== false;

  const colorBtns = PROJECT_COLORS.map((c) =>
    `<button class="project-color-btn${c === currentColor ? ' selected' : ''}" data-color="${c}" style="background:${c};" title="${c}"></button>`
  ).join('');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Edit Project');
  overlay.innerHTML = `<div class="modal-card" style="max-width:380px;">
    <h3>Edit Project</h3>
    <label style="font-size:11px;color:var(--vscode-descriptionForeground);display:block;margin-bottom:2px;">Name</label>
    <input type="text" id="project-rename-input" value="${escapeAttr(currentName)}" style="width:100%;padding:6px;margin:0 0 10px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:2px;" />
    <label style="font-size:11px;color:var(--vscode-descriptionForeground);display:block;margin-bottom:4px;">Color</label>
    <div class="project-color-picker">${colorBtns}</div>
    <label style="font-size:11px;color:var(--vscode-descriptionForeground);display:flex;align-items:center;gap:6px;margin-top:8px;margin-bottom:4px;cursor:pointer;">
      <input type="checkbox" id="project-context-toggle" ${contextEnabled ? 'checked' : ''} />
      <span>Copilot Context</span>
    </label>
    <textarea id="project-context-input" placeholder="e.g. Always add comments, run tests, update help docs..." rows="3" style="width:100%;padding:6px;margin:0 0 4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:2px;resize:vertical;font-family:inherit;font-size:12px;${contextEnabled ? '' : 'opacity:0.4;pointer-events:none;'}">${escapeHtml(currentContext)}</textarea>
    <p style="font-size:10px;color:var(--vscode-descriptionForeground);margin:0 0 8px;">These instructions are included with every Copilot prompt for tasks in this project.</p>
    <div class="modal-actions">
      <button class="secondary" id="modal-cancel">Cancel</button>
      <button id="modal-confirm">Save</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  // Toggle context textarea enabled/disabled
  const contextToggle = document.getElementById('project-context-toggle') as HTMLInputElement;
  const contextTextarea = document.getElementById('project-context-input') as HTMLTextAreaElement;
  contextToggle?.addEventListener('change', () => {
    if (contextToggle.checked) {
      contextTextarea.style.opacity = '1';
      contextTextarea.style.pointerEvents = 'auto';
    } else {
      contextTextarea.style.opacity = '0.4';
      contextTextarea.style.pointerEvents = 'none';
    }
  });

  let selectedColor = currentColor;
  overlay.querySelectorAll<HTMLElement>('.project-color-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      overlay.querySelectorAll('.project-color-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedColor = btn.dataset.color!;
    });
  });

  const input = document.getElementById('project-rename-input') as HTMLInputElement;
  input?.focus();
  input?.select();

  const doSave = () => {
    const name = input?.value.trim();
    if (!name) { return; }
    const contextInput = document.getElementById('project-context-input') as HTMLTextAreaElement;
    const contextToggleEl = document.getElementById('project-context-toggle') as HTMLInputElement;
    const copilotContext = contextInput?.value.trim() || undefined;
    const copilotContextEnabled = contextToggleEl?.checked ?? true;
    vscode.postMessage({ type: 'updateProject', payload: { projectId, changes: { name, color: selectedColor, copilotContext, copilotContextEnabled } } });
    overlay.remove();
  };

  document.getElementById('modal-confirm')!.addEventListener('click', doSave);
  input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { doSave(); } });
  document.getElementById('modal-cancel')!.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); } });
}

// ============================================================
// End Session Picker
// ============================================================

function showEndSessionPicker(): void {
  if (!state) { return; }
  const boards = state.boards ?? [];
  if (boards.length === 0) { return; }
  const activeBoardId = state.activeBoardId || 'default';

  // Determine which tasks will be carried over
  const incompleteTasks = state.tasks.filter(
    (t) => t.sessionId === state!.activeSessionId && t.status !== 'completed'
  );

  const TAG_COLORS: Record<string, string> = {
    feature: '#4CAF50', bug: '#F44336', refactor: '#2196F3', note: '#FF9800', plan: '#9C27B0', todo: '#00BCD4'
  };

  // Build carry-over section
  let carryOverHtml = '';
  if (incompleteTasks.length > 0) {
    // Group tasks by board
    const boardMap = new Map<string, typeof incompleteTasks>();
    for (const t of incompleteTasks) {
      const boardId = (t as any).boardId || 'default';
      if (!boardMap.has(boardId)) { boardMap.set(boardId, []); }
      boardMap.get(boardId)!.push(t);
    }

    let taskRows = '';
    for (const [boardId, boardTasks] of boardMap) {
      const board = boards.find((b) => b.id === boardId);
      const boardName = board?.name || 'Board';
      taskRows += `<div class="carryover-session-group">
        <div class="carryover-session-label">${escapeHtml(boardName)}</div>`;
      for (const t of boardTasks.slice(0, 15)) {
        const tagColor = TAG_COLORS[t.tag] || '#888';
        const prio = t.priority === 'high' ? '&#9650;' : t.priority === 'low' ? '&#9660;' : '&#9670;';
        const prioClass = t.priority === 'high' ? 'high' : t.priority === 'low' ? 'low' : '';
        const carried = (t as any).carriedFromSessionId ? ' <span class="carryover-badge">&#8634;</span>' : '';
        taskRows += `<div class="carryover-task-row">
          <span class="carryover-task-prio ${prioClass}">${prio}</span>
          <span class="carryover-task-title">${escapeHtml(t.title)}${carried}</span>
          <span class="carryover-task-tag" style="background:${tagColor}">${t.tag}</span>
        </div>`;
      }
      taskRows += '</div>';
    }

    const moreCount = incompleteTasks.length - 15;
    const moreLabel = moreCount > 0 ? `<p class="carryover-more">…and ${moreCount} more</p>` : '';

    carryOverHtml = `
      <div class="carryover-section">
        <p class="carryover-desc">&#8634; <strong>${incompleteTasks.length}</strong> incomplete task${incompleteTasks.length === 1 ? '' : 's'} will carry over to your next session.</p>
        <div class="carryover-task-list">${taskRows}</div>
        ${moreLabel}
      </div>`;
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'End Session');

  if (boards.length === 1) {
    // Single board — simple end session dialog
    const b = boards[0];
    overlay.innerHTML = `<div class="modal-card carryover-preview-card">
      <h3>End Session?</h3>
      <p class="session-pick-desc">"${escapeHtml(b.name)}" will be closed and the session will end.</p>
      ${carryOverHtml}
      <div class="modal-actions" style="margin-top:12px">
        <button class="secondary" id="end-session-cancel">Cancel</button>
        <button class="danger" id="end-session-confirm">End Session</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);

    document.getElementById('end-session-confirm')!.addEventListener('click', () => {
      overlay.remove();
      showEndSessionJiraPrompt([b.id]);
    });
    document.getElementById('end-session-cancel')!.addEventListener('click', () => overlay.remove());
  } else {
    // Multi-board — board picker with carry-over preview
    const boardRows = boards.map((b) => {
      const isActive = b.id === activeBoardId;
      const boardTasks = state!.tasks.filter((t) => (t.boardId || 'default') === b.id && t.sessionId === state!.activeSessionId);
      const completed = boardTasks.filter((t) => t.status === 'completed').length;

      return `<label class="session-pick-row ${isActive ? 'active' : ''}" data-session-pick="${b.id}">
        <input type="checkbox" class="session-pick-cb" value="${b.id}"${isActive ? ' checked' : ''} />
        <div class="session-pick-info">
          <div class="session-pick-top">
            <span class="session-pick-name">${escapeHtml(b.name)}</span>
            ${isActive ? '<span class="session-pick-active">Active</span>' : ''}
          </div>
          <div class="session-pick-bottom">
            <span>&#10003; ${completed}/${boardTasks.length} tasks</span>
          </div>
        </div>
      </label>`;
    }).join('');

    overlay.innerHTML = `<div class="modal-card session-picker-card carryover-preview-card">
      <h3>End Session</h3>
      <p class="session-pick-desc">Select which boards to close. If all are closed, the session will end.</p>
      <div class="session-pick-list">
        <label class="session-pick-row select-all-row">
          <input type="checkbox" class="session-pick-cb" id="session-pick-select-all" />
          <div class="session-pick-info">
            <div class="session-pick-top"><span class="session-pick-name">Select All</span></div>
          </div>
        </label>
        ${boardRows}
      </div>
      ${carryOverHtml}
      <div class="modal-actions" style="margin-top:12px">
        <button class="secondary" id="end-session-cancel">Cancel</button>
        <button class="danger" id="end-session-confirm" disabled>Close Selected</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);

    const checkboxes = overlay.querySelectorAll<HTMLInputElement>('.session-pick-cb:not(#session-pick-select-all)');
    const selectAllCb = document.getElementById('session-pick-select-all') as HTMLInputElement;
    const confirmBtn = document.getElementById('end-session-confirm') as HTMLButtonElement;

    const updateConfirm = () => {
      const anyChecked = Array.from(checkboxes).some((cb) => cb.checked);
      confirmBtn.disabled = !anyChecked;
      const allChecked = Array.from(checkboxes).every((cb) => cb.checked);
      selectAllCb.checked = allChecked;
      selectAllCb.indeterminate = anyChecked && !allChecked;
    };
    checkboxes.forEach((cb) => cb.addEventListener('change', updateConfirm));
    updateConfirm();

    selectAllCb.addEventListener('change', () => {
      checkboxes.forEach((cb) => { cb.checked = selectAllCb.checked; });
      updateConfirm();
    });

    document.getElementById('end-session-confirm')!.addEventListener('click', () => {
      const selected = Array.from(checkboxes).filter((cb) => cb.checked).map((cb) => cb.value);
      if (selected.length > 0) {
        overlay.remove();
        showEndSessionJiraPrompt(selected);
      }
    });

    document.getElementById('end-session-cancel')!.addEventListener('click', () => overlay.remove());
  }

  overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); } });
  overlay.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Escape') { overlay.remove(); } });
}

/**
 * After the user confirms ending a session, prompt them about Jira export.
 * - If Jira is configured: ask if they want to export tasks first.
 * - If Jira is NOT configured: show a tip about Jira integration with a "Don't show again" checkbox.
 * - If the user previously dismissed the prompt: skip straight to closing boards.
 */
function showEndSessionJiraPrompt(boardIds: string[]): void {
  const dismissed = !!(state as Record<string, unknown>)?.jiraPromptDismissed;

  // If user previously dismissed, skip the prompt
  if (dismissed) {
    vscode.postMessage({ type: 'closeBoards', payload: { boardIds } });
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Export to Jira');

  if (extensionSettings.jiraConfigured) {
    // Jira is configured — offer to export
    // Filter to actionable tasks (exclude notes), matching the export dialog logic
    const sessionTasks = (state?.tasks?.filter(
      (t) => t.sessionId === state?.activeSessionId
    ) || []).filter((t: { status: string; tag: string }) => t.status !== 'notes' || t.tag !== 'note');
    const unexported = sessionTasks.filter((t: { jiraExports?: Record<string, unknown>; jiraIssueKey?: string }) =>
      !t.jiraIssueKey && (!t.jiraExports || Object.keys(t.jiraExports).length === 0)
    );

    // If no unexported tasks remain, skip the prompt entirely
    if (unexported.length === 0) {
      vscode.postMessage({ type: 'closeBoards', payload: { boardIds } });
      return;
    }

    overlay.innerHTML = `<div class="modal-card jira-dialog" style="max-width:380px">
      <h3>&#128640; Export to Jira?</h3>
      <p>Would you like to export your tasks to Jira before ending the session?</p>
      ${unexported.length > 0 ? `<p style="opacity:0.75;font-size:12px">You have <strong>${unexported.length}</strong> task${unexported.length === 1 ? '' : 's'} not yet exported.</p>` : ''}
      <label class="jira-filter-row" style="margin-top:8px">
        <input type="checkbox" id="jira-end-dismiss" />
        Don&rsquo;t ask me again
      </label>
      <div class="modal-actions" style="margin-top:12px">
        <button class="secondary" id="jira-end-skip">Skip</button>
        <button id="jira-end-export">&#128640; Export to Jira</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('#jira-end-skip')!.addEventListener('click', () => {
      const dismissCb = overlay.querySelector('#jira-end-dismiss') as HTMLInputElement;
      if (dismissCb.checked) {
        vscode.postMessage({ type: 'setJiraPromptDismissed', payload: { dismissed: true } });
      }
      overlay.remove();
      vscode.postMessage({ type: 'closeBoards', payload: { boardIds } });
    });

    overlay.querySelector('#jira-end-export')!.addEventListener('click', () => {
      const dismissCb = overlay.querySelector('#jira-end-dismiss') as HTMLInputElement;
      if (dismissCb.checked) {
        vscode.postMessage({ type: 'setJiraPromptDismissed', payload: { dismissed: true } });
      }
      overlay.remove();
      // Open the full Jira export dialog, then close boards when done or cancelled
      pendingCloseBoardIds = boardIds;
      showJiraExportDialog();
    });
  } else {
    // Jira is NOT configured — informational tip
    overlay.innerHTML = `<div class="modal-card jira-dialog" style="max-width:400px">
      <h3>&#128161; Did you know?</h3>
      <p>You can export your Vibe Board tasks directly to <strong>Jira</strong> as issues &mdash; with automatic field mapping, status transitions, and duplicate prevention.</p>
      <p style="font-size:12px;opacity:0.8">Set it up in <strong>&#9881; Settings</strong> &rarr; <strong>Jira Integration</strong>.</p>
      <label class="jira-filter-row" style="margin-top:8px">
        <input type="checkbox" id="jira-end-dismiss" />
        Don&rsquo;t show this again
      </label>
      <div class="modal-actions" style="margin-top:12px">
        <button id="jira-end-ok">OK</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('#jira-end-ok')!.addEventListener('click', () => {
      const dismissCb = overlay.querySelector('#jira-end-dismiss') as HTMLInputElement;
      if (dismissCb.checked) {
        vscode.postMessage({ type: 'setJiraPromptDismissed', payload: { dismissed: true } });
      }
      overlay.remove();
      vscode.postMessage({ type: 'closeBoards', payload: { boardIds } });
    });
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.remove();
      flushPendingBoardClose();
    }
  });
  overlay.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      overlay.remove();
      flushPendingBoardClose();
    }
  });
}

// Variable to track pending board close after Jira export
let pendingCloseBoardIds: string[] | null = null;

/** Flush any pending board close after Jira export flow completes. */
function flushPendingBoardClose(): void {
  if (pendingCloseBoardIds) {
    const boardIds = pendingCloseBoardIds;
    pendingCloseBoardIds = null;
    vscode.postMessage({ type: 'closeBoards', payload: { boardIds } });
  }
}

// ============================================================
// Dialogs
// ============================================================

function showDeleteConfirm(taskId: string, taskTitle: string): void {
  showConfirmDialog('Delete task?', `"${taskTitle}" will be permanently removed.`, () => {
    vscode.postMessage({ type: 'deleteTask', payload: { id: taskId } });
  });
}

function showConfirmDialog(title: string, message: string, onConfirm: () => void): void {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', title);
  overlay.innerHTML = `<div class="modal-card">
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(message)}</p>
    <div class="modal-actions">
      <button class="secondary" id="modal-cancel">Cancel</button>
      <button class="danger" id="modal-confirm">Confirm</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  document.getElementById('modal-confirm')!.addEventListener('click', () => { onConfirm(); overlay.remove(); });
  document.getElementById('modal-cancel')!.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); } });
  // Focus the confirm button for keyboard users
  (document.getElementById('modal-cancel') as HTMLElement)?.focus();
}

// ============================================================
// Image Preview Modal
// ============================================================

function showImagePreview(src: string, alt: string): void {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay image-preview-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', `Preview: ${alt}`);
  overlay.innerHTML = `<div class="image-preview-card">
    <div class="image-preview-header">
      <span class="image-preview-title">${escapeHtml(alt)}</span>
      <button class="image-preview-close" id="preview-close" title="Close" aria-label="Close preview">&#10005;</button>
    </div>
    <img class="image-preview-img" src="${src}" alt="${escapeAttr(alt)}" />
  </div>`;
  document.body.appendChild(overlay);
  document.getElementById('preview-close')!.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); } });
}

// ============================================================
// Export Project Picker
// ============================================================

function showExportProjectPicker(format: 'json' | 'csv' | 'markdown'): void {
  const projects = state?.projects || [];

  // If no projects exist, skip picker and go directly
  if (projects.length === 0) {
    if (format === 'json') {
      vscode.postMessage({ type: 'exportData', payload: { format: 'json' } });
    } else {
      showExportTimePicker(format as 'csv' | 'markdown');
    }
    return;
  }

  const formatLabel = format === 'json' ? 'JSON' : format === 'csv' ? 'CSV' : 'Markdown';
  const confirmLabel = format === 'json' ? 'Export' : 'Next';
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', `Export ${formatLabel} — Select Projects`);

  const activeProjectId = state?.activeProjectId || null;
  const isAllSelected = !activeProjectId;

  const projectRows = projects.map((p) => {
    const dotColor = p.color || '#888';
    const isChecked = isAllSelected || p.id === activeProjectId;
    return `<label class="export-project-option">
      <input type="checkbox" name="export-project" value="${p.id}"${isChecked ? ' checked' : ''} />
      <span class="project-dot" style="background:${dotColor}"></span>
      <span>${escapeHtml(p.name)}</span>
    </label>`;
  }).join('');

  overlay.innerHTML = `<div class="modal-card export-project-picker">
    <h3>Export ${formatLabel} — Projects</h3>
    <p>Choose which projects to include in the export.</p>
    <div class="export-project-options">
      <label class="export-project-option export-project-all">
        <input type="checkbox" id="export-all-projects"${isAllSelected ? ' checked' : ''} />
        <span>All Projects</span>
      </label>
      <div class="export-project-divider"></div>
      ${projectRows}
    </div>
    <div class="modal-actions">
      <button class="secondary" id="export-project-cancel">Cancel</button>
      <button id="export-project-confirm">${confirmLabel}</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  const allCheckbox = document.getElementById('export-all-projects') as HTMLInputElement;
  const projectCheckboxes = overlay.querySelectorAll<HTMLInputElement>('input[name="export-project"]');

  // "All Projects" toggle behavior — checks all individual projects
  allCheckbox.addEventListener('change', () => {
    projectCheckboxes.forEach((cb) => {
      cb.checked = allCheckbox.checked;
    });
  });

  // When individual projects change, sync "All" checkbox state
  projectCheckboxes.forEach((cb) => {
    cb.addEventListener('change', () => {
      const allChecked = Array.from(projectCheckboxes).every((c) => c.checked);
      const noneChecked = !Array.from(projectCheckboxes).some((c) => c.checked);
      allCheckbox.checked = allChecked;
      allCheckbox.indeterminate = !allChecked && !noneChecked;
    });
  });

  document.getElementById('export-project-confirm')!.addEventListener('click', () => {
    const allChecked = allCheckbox.checked && !allCheckbox.indeterminate;
    // Collect selected project IDs (undefined means "all")
    let selectedIds: string[] | undefined;
    if (!allChecked) {
      selectedIds = Array.from(projectCheckboxes).filter((cb) => cb.checked).map((cb) => cb.value);
      if (selectedIds.length === 0) {
        // Must select at least one project
        return;
      }
    }

    overlay.remove();

    if (format === 'json') {
      const payload: Record<string, unknown> = { format: 'json' };
      if (selectedIds) { payload.projectIds = selectedIds; }
      vscode.postMessage({ type: 'exportData', payload });
    } else {
      showExportTimePicker(format as 'csv' | 'markdown', selectedIds);
    }
  });

  document.getElementById('export-project-cancel')!.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); } });
}

// ============================================================
// Export Time Period Picker
// ============================================================

function showExportTimePicker(format: 'csv' | 'markdown', projectIds?: string[]): void {
  const formatLabel = format === 'csv' ? 'CSV' : 'Markdown';
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', `Export ${formatLabel} — Select Time Period`);

  // Calculate default date values for custom range
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  overlay.innerHTML = `<div class="modal-card export-time-picker">
    <h3>Export ${formatLabel} — Time Period</h3>
    <p>Select a time range to filter the exported data.</p>
    <div class="export-time-options">
      <label class="export-time-option"><input type="radio" name="export-time" value="all" checked /> All Time</label>
      <label class="export-time-option"><input type="radio" name="export-time" value="day" /> By Day</label>
      <label class="export-time-option"><input type="radio" name="export-time" value="week" /> By Week</label>
      <label class="export-time-option"><input type="radio" name="export-time" value="month" /> By Month</label>
      <label class="export-time-option"><input type="radio" name="export-time" value="year" /> By Year</label>
      <label class="export-time-option"><input type="radio" name="export-time" value="current-month" /> Current Month</label>
      <label class="export-time-option"><input type="radio" name="export-time" value="last-month" /> Last Month</label>
      <label class="export-time-option"><input type="radio" name="export-time" value="custom" /> Custom Range</label>
    </div>
    <div class="export-custom-range" id="export-custom-range" style="display:none;">
      <label>From: <input type="date" id="export-custom-start" value="${todayStr}" /></label>
      <label>To: <input type="date" id="export-custom-end" value="${todayStr}" /></label>
    </div>
    <div class="modal-actions">
      <button class="secondary" id="export-time-cancel">Cancel</button>
      <button id="export-time-confirm">Export</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  // Show/hide custom range inputs based on radio selection
  overlay.querySelectorAll<HTMLInputElement>('input[name="export-time"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const customDiv = document.getElementById('export-custom-range')!;
      customDiv.style.display = radio.value === 'custom' ? 'flex' : 'none';
    });
  });

  // Enforce start ≤ end for custom range date inputs
  const startInput = document.getElementById('export-custom-start') as HTMLInputElement;
  const endInput = document.getElementById('export-custom-end') as HTMLInputElement;
  startInput.addEventListener('change', () => {
    if (startInput.value && endInput.value && startInput.value > endInput.value) {
      endInput.value = startInput.value;
    }
    endInput.min = startInput.value;
  });
  endInput.addEventListener('change', () => {
    if (endInput.value && startInput.value && endInput.value < startInput.value) {
      startInput.value = endInput.value;
    }
    startInput.max = endInput.value;
  });

  document.getElementById('export-time-confirm')!.addEventListener('click', () => {
    const selected = overlay.querySelector<HTMLInputElement>('input[name="export-time"]:checked')!.value;
    const payload: Record<string, string> = { format, timePeriod: selected };
    if (selected === 'custom') {
      const cStart = startInput.value;
      const cEnd = endInput.value;
      if (cStart > cEnd) {
        startInput.style.borderColor = 'var(--vscode-inputValidation-errorBorder, red)';
        endInput.style.borderColor = 'var(--vscode-inputValidation-errorBorder, red)';
        return;
      }
      payload.customStart = cStart;
      payload.customEnd = cEnd;
    }
    // Include selected project filter
    if (projectIds && projectIds.length > 0) { (payload as Record<string, unknown>).projectIds = projectIds; }
    vscode.postMessage({ type: 'exportData', payload });
    overlay.remove();
  });

  document.getElementById('export-time-cancel')!.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); } });
  (document.getElementById('export-time-cancel') as HTMLElement)?.focus();
}

// ============================================================
// Jira Export & Import
// ============================================================

/** Pending callback for when Jira projects arrive from the extension. */
let jiraProjectsCallback: ((payload: { projects: { id: string; key: string; name: string }[]; error?: string }) => void) | null = null;

/** Pending callback for when Jira statuses arrive from the extension. */
let jiraStatusesCallback: ((payload: { statuses: { id: string; name: string }[]; error?: string }) => void) | null = null;

/** Pending callback for when Jira epics arrive from the extension. */
let jiraEpicsCallback: ((payload: { epics: { key: string; name: string }[]; error?: string; newEpicKey?: string }) => void) | null = null;

/** Pending overlay for Jira export result display. */
let jiraResultOverlay: HTMLDivElement | null = null;

/** Pending callback for Jira issue search results. */
let jiraSearchCallback: ((payload: { issues: JiraImportIssue[]; total: number; error?: string }) => void) | null = null;

/** Pending callback for Jira import results. */
let jiraImportCallback: ((payload: { success: boolean; imported: number; error?: string }) => void) | null = null;

/** Pending Jira import — stored when user tries to import without an active session. Executed automatically after session starts. */
let pendingJiraImport: { issues: JiraImportIssue[]; statusMapping: Record<string, string> } | null = null;

/**
 * Show the Jira export dialog.
 * Step 1: Check credentials → fetch projects → show project picker with task selection.
 */
function showJiraExportDialog(): void {
  if (!extensionSettings.jiraConfigured) {
    showJiraCredentialsPrompt();
    return;
  }

  // Show a loading overlay while projects are fetched
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Export to Jira');
  overlay.innerHTML = `<div class="modal-card jira-dialog">
    <h3>&#127919; Export to Jira</h3>
    <p class="jira-loading">Fetching Jira projects&hellip;</p>
  </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.remove();
      flushPendingBoardClose();
    }
  });

  jiraProjectsCallback = (payload) => {
    jiraProjectsCallback = null;
    if (payload.error) {
      overlay.querySelector('.jira-dialog')!.innerHTML = `
        <h3>&#127919; Export to Jira</h3>
        <p class="jira-error">&#9888; ${escapeHtml(payload.error)}</p>
        <div class="modal-actions">
          <button id="jira-error-close">Close</button>
        </div>`;
      overlay.querySelector('#jira-error-close')!.addEventListener('click', () => { overlay.remove(); flushPendingBoardClose(); });
      return;
    }
    if (payload.projects.length === 0) {
      overlay.querySelector('.jira-dialog')!.innerHTML = `
        <h3>&#127919; Export to Jira</h3>
        <p class="jira-error">No Jira projects found. Check your permissions.</p>
        <div class="modal-actions">
          <button id="jira-error-close">Close</button>
        </div>`;
      overlay.querySelector('#jira-error-close')!.addEventListener('click', () => { overlay.remove(); flushPendingBoardClose(); });
      return;
    }
    showJiraProjectAndTaskPicker(overlay, payload.projects);
  };

  vscode.postMessage({ type: 'getJiraProjects', payload: {} });
}

/** Handle the jiraProjects response from the extension. */
function handleJiraProjectsResponse(payload: { projects: { id: string; key: string; name: string }[]; error?: string }): void {
  if (jiraProjectsCallback) {
    jiraProjectsCallback(payload);
  }
}

/** Handle the jiraStatuses response from the extension. */
function handleJiraStatusesResponse(payload: { statuses: { id: string; name: string }[]; error?: string }): void {
  if (jiraStatusesCallback) {
    jiraStatusesCallback(payload);
  }
}

/** Handle the jiraEpics response from the extension. */
function handleJiraEpicsResponse(payload: { epics: { key: string; name: string }[]; error?: string; newEpicKey?: string }): void {
  if (jiraEpicsCallback) {
    jiraEpicsCallback(payload);
  }
}

/** Handle the jiraConnectionTest response from the extension — update settings UI. */
function handleJiraConnectionTestResult(payload: { success: boolean; displayName?: string; error?: string }): void {
  const testStatus = document.getElementById('jira-test-status');
  const testBtn = document.getElementById('jira-test-btn') as HTMLButtonElement | null;
  if (testBtn) { testBtn.disabled = false; }
  if (!testStatus) { return; }
  if (payload.success) {
    testStatus.style.color = 'var(--vscode-testing-iconPassed, #73c991)';
    testStatus.textContent = `\u2713 Connected as ${payload.displayName || 'Jira user'}`;
  } else {
    testStatus.style.color = 'var(--vscode-errorForeground, #f48771)';
    testStatus.textContent = `\u2717 ${payload.error || 'Connection failed'}`;
  }
  // Auto-clear after 8 seconds for errors (longer to read)
  setTimeout(() => { if (testStatus) { testStatus.textContent = ''; testStatus.style.color = ''; } }, payload.success ? 4000 : 8000);
}

/**
 * Show a dialog prompting the user to configure Jira credentials.
 */
function showJiraCredentialsPrompt(): void {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Jira Setup Required');
  overlay.innerHTML = `<div class="modal-card jira-dialog">
    <h3>&#127919; Jira Setup Required</h3>
    <p>To export tasks to Jira, configure your credentials in the <strong>Settings</strong> dialog (gear icon):</p>
    <ol class="jira-setup-steps">
      <li>Click the <strong>&#9881; gear icon</strong> at the top of Vibe Board</li>
      <li>Scroll to the <strong>Jira Integration</strong> section</li>
      <li>Enter your <strong>Base URL</strong> (e.g. https://your-domain.atlassian.net)</li>
      <li>Enter your <strong>Email</strong></li>
      <li>Enter your <strong>API Token</strong> (<a href="https://id.atlassian.com/manage-profile/security/api-tokens" class="jira-link">generate one here</a>)</li>
      <li>Click <strong>&#128274; Save Securely</strong></li>
    </ol>
    <p class="settings-hint">&#128274; Your email and API token are encrypted via your OS keychain.</p>
    <div class="modal-actions">
      <button class="secondary" id="jira-setup-close">Close</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#jira-setup-close')!.addEventListener('click', () => { overlay.remove(); flushPendingBoardClose(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); flushPendingBoardClose(); } });
}

/**
 * Replace the loading overlay with the project + task picker.
 * Features: VB→Jira project mapping, exported task exclusion, taller scrollable list.
 */
function showJiraProjectAndTaskPicker(
  overlay: HTMLDivElement,
  jiraProjects: { id: string; key: string; name: string }[]
): void {
  // Get tasks in the current context — scoped to active session or active project
  const activeSessionId = state?.activeSessionId || null;
  const tasks = state?.tasks || [];
  const activeProjectId = (state as Record<string, unknown>)?.activeProjectId as string | null || null;
  let sessionTasks: typeof tasks;
  if (activeSessionId) {
    // Active session: show only that session's tasks
    sessionTasks = tasks.filter((t: { sessionId: string }) => t.sessionId === activeSessionId);
  } else if (activeProjectId) {
    // No active session but a project filter is set: show tasks from all sessions in this project
    const projectSessionIds = new Set(
      (state?.sessions || [])
        .filter((s: { projectId?: string }) => s.projectId === activeProjectId)
        .map((s: { id: string }) => s.id)
    );
    sessionTasks = tasks.filter((t: { sessionId: string }) => projectSessionIds.has(t.sessionId));
  } else {
    // No session, no project filter: show all tasks
    sessionTasks = tasks;
  }

  // Filter to actionable tasks (not notes)
  const exportableTasks = sessionTasks.filter(
    (t: { status: string; tag: string }) => t.status !== 'notes' || t.tag !== 'note'
  );

  if (exportableTasks.length === 0) {
    overlay.querySelector('.jira-dialog')!.innerHTML = `
      <h3>&#127919; Export to Jira</h3>
      <p class="jira-error">No tasks available to export${activeSessionId ? ' in the active session' : activeProjectId ? ' in the selected project' : ''}.</p>
      <div class="modal-actions">
        <button id="jira-error-close">Close</button>
      </div>`;
    overlay.querySelector('#jira-error-close')!.addEventListener('click', () => { overlay.remove(); flushPendingBoardClose(); });
    return;
  }

  // Determine active VB project and its mapped Jira project
  const jiraProjectMapping = (state as Record<string, unknown>)?.jiraProjectMapping as Record<string, string> || {};
  const jiraEpicMapping = (state as Record<string, unknown>)?.jiraEpicMapping as Record<string, string> || {};
  const mappedJiraKey = activeProjectId ? (jiraProjectMapping[activeProjectId] || '') : '';
  const mappedEpicKey = activeProjectId ? (jiraEpicMapping[activeProjectId] || '') : '';
  const activeVBProject = activeProjectId
    ? ((state as Record<string, unknown>)?.projects as { id: string; name: string }[] || []).find(
        (p) => p.id === activeProjectId
      )
    : null;

  const projectOptions = jiraProjects.map((p) =>
    `<option value="${escapeHtml(p.key)}" ${p.key === mappedJiraKey ? 'selected' : ''}>${escapeHtml(p.name)} (${escapeHtml(p.key)})</option>`
  ).join('');

  // Build a lookup of per-project exports for each task
  type TaskWithExports = { id: string; title: string; tag: string; priority: string; status: string; jiraExports?: Record<string, { issueKey: string; exportedAt: string }>; jiraIssueKey?: string };
  const taskExportsMap = new Map<string, Record<string, { issueKey: string; exportedAt: string }>>();
  for (const t of exportableTasks as TaskWithExports[]) {
    if (t.jiraExports && Object.keys(t.jiraExports).length > 0) {
      taskExportsMap.set(t.id, t.jiraExports);
    }
  }

  // Helper: check if task was exported to a specific Jira project
  const getExportInfo = (taskId: string, jiraProjectKey: string): { issueKey: string; exportedAt: string } | null => {
    const exports = taskExportsMap.get(taskId);
    return exports?.[jiraProjectKey] || null;
  };

  // Build initial task rows based on the initially selected Jira project
  const initialJiraKey = mappedJiraKey || (jiraProjects.length > 0 ? jiraProjects[0].key : '');

  const buildTaskRows = (selectedJiraKey: string) => {
    let exportedCount = 0;

    // Group tasks by VB status
    const STATUS_ORDER = ['in-progress', 'up-next', 'backlog', 'completed', 'notes'];
    const STATUS_LABELS: Record<string, string> = {
      'in-progress': 'In Progress',
      'up-next': 'Up Next',
      'backlog': 'Backlog',
      'completed': 'Completed',
      'notes': 'Notes',
    };

    const grouped: Record<string, TaskWithExports[]> = {};
    for (const t of exportableTasks as TaskWithExports[]) {
      const status = t.status || 'up-next';
      if (!grouped[status]) { grouped[status] = []; }
      grouped[status].push(t);
    }

    let html = '';
    for (const status of STATUS_ORDER) {
      const group = grouped[status];
      if (!group || group.length === 0) { continue; }

      const label = STATUS_LABELS[status] || status;
      const rows = group.map((t) => {
        const tagClass = `tag-${t.tag}`;
        const exportInfo = getExportInfo(t.id, selectedJiraKey);
        const isExported = !!exportInfo;
        if (isExported) { exportedCount++; }
        const exportedClass = isExported ? ' jira-task-exported' : '';
        const checkedAttr = isExported ? '' : 'checked';
        const badge = isExported
          ? `<span class="jira-exported-badge" title="Exported as ${escapeHtml(exportInfo!.issueKey)}">${escapeHtml(exportInfo!.issueKey)}</span>`
          : '';
        return `<label class="jira-task-option${exportedClass}" data-exported="${isExported}" data-task-id="${t.id}" data-group="${escapeHtml(status)}">
          <input type="checkbox" name="jira-task" value="${t.id}" ${checkedAttr} />
          <span class="task-tag ${tagClass}">${t.tag}</span>
          <span class="jira-task-title">${escapeHtml(t.title)}</span>
          ${badge}
        </label>`;
      }).join('');

      html += `<div class="jira-group" data-group-key="${escapeHtml(status)}">
        <div class="jira-group-header">
          <input type="checkbox" class="jira-group-select-all" data-group="${escapeHtml(status)}" checked />
          <button type="button" class="jira-group-toggle" data-group="${escapeHtml(status)}" aria-expanded="true">&#9660;</button>
          <strong>${escapeHtml(label)}</strong>
          <span class="jira-group-count">(${group.length})</span>
        </div>
        <div class="jira-group-body" data-group="${escapeHtml(status)}">
          ${rows}
        </div>
      </div>`;
    }

    return { html, exportedCount };
  };

  const initial = buildTaskRows(initialJiraKey);
  const nonExportedCount = exportableTasks.length - initial.exportedCount;

  // Project mapping row (only show when a VB project is active)
  const mappingRow = activeVBProject
    ? `<label class="jira-project-mapping-row">
         <input type="checkbox" id="jira-save-mapping" ${mappedJiraKey ? 'checked' : ''} />
         <span>Remember for <strong>${escapeHtml(activeVBProject.name)}</strong></span>
       </label>`
    : '';

  // Epic mapping row
  const epicMappingRow = activeVBProject
    ? `<label class="jira-project-mapping-row">
         <input type="checkbox" id="jira-save-epic-mapping" ${mappedEpicKey ? 'checked' : ''} />
         <span>Remember for <strong>${escapeHtml(activeVBProject.name)}</strong></span>
       </label>`
    : '';

  overlay.querySelector('.jira-dialog')!.innerHTML = `
    <h3>&#127919; Export to Jira</h3>
    <div class="jira-form">
      <div class="jira-field">
        <label for="jira-project-select">Jira Project</label>
        <select id="jira-project-select" class="jira-select">${projectOptions}</select>
        ${mappingRow}
      </div>
      <div class="jira-field">
        <label for="jira-epic-select">Epic <span style="opacity:0.6;font-weight:normal">(optional)</span></label>
        <select id="jira-epic-select" class="jira-select">
          <option value="">&mdash; None &mdash;</option>
          <option value="" disabled>Loading&hellip;</option>
        </select>
        ${epicMappingRow}
      </div>
      <div class="jira-field">
        <label>Tasks to Export <span class="jira-task-count">(${nonExportedCount} selected)</span></label>
        <label class="jira-filter-row" id="jira-filter-row" ${initial.exportedCount === 0 ? 'style="display:none"' : ''}>
          <input type="checkbox" id="jira-hide-exported" checked />
          <span id="jira-hide-exported-label">Hide ${initial.exportedCount} already exported task${initial.exportedCount === 1 ? '' : 's'}</span>
        </label>
        <div class="jira-task-list">
          <label class="jira-task-option jira-select-all">
            <input type="checkbox" id="jira-select-all" checked />
            <strong>Select All</strong>
          </label>
          <div id="jira-task-rows">${initial.html}</div>
        </div>
      </div>
    </div>
    <div class="modal-actions">
      <button class="secondary" id="jira-cancel">Cancel</button>
      <button id="jira-export-confirm">&#128640; Export to Jira</button>
    </div>`;

  // Select All toggling
  const selectAllCb = overlay.querySelector('#jira-select-all') as HTMLInputElement;
  let taskCbs = overlay.querySelectorAll<HTMLInputElement>('input[name="jira-task"]');
  const countSpan = overlay.querySelector('.jira-task-count') as HTMLElement;

  const updateCount = () => {
    const checked = Array.from(taskCbs).filter((cb) => cb.checked).length;
    countSpan.textContent = `(${checked} selected)`;
  };

  const updateGroupSelectAll = (groupKey: string) => {
    const groupCb = overlay.querySelector(`.jira-group-select-all[data-group="${CSS.escape(groupKey)}"]`) as HTMLInputElement | null;
    if (!groupCb) { return; }
    const groupTaskCbs = Array.from(taskCbs).filter((cb) => {
      const row = cb.closest('.jira-task-option') as HTMLElement;
      return row && row.getAttribute('data-group') === groupKey && row.style.display !== 'none';
    });
    if (groupTaskCbs.length === 0) { groupCb.checked = false; return; }
    const allChecked = groupTaskCbs.every((c) => c.checked);
    const noneChecked = !groupTaskCbs.some((c) => c.checked);
    groupCb.checked = allChecked;
    groupCb.indeterminate = !allChecked && !noneChecked;
  };

  const updateGlobalSelectAll = () => {
    const visibleCbs = Array.from(taskCbs).filter((c) => {
      const row = c.closest('.jira-task-option') as HTMLElement;
      return row && row.style.display !== 'none';
    });
    if (visibleCbs.length === 0) { selectAllCb.checked = false; selectAllCb.indeterminate = false; return; }
    const allChecked = visibleCbs.every((c) => c.checked);
    const noneChecked = !visibleCbs.some((c) => c.checked);
    selectAllCb.checked = allChecked;
    selectAllCb.indeterminate = !allChecked && !noneChecked;
  };

  const bindSelectAll = () => {
    selectAllCb.addEventListener('change', () => {
      taskCbs.forEach((cb) => {
        const row = cb.closest('.jira-task-option') as HTMLElement;
        if (row && row.style.display !== 'none') {
          cb.checked = selectAllCb.checked;
        }
      });
      // Update all group select-all checkboxes
      overlay.querySelectorAll<HTMLInputElement>('.jira-group-select-all').forEach((gcb) => {
        gcb.checked = selectAllCb.checked;
        gcb.indeterminate = false;
      });
      updateCount();
    });
  };

  const bindGroupControls = () => {
    // Group select-all checkboxes
    overlay.querySelectorAll<HTMLInputElement>('.jira-group-select-all').forEach((gcb) => {
      gcb.addEventListener('change', () => {
        const groupKey = gcb.getAttribute('data-group')!;
        taskCbs.forEach((cb) => {
          const row = cb.closest('.jira-task-option') as HTMLElement;
          if (row && row.getAttribute('data-group') === groupKey && row.style.display !== 'none') {
            cb.checked = gcb.checked;
          }
        });
        updateGlobalSelectAll();
        updateCount();
      });
    });

    // Group collapse/expand toggles
    overlay.querySelectorAll<HTMLButtonElement>('.jira-group-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const groupKey = btn.getAttribute('data-group')!;
        const body = overlay.querySelector(`.jira-group-body[data-group="${CSS.escape(groupKey)}"]`) as HTMLElement | null;
        if (!body) { return; }
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', String(!expanded));
        btn.innerHTML = expanded ? '&#9654;' : '&#9660;';
        body.style.display = expanded ? 'none' : '';
      });
    });
  };

  const bindTaskCbs = () => {
    taskCbs.forEach((cb) => {
      cb.addEventListener('change', () => {
        const row = cb.closest('.jira-task-option') as HTMLElement;
        const groupKey = row?.getAttribute('data-group') || '';
        if (groupKey) { updateGroupSelectAll(groupKey); }
        updateGlobalSelectAll();
        updateCount();
      });
    });
  };

  bindSelectAll();
  bindGroupControls();
  bindTaskCbs();

  // Hide/show exported tasks toggle
  const hideExportedCb = overlay.querySelector('#jira-hide-exported') as HTMLInputElement;
  const filterRow = overlay.querySelector('#jira-filter-row') as HTMLElement;
  const filterLabel = overlay.querySelector('#jira-hide-exported-label') as HTMLElement;

  const applyExportedFilter = () => {
    const hide = hideExportedCb.checked;
    overlay.querySelectorAll<HTMLElement>('.jira-task-option[data-exported="true"]').forEach((row) => {
      row.style.display = hide ? 'none' : '';
    });

    // Hide groups that have no visible tasks; update group select-all checkboxes
    overlay.querySelectorAll<HTMLElement>('.jira-group').forEach((group) => {
      const groupKey = group.getAttribute('data-group-key') || '';
      const visibleRows = group.querySelectorAll<HTMLElement>('.jira-task-option:not([style*="display: none"])');
      group.style.display = visibleRows.length === 0 ? 'none' : '';
      if (groupKey) { updateGroupSelectAll(groupKey); }
    });
    updateGlobalSelectAll();
    updateCount();
  };
  applyExportedFilter(); // Apply initial state
  hideExportedCb.addEventListener('change', applyExportedFilter);

  // When Jira project changes, re-evaluate which tasks are "exported" for that project
  const refreshTasksForProject = (jiraKey: string) => {
    const result = buildTaskRows(jiraKey);
    const rowsContainer = overlay.querySelector('#jira-task-rows') as HTMLElement;
    rowsContainer.innerHTML = result.html;

    // Update filter row
    if (result.exportedCount > 0) {
      filterRow.style.display = '';
      filterLabel.textContent = `Hide ${result.exportedCount} already exported task${result.exportedCount === 1 ? '' : 's'}`;
    } else {
      filterRow.style.display = 'none';
    }

    // Re-query checkboxes and rebind
    taskCbs = overlay.querySelectorAll<HTMLInputElement>('input[name="jira-task"]');
    selectAllCb.checked = true;
    selectAllCb.indeterminate = false;
    bindGroupControls();
    bindTaskCbs();
    applyExportedFilter();
    updateCount();
  };

  // Project mapping save
  const saveMappingCb = overlay.querySelector('#jira-save-mapping') as HTMLInputElement | null;
  const projectSelect = overlay.querySelector('#jira-project-select') as HTMLSelectElement;

  // When Jira project changes: refresh exported state + update mapping if "remember" is checked
  projectSelect.addEventListener('change', () => {
    refreshTasksForProject(projectSelect.value);
    if (saveMappingCb?.checked && activeProjectId) {
      vscode.postMessage({
        type: 'setJiraProjectMapping',
        payload: { vbProjectId: activeProjectId, jiraProjectKey: projectSelect.value },
      });
    }
    loadEpicsForProject(projectSelect.value);
  });

  if (saveMappingCb && activeProjectId) {
    saveMappingCb.addEventListener('change', () => {
      vscode.postMessage({
        type: 'setJiraProjectMapping',
        payload: {
          vbProjectId: activeProjectId,
          jiraProjectKey: saveMappingCb.checked ? projectSelect.value : '',
        },
      });
    });
  }

  // Epic dropdown logic
  const epicSelect = overlay.querySelector('#jira-epic-select') as HTMLSelectElement;
  const saveEpicMappingCb = overlay.querySelector('#jira-save-epic-mapping') as HTMLInputElement | null;

  const loadEpicsForProject = (jiraKey: string) => {
    // Show loading state
    epicSelect.innerHTML = '<option value="">&mdash; None &mdash;</option><option value="" disabled>Loading&hellip;</option>';

    jiraEpicsCallback = (payload) => {
      jiraEpicsCallback = null;
      if (payload.error) {
        epicSelect.innerHTML = `<option value="">&mdash; None &mdash;</option><option value="" disabled>Error: ${escapeHtml(payload.error)}</option>`;
        return;
      }
      let opts = '<option value="">&mdash; None &mdash;</option>';
      for (const ep of payload.epics) {
        opts += `<option value="${escapeHtml(ep.key)}">${escapeHtml(ep.name)} (${escapeHtml(ep.key)})</option>`;
      }
      opts += '<option value="__create__">\uFF0B Create new epic\u2026</option>';
      epicSelect.innerHTML = opts;

      // Auto-select: if a new epic was just created, select it; otherwise use saved mapping
      if (payload.newEpicKey) {
        epicSelect.value = payload.newEpicKey;
      } else if (mappedEpicKey) {
        epicSelect.value = mappedEpicKey;
      }
    };

    vscode.postMessage({ type: 'getJiraEpics', payload: { projectKey: jiraKey } });
  };

  // Handle epic select change — create new epic flow
  epicSelect.addEventListener('change', () => {
    if (epicSelect.value === '__create__') {
      // Show inline input instead of prompt() which is blocked in VS Code webviews
      epicSelect.style.display = 'none';
      const row = document.createElement('div');
      row.className = 'jira-create-epic-row';
      row.innerHTML = `<input type="text" class="jira-input" id="jira-new-epic-name" placeholder="Epic name" autofocus />
        <button class="jira-btn jira-btn-sm" id="jira-create-epic-confirm">Create</button>
        <button class="jira-btn jira-btn-sm jira-btn-cancel" id="jira-create-epic-cancel">Cancel</button>`;
      epicSelect.parentElement!.insertBefore(row, epicSelect.nextSibling);
      const nameInput = row.querySelector<HTMLInputElement>('#jira-new-epic-name')!;
      nameInput.focus();

      const doCreate = () => {
        const name = nameInput.value.trim();
        if (!name) { nameInput.focus(); return; }
        row.remove();
        epicSelect.style.display = '';
        epicSelect.innerHTML = '<option value="" disabled selected>Creating&hellip;</option>';
        jiraEpicsCallback = (payload) => {
          jiraEpicsCallback = null;
          if (payload.error) {
            epicSelect.innerHTML = `<option value="">&mdash; None &mdash;</option><option value="" disabled>Error: ${escapeHtml(payload.error)}</option>`;
            return;
          }
          let opts = '<option value="">&mdash; None &mdash;</option>';
          for (const ep of payload.epics) {
            opts += `<option value="${escapeHtml(ep.key)}">${escapeHtml(ep.name)} (${escapeHtml(ep.key)})</option>`;
          }
          opts += '<option value="__create__">\uFF0B Create new epic\u2026</option>';
          epicSelect.innerHTML = opts;
          if (payload.newEpicKey) {
            epicSelect.value = payload.newEpicKey;
          }
        };
        vscode.postMessage({ type: 'createJiraEpic', payload: { projectKey: projectSelect.value, epicName: name } });
      };
      const doCancel = () => {
        row.remove();
        epicSelect.style.display = '';
        epicSelect.value = '';
      };
      row.querySelector('#jira-create-epic-confirm')!.addEventListener('click', doCreate);
      row.querySelector('#jira-create-epic-cancel')!.addEventListener('click', doCancel);
      nameInput.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { doCreate(); } else if (ev.key === 'Escape') { doCancel(); }
      });
    }
  });

  // Epic mapping save
  if (saveEpicMappingCb && activeProjectId) {
    saveEpicMappingCb.addEventListener('change', () => {
      vscode.postMessage({
        type: 'setJiraEpicMapping',
        payload: {
          vbProjectId: activeProjectId,
          epicKey: saveEpicMappingCb.checked ? epicSelect.value : '',
        },
      });
    });
  }

  // Load epics for the initially selected project
  loadEpicsForProject(initialJiraKey);

  // Cancel
  overlay.querySelector('#jira-cancel')!.addEventListener('click', () => {
    overlay.remove();
    flushPendingBoardClose();
  });

  // Export — show status mapping step
  overlay.querySelector('#jira-export-confirm')!.addEventListener('click', () => {
    const selectedIds = Array.from(taskCbs).filter((cb) => cb.checked).map((cb) => cb.value);
    if (selectedIds.length === 0) { return; }

    const projectKey = projectSelect.value;
    const selectedEpicKey = epicSelect.value && epicSelect.value !== '__create__' ? epicSelect.value : undefined;

    // Determine which VB statuses are present in the selected tasks
    const selectedTasks = exportableTasks.filter((t: { id: string }) => selectedIds.includes(t.id));
    const presentStatuses = [...new Set(selectedTasks.map((t: { status: string }) => t.status))];

    // Show loading while fetching Jira statuses
    overlay.querySelector('.jira-dialog')!.innerHTML = `
      <h3>&#127919; Export to Jira</h3>
      <p class="jira-loading">Fetching statuses for ${escapeHtml(projectKey)}&hellip;</p>`;

    jiraStatusesCallback = (payload) => {
      jiraStatusesCallback = null;
      if (payload.error || payload.statuses.length === 0) {
        // Can't get statuses — export without mapping
        overlay.querySelector('.jira-dialog')!.innerHTML = `
          <h3>&#127919; Exporting to Jira&hellip;</h3>
          <p class="jira-loading">Creating ${selectedIds.length} issue${selectedIds.length === 1 ? '' : 's'} in ${escapeHtml(projectKey)}&hellip;</p>`;
        jiraResultOverlay = overlay;
        vscode.postMessage({ type: 'exportToJira', payload: { projectKey, taskIds: selectedIds, epicKey: selectedEpicKey } });
        return;
      }
      showJiraStatusMapping(overlay, projectKey, selectedIds, presentStatuses, payload.statuses, selectedEpicKey);
    };

    vscode.postMessage({ type: 'getJiraStatuses', payload: { projectKey } });
  });
}

/**
 * Show the status mapping step — lets user map each VB status to a Jira status.
 */
function showJiraStatusMapping(
  overlay: HTMLDivElement,
  projectKey: string,
  taskIds: string[],
  presentStatuses: string[],
  jiraStatuses: { id: string; name: string }[],
  epicKey?: string
): void {
  const STATUS_LABELS: Record<string, string> = {
    'in-progress': 'In Progress',
    'up-next': 'Up Next',
    'backlog': 'Backlog',
    'completed': 'Completed',
    'notes': 'Notes',
  };

  // Build a smart default mapping — prefer saved mapping, then auto-detect
  const savedExportMapping = ((state as Record<string, unknown>)?.jiraStatusMapping as Record<string, { export: Record<string, string>; import: Record<string, string> }> || {})[projectKey]?.export || {};
  const defaultMap: Record<string, string> = {};
  for (const vbStatus of presentStatuses) {
    // Use saved mapping first
    if (savedExportMapping[vbStatus]) {
      // Verify the saved Jira status still exists in this project
      const match = jiraStatuses.find((s) => s.name === savedExportMapping[vbStatus]);
      if (match) { defaultMap[vbStatus] = match.name; continue; }
    }
    // Otherwise try to find a matching Jira status name
    const label = STATUS_LABELS[vbStatus]?.toLowerCase() || vbStatus;
    const exactMatch = jiraStatuses.find((s) => s.name.toLowerCase() === label);
    if (exactMatch) {
      defaultMap[vbStatus] = exactMatch.name;
    } else if (vbStatus === 'completed') {
      // Common Jira names for done status
      const done = jiraStatuses.find((s) => ['done', 'closed', 'resolved', 'complete', 'completed'].includes(s.name.toLowerCase()));
      defaultMap[vbStatus] = done ? done.name : '';
    } else if (vbStatus === 'in-progress') {
      const inProg = jiraStatuses.find((s) => ['in progress', 'in development', 'active'].includes(s.name.toLowerCase()));
      defaultMap[vbStatus] = inProg ? inProg.name : '';
    } else if (vbStatus === 'backlog') {
      const backlog = jiraStatuses.find((s) => ['backlog', 'open', 'to do'].includes(s.name.toLowerCase()));
      defaultMap[vbStatus] = backlog ? backlog.name : '';
    } else if (vbStatus === 'up-next') {
      const upNext = jiraStatuses.find((s) => ['to do', 'selected for development', 'open'].includes(s.name.toLowerCase()));
      defaultMap[vbStatus] = upNext ? upNext.name : '';
    } else {
      defaultMap[vbStatus] = '';
    }
  }

  const statusOptions = jiraStatuses.map((s) =>
    `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`
  ).join('');

  const mappingRows = presentStatuses.map((vbStatus) => {
    const label = STATUS_LABELS[vbStatus] || vbStatus;
    const defaultVal = defaultMap[vbStatus] || '';
    return `<div class="jira-mapping-row">
      <span class="jira-mapping-label">${escapeHtml(label)}</span>
      <span class="jira-mapping-arrow">&#8594;</span>
      <select class="jira-select jira-status-select" data-vb-status="${escapeHtml(vbStatus)}">
        <option value="">— Don't change —</option>
        ${statusOptions}
      </select>
    </div>`;
  }).join('');

  overlay.querySelector('.jira-dialog')!.innerHTML = `
    <h3>&#127919; Status Mapping</h3>
    <p class="jira-mapping-desc">Map Vibe Board statuses to Jira statuses. Issues will be transitioned after creation.</p>
    <div class="jira-mapping-grid">
      ${mappingRows}
    </div>
    <label class="jira-save-mapping-label" style="display:flex;align-items:center;gap:6px;margin:8px 0 4px;font-size:11px;cursor:pointer;">
      <input type="checkbox" id="jira-export-save-mapping" checked />
      Remember this mapping for <strong>${escapeHtml(projectKey)}</strong>
    </label>
    <div class="modal-actions">
      <button class="secondary" id="jira-mapping-back">&#8592; Back</button>
      <button id="jira-mapping-export">&#128640; Export to Jira</button>
    </div>`;

  // Set default values on the selects
  for (const vbStatus of presentStatuses) {
    const sel = overlay.querySelector(`select[data-vb-status="${vbStatus}"]`) as HTMLSelectElement | null;
    if (sel && defaultMap[vbStatus]) {
      sel.value = defaultMap[vbStatus];
    }
  }

  // Back button — go back to project/task picker would be complex, so just close
  overlay.querySelector('#jira-mapping-back')!.addEventListener('click', () => {
    overlay.remove();
    showJiraExportDialog();
  });

  // Export with mapping
  overlay.querySelector('#jira-mapping-export')!.addEventListener('click', () => {
    const statusMapping: Record<string, string> = {};
    const selects = overlay.querySelectorAll<HTMLSelectElement>('.jira-status-select');
    selects.forEach((sel) => {
      const vbStatus = sel.getAttribute('data-vb-status')!;
      if (sel.value) {
        statusMapping[vbStatus] = sel.value;
      }
    });

    // Save mapping if checkbox is checked
    const saveCb = overlay.querySelector('#jira-export-save-mapping') as HTMLInputElement;
    if (saveCb?.checked && Object.keys(statusMapping).length > 0) {
      vscode.postMessage({
        type: 'setJiraStatusMapping',
        payload: { jiraProjectKey: projectKey, direction: 'export', mapping: statusMapping },
      });
    }

    // Show progress
    overlay.querySelector('.jira-dialog')!.innerHTML = `
      <h3>&#127919; Exporting to Jira&hellip;</h3>
      <p class="jira-loading">Creating ${taskIds.length} issue${taskIds.length === 1 ? '' : 's'} in ${escapeHtml(projectKey)}&hellip;</p>`;

    jiraResultOverlay = overlay;

    vscode.postMessage({
      type: 'exportToJira',
      payload: {
        projectKey,
        taskIds,
        statusMapping: Object.keys(statusMapping).length > 0 ? statusMapping : undefined,
        epicKey,
      },
    });
  });
}

/**
 * Handle the export result from the extension and show success/failure summary.
 */
function handleJiraExportResult(payload: {
  success: boolean;
  created: number;
  failed: number;
  issues: { taskTitle: string; issueKey: string; issueUrl: string }[];
  errors: string[];
}): void {
  const overlay = jiraResultOverlay || document.querySelector('.jira-dialog')?.closest('.modal-overlay') as HTMLDivElement;
  jiraResultOverlay = null;

  if (!overlay) { return; }

  const issueRows = payload.issues.map((i) =>
    `<li class="jira-result-item jira-result-success">
      <span class="jira-issue-key">${escapeHtml(i.issueKey)}</span>
      <span class="jira-issue-title">${escapeHtml(i.taskTitle)}</span>
    </li>`
  ).join('');

  const errorRows = payload.errors.map((e) =>
    `<li class="jira-result-item jira-result-error">&#9888; ${escapeHtml(e)}</li>`
  ).join('');

  const statusIcon = payload.created > 0 && payload.failed === 0 ? '&#9989;' : payload.created > 0 ? '&#9888;' : '&#10060;';
  const statusText = payload.created > 0 && payload.failed === 0
    ? `Successfully created ${payload.created} issue${payload.created === 1 ? '' : 's'}!`
    : payload.created > 0
    ? `Created ${payload.created} issue${payload.created === 1 ? '' : 's'}, ${payload.failed} failed.`
    : `Failed to create issues.`;

  overlay.querySelector('.jira-dialog')!.innerHTML = `
    <h3>&#127919; Jira Export Result</h3>
    <p class="jira-status">${statusIcon} ${statusText}</p>
    <ul class="jira-result-list">
      ${issueRows}
      ${errorRows}
    </ul>
    <div class="modal-actions">
      <button id="jira-result-close">Close</button>
    </div>`;

  overlay.querySelector('#jira-result-close')!.addEventListener('click', () => {
    overlay.remove();
    flushPendingBoardClose();
  });
}

// ============================================================
// Jira Import
// ============================================================

/**
 * Show the Jira import dialog.
 * Step 1: Check credentials → fetch projects → show project picker with JQL filter.
 * Step 2: Search issues → show issue list with checkboxes.
 * Step 3: Import selected issues as VB tasks.
 */
function showJiraImportDialog(): void {
  if (!extensionSettings.jiraConfigured) {
    showJiraCredentialsPrompt();
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Import from Jira');
  overlay.innerHTML = `<div class="modal-card jira-dialog">
    <h3>&#128229; Import from Jira</h3>
    <p class="jira-loading">Fetching Jira projects&hellip;</p>
  </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) { overlay.remove(); flushPendingBoardClose(); }
  });

  jiraProjectsCallback = (payload) => {
    jiraProjectsCallback = null;
    if (payload.error) {
      overlay.querySelector('.jira-dialog')!.innerHTML = `
        <h3>&#128229; Import from Jira</h3>
        <p class="jira-error">&#9888; ${escapeHtml(payload.error)}</p>
        <div class="modal-actions"><button id="jira-import-error-close">Close</button></div>`;
      overlay.querySelector('#jira-import-error-close')!.addEventListener('click', () => { overlay.remove(); flushPendingBoardClose(); });
      return;
    }
    if (payload.projects.length === 0) {
      overlay.querySelector('.jira-dialog')!.innerHTML = `
        <h3>&#128229; Import from Jira</h3>
        <p class="jira-error">No Jira projects found. Check your permissions.</p>
        <div class="modal-actions"><button id="jira-import-error-close">Close</button></div>`;
      overlay.querySelector('#jira-import-error-close')!.addEventListener('click', () => { overlay.remove(); flushPendingBoardClose(); });
      return;
    }
    showJiraImportProjectPicker(overlay, payload.projects);
  };

  vscode.postMessage({ type: 'getJiraProjects', payload: {} });
}

/**
 * Show the project picker + JQL filter + search for the import dialog.
 */
function showJiraImportProjectPicker(
  overlay: HTMLDivElement,
  jiraProjects: { id: string; key: string; name: string }[]
): void {
  const activeProjectId = (state as Record<string, unknown>)?.activeProjectId as string | null || null;
  const jiraProjectMapping = (state as Record<string, unknown>)?.jiraProjectMapping as Record<string, string> || {};
  const mappedJiraKey = activeProjectId ? (jiraProjectMapping[activeProjectId] || '') : '';

  const projectOptions = jiraProjects.map((p) =>
    `<option value="${escapeHtml(p.key)}" ${p.key === mappedJiraKey ? 'selected' : ''}>${escapeHtml(p.name)} (${escapeHtml(p.key)})</option>`
  ).join('');

  overlay.querySelector('.jira-dialog')!.innerHTML = `
    <h3>&#128229; Import from Jira</h3>
    <div class="jira-form">
      <div class="jira-field">
        <label for="jira-import-project">Jira Project</label>
        <select id="jira-import-project" class="jira-select">${projectOptions}</select>
      </div>
      <div class="jira-field">
        <label for="jira-import-jql">Filter <span style="opacity:0.6;font-weight:normal">(JQL — optional)</span></label>
        <input type="text" id="jira-import-jql" class="jira-input" placeholder='e.g. status = "To Do" AND type = Bug' />
      </div>
      <div class="modal-actions">
        <button class="secondary" id="jira-import-cancel">Cancel</button>
        <button id="jira-import-search">&#128269; Search Issues</button>
      </div>
    </div>`;

  overlay.querySelector('#jira-import-cancel')!.addEventListener('click', () => { overlay.remove(); flushPendingBoardClose(); });

  overlay.querySelector('#jira-import-search')!.addEventListener('click', () => {
    const projectKey = (overlay.querySelector('#jira-import-project') as HTMLSelectElement).value;
    const jql = (overlay.querySelector('#jira-import-jql') as HTMLInputElement).value.trim();

    // Show loading state
    const searchBtn = overlay.querySelector('#jira-import-search') as HTMLButtonElement;
    searchBtn.disabled = true;
    searchBtn.textContent = 'Searching\u2026';

    jiraSearchCallback = (payload) => {
      jiraSearchCallback = null;
      if (payload.error) {
        searchBtn.disabled = false;
        searchBtn.textContent = '\uD83D\uDD0D Search Issues';
        // Show error inline
        let errEl = overlay.querySelector('.jira-search-error') as HTMLParagraphElement | null;
        if (!errEl) {
          errEl = document.createElement('p');
          errEl.className = 'jira-error jira-search-error';
          searchBtn.parentElement!.insertBefore(errEl, searchBtn);
        }
        errEl.innerHTML = `&#9888; ${escapeHtml(payload.error)}`;
        return;
      }
      if (payload.issues.length === 0) {
        searchBtn.disabled = false;
        searchBtn.textContent = '\uD83D\uDD0D Search Issues';
        let errEl = overlay.querySelector('.jira-search-error') as HTMLParagraphElement | null;
        if (!errEl) {
          errEl = document.createElement('p');
          errEl.className = 'jira-error jira-search-error';
          searchBtn.parentElement!.insertBefore(errEl, searchBtn);
        }
        errEl.textContent = 'No issues found matching your filter.';
        return;
      }
      showJiraImportIssuePicker(overlay, payload.issues, payload.total, projectKey, jql, jiraProjects);
    };

    vscode.postMessage({ type: 'searchJiraIssues', payload: { projectKey, jql: jql || undefined, maxResults: 50 } });
  });
}

/**
 * Show the issue picker — user selects which Jira issues to import.
 */
function showJiraImportIssuePicker(
  overlay: HTMLDivElement,
  issues: JiraImportIssue[],
  total: number,
  projectKey: string,
  jql: string,
  jiraProjects: { id: string; key: string; name: string }[]
): void {
  const issueTypeIcon = (t: string): string => {
    const lt = t.toLowerCase();
    if (lt === 'bug') { return '&#128027;'; }
    if (lt === 'story' || lt === 'feature') { return '&#128218;'; }
    if (lt === 'epic') { return '&#9889;'; }
    if (lt === 'sub-task' || lt === 'subtask') { return '&#128279;'; }
    return '&#9744;';
  };

  const priorityClass = (p: string): string => {
    const lp = p.toLowerCase();
    if (lp === 'highest' || lp === 'high' || lp === 'critical' || lp === 'blocker') { return 'priority-high'; }
    if (lp === 'lowest' || lp === 'low' || lp === 'trivial') { return 'priority-low'; }
    return 'priority-medium';
  };

  // Group issues by Jira status
  const statusGroups = new Map<string, JiraImportIssue[]>();
  for (const issue of issues) {
    const s = issue.status;
    if (!statusGroups.has(s)) { statusGroups.set(s, []); }
    statusGroups.get(s)!.push(issue);
  }

  const buildIssueRow = (issue: JiraImportIssue, groupKey: string): string => {
    const badges: string[] = [];
    if (issue.attachments && issue.attachments.length > 0) {
      badges.push(`<span class="jira-badge" title="${issue.attachments.length} image(s)">&#128247; ${issue.attachments.length}</span>`);
    }
    if (issue.comments && issue.comments.length > 0) {
      badges.push(`<span class="jira-badge" title="${issue.comments.length} comment(s)">&#128172; ${issue.comments.length}</span>`);
    }
    return `
    <label class="jira-task-option" data-issue-key="${escapeHtml(issue.key)}" data-group="${escapeHtml(groupKey)}">
      <input type="checkbox" name="jira-import-issue" value="${escapeHtml(issue.key)}" checked />
      <span class="jira-import-type" title="${escapeHtml(issue.issueType)}">${issueTypeIcon(issue.issueType)}</span>
      <span class="jira-issue-key">${escapeHtml(issue.key)}</span>
      <span class="jira-task-title">${escapeHtml(issue.summary)}</span>
      ${badges.length > 0 ? `<span class="jira-badges">${badges.join('')}</span>` : ''}
      <span class="jira-import-status ${priorityClass(issue.priority)}">${escapeHtml(issue.status)}</span>
    </label>`;
  };

  let groupedHtml = '';
  for (const [statusName, groupIssues] of statusGroups) {
    const groupKey = statusName;
    const issueRows = groupIssues.map((issue) => buildIssueRow(issue, groupKey)).join('');
    groupedHtml += `
    <div class="jira-group" data-group-key="${escapeHtml(groupKey)}">
      <div class="jira-group-header">
        <input type="checkbox" class="jira-group-select-all" data-group="${escapeHtml(groupKey)}" checked />
        <button class="jira-group-toggle" data-group="${escapeHtml(groupKey)}" aria-expanded="true">&#9660;</button>
        <strong>${escapeHtml(statusName)}</strong>
        <span class="jira-group-count">(${groupIssues.length})</span>
      </div>
      <div class="jira-group-body" data-group="${escapeHtml(groupKey)}">
        ${issueRows}
      </div>
    </div>`;
  }

  const showing = issues.length < total ? `Showing ${issues.length} of ${total}` : `${issues.length} issue${issues.length === 1 ? '' : 's'}`;

  overlay.querySelector('.jira-dialog')!.innerHTML = `
    <h3>&#128229; Import from Jira</h3>
    <div class="jira-form">
      <div class="jira-field">
        <label>Issues from <strong>${escapeHtml(projectKey)}</strong> <span class="jira-task-count">(${showing})</span></label>
        <div class="jira-task-list">
          <label class="jira-task-option jira-select-all">
            <input type="checkbox" id="jira-import-select-all" checked />
            <strong>Select All</strong>
          </label>
          ${groupedHtml}
        </div>
      </div>
      <div class="modal-actions">
        <button class="secondary" id="jira-import-back">&#8592; Back</button>
        <button id="jira-import-confirm">&#128229; Import ${issues.length} Issue${issues.length === 1 ? '' : 's'}</button>
      </div>
    </div>`;

  // Select All logic
  const selectAllCb = overlay.querySelector('#jira-import-select-all') as HTMLInputElement;
  let allCheckboxes = overlay.querySelectorAll<HTMLInputElement>('input[name="jira-import-issue"]');
  const confirmBtn = overlay.querySelector('#jira-import-confirm') as HTMLButtonElement;

  const updateImportGroupSelectAll = (groupKey: string) => {
    const gcb = overlay.querySelector(`.jira-group-select-all[data-group="${CSS.escape(groupKey)}"]`) as HTMLInputElement | null;
    if (!gcb) { return; }
    const groupCbs = Array.from(allCheckboxes).filter((c) => {
      const row = c.closest('.jira-task-option') as HTMLElement;
      return row && row.getAttribute('data-group') === groupKey;
    });
    if (groupCbs.length === 0) { gcb.checked = false; return; }
    const allChecked = groupCbs.every((c) => c.checked);
    const noneChecked = !groupCbs.some((c) => c.checked);
    gcb.checked = allChecked;
    gcb.indeterminate = !allChecked && !noneChecked;
  };

  const updateImportGlobalSelectAll = () => {
    if (allCheckboxes.length === 0) { selectAllCb.checked = false; selectAllCb.indeterminate = false; return; }
    const allChecked = Array.from(allCheckboxes).every((c) => c.checked);
    const noneChecked = !Array.from(allCheckboxes).some((c) => c.checked);
    selectAllCb.checked = allChecked;
    selectAllCb.indeterminate = !allChecked && !noneChecked;
  };

  const updateCount = () => {
    const checked = overlay.querySelectorAll<HTMLInputElement>('input[name="jira-import-issue"]:checked');
    confirmBtn.textContent = `\uD83D\uDCE5 Import ${checked.length} Issue${checked.length === 1 ? '' : 's'}`;
    confirmBtn.disabled = checked.length === 0;
  };

  selectAllCb.addEventListener('change', () => {
    allCheckboxes.forEach((cb) => { cb.checked = selectAllCb.checked; });
    overlay.querySelectorAll<HTMLInputElement>('.jira-group-select-all').forEach((gcb) => {
      gcb.checked = selectAllCb.checked;
      gcb.indeterminate = false;
    });
    updateCount();
  });

  // Group select-all checkboxes
  overlay.querySelectorAll<HTMLInputElement>('.jira-group-select-all').forEach((gcb) => {
    gcb.addEventListener('change', () => {
      const groupKey = gcb.getAttribute('data-group')!;
      allCheckboxes.forEach((cb) => {
        const row = cb.closest('.jira-task-option') as HTMLElement;
        if (row && row.getAttribute('data-group') === groupKey) {
          cb.checked = gcb.checked;
        }
      });
      updateImportGlobalSelectAll();
      updateCount();
    });
  });

  // Group collapse/expand toggles
  overlay.querySelectorAll<HTMLButtonElement>('.jira-group-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const groupKey = btn.getAttribute('data-group')!;
      const body = overlay.querySelector(`.jira-group-body[data-group="${CSS.escape(groupKey)}"]`) as HTMLElement | null;
      if (!body) { return; }
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!expanded));
      btn.innerHTML = expanded ? '&#9654;' : '&#9660;';
      body.style.display = expanded ? 'none' : '';
    });
  });

  allCheckboxes.forEach((cb) => cb.addEventListener('change', () => {
    const row = cb.closest('.jira-task-option') as HTMLElement;
    const groupKey = row?.getAttribute('data-group') || '';
    if (groupKey) { updateImportGroupSelectAll(groupKey); }
    updateImportGlobalSelectAll();
    updateCount();
  }));

  // Back button
  overlay.querySelector('#jira-import-back')!.addEventListener('click', () => {
    showJiraImportProjectPicker(overlay, jiraProjects);
  });

  // Import button — go to status mapping step
  confirmBtn.addEventListener('click', () => {
    const checkedKeys = new Set<string>();
    overlay.querySelectorAll<HTMLInputElement>('input[name="jira-import-issue"]:checked').forEach((cb) => {
      checkedKeys.add(cb.value);
    });

    const selectedIssues = issues.filter((i) => checkedKeys.has(i.key));
    if (selectedIssues.length === 0) { return; }

    // Determine which unique Jira statuses are present in the selected issues
    const presentJiraStatuses = [...new Set(selectedIssues.map((i) => i.status))];
    showJiraImportStatusMapping(overlay, projectKey, selectedIssues, presentJiraStatuses, jiraProjects, jql);
  });
}

/**
 * Show the import status mapping step — lets user map each Jira status to a VB column.
 */
function showJiraImportStatusMapping(
  overlay: HTMLDivElement,
  projectKey: string,
  selectedIssues: JiraImportIssue[],
  presentJiraStatuses: string[],
  jiraProjects: { id: string; key: string; name: string }[],
  jql: string
): void {
  const VB_STATUSES: { value: string; label: string }[] = [
    { value: 'up-next', label: 'Up Next' },
    { value: 'in-progress', label: 'In Progress' },
    { value: 'backlog', label: 'Backlog' },
    { value: 'completed', label: 'Completed' },
    { value: 'notes', label: 'Notes' },
  ];

  // Load any saved import mapping for this Jira project
  const savedMapping = ((state as Record<string, unknown>)?.jiraStatusMapping as Record<string, { export: Record<string, string>; import: Record<string, string> }> || {})[projectKey]?.import || {};

  // Build smart defaults
  const defaultMap: Record<string, string> = {};
  for (const jiraStatus of presentJiraStatuses) {
    // Use saved mapping first
    if (savedMapping[jiraStatus]) {
      defaultMap[jiraStatus] = savedMapping[jiraStatus];
      continue;
    }
    // Otherwise try to guess
    const ls = jiraStatus.toLowerCase();
    if (['in progress', 'in development', 'active'].includes(ls)) { defaultMap[jiraStatus] = 'in-progress'; }
    else if (['done', 'closed', 'resolved', 'complete', 'completed'].includes(ls)) { defaultMap[jiraStatus] = 'completed'; }
    else if (['backlog', 'open'].includes(ls)) { defaultMap[jiraStatus] = 'backlog'; }
    else if (['to do', 'selected for development', 'new'].includes(ls)) { defaultMap[jiraStatus] = 'up-next'; }
    else { defaultMap[jiraStatus] = 'up-next'; }
  }

  const vbOptions = VB_STATUSES.map((s) =>
    `<option value="${s.value}">${escapeHtml(s.label)}</option>`
  ).join('');

  const mappingRows = presentJiraStatuses.map((jiraStatus) => `
    <div class="jira-mapping-row">
      <span class="jira-mapping-label">${escapeHtml(jiraStatus)}</span>
      <span class="jira-mapping-arrow">&#8594;</span>
      <select class="jira-select jira-import-status-select" data-jira-status="${escapeHtml(jiraStatus)}">
        ${vbOptions}
      </select>
    </div>`
  ).join('');

  overlay.querySelector('.jira-dialog')!.innerHTML = `
    <h3>&#128229; Status Mapping</h3>
    <p class="jira-mapping-desc">Map Jira statuses to Vibe Board columns for the ${selectedIssues.length} selected issue${selectedIssues.length === 1 ? '' : 's'}.</p>
    <div class="jira-mapping-grid">
      ${mappingRows}
    </div>
    <label class="jira-save-mapping-label" style="display:flex;align-items:center;gap:6px;margin:8px 0 4px;font-size:11px;cursor:pointer;">
      <input type="checkbox" id="jira-import-save-mapping" checked />
      Remember this mapping for <strong>${escapeHtml(projectKey)}</strong>
    </label>
    <div class="modal-actions">
      <button class="secondary" id="jira-import-mapping-back">&#8592; Back</button>
      <button id="jira-import-mapping-confirm">&#128229; Import ${selectedIssues.length} Issue${selectedIssues.length === 1 ? '' : 's'}</button>
    </div>`;

  // Set default values on the selects
  for (const jiraStatus of presentJiraStatuses) {
    const sel = overlay.querySelector(`select[data-jira-status="${CSS.escape(jiraStatus)}"]`) as HTMLSelectElement | null;
    if (sel && defaultMap[jiraStatus]) {
      sel.value = defaultMap[jiraStatus];
    }
  }

  // Back button — go back to issue picker
  overlay.querySelector('#jira-import-mapping-back')!.addEventListener('click', () => {
    // Re-search to go back to the issue picker (preserving the project and JQL)
    overlay.querySelector('.jira-dialog')!.innerHTML = `
      <h3>&#128229; Import from Jira</h3>
      <p class="jira-loading">Loading issues&hellip;</p>`;

    jiraSearchCallback = (payload) => {
      jiraSearchCallback = null;
      if (payload.error || payload.issues.length === 0) {
        showJiraImportProjectPicker(overlay, jiraProjects);
        return;
      }
      showJiraImportIssuePicker(overlay, payload.issues, payload.total, projectKey, jql, jiraProjects);
    };
    vscode.postMessage({ type: 'searchJiraIssues', payload: { projectKey, jql: jql || undefined, maxResults: 50 } });
  });

  // Import button
  overlay.querySelector('#jira-import-mapping-confirm')!.addEventListener('click', () => {
    // Collect the status mapping (Jira status → VB status)
    const statusMapping: Record<string, string> = {};
    overlay.querySelectorAll<HTMLSelectElement>('.jira-import-status-select').forEach((sel) => {
      const jiraStatus = sel.getAttribute('data-jira-status')!;
      statusMapping[jiraStatus] = sel.value;
    });

    // Save mapping if checkbox is checked
    const saveCb = overlay.querySelector('#jira-import-save-mapping') as HTMLInputElement;
    if (saveCb?.checked) {
      vscode.postMessage({
        type: 'setJiraStatusMapping',
        payload: { jiraProjectKey: projectKey, direction: 'import', mapping: statusMapping },
      });
    }

    if (!state?.activeSessionId) {
      // Store the import for after session starts
      pendingJiraImport = { issues: selectedIssues, statusMapping };
      overlay.remove();
      flushPendingBoardClose();
      showStartSessionDialog();
      return;
    }

    // Show importing state
    const importBtn = overlay.querySelector('#jira-import-mapping-confirm') as HTMLButtonElement;
    importBtn.disabled = true;
    importBtn.textContent = 'Importing\u2026';

    jiraImportCallback = (payload) => {
      jiraImportCallback = null;
      if (payload.error) {
        overlay.querySelector('.jira-dialog')!.innerHTML = `
          <h3>&#128229; Import from Jira</h3>
          <p class="jira-error">&#9888; ${escapeHtml(payload.error)}</p>
          <div class="modal-actions"><button id="jira-import-close">Close</button></div>`;
        overlay.querySelector('#jira-import-close')!.addEventListener('click', () => { overlay.remove(); flushPendingBoardClose(); });
        return;
      }

      overlay.querySelector('.jira-dialog')!.innerHTML = `
        <h3>&#128229; Import from Jira</h3>
        <p class="jira-status">&#9989; Successfully imported ${payload.imported} issue${payload.imported === 1 ? '' : 's'}!</p>
        <div class="modal-actions"><button id="jira-import-close">Close</button></div>`;
      overlay.querySelector('#jira-import-close')!.addEventListener('click', () => { overlay.remove(); flushPendingBoardClose(); });
    };

    vscode.postMessage({ type: 'importFromJira', payload: { issues: selectedIssues, statusMapping } });
  });
}

// ============================================================
// Session Summary
// ============================================================

function showSummary(summary: VBSessionSummary): void {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Session Summary');
  overlay.innerHTML = `<div class="summary-card">
    <h2>&#127881; Session Complete</h2>
    <div class="summary-stats">
      <div class="stat"><span>Duration</span><span class="stat-value">${formatDuration(summary.duration)}</span></div>
      <div class="stat"><span>Tasks Completed</span><span class="stat-value">${summary.tasksCompleted}</span></div>
      <div class="stat"><span>Features</span><span class="stat-value">${summary.tasksByTag['feature'] ?? 0}</span></div>
      <div class="stat"><span>Bugs Fixed</span><span class="stat-value">${summary.tasksByTag['bug'] ?? 0}</span></div>
      <div class="stat"><span>Refactors</span><span class="stat-value">${summary.tasksByTag['refactor'] ?? 0}</span></div>
      <div class="stat"><span>Plans</span><span class="stat-value">${summary.tasksByTag['plan'] ?? 0}</span></div>
      <div class="stat"><span>Todos</span><span class="stat-value">${summary.tasksByTag['todo'] ?? 0}</span></div>
      <div class="stat"><span>Carried Over</span><span class="stat-value">${summary.tasksCarriedOver}</span></div>
    </div>
    <button id="btn-dismiss-summary" style="width:100%;margin-top:12px;">Close</button>
  </div>`;
  document.body.appendChild(overlay);
  document.getElementById('btn-dismiss-summary')!.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); } });
}

// ============================================================
// Session History View
// ============================================================

function toggleView(): void {
  if (activeView === 'board') {
    activeView = 'history';
    vscode.postMessage({ type: 'requestHistory', payload: {} });
  } else {
    activeView = 'board';
    render();
  }
}

function renderHistory(): void {
  if (!sessionHistoryData) {
    app.innerHTML = '<div class="empty-state"><p>Loading history...</p></div>';
    return;
  }
  const { sessions, summaries } = sessionHistoryData;

  let html = `<div class="session-bar" role="toolbar">
    <div class="session-info"><span style="font-size:12px;font-weight:600;">Session History</span></div>
    <div class="session-actions">
      <button class="icon-btn view-toggle active" id="btn-toggle-view" title="Back to Board" aria-label="Back to board">&#128218;</button>
      ${getActiveSession()
    ? '<button class="secondary" id="btn-end-session">End Session</button>'
    : '<button class="btn-start-session">Start Session</button>'}
      <button class="icon-btn settings-btn" id="btn-settings" title="Settings" aria-label="Open settings">&#9881;</button>
      <button class="icon-btn help-btn" id="btn-help" title="Help (F1)" aria-label="Open help">&#63;</button>
    </div>
  </div>`;

  if (sessions.length === 0) {
    html += '<div class="empty-state"><p>No completed sessions yet.</p></div>';
  } else {
    html += '<div class="history-list">';
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      const sum = summaries[i];
      const date = new Date(s.startedAt).toLocaleDateString();
      const time = new Date(s.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      html += `<div class="history-item">
        <div class="history-header"><span class="history-date">${date} ${time}</span><span class="history-duration">${formatDuration(sum.duration)}</span></div>
        <div class="history-stats">
          <span>&#10003; ${sum.tasksCompleted} completed</span>
          <span>&#8634; ${sum.tasksCarriedOver} carried over</span>
        </div>
        <div class="history-tags">
          ${sum.tasksByTag['feature'] ? `<span class="task-tag feature">${sum.tasksByTag['feature']} feat</span>` : ''}
          ${sum.tasksByTag['bug'] ? `<span class="task-tag bug">${sum.tasksByTag['bug']} bug</span>` : ''}
          ${sum.tasksByTag['refactor'] ? `<span class="task-tag refactor">${sum.tasksByTag['refactor']} refactor</span>` : ''}
          ${sum.tasksByTag['plan'] ? `<span class="task-tag plan">${sum.tasksByTag['plan']} plan</span>` : ''}
          ${sum.tasksByTag['todo'] ? `<span class="task-tag todo">${sum.tasksByTag['todo']} todo</span>` : ''}
        </div>
      </div>`;
    }
    html += '</div>';
  }

  app.innerHTML = html;
  document.getElementById('btn-toggle-view')?.addEventListener('click', () => toggleView());
  document.getElementById('btn-settings')?.addEventListener('click', () => showSettingsDialog());
  document.getElementById('btn-help')?.addEventListener('click', () => showHelp());
  document.querySelectorAll<HTMLElement>('.btn-start-session').forEach((el) => {
    el.addEventListener('click', () => { showStartSessionDialog(); activeView = 'board'; });
  });
  document.getElementById('btn-end-session')?.addEventListener('click', () => vscode.postMessage({ type: 'endSession', payload: {} }));
  document.getElementById('btn-pause-session')?.addEventListener('click', () => vscode.postMessage({ type: 'pauseSession', payload: {} }));
  document.getElementById('btn-resume-session')?.addEventListener('click', () => vscode.postMessage({ type: 'resumeSession', payload: {} }));
}

// ============================================================
// Timers
// ============================================================

function getBoardElapsedMs(board: VBBoard): number {
  const startTime = new Date(board.createdAt).getTime();
  const totalPaused = board.totalPausedMs || 0;
  if (board.pausedAt) {
    // Paused: freeze at the moment of pause minus accumulated pauses
    return new Date(board.pausedAt).getTime() - startTime - totalPaused;
  }
  return Date.now() - startTime - totalPaused;
}

function startTimer(session: VBSession | null): void {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  if (!session || session.status !== 'active') { return; }

  const activeBoard = state?.boards?.find((b) => b.id === state?.activeBoardId);
  if (!activeBoard) { return; }

  const update = () => {
    const el = document.getElementById('session-timer');
    if (el) { el.textContent = formatDuration(Math.max(0, getBoardElapsedMs(activeBoard))); }
  };
  update();

  // Don't tick when paused
  if (!activeBoard.pausedAt) {
    timerInterval = setInterval(update, 1000);
  }
}

function startTaskTimers(): void {
  if (taskTimerInterval) { clearInterval(taskTimerInterval); taskTimerInterval = null; }
  const hasActive = state?.tasks.some((t) => t.timerStartedAt);
  if (!hasActive) { return; }

  taskTimerInterval = setInterval(() => {
    if (!state) { return; }
    for (const task of state.tasks) {
      if (task.timerStartedAt) {
        const el = document.querySelector(`[data-timer-display="${task.id}"]`);
        if (el) { el.textContent = formatDurationCompact(getTaskTotalMs(task)); }
      }
    }
  }, 1000);
}

function getTaskTotalMs(task: VBTask): number {
  let total = task.timeSpentMs || 0;
  if (task.timerStartedAt) { total += Date.now() - new Date(task.timerStartedAt).getTime(); }
  return total;
}

// ============================================================
// Help System
// ============================================================

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function stripHtml(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent || div.innerText || '';
}

interface FuzzyMatchResult {
  score: number;
  indices: number[];
}

function fuzzyMatch(query: string, text: string): FuzzyMatchResult | null {
  const lowerQuery = query.toLowerCase().replace(/-/g, ' ');
  const lowerText = text.toLowerCase().replace(/-/g, ' ');

  // Exact substring match gets highest score
  const exactIdx = lowerText.indexOf(lowerQuery);
  if (exactIdx !== -1) {
    const indices: number[] = [];
    for (let i = 0; i < lowerQuery.length; i++) { indices.push(exactIdx + i); }
    return { score: 100 + lowerQuery.length, indices };
  }

  // Word-start matching: check if each query char matches start of words in order
  const words = lowerQuery.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    let allFound = true;
    let totalScore = 0;
    const allIndices: number[] = [];
    for (const word of words) {
      const wIdx = lowerText.indexOf(word);
      if (wIdx === -1) { allFound = false; break; }
      totalScore += word.length;
      for (let i = 0; i < word.length; i++) { allIndices.push(wIdx + i); }
    }
    if (allFound) {
      return { score: 50 + totalScore, indices: allIndices };
    }
  }

  // Fuzzy character-by-character matching
  let qIdx = 0;
  const indices: number[] = [];
  let score = 0;
  let prevMatchIdx = -2;

  for (let tIdx = 0; tIdx < lowerText.length && qIdx < lowerQuery.length; tIdx++) {
    if (lowerText[tIdx] === lowerQuery[qIdx]) {
      indices.push(tIdx);
      // Consecutive matches score higher
      if (tIdx === prevMatchIdx + 1) { score += 3; } else { score += 1; }
      // Word boundary bonus
      if (tIdx === 0 || /\s|[^a-z0-9]/i.test(text[tIdx - 1])) { score += 2; }
      prevMatchIdx = tIdx;
      qIdx++;
    }
  }

  if (qIdx === lowerQuery.length) {
    // Penalize spread-out matches
    const spread = indices[indices.length - 1] - indices[0];
    score -= Math.floor(spread / 10);
    return { score: Math.max(1, score), indices };
  }

  return null;
}

interface HelpSearchResult {
  section: string;
  tabLabel: string;
  snippetHtml: string;
  score: number;
}

const helpTabLabels: Record<string, string> = {
  'getting-started': 'Getting Started',
  'tasks': 'Tasks',
  'board': 'Board',
  'sessions': 'Sessions',
  'projects': 'Projects',
  'timers': 'Timers',
  'templates': 'Templates',
  'ai': 'AI Features',
  'voice': 'Voice Input',
  'attachments': 'Attachments',
  'export': 'Export / Import',
  'shortcuts': 'Shortcuts'
};

function searchHelpSections(query: string): HelpSearchResult[] {
  const sections = Object.keys(helpTabLabels);
  const results: HelpSearchResult[] = [];

  for (const section of sections) {
    const html = renderHelpContent(section);
    const plainText = stripHtml(html);

    const match = fuzzyMatch(query, plainText);
    if (!match) { continue; }

    // Extract snippet around first match position
    const firstIdx = match.indices[0];
    const snippetRadius = 80;
    let snippetStart = Math.max(0, firstIdx - snippetRadius);
    let snippetEnd = Math.min(plainText.length, firstIdx + snippetRadius);

    // Snap to word boundaries
    if (snippetStart > 0) {
      const spaceIdx = plainText.indexOf(' ', snippetStart);
      if (spaceIdx !== -1 && spaceIdx < firstIdx) { snippetStart = spaceIdx + 1; }
    }
    if (snippetEnd < plainText.length) {
      const spaceIdx = plainText.lastIndexOf(' ', snippetEnd);
      if (spaceIdx > firstIdx) { snippetEnd = spaceIdx; }
    }

    let snippet = plainText.substring(snippetStart, snippetEnd);
    const prefix = snippetStart > 0 ? '...' : '';
    const suffix = snippetEnd < plainText.length ? '...' : '';

    // Highlight matched characters in snippet
    const offsetIndices = match.indices
      .filter(i => i >= snippetStart && i < snippetEnd)
      .map(i => i - snippetStart);

    let highlighted = '';
    for (let i = 0; i < snippet.length; i++) {
      if (offsetIndices.includes(i)) {
        highlighted += `<mark>${escapeHtml(snippet[i])}</mark>`;
      } else {
        highlighted += escapeHtml(snippet[i]);
      }
    }

    results.push({
      section,
      tabLabel: helpTabLabels[section] || section,
      snippetHtml: prefix + highlighted + suffix,
      score: match.score
    });
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  return results;
}

function highlightAndScrollToMatch(overlay: HTMLElement, query: string): void {
  const contentEl = overlay.querySelector('.help-content') as HTMLElement;
  if (!contentEl) { return; }

  // Walk text nodes and find matches
  const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT, null);
  const lowerQuery = query.toLowerCase();
  const words = lowerQuery.split(/\s+/).filter(Boolean);
  let firstHighlight: HTMLElement | null = null;

  // Collect all text nodes first to avoid mutation during iteration
  const textNodes: Text[] = [];
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    textNodes.push(node);
  }

  for (const textNode of textNodes) {
    const text = textNode.textContent || '';
    const lowerText = text.toLowerCase();

    // Try exact query match first, then individual words
    let matchIdx = lowerText.indexOf(lowerQuery);
    let matchLen = lowerQuery.length;

    if (matchIdx === -1 && words.length > 1) {
      // Try matching any individual word
      for (const word of words) {
        matchIdx = lowerText.indexOf(word);
        if (matchIdx !== -1) { matchLen = word.length; break; }
      }
    }

    if (matchIdx === -1) { continue; }

    // Split text node and wrap the match in a <mark>
    const before = text.substring(0, matchIdx);
    const match = text.substring(matchIdx, matchIdx + matchLen);
    const after = text.substring(matchIdx + matchLen);

    const mark = document.createElement('mark');
    mark.className = 'help-search-highlight';
    mark.textContent = match;

    const parent = textNode.parentNode;
    if (!parent) { continue; }

    if (before) { parent.insertBefore(document.createTextNode(before), textNode); }
    parent.insertBefore(mark, textNode);
    if (after) { parent.insertBefore(document.createTextNode(after), textNode); }
    parent.removeChild(textNode);

    if (!firstHighlight) { firstHighlight = mark; }
  }

  // Scroll to first highlight
  if (firstHighlight) {
    setTimeout(() => {
      firstHighlight!.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
  }
}

function showHelp(): void {
  // Close if already open
  const existing = document.querySelector('.help-overlay');
  if (existing) { existing.remove(); return; }

  const overlay = document.createElement('div');
  overlay.className = 'help-overlay modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Help & Documentation');
  overlay.innerHTML = `<div class="help-panel">
    <div class="help-header">
      <h2>&#10067; Vibe Board Help</h2>
      <button class="icon-btn help-close-btn" id="btn-help-close" aria-label="Close help">&times;</button>
    </div>
    <div class="help-search-bar">
      <input type="text" id="help-search-input" placeholder="Search help docs..." aria-label="Search help documentation" autocomplete="off" />
    </div>
    <div class="help-body">
      <nav class="help-nav" role="tablist" aria-label="Help sections" id="help-nav">
        <button class="help-tab active" data-help-tab="getting-started" role="tab" aria-selected="true">Getting Started</button>
        <button class="help-tab" data-help-tab="tasks" role="tab" aria-selected="false">Tasks</button>
        <button class="help-tab" data-help-tab="board" role="tab" aria-selected="false">Board</button>
        <button class="help-tab" data-help-tab="sessions" role="tab" aria-selected="false">Sessions</button>
        <button class="help-tab" data-help-tab="projects" role="tab" aria-selected="false">Projects</button>
        <button class="help-tab" data-help-tab="timers" role="tab" aria-selected="false">Timers</button>
        <button class="help-tab" data-help-tab="templates" role="tab" aria-selected="false">Templates</button>
        <button class="help-tab" data-help-tab="ai" role="tab" aria-selected="false">AI Features</button>
        <button class="help-tab" data-help-tab="automation" role="tab" aria-selected="false">Automation</button>
        <button class="help-tab" data-help-tab="voice" role="tab" aria-selected="false">Voice Input</button>
        <button class="help-tab" data-help-tab="attachments" role="tab" aria-selected="false">Attachments</button>
        <button class="help-tab" data-help-tab="export" role="tab" aria-selected="false">Export / Import</button>
        <button class="help-tab" data-help-tab="shortcuts" role="tab" aria-selected="false">Shortcuts</button>
      </nav>
      <div class="help-content" role="tabpanel">
        ${renderHelpContent('getting-started')}
      </div>
    </div>
  </div>`;

  document.body.appendChild(overlay);

  // Tab switching
  const switchToTab = (tab: HTMLElement) => {
    overlay.querySelectorAll('.help-tab').forEach((t) => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    const content = overlay.querySelector('.help-content');
    if (content) { content.innerHTML = renderHelpContent(tab.dataset.helpTab!); }
  };

  overlay.querySelectorAll<HTMLElement>('[data-help-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      // Clear search when clicking a tab
      const searchInput = document.getElementById('help-search-input') as HTMLInputElement;
      if (searchInput) { searchInput.value = ''; }
      const nav = document.getElementById('help-nav');
      if (nav) { nav.style.display = ''; }
      switchToTab(tab);
    });
  });

  // Fuzzy search
  const searchInput = document.getElementById('help-search-input') as HTMLInputElement;
  let searchTimeout: ReturnType<typeof setTimeout> | null = null;

  searchInput.addEventListener('input', () => {
    if (searchTimeout) { clearTimeout(searchTimeout); }
    searchTimeout = setTimeout(() => {
      const query = searchInput.value.trim();
      const content = overlay.querySelector('.help-content');
      const nav = document.getElementById('help-nav');
      if (!content || !nav) { return; }

      if (!query) {
        // Restore active tab content
        nav.style.display = '';
        const activeTab = overlay.querySelector('.help-tab.active') as HTMLElement;
        content.innerHTML = renderHelpContent(activeTab?.dataset.helpTab || 'getting-started');
        return;
      }

      // Hide tabs during search
      nav.style.display = 'none';

      // Search all sections
      const results = searchHelpSections(query);
      if (results.length === 0) {
        content.innerHTML = `<div class="help-search-empty"><p>No results found for "<strong>${escapeHtml(query)}</strong>"</p><p style="font-size:11px;color:var(--vscode-descriptionForeground);">Try different keywords or shorter search terms.</p></div>`;
      } else {
        content.innerHTML = results.map((r) => `<div class="help-search-result">
          <div class="help-search-result-header" data-help-section="${r.section}" data-help-query="${escapeHtml(query)}">${r.tabLabel}</div>
          <div class="help-search-result-snippet">${r.snippetHtml}</div>
        </div>`).join('');

        // Click result to open that tab, scroll to match, highlight
        content.querySelectorAll<HTMLElement>('.help-search-result-header').forEach((header) => {
          header.addEventListener('click', () => {
            const section = header.dataset.helpSection!;
            const searchQuery = header.dataset.helpQuery || '';
            searchInput.value = '';
            nav.style.display = '';
            const tab = overlay.querySelector(`[data-help-tab="${section}"]`) as HTMLElement;
            if (tab) {
              switchToTab(tab);
              if (searchQuery) { highlightAndScrollToMatch(overlay, searchQuery); }
            }
          });
        });

        // Also allow clicking the snippet
        content.querySelectorAll<HTMLElement>('.help-search-result').forEach((result) => {
          const snippet = result.querySelector('.help-search-result-snippet') as HTMLElement;
          const header = result.querySelector('.help-search-result-header') as HTMLElement;
          if (snippet && header) {
            snippet.style.cursor = 'pointer';
            snippet.addEventListener('click', () => header.click());
          }
        });
      }
    }, 150);
  });

  // Close handlers
  document.getElementById('btn-help-close')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); } });
  overlay.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Escape') { overlay.remove(); } });

  // Focus management — focus search input for immediate typing
  searchInput.focus();
}

function renderHelpContent(section: string): string {
  switch (section) {
    case 'getting-started':
      return `
        <h3>Welcome to Vibe Board</h3>
        <p>Vibe Board is a Kanban-style task board built right into VS Code. Plan, organize, and send tasks directly to <strong>GitHub Copilot</strong> &mdash; or automate your entire queue and let AI work through them one by one while you review.</p>
        <h4>Quick Start</h4>
        <ol>
          <li><strong>Start a Session</strong> &mdash; Click the <em>Start Session</em> button to begin tracking your work. Sessions time your overall workflow.</li>
          <li><strong>Add Tasks</strong> &mdash; Type a rough idea and click <strong>AI Improve</strong> (&#10024;) to auto-classify, format, and template it &mdash; or add manually with a tag, priority, and column.</li>
          <li><strong>Send to Copilot</strong> &mdash; Click the <strong>rocket icon</strong> (&#128640;) on any task to send it to Copilot Chat. Follow up, attach screenshots, and mark complete &mdash; all from the card.</li>
          <li><strong>Automate</strong> &mdash; Click <strong>&#9654; Automate</strong> to queue multiple tasks and let the automation engine send them to Copilot in sequence, verify changes via AI, and checkpoint for your approval.</li>
          <li><strong>Organize &amp; Track</strong> &mdash; Drag tasks between columns, use per-task timers, and export your session as JSON, CSV, or Markdown.</li>
        </ol>
        <h4>Interface Overview</h4>
        <ul>
          <li><strong>Session Bar</strong> &mdash; Top bar showing session timer, pause/resume, undo/redo, AI summary, &#9654; Automate, help, and end session.</li>
          <li><strong>Board Tabs</strong> &mdash; Below the session bar. Click to switch boards, <strong>&times;</strong> to close, double-click to rename, <strong>+</strong> to create a new board.</li>
          <li><strong>Automation Bar</strong> &mdash; Appears during automation, showing the current task, queue progress, and pause/skip/cancel controls.</li>
          <li><strong>Stats Bar</strong> &mdash; Live counts for total tasks, completed, in progress, up next, and high-priority items.</li>
          <li><strong>Search &amp; Filter</strong> &mdash; Filter tasks by text, tag, or priority.</li>
          <li><strong>Quick Add</strong> &mdash; Fast task creation with tag, priority, and column selectors plus template buttons, voice input, and AI Improve.</li>
          <li><strong>Columns</strong> &mdash; Five columns: <em>In Progress</em>, <em>Up Next</em>, <em>Backlog</em>, <em>Completed</em>, and <em>Notes</em>. Click headers to collapse.</li>
        </ul>
        <h4>AI &amp; Automation</h4>
        <p>Vibe Board integrates deeply with <strong>GitHub Copilot Chat</strong> &mdash; from one-click sends and follow-ups to fully automated task queues with AI-powered verification. See the <em>AI Features</em> and <em>Automation</em> tabs for details.</p>`;

    case 'tasks':
      return `
        <h3>Working with Tasks</h3>
        <h4>Creating Tasks</h4>
        <ul>
          <li>Type in the quick-add area and press <kbd>Enter</kbd> (or click <em>Add</em>).</li>
          <li>Select a <strong>tag</strong> (Feature, Bug, Refactor, Note, Plan, Todo), <strong>priority</strong> (High, Medium, Low), and <strong>column</strong> before adding.</li>
          <li>Use <kbd>Ctrl+N</kbd> to focus the quick-add input from anywhere.</li>
          <li>Use template buttons (emoji row) for pre-filled task types.</li>
        </ul>
        <h4>Editing Tasks</h4>
        <ul>
          <li><strong>Double-click</strong> a task title to edit inline.</li>
          <li>Click the <strong>pencil icon</strong> (&#9998;) to open the full edit form with title, description, tag, and priority fields.</li>
          <li>Press <kbd>Enter</kbd> on a focused task card to start editing.</li>
          <li>Press <kbd>Escape</kbd> to cancel editing.</li>
        </ul>
        <h4>Completing Tasks</h4>
        <ul>
          <li>Click the <strong>checkbox</strong> on a task to mark it complete. It moves to the <em>Completed</em> column.</li>
          <li>Right-click or use the <strong>three-dot menu</strong> (&#8943;) and choose <em>Complete</em>.</li>
          <li>Uncheck a completed task to reopen it (moves back to <em>Up Next</em>).</li>
        </ul>
        <h4>Deleting Tasks</h4>
        <ul>
          <li>Right-click &rarr; <em>Delete</em>, or use the three-dot menu &rarr; <em>Delete</em>.</li>
          <li>Press <kbd>Delete</kbd> on a focused task card.</li>
          <li>A confirmation dialog will appear before deletion.</li>
          <li>Deleted tasks can be recovered with <strong>Undo</strong> (<kbd>Ctrl+Z</kbd>).</li>
        </ul>
        <h4>Priority Levels</h4>
        <ul>
          <li><span class="help-badge priority-high">H</span> <strong>High</strong> &mdash; Red left border. Counted in the stats bar warning.</li>
          <li><span class="help-badge priority-medium">M</span> <strong>Medium</strong> &mdash; Orange left border. Default for new tasks.</li>
          <li><span class="help-badge priority-low">L</span> <strong>Low</strong> &mdash; Green left border.</li>
        </ul>
        <h4>Tags</h4>
        <ul>
          <li><span class="task-tag feature">Feature</span> &mdash; New functionality or enhancements.</li>
          <li><span class="task-tag bug">Bug</span> &mdash; Defects to fix.</li>
          <li><span class="task-tag refactor">Refactor</span> &mdash; Code improvements.</li>
          <li><span class="task-tag note">Note</span> &mdash; Ideas, reminders, prompts.</li>
          <li><span class="task-tag plan">Plan</span> &mdash; Implementation plans. Sent to Copilot in Ask mode for planning without changes.</li>
        </ul>`;

    case 'board':
      return `
        <h3>Board &amp; Columns</h3>
        <h4>Multiple Boards</h4>
        <p>You can create multiple boards within a session to organize different areas of work. Board tabs appear below the session bar.</p>
        <ul>
          <li><strong>Switch boards</strong> &mdash; Click a board tab to switch to that board.</li>
          <li><strong>Add a board</strong> &mdash; Click the <strong>+</strong> button at the end of the tab bar.</li>
          <li><strong>Close a board</strong> &mdash; Hover over a tab and click the <strong>&times;</strong> button that appears. A confirmation dialog will appear. Closing all boards ends the session.</li>
          <li><strong>Rename a board</strong> &mdash; <strong>Double-click</strong> a board tab name to edit it inline. Press <kbd>Enter</kbd> to save or <kbd>Escape</kbd> to cancel.</li>
        </ul>
        <h4>Columns</h4>
        <p>Each board has five columns, each representing a stage:</p>
        <ul>
          <li><strong>In Progress</strong> &mdash; Tasks you are actively working on. Tasks sent to Copilot are automatically moved here.</li>
          <li><strong>Up Next</strong> &mdash; Tasks you plan to work on now or soon.</li>
          <li><strong>Backlog</strong> &mdash; Tasks to do later, parked for future sessions.</li>
          <li><strong>Completed</strong> &mdash; Done tasks. Checked off automatically or via drag.</li>
          <li><strong>Notes</strong> &mdash; Ideas, prompts, reference material. Not formal tasks.</li>
        </ul>
        <h4>Collapsing Columns</h4>
        <ul>
          <li>Click a column header to <strong>collapse/expand</strong> it.</li>
          <li>Use <kbd>Enter</kbd> or <kbd>Space</kbd> on a focused column header.</li>
          <li>Collapsed state persists while the view is open.</li>
        </ul>
        <h4>Drag &amp; Drop</h4>
        <ul>
          <li><strong>Drag</strong> any task card to move it between columns or reorder within a column.</li>
          <li>A blue insertion indicator shows where the task will land.</li>
          <li>Dragging a task to <em>Completed</em> automatically marks it done and stops its timer.</li>
          <li>Dragging out of <em>Completed</em> reopens the task.</li>
        </ul>
        <h4>Search &amp; Filtering</h4>
        <ul>
          <li>The <strong>search box</strong> filters tasks by title and description text.</li>
          <li>Use the <strong>tag dropdown</strong> to show only a specific tag.</li>
          <li>Use the <strong>priority dropdown</strong> to filter by priority level.</li>
          <li>Filters apply across all columns simultaneously.</li>
        </ul>`;

    case 'sessions':
      return `
        <h3>Sessions</h3>
        <h4>What Is a Session?</h4>
        <p>A session represents a focused work period. It tracks duration, tasks created, tasks completed, and produces a summary when ended.</p>
        <h4>Starting a Session</h4>
        <ul>
          <li>Click <em>Start Session</em> on the start page or session bar.</li>
          <li>You'll be prompted to name your session. A default board is created automatically.</li>
          <li>A live timer appears in the top-left showing elapsed time.</li>
          <li>If the <em>Carry Over Tasks</em> setting is enabled, unfinished tasks from <strong>all previous sessions</strong> automatically transfer to the new one.</li>
          <li>Carried-over tasks show a <strong>&#8634; badge</strong> on the task card and an orange banner at the top of the board. Click the banner to expand and see all carried items.</li>
          <li>The stats bar shows a <strong>&#8634; count</strong> when there are carried-over tasks.</li>
        </ul>
        <h4>Ending a Session</h4>
        <ul>
          <li>Click <em>End Session</em> in the session bar. You can choose which boards to close.</li>
          <li>Closing all boards ends the session and shows a <strong>Session Summary</strong> with duration, tasks completed, breakdown by tag, and tasks carried over.</li>
          <li>If you keep some boards open, the session continues with the remaining boards.</li>
          <li>Tasks are preserved for history and carry-over — closing a board does not delete tasks.</li>
        </ul>
        <h4>Pausing &amp; Resuming</h4>
        <ul>
          <li>Click the <strong>pause button</strong> (&#9208;) next to the session timer to pause. The timer freezes and blinks.</li>
          <li>Click the <strong>play button</strong> (&#9654;) to resume. Paused time is excluded from total session duration.</li>
          <li>You can pause and resume as many times as needed throughout a session.</li>
          <li>If you end a session while it&rsquo;s paused, the paused time is automatically excluded from the duration summary.</li>
        </ul>
        <h4>Session History</h4>
        <ul>
          <li>The start page shows recent session history with duration, completion count, and tag breakdown.</li>
        </ul>
        <h4>Undo / Redo</h4>
        <ul>
          <li>Press <kbd>Ctrl+Z</kbd> or click the <strong>undo button</strong> (&#8630;) to undo the last action.</li>
          <li>Press <kbd>Ctrl+Y</kbd> or click the <strong>redo button</strong> (&#8631;) to redo the last undone action.</li>
          <li>Supports undoing/redoing edits, moves, completions, deletions, task creation, and timer toggles.</li>
          <li>Up to <strong>20 actions</strong> are stored in the undo stack per session.</li>
          <li>Performing a new action clears the redo history.</li>
        </ul>`;

    case 'projects':
      return `
        <h3>Projects</h3>
        <h4>What Is a Project?</h4>
        <p>Projects are a way to group related sessions together. If you work on multiple codebases, features, or initiatives, create a project for each one and assign sessions to it. Projects provide an organizational layer above sessions.</p>
        <h4>Creating a Project</h4>
        <ul>
          <li>On the start page, click <strong>+ New Project</strong> in the project bar.</li>
          <li>Give the project a name and pick a color to distinguish it visually.</li>
          <li>Projects appear as colored chips on the start page.</li>
        </ul>
        <h4>Assigning Sessions</h4>
        <ul>
          <li>When starting a new session, choose a <strong>Project</strong> from the dropdown in the Start Session dialog.</li>
          <li>The active project is pre-selected, but you can change it or leave it unassigned.</li>
          <li>The session bar shows a colored badge with the project name while the session is active.</li>
        </ul>
        <h4>Filtering by Project</h4>
        <ul>
          <li>Click a project chip on the start page to filter session history, completed tasks, and exports to that project only.</li>
          <li>Click <strong>All Projects</strong> to remove the filter and see everything.</li>
          <li>When a project is active, the export buttons scope data to that project automatically.</li>
        </ul>
        <h4>Managing Projects</h4>
        <ul>
          <li><strong>Edit</strong> &mdash; Hover over a project chip and click the pencil icon to edit the name, color, and Copilot Context.</li>
          <li><strong>Delete</strong> &mdash; Hover over a project chip and click the &times; icon to delete it. Sessions are preserved but become unassigned.</li>
          <li><strong>Copilot Context</strong> &mdash; Set project-level instructions that are automatically included in every Copilot prompt for tasks in that project.</li>
        </ul>
        <h4>Project-Scoped Exports</h4>
        <ul>
          <li>When a project filter is active, all export formats (JSON, CSV, Markdown) only include sessions and tasks from that project.</li>
          <li>The export filename and headers include the project name for easy identification.</li>
          <li>Switch to <strong>All Projects</strong> to export everything.</li>
        </ul>`;

    case 'timers':
      return `
        <h3>Time Tracking</h3>
        <h4>Session Timer</h4>
        <p>The timer in the top-left of the session bar tracks total session duration. It starts automatically when you begin a session.</p>
        <ul>
          <li>Click the <strong>pause button</strong> (&#9208;) next to the timer to pause the session. The timer freezes and blinks to indicate it&rsquo;s paused.</li>
          <li>Click the <strong>play button</strong> (&#9654;) to resume. Paused time is <em>not</em> counted toward session duration.</li>
          <li>Each session tracks its own elapsed time independently, excluding any paused intervals.</li>
        </ul>
        <h4>Per-Task Timers</h4>
        <ul>
          <li>Each task has its own timer. Click the <strong>play button</strong> (&#9654;) on a task card to start tracking time on it.</li>
          <li>Click the <strong>pause button</strong> (&#9209;) to stop the timer. Time accumulates across multiple start/stop cycles.</li>
          <li>Active timers show a <strong>blue time badge</strong> on the task card that updates live.</li>
          <li>You can also toggle timers via right-click &rarr; <em>Start/Stop Timer</em>.</li>
        </ul>
        <h4>Automatic Timer Behavior</h4>
        <ul>
          <li>Completing a task <strong>automatically stops</strong> its timer and saves accumulated time.</li>
          <li>Dragging a task to the <em>Completed</em> column also stops the timer.</li>
          <li>Time spent is preserved across sessions and shown in export data.</li>
        </ul>`;

    case 'templates':
      return `
        <h3>Task Templates</h3>
        <p>Templates let you quickly create pre-structured tasks for common workflows.</p>
        <h4>Available Templates</h4>
        <ul>
          <li>&#128027; <strong>Bug Report</strong> &mdash; Creates a high-priority bug in <em>Up Next</em> with steps-to-reproduce structure.</li>
          <li>&#128161; <strong>Feature Spike</strong> &mdash; Creates a medium-priority feature in <em>Up Next</em> with goal/approach/questions.</li>
          <li>&#128295; <strong>Refactor Plan</strong> &mdash; Creates a medium-priority refactor in <em>Backlog</em> with current/desired/risks.</li>
          <li>&#128221; <strong>Quick Note</strong> &mdash; Creates a low-priority note in <em>Notes</em> for freeform ideas.</li>
          <li>&#129302; <strong>AI Prompt Idea</strong> &mdash; Creates a medium-priority note in <em>Notes</em> with context/prompt/expected output.</li>
        </ul>
        <h4>Using Templates</h4>
        <ul>
          <li>Click any emoji button in the <strong>template bar</strong> below the quick-add area.</li>
          <li>A new task is instantly created with the template's tag, priority, column, and description structure.</li>
          <li>Edit the created task to fill in the details.</li>
        </ul>`;

    case 'ai':
      return `
        <h3>AI Features</h3>
        <h4>Requirements</h4>
        <p>AI features require <strong>GitHub Copilot Chat</strong> to be installed and active in VS Code.</p>
        <ol>
          <li>Install the <strong>GitHub Copilot Chat</strong> extension from the VS Code Marketplace.</li>
          <li>Sign in with your GitHub account (a Copilot subscription is required).</li>
          <li>Restart VS Code. Vibe Board will automatically detect the language model.</li>
        </ol>
        <p>If Copilot Chat is not available, AI buttons will show a setup message explaining what's needed.</p>
        <h4>AI Session Summary</h4>
        <ul>
          <li>Click the <strong>sparkle icon</strong> (&#10024;) in the session bar to generate an AI summary of your current session's tasks.</li>
          <li>The summary provides a concise 2&ndash;3 sentence overview of what was accomplished.</li>
        </ul>
        <h4>AI Task Breakdown</h4>
        <ul>
          <li>Right-click a task and choose <strong>AI Breakdown</strong> from the context menu.</li>
          <li>The AI splits the task into 3&ndash;5 actionable subtasks, which are added as new tasks in <em>Up Next</em>.</li>
        </ul>
        <h4>Send to Copilot</h4>
        <ul>
          <li>Click the <strong>rocket icon</strong> (&#x1F680;) on any task card to send it directly to <strong>Copilot Chat</strong>.</li>
          <li>You can also right-click a task and choose <strong>Send to Copilot</strong> from the context menu.</li>
          <li>The task title and description are placed into the Copilot Chat input so you can start prompting immediately.</li>
          <li><strong>Plan tasks</strong> automatically open in <strong>Ask mode</strong>, so Copilot provides a planning response instead of making changes immediately.</li>
          <li>The task is <strong>automatically moved to In Progress</strong> and flagged as sent to Copilot.</li>
          <li>If Copilot Chat is not available, the prompt is copied to your clipboard instead.</li>
        </ul>
        <h4>Copilot Context</h4>
        <p>Attach persistent instructions to projects that are automatically included in every Copilot prompt.</p>
        <ul>
          <li><strong>Project-level context</strong> &mdash; Set in the <strong>Edit Project</strong> dialog (click the pencil icon on a project chip). These instructions apply to every task in the project (e.g. &ldquo;Always add comments, run tests, update help docs&rdquo;).</li>
          <li>When a task is sent to Copilot, the project context is prepended before the task title and description.</li>
          <li>Context is also included during <strong>Automation</strong> runs.</li>
        </ul>
        <h4>Copilot Completion Loop</h4>
        <p>After sending a task to Copilot, persistent action buttons appear directly on the task card. These buttons stay visible as long as you need &mdash; no time pressure.</p>
        <ul>
          <li><strong>&#10003; Mark Complete</strong> &mdash; Mark the task as done and move it to the <em>Completed</em> column.</li>
          <li><strong>&#128172; Follow Up</strong> &mdash; Open an inline follow-up section to send additional context to Copilot.</li>
          <li><strong>&times; Dismiss</strong> &mdash; Clear the Copilot status without completing the task.</li>
        </ul>
        <h4>Follow-up Workflow</h4>
        <p>When you click <strong>Follow Up</strong>, a text area appears on the task card where you can describe what else needs to be done:</p>
        <ul>
          <li>Type your follow-up prompt in the text area.</li>
          <li>Use the <strong>microphone</strong> button for voice input.</li>
          <li>Use the <strong>paperclip</strong> button or paste images (<kbd>Ctrl+V</kbd>) to attach files.</li>
          <li>Click <strong>Send to Copilot</strong> to send the follow-up. It opens in Copilot Chat with any attached images.</li>
          <li>Click <strong>&#10003; Mark Complete</strong> to finish the task.</li>
          <li>Click <strong>Cancel</strong> to close the follow-up section without sending.</li>
        </ul>
        <h4>Copilot Log</h4>
        <p>Each follow-up prompt you send is logged on the task card under a <strong>&#128640; Copilot Log</strong> section, showing a numbered list of prompts with timestamps. This gives you a history of the AI conversation tied to each task.</p>
        <h4>AI Improve Task</h4>
        <ul>
          <li>Type a rough idea in the quick-add input, then click the <strong>sparkle icon</strong> (&#10024;) next to the Add button.</li>
          <li>AI automatically <strong>classifies</strong> your input into the right category (Feature, Bug, Refactor, Note, Plan, or Todo) and sets the tag, priority, and column dropdowns accordingly.</li>
          <li>AI then <strong>formats</strong> the task using the matching template structure:
            <ul>
              <li><strong>Bug</strong> &mdash; Title prefixed with "Bug:", description with Steps to reproduce, Expected, Actual</li>
              <li><strong>Feature</strong> &mdash; Title prefixed with "Spike:", description with Goal, Approach, Questions</li>
              <li><strong>Refactor</strong> &mdash; Title prefixed with "Refactor:", description with Current state, Desired state, Risks</li>
              <li><strong>Note</strong> &mdash; Clear note text</li>
              <li><strong>Plan</strong> &mdash; Title prefixed with "Plan:", description with Objective, Steps, Success criteria</li>
              <li><strong>Todo</strong> &mdash; Title prefixed with "Todo:", description with numbered list items</li>
            </ul>
          </li>
          <li>The full result (title on the first line, structured description below) appears in the <strong>quick-add textarea</strong> for you to review and edit. The tag, priority, and column dropdowns are set automatically.</li>
          <li>Click <em>Add</em> to create the task. The first line becomes the title; remaining lines become the description.</li>
        </ul>`;

    case 'automation':
      return `
        <h3>Task Automation</h3>
        <p>Automate your workflow by sending multiple tasks to Copilot Chat in sequence, with automatic change detection and AI-powered verification.</p>
        <h4>How It Works</h4>
        <ol>
          <li>Click <strong>&#9654; Automate</strong> in the session bar to open the automation task picker.</li>
          <li>Select which incomplete tasks you want to automate, then click <strong>Start Automation</strong>.</li>
          <li>For each task, the automation engine will:
            <ol>
              <li><strong>Send the task to Copilot Chat</strong> &mdash; The task title and description are sent as a prompt.</li>
              <li><strong>Watch for file changes</strong> &mdash; A file system watcher monitors your workspace for modifications.</li>
              <li><strong>Capture git changes</strong> &mdash; When changes settle (8 seconds after last change), the git diff is captured.</li>
              <li><strong>Verify with AI</strong> &mdash; The Language Model API analyzes the diff against the task to determine if it was completed.</li>
              <li><strong>Checkpoint</strong> &mdash; If confidence is high (&ge;85%), the task is auto-completed. Otherwise, you're asked to approve or reject.</li>
            </ol>
          </li>
          <li>The process repeats for each selected task until all are processed.</li>
        </ol>
        <h4>Automation Bar</h4>
        <p>When automation is running, a progress bar appears below the board tabs showing:</p>
        <ul>
          <li><strong>Status</strong> &mdash; Current step (Sending, Waiting, Verifying, Review needed, Paused)</li>
          <li><strong>Progress</strong> &mdash; How many tasks have been completed out of the total</li>
          <li><strong>Current task</strong> &mdash; Which task is being processed</li>
          <li><strong>Queue</strong> &mdash; Visual list of all tasks with their status (&#10003; done, &#10007; failed, &ndash; skipped, &#9654; current, &#9675; pending)</li>
        </ul>
        <h4>Controls</h4>
        <ul>
          <li><strong>Pause</strong> &mdash; Pause after the current task finishes. Resume whenever you're ready.</li>
          <li><strong>Skip</strong> &mdash; Skip the current task and move to the next one.</li>
          <li><strong>Cancel</strong> &mdash; Stop automation entirely. Remaining tasks are marked as skipped.</li>
        </ul>
        <h4>Checkpoints</h4>
        <p>When the AI verification has low confidence or cannot determine completion, you'll see a checkpoint with:</p>
        <ul>
          <li>The AI's assessment and confidence percentage</li>
          <li>List of changed files</li>
          <li><strong>Approve</strong> &mdash; Accept the changes, mark the task complete, and continue to the next task.</li>
          <li><strong>Reject</strong> &mdash; Mark the task as failed and pause automation.</li>
          <li><strong>Skip</strong> &mdash; Skip without marking as failed and continue.</li>
        </ul>
        <h4>Retrying Failed Tasks</h4>
        <p>If a task fails or is rejected, a <strong>&#8635; Retry</strong> button appears next to it in the queue list. Clicking it:</p>
        <ul>
          <li>Resets the task to pending and re-sends it to Copilot with added context: <em>"The previous attempt was rejected. Please try a different approach."</em></li>
          <li>Automatically resumes automation if it was paused.</li>
          <li>Each task can be retried up to <strong>3 times</strong>. After that, the retry button is replaced with <em>(max retries)</em>.</li>
        </ul>
        <h4>Auto-Approve Threshold</h4>
        <p>By default, all tasks require manual approval (threshold is 100%). You can lower this in VS Code settings to auto-approve high-confidence results:</p>
        <ul>
          <li>Open <strong>Settings</strong> (<kbd>Ctrl+,</kbd>) and search for <em>vibeboard.automationAutoApproveThreshold</em>.</li>
          <li>Set a value between 0 and 100. Higher = more manual checkpoints. Set to <strong>100</strong> to always require manual approval.</li>
        </ul>
        <h4>Requirements</h4>
        <ul>
          <li><strong>GitHub Copilot Chat</strong> must be installed and active (for sending tasks and AI verification).</li>
          <li><strong>Git</strong> must be available in the workspace (for change detection and diff capture).</li>
          <li>Works best with tasks that have clear, actionable descriptions.</li>
        </ul>`;

    case 'voice':
      return `
        <h3>Voice Input</h3>
        <p>Use your microphone to create tasks hands-free using speech recognition.</p>
        <h4>How to Use</h4>
        <ol>
          <li>Click the <strong>microphone icon</strong> (&#127908;) next to the quick-add text area.</li>
          <li>Speak your task title or description. The text appears in the input field in real time.</li>
          <li>Click the microphone again (or it auto-stops after silence) to finish recording.</li>
          <li>Review the transcribed text, then click <strong>Add</strong> to create the task.</li>
        </ol>
        <h4>Voice + AI Workflow</h4>
        <ul>
          <li>After speaking your idea, click the <strong>sparkle icon</strong> (&#10024;) to use <strong>AI Improve</strong> &mdash; AI will classify, format, and structure your rough spoken input.</li>
          <li>Then click <strong>Add</strong> to create the polished task.</li>
        </ul>
        <h4>Voice + Send to Copilot</h4>
        <ul>
          <li>Speak your idea, add it as a task, then click the <strong>rocket icon</strong> (&#128640;) to send it to Copilot Chat.</li>
          <li>This creates a fluid voice &rarr; task &rarr; Copilot workflow.</li>
        </ul>
        <h4>Voice in Follow-ups</h4>
        <ul>
          <li>When the Copilot follow-up section is open on a task card, click the <strong>microphone icon</strong> in the follow-up controls to dictate your follow-up prompt.</li>
          <li>Voice input works the same way as in quick-add &mdash; speak naturally and the text appears in the follow-up text area.</li>
        </ul>
        <h4>Tips</h4>
        <ul>
          <li>The recording indicator pulses red while the microphone is active.</li>
          <li>Interim (partial) recognition results are shown as you speak.</li>
          <li>Speech recognition requires a microphone and works best in quiet environments.</li>
          <li>If speech recognition is not available in your environment, a message will appear.</li>
        </ul>`;

    case 'attachments':
      return `
        <h3>Attachments</h3>
        <p>Attach images and files to any task. Great for screenshots, mockups, and reference materials.</p>
        <h4>Adding Attachments</h4>
        <ul>
          <li>Click the <strong>paperclip icon</strong> (&#128206;) on a task card or in the edit form to open a file picker.</li>
          <li>Select one or more images (PNG, JPG, GIF, WebP, SVG, BMP) or any file.</li>
          <li><strong>Paste images</strong> directly into the description field when editing &mdash; paste from clipboard (Ctrl+V) and images are attached automatically.</li>
        </ul>
        <h4>Viewing Attachments</h4>
        <ul>
          <li>Image thumbnails appear on the task card below the description.</li>
          <li>Up to 3 thumbnail previews are shown; the attachment count badge (&#128206;) shows the total.</li>
          <li>Click any thumbnail to open a <strong>full-size preview</strong> in a modal.</li>
        </ul>
        <h4>Managing Attachments</h4>
        <ul>
          <li>Open the task edit form to see all attachments with remove buttons.</li>
          <li>Hover over an attachment and click the <strong>&#10005;</strong> button to remove it.</li>
        </ul>
        <h4>Attachments + Copilot</h4>
        <ul>
          <li>When you <strong>Send to Copilot</strong> a task with image attachments, the images are saved to <code>.vibeboard/temp/</code> and attached directly to the Copilot Chat prompt.</li>
          <li>You can also attach images in the <strong>follow-up section</strong> &mdash; use the paperclip button or paste images (<kbd>Ctrl+V</kbd>) into the follow-up text area. These are sent along with your follow-up prompt.</li>
        </ul>`;

    case 'export':
      return `
        <h3>Exporting &amp; Importing Data</h3>
        <p>Vibe Board supports three export formats. All formats include comprehensive data with summary totals.</p>
        <h4>Export Formats</h4>
        <ul>
          <li><strong>JSON</strong> &mdash; Full data backup with summary totals, all sessions (with per-session stats), active session details, and every task. Best for backups or programmatic use. Exports all data regardless of time period.</li>
          <li><strong>CSV</strong> &mdash; Spreadsheet-ready table of tasks with columns: Session, Session Date, Session Duration, Task Title, Description, Tag, Priority, Status, Board, Time Spent, Carried Over, Created, Completed. Includes a summary section at the top with totals by session, tasks, tag, priority, and performance metrics.</li>
          <li><strong>Markdown</strong> &mdash; Human-readable report with summary statistics table, session history, tasks grouped by tag, and a performance metrics section. Includes breakdowns by tag and priority. Ideal for documentation and sharing.</li>
        </ul>
        <h4>Time Period Filter</h4>
        <p>When exporting to CSV or Markdown, you can choose a time period to filter the data:</p>
        <ul>
          <li><strong>All Time</strong> &mdash; Export everything.</li>
          <li><strong>By Day</strong> &mdash; Tasks created today.</li>
          <li><strong>By Week</strong> &mdash; Tasks created this week (Sunday to today).</li>
          <li><strong>By Month / Current Month</strong> &mdash; Tasks created this calendar month.</li>
          <li><strong>By Year</strong> &mdash; Tasks created this calendar year.</li>
          <li><strong>Last Month</strong> &mdash; Tasks created in the previous calendar month.</li>
          <li><strong>Custom Range</strong> &mdash; Set a specific start and end date.</li>
        </ul>
        <p>Tasks are filtered by their <strong>creation date</strong>. The selected period is shown in the exported file.</p>
        <h4>Project Scoping</h4>
        <p>When a project filter is active on the start page, exports are automatically scoped to that project. Only sessions and tasks belonging to the selected project are included. The project name appears in the file header and filename.</p>
        <h4>Performance Metrics</h4>
        <p>CSV and Markdown exports include a <strong>Performance</strong> section with productivity insights:</p>
        <ul>
          <li><strong>Completion Rate</strong> &mdash; Percentage of tasks that are completed.</li>
          <li><strong>Carry-over Rate</strong> &mdash; Percentage of tasks carried over from previous sessions.</li>
          <li><strong>Avg Session Duration</strong> &mdash; Mean length of all sessions.</li>
          <li><strong>Tasks Completed per Session</strong> &mdash; Average number of tasks completed each session.</li>
          <li><strong>Avg Task Turnaround</strong> &mdash; Average time from task creation to completion.</li>
          <li><strong>Longest Session</strong> &mdash; The session with the most elapsed time.</li>
          <li><strong>Most Productive Session</strong> &mdash; The session with the most tasks completed.</li>
        </ul>
        <h4>Importing Data</h4>
        <ul>
          <li>Click <strong>Import JSON</strong> on the start page to restore data from a Vibe Board JSON export or a raw <code>data.json</code> backup.</li>
          <li><strong>Replace</strong> &mdash; Overwrites all current data with the imported file. Use for restoring a backup.</li>
          <li><strong>Merge</strong> &mdash; Adds imported sessions and tasks to your existing data. Duplicates (matching IDs) are skipped. Use for combining data from multiple workspaces.</li>
          <li>Boards are also imported/merged when present in the file.</li>
          <li>The file is validated before import &mdash; sessions must have id, startedAt, and status; tasks must have id, title, status, and tag.</li>
        </ul>
        <h4>How to Export</h4>
        <ul>
          <li><strong>Start page</strong> &mdash; When no session is active, export and import buttons appear at the top of the start page.</li>
          <li><strong>Command Palette</strong> &mdash; Run <em>Vibe Board: Export Session as Markdown</em> from the command palette at any time.</li>
        </ul>
        <h4>Data Storage</h4>
        <ul>
          <li>All Vibe Board data is stored locally in your workspace at <code>.vibeboard/data.json</code>.</li>
          <li>Data is auto-saved with a 300ms debounce after each change.</li>
          <li>No data is sent to external servers.</li>
        </ul>
        <h4>Auto-Backup</h4>
        <p>Vibe Board automatically creates backup copies of your data in the background so you never lose work.</p>
        <ul>
          <li>Backups are saved to <code>.vibeboard/backups/</code> as timestamped JSON files (e.g. <code>data-backup-2026-03-04T10-30-00.json</code>).</li>
          <li>A new backup is created at most every <strong>5 minutes</strong> (configurable) when data changes.</li>
          <li>Old backups are automatically rotated &mdash; only the most recent files are kept (default: 10).</li>
          <li>To restore from a backup, use <strong>Import JSON</strong> on the start page and select a backup file, or copy it over <code>.vibeboard/data.json</code>.</li>
        </ul>
        <h4>Auto-Backup Settings</h4>
        <ul>
          <li><code>vibeboard.autoBackup</code> &mdash; Enable or disable auto-backups (default: <strong>on</strong>).</li>
          <li><code>vibeboard.autoBackupMaxCount</code> &mdash; Maximum number of backup files to keep (default: <strong>10</strong>, range: 1&ndash;100).</li>
          <li><code>vibeboard.autoBackupIntervalMin</code> &mdash; Minutes between backups (default: <strong>5</strong>, range: 1&ndash;60).</li>
          <li>You can also configure these in the <strong>&#9881; Settings</strong> dialog (click the gear icon in the toolbar).</li>
        </ul>
        <h4>Clear All Data</h4>
        <ul>
          <li>The <strong>Danger Zone</strong> section on the start page lets you permanently delete all sessions, tasks, and boards.</li>
          <li>A confirmation dialog prevents accidental deletion.</li>
          <li>Consider exporting your data first as a backup &mdash; this action cannot be undone.</li>
        </ul>
        <h4>Jira Integration</h4>
        <p>Export tasks directly to Jira as issues. Each Vibe Board task becomes a Jira issue with auto-mapped fields.</p>
        <ul>
          <li><strong>Setup</strong> &mdash; Configure your Jira credentials in the Settings dialog (gear icon). Email and API token are stored securely in your OS keychain &mdash; never in plain text.</li>
          <li><strong>API Token</strong> &mdash; Generate one at <em>id.atlassian.com &rarr; Security &rarr; API tokens</em>.</li>
          <li><strong>Export Dialog</strong> &mdash; Click the Jira button on the start page to open a full-screen picker showing your Jira projects and session tasks.</li>
          <li><strong>End-Session Export Prompt</strong> &mdash; When ending a session, Vibe Board prompts you to export unexported tasks to Jira. Toggle this on or off in <strong>&#9881; Settings &rarr; Jira Integration</strong>.</li>
        </ul>
        <h4>Project Mapping</h4>
        <ul>
          <li>The export dialog lets you pick which <strong>Jira project</strong> to create issues in.</li>
          <li>Check <strong>&ldquo;Remember for [Project]&rdquo;</strong> to save the mapping between your active Vibe Board project and the selected Jira project.</li>
          <li>Next time you export from the same Vibe Board project, the mapped Jira project is <strong>pre-selected automatically</strong>.</li>
          <li>Change the Jira project or uncheck the checkbox to update or clear the mapping.</li>
        </ul>
        <h4>Duplicate Prevention</h4>
        <ul>
          <li>Tasks that have already been exported to Jira are tracked automatically &mdash; the Jira issue key (e.g. <strong>PROJ-42</strong>) and export timestamp are saved on the task.</li>
          <li>Already-exported tasks are <strong>hidden by default</strong> in the export dialog to prevent duplicate issues.</li>
          <li>Toggle <strong>&ldquo;Hide N already exported tasks&rdquo;</strong> to show or hide them. When visible, exported tasks appear dimmed with a Jira issue key badge and are unchecked by default.</li>
          <li><strong>Select All</strong> only toggles visible (non-hidden) tasks, so hidden exported tasks are never accidentally re-exported.</li>
        </ul>
        <h4>Status Mapping</h4>
        <ul>
          <li>After selecting tasks, a <strong>status mapping step</strong> lets you map each Vibe Board column (In Progress, Up Next, Backlog, Completed, Notes) to a Jira status in the target project.</li>
          <li>Jira statuses are fetched from yor project automatically.</li>
          <li>After issues are created, Vibe Board <strong>transitions</strong> each issue to the mapped Jira status so they land in the correct workflow state.</li>
        </ul>
        <h4>Epic Linking</h4>
        <ul>
          <li>The export dialog includes an <strong>Epic</strong> dropdown that lists all epics in the selected Jira project.</li>
          <li>Select an epic to <strong>link every exported task</strong> to that epic automatically.</li>
          <li>Choose <strong>&ldquo;&#xFF0B; Create new epic&hellip;&rdquo;</strong> to create a brand-new epic in the Jira project and link tasks to it in one step.</li>
          <li>Check <strong>&ldquo;Remember for [Project]&rdquo;</strong> on the epic row to save the mapping between your active Vibe Board project and the selected epic.</li>
          <li>Next time you export from the same project, the mapped epic is <strong>pre-selected automatically</strong>.</li>
        </ul>
        <h4>Jira Field Mapping</h4>
        <ul>
          <li><strong>Title</strong> &rarr; Issue Summary</li>
          <li><strong>Description</strong> &rarr; Issue Description (ADF format, with metadata footer)</li>
          <li><strong>Tag</strong> &rarr; Label (feature, bug, refactor, etc.)</li>
          <li><strong>Priority</strong> &rarr; Issue Priority (High, Medium, Low)</li>
          <li><strong>Issue Type</strong> &rarr; Task (default)</li>
        </ul>`;

    case 'shortcuts':
      return `
        <h3>Keyboard Shortcuts</h3>
        <table class="help-shortcuts-table">
          <thead><tr><th>Shortcut</th><th>Action</th></tr></thead>
          <tbody>
            <tr><td><kbd>F1</kbd></td><td>Toggle this help panel</td></tr>
            <tr><td><kbd>Ctrl+N</kbd></td><td>Focus the quick-add input</td></tr>

            <tr><td><kbd>Ctrl+Z</kbd></td><td>Undo last action</td></tr>
            <tr><td><kbd>Ctrl+Shift+V</kbd></td><td>Quick Add Task (global VS Code keybinding)</td></tr>
            <tr><td><kbd>Enter</kbd></td><td>Submit quick-add / edit task (when focused)</td></tr>
            <tr><td><kbd>Escape</kbd></td><td>Cancel editing / close overlays</td></tr>
            <tr><td><kbd>Delete</kbd></td><td>Delete focused task card</td></tr>
            <tr><td><kbd>Enter</kbd> on task</td><td>Start editing focused task</td></tr>
            <tr><td><kbd>Space</kbd> / <kbd>Enter</kbd></td><td>Toggle column collapse (when header focused)</td></tr>
            <tr><td><kbd>Double-click</kbd></td><td>Edit task title inline</td></tr>
            <tr><td><kbd>Double-click tab</kbd></td><td>Rename a board tab inline</td></tr>
            <tr><td><kbd>Right-click</kbd></td><td>Open context menu on task</td></tr>
          </tbody>
        </table>
        <h4>Context Menu Actions</h4>
        <ul>
          <li><strong>Edit</strong> &mdash; Open inline edit form.</li>
          <li><strong>Move to...</strong> &mdash; Move task to another column.</li>
          <li><strong>Complete / Reopen</strong> &mdash; Toggle completion status.</li>
          <li><strong>Start / Stop Timer</strong> &mdash; Toggle per-task time tracking.</li>
          <li><strong>AI Breakdown</strong> &mdash; Use AI to split a task into subtasks (requires Copilot Chat).</li>
          <li><strong>Send to Copilot</strong> &mdash; Send task content to Copilot Chat as a prompt.</li>
          <li><strong>Delete</strong> &mdash; Remove task (with confirmation).</li>
        </ul>
        <h4>Task Card Actions</h4>
        <ul>
          <li><strong>&#128206; (Paperclip)</strong> &mdash; Attach a file or image to the task.</li>
          <li><strong>&#128640; (Rocket)</strong> &mdash; Send task to Copilot Chat.</li>
          <li><strong>&#127908; (Microphone)</strong> &mdash; Voice input for quick-add (in the quick-add bar).</li>
        </ul>
        <h4>Copilot Action Buttons</h4>
        <p>These appear on task cards after sending to Copilot:</p>
        <ul>
          <li><strong>&#10003; Mark Complete</strong> &mdash; Complete the task.</li>
          <li><strong>&#128172; Follow Up</strong> &mdash; Open the follow-up section to send more context.</li>
          <li><strong>&times; Dismiss</strong> &mdash; Clear the Copilot state without completing.</li>
        </ul>
        <h4>VS Code Commands</h4>
        <ul>
          <li><code>Vibe Board: Start Session</code></li>
          <li><code>Vibe Board: End Session</code></li>
          <li><code>Vibe Board: Quick Add Task</code></li>
          <li><code>Vibe Board: Export Session as Markdown</code></li>
        </ul>
        <h4>Settings</h4>
        <p>You can configure these in <strong>VS Code Settings</strong> (<kbd>Ctrl+,</kbd>) or by clicking the <strong>&#9881; Settings</strong> icon in the toolbar.</p>
        <ul>
          <li><code>vibeboard.autoPromptSession</code> &mdash; Prompt to start a session when VS Code opens (default: true).</li>
          <li><code>vibeboard.carryOverTasks</code> &mdash; Carry over unfinished tasks to the next session (default: true).</li>
          <li><code>vibeboard.autoBackup</code> &mdash; Automatically back up data (default: true).</li>
          <li><code>vibeboard.autoBackupMaxCount</code> &mdash; Maximum backup files to keep (default: 10).</li>
          <li><code>vibeboard.autoBackupIntervalMin</code> &mdash; Minutes between backups (default: 5, range: 1&ndash;60).</li>
          <li><code>vibeboard.jiraBaseUrl</code> &mdash; Your Jira Cloud base URL (e.g. <em>https://yourteam.atlassian.net</em>). Email and API token are stored in the OS keychain via the Settings dialog.</li>
        </ul>`;

    default:
      return '<p>Select a topic from the tabs above.</p>';
  }
}

// ============================================================
// Board Management Dialogs
// ============================================================

function startBoardRename(boardId: string, nameSpan: HTMLElement): void {
  const currentName = nameSpan.textContent || '';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'board-tab-rename';
  input.value = currentName;

  renamingBoardId = boardId;
  nameSpan.textContent = '';
  nameSpan.appendChild(input);
  input.focus();
  input.select();

  const commit = () => {
    renamingBoardId = null;
    const newName = input.value.trim();
    if (newName && newName !== currentName) {
      vscode.postMessage({ type: 'renameBoard', payload: { boardId, name: newName } });
    } else {
      nameSpan.textContent = currentName;
    }
  };

  input.addEventListener('blur', commit, { once: true });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); input.value = currentName; input.blur(); }
  });
}

function showNewBoardDialog(): void {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Create New Board');
  overlay.innerHTML = `<div class="modal-card">
    <h3>Create New Board</h3>
    <input type="text" id="new-board-name" placeholder="Board name..." style="width:100%;padding:6px;margin:8px 0;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:2px;" />
    <div class="modal-actions">
      <button class="secondary" id="modal-cancel">Cancel</button>
      <button id="modal-confirm">Create</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  const input = document.getElementById('new-board-name') as HTMLInputElement;
  input?.focus();

  const doCreate = () => {
    const name = input?.value.trim();
    if (name) { vscode.postMessage({ type: 'createBoard', payload: { name } }); }
    overlay.remove();
  };

  document.getElementById('modal-confirm')!.addEventListener('click', doCreate);
  input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { doCreate(); } });
  document.getElementById('modal-cancel')!.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); } });
}

function showBoardManager(): void {
  if (!state) { return; }
  const boards = state.boards ?? [];
  const activeBoardId = state.activeBoardId || 'default';

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Manage Boards');

  const boardRows = boards.map((b) => {
    const isDefault = b.id === 'default';
    const isActive = b.id === activeBoardId;
    return `<div class="board-manager-row ${isActive ? 'active' : ''}">
      <span class="board-manager-name">${escapeHtml(b.name)}${isActive ? ' <small>(active)</small>' : ''}</span>
      <div class="board-manager-actions">
        <button class="icon-btn" data-rename-board="${b.id}" title="Rename">&#9998;</button>
        ${!isDefault ? `<button class="icon-btn danger" data-delete-board="${b.id}" title="Delete">&#128465;</button>` : ''}
      </div>
    </div>`;
  }).join('');

  overlay.innerHTML = `<div class="modal-card board-manager-card">
    <h3>Manage Boards</h3>
    <div class="board-manager-list">${boardRows}</div>
    <div class="modal-actions" style="margin-top:12px;">
      <button class="secondary" id="modal-cancel">Close</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  // Rename handlers
  overlay.querySelectorAll<HTMLElement>('[data-rename-board]').forEach((el) => {
    el.addEventListener('click', () => {
      const boardId = el.dataset.renameBoard!;
      const board = boards.find((b) => b.id === boardId);
      if (!board) { return; }
      const newName = prompt('Rename board:', board.name);
      if (newName && newName.trim()) {
        vscode.postMessage({ type: 'renameBoard', payload: { boardId, name: newName.trim() } });
        overlay.remove();
      }
    });
  });

  // Delete handlers
  overlay.querySelectorAll<HTMLElement>('[data-delete-board]').forEach((el) => {
    el.addEventListener('click', () => {
      const boardId = el.dataset.deleteBoard!;
      const board = boards.find((b) => b.id === boardId);
      if (!board) { return; }
      showConfirmDialog('Delete board?', `"${board.name}" and its tasks will be affected.`, () => {
        vscode.postMessage({ type: 'deleteBoard', payload: { boardId } });
        overlay.remove();
      });
    });
  });

  document.getElementById('modal-cancel')!.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); } });
}

// ============================================================
// AI Result Handling
// ============================================================

/** Sync undo/redo button disabled state with current snapshot + stack state */
function syncUndoRedoButtons(): void {
  const undoBtn = document.getElementById('btn-undo') as HTMLButtonElement | null;
  const redoBtn = document.getElementById('btn-redo') as HTMLButtonElement | null;
  if (undoBtn) {
    undoBtn.disabled = !(preAIFormSnapshot || (state?.undoCount && state.undoCount > 0));
  }
  if (redoBtn) {
    redoBtn.disabled = !(redoAIFormSnapshot || (state?.redoCount && state.redoCount > 0));
  }
}

/**
 * Undo an AI Improve rewrite by restoring the pre-AI form state.
 * Returns true if there was an AI rewrite to undo, false otherwise.
 */
function undoAIImprove(): boolean {
  if (!preAIFormSnapshot) { return false; }
  const snapshot = preAIFormSnapshot;
  preAIFormSnapshot = null;

  const input = document.getElementById('quick-add-input') as HTMLTextAreaElement | null;
  const tagSelect = document.getElementById('quick-add-tag') as HTMLSelectElement | null;
  const prioSelect = document.getElementById('quick-add-priority') as HTMLSelectElement | null;
  const colSelect = document.getElementById('quick-add-col') as HTMLSelectElement | null;

  // Save current (AI) state so redo can restore it
  redoAIFormSnapshot = {
    text: input?.value || '',
    tag: tagSelect?.value || quickAddTag,
    priority: prioSelect?.value || quickAddPriority,
    col: colSelect?.value || quickAddCol,
  };

  if (input) {
    input.value = snapshot.text;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    input.focus();
  }
  if (tagSelect) { tagSelect.value = snapshot.tag; }
  if (prioSelect) { prioSelect.value = snapshot.priority; }
  if (colSelect) { colSelect.value = snapshot.col; }

  // Restore state variables so next render picks them up
  quickAddTag = snapshot.tag;
  quickAddPriority = snapshot.priority;
  quickAddCol = snapshot.col;
  pendingAIClassification = null;
  pendingAIDescription = '';

  showAIToast('AI Improve undone', false);
  syncUndoRedoButtons();
  return true;
}

/**
 * Redo an AI Improve rewrite that was previously undone.
 * Returns true if there was an AI redo to apply, false otherwise.
 */
function redoAIImprove(): boolean {
  if (!redoAIFormSnapshot) { return false; }
  const snapshot = redoAIFormSnapshot;
  redoAIFormSnapshot = null;

  const input = document.getElementById('quick-add-input') as HTMLTextAreaElement | null;
  const tagSelect = document.getElementById('quick-add-tag') as HTMLSelectElement | null;
  const prioSelect = document.getElementById('quick-add-priority') as HTMLSelectElement | null;
  const colSelect = document.getElementById('quick-add-col') as HTMLSelectElement | null;

  // Save current state so undo can reverse this redo
  preAIFormSnapshot = {
    text: input?.value || '',
    tag: tagSelect?.value || quickAddTag,
    priority: prioSelect?.value || quickAddPriority,
    col: colSelect?.value || quickAddCol,
  };

  if (input) {
    input.value = snapshot.text;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    input.focus();
  }
  if (tagSelect) { tagSelect.value = snapshot.tag; }
  if (prioSelect) { prioSelect.value = snapshot.priority; }
  if (colSelect) { colSelect.value = snapshot.col; }

  quickAddTag = snapshot.tag;
  quickAddPriority = snapshot.priority;
  quickAddCol = snapshot.col;
  pendingAIClassification = { tag: snapshot.tag, priority: snapshot.priority, status: snapshot.col };

  showAIToast('AI Improve redone', false);
  syncUndoRedoButtons();
  return true;
}

function handleAIResult(payload: { action: string; result: string | string[]; taskId?: string }): void {
  const { action, result } = payload;

  // Ignore loading states
  if (result === '...') {
    showAIToast('AI is thinking...', true);
    return;
  }

  switch (action) {
    case 'summarize': {
      showAIResultModal('AI Session Summary', typeof result === 'string' ? result : result.join('\n'));
      break;
    }
    case 'breakdown': {
      const subtasks = Array.isArray(result) ? result : [result];
      showAIResultModal('AI Task Breakdown', `Created ${subtasks.length} subtask${subtasks.length !== 1 ? 's' : ''}:\n\n${subtasks.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
      break;
    }
    case 'rewriteTitle': {
      const raw = typeof result === 'string' ? result : result[0];
      try {
        const parsed = JSON.parse(raw);
        const input = document.getElementById('quick-add-input') as HTMLTextAreaElement | null;
        const tagSelect = document.getElementById('quick-add-tag') as HTMLSelectElement | null;
        const prioSelect = document.getElementById('quick-add-priority') as HTMLSelectElement | null;
        const colSelect = document.getElementById('quick-add-col') as HTMLSelectElement | null;

        if (input && parsed.title) {
          // Save pre-AI form state so Undo can restore it
          preAIFormSnapshot = {
            text: input.value,
            tag: tagSelect?.value || quickAddTag,
            priority: prioSelect?.value || quickAddPriority,
            col: colSelect?.value || quickAddCol,
          };
          // Show full content in textarea: title on first line, description below
          const fullContent = parsed.description
            ? parsed.title + '\n' + parsed.description
            : parsed.title;
          input.value = fullContent;
          input.focus();
          // Auto-resize textarea to fit content
          input.style.height = 'auto';
          input.style.height = Math.min(input.scrollHeight, 200) + 'px';
          pendingAIDescription = '';

          // Set tag, priority, and column from AI classification
          // Update state variables so next render picks them up
          if (parsed.tag) { quickAddTag = parsed.tag; }
          if (parsed.priority) { quickAddPriority = parsed.priority; }
          if (parsed.status) { quickAddCol = parsed.status; }
          // Also set DOM directly for immediate visual feedback
          if (tagSelect && parsed.tag) { tagSelect.value = parsed.tag; }
          if (prioSelect && parsed.priority) { prioSelect.value = parsed.priority; }
          if (colSelect && parsed.status) { colSelect.value = parsed.status; }

          // Store classification so it survives any re-renders
          pendingAIClassification = { tag: parsed.tag, priority: parsed.priority, status: parsed.status };

          const tagLabel = parsed.tag ? TAG_LABELS[parsed.tag as TaskTag] || parsed.tag : '';
          showAIToast(`Classified as ${tagLabel} — review & edit, then click Add`, false);
          syncUndoRedoButtons();
        }
      } catch {
        // Fallback if not JSON
        const input = document.getElementById('quick-add-input') as HTMLTextAreaElement | null;
        if (input && raw) {
          const tagSelect = document.getElementById('quick-add-tag') as HTMLSelectElement | null;
          const prioSelect = document.getElementById('quick-add-priority') as HTMLSelectElement | null;
          const colSelect = document.getElementById('quick-add-col') as HTMLSelectElement | null;
          preAIFormSnapshot = {
            text: input.value,
            tag: tagSelect?.value || quickAddTag,
            priority: prioSelect?.value || quickAddPriority,
            col: colSelect?.value || quickAddCol,
          };
          input.value = raw;
          input.focus();
          showAIToast('Title improved by AI', false);
          syncUndoRedoButtons();
        }
      }
      break;
    }
  }
}

function showAIToast(message: string, loading: boolean): void {
  const existing = document.getElementById('ai-toast');
  if (existing) { existing.remove(); }

  const toast = document.createElement('div');
  toast.id = 'ai-toast';
  toast.className = `ai-toast ${loading ? 'loading' : ''}`;
  toast.innerHTML = `<span class="ai-toast-icon">${loading ? '&#8987;' : '&#10024;'}</span> ${escapeHtml(message)}`;
  document.body.appendChild(toast);

  if (!loading) {
    setTimeout(() => toast.remove(), 4000);
  }
}

function showAIResultModal(title: string, content: string): void {
  // Remove loading toast
  document.getElementById('ai-toast')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', title);
  overlay.innerHTML = `<div class="modal-card ai-result-card">
    <div class="ai-result-header">
      <span class="ai-result-icon">&#10024;</span>
      <h3>${escapeHtml(title)}</h3>
    </div>
    <div class="ai-result-content"><pre>${escapeHtml(content)}</pre></div>
    <div class="modal-actions">
      <button id="modal-cancel">Close</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  document.getElementById('modal-cancel')!.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); } });
  overlay.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Escape') { overlay.remove(); } });
}

// ============================================================
// Utility Helpers
// ============================================================

function closeAllOverlays(): void {
  document.querySelectorAll('.modal-overlay, .summary-overlay, #context-menu').forEach((el) => el.remove());
  contextMenuTaskId = null;
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function formatDurationCompact(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) { return `${hours}h${minutes}m`; }
  if (minutes > 0) { return `${minutes}m`; }
  return `${totalSeconds}s`;
}

function pad(n: number): string { return n.toString().padStart(2, '0'); }

function getTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) { return 'just now'; }
  if (mins < 60) { return `${mins}m ago`; }
  const hours = Math.floor(mins / 60);
  if (hours < 24) { return `${hours}h ago`; }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
