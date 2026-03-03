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
  tag: 'feature' | 'bug' | 'refactor' | 'note';
  priority: 'high' | 'medium' | 'low';
  status: 'up-next' | 'backlog' | 'completed' | 'notes';
  createdAt: string;
  completedAt: string | null;
  order: number;
  sessionId: string;
  boardId: string;
  timeSpentMs: number;
  timerStartedAt: string | null;
  carriedFromSessionId?: string;
}

interface VBSession {
  id: string;
  name: string;
  projectPath: string;
  startedAt: string;
  endedAt: string | null;
  status: 'active' | 'ended';
}

interface VBBoard {
  id: string;
  name: string;
  createdAt: string;
}

interface VBWorkspaceData {
  version: 1;
  activeSessionId: string | null;
  sessions: VBSession[];
  tasks: VBTask[];
  undoStack?: unknown[];
  redoStack?: unknown[];
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

// ============================================================
// Constants
// ============================================================

const COLUMNS: { id: TaskStatus; label: string }[] = [
  { id: 'up-next', label: 'Up Next' },
  { id: 'backlog', label: 'Backlog' },
  { id: 'completed', label: 'Completed' },
  { id: 'notes', label: 'Notes' },
];

const TAG_LABELS: Record<TaskTag, string> = { feature: 'Feature', bug: 'Bug', refactor: 'Refactor', note: 'Note' };
const TAG_OPTIONS: TaskTag[] = ['feature', 'bug', 'refactor', 'note'];
const PRIORITY_LABELS: Record<TaskPriority, string> = { high: 'High', medium: 'Medium', low: 'Low' };
const PRIORITY_OPTIONS: TaskPriority[] = ['high', 'medium', 'low'];

const TEMPLATES = [
  { name: 'Bug Report', icon: '🐛' },
  { name: 'Feature Spike', icon: '💡' },
  { name: 'Refactor Plan', icon: '🔧' },
  { name: 'Quick Note', icon: '📝' },
  { name: 'AI Prompt Idea', icon: '🤖' },
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
  if ((e.ctrlKey || e.metaKey) && e.key === 'h') {
    e.preventDefault();
    toggleView();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    vscode.postMessage({ type: 'undo', payload: {} });
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
    e.preventDefault();
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

  app.innerHTML = html;
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
  const viewToggle = `<button class="icon-btn view-toggle ${activeView === 'history' ? 'active' : ''}" id="btn-toggle-view" title="Session History (Ctrl+H)" aria-label="Toggle session history">&#128218;</button>`;
  const undoBtn = `<button class="icon-btn" id="btn-undo" title="Undo (Ctrl+Z)" aria-label="Undo last action">&#8630;</button>`;
  const redoBtn = `<button class="icon-btn" id="btn-redo" title="Redo (Ctrl+Y)" aria-label="Redo last action">&#8631;</button>`;
  const helpBtn = `<button class="icon-btn help-btn" id="btn-help" title="Help (F1)" aria-label="Open help">&#63;</button>`;
  const aiBtn = session ? `<button class="icon-btn ai-btn" id="btn-ai-summarize" title="AI Summarize Session" aria-label="AI summarize session">&#10024;</button>` : '';

  const boardSwitcher = session ? renderBoardSwitcher() : '';

  if (!session) {
    return `<div class="session-bar" role="toolbar" aria-label="Session controls">
      <div class="session-info"><span style="font-size:12px;font-weight:600;">Vibe Board</span></div>
      <div class="session-actions">${helpBtn}${viewToggle}<button class="btn-start-session">Start Session</button></div>
    </div>`;
  }

  const activeBoardName = state?.boards?.find((b) => b.id === state?.activeBoardId)?.name || 'Session';

  return `<div class="session-bar" role="toolbar" aria-label="Session controls">
    <div class="session-info">
      <span class="session-name">${escapeHtml(activeBoardName)}</span>
      <span class="session-timer" id="session-timer" aria-live="polite">00:00:00</span>
    </div>
    <div class="session-actions">${aiBtn}${undoBtn}${redoBtn}${helpBtn}${viewToggle}<button class="secondary" id="btn-end-session">End Session</button></div>
  </div>
  ${boardSwitcher}`;
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

  return `<div class="carried-over-banner" role="region" aria-label="Carried over tasks">
    <div class="carried-over-header" id="carried-over-toggle">
      <span>&#8634; ${carriedTasks.length} task${carriedTasks.length === 1 ? '' : 's'} carried over from <strong>${escapeHtml(fromName)}</strong></span>
      <button class="icon-btn carried-over-expand" title="Toggle details" aria-label="Toggle carried over details">&#9660;</button>
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
  const upNext = tasks.filter((t) => t.status === 'up-next').length;
  const highPrio = tasks.filter((t) => t.priority === 'high' && t.status !== 'completed').length;
  const carriedOver = tasks.filter((t) => t.carriedFromSessionId).length;

  return `<div class="stats-bar" role="status" aria-label="Task statistics">
    <span class="stat-pill" title="Total tasks">&#128203; ${total}</span>
    <span class="stat-pill completed" title="Completed">&#10003; ${completed}</span>
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

  return `<div class="quick-add">
    <textarea id="quick-add-input" placeholder="Add a task... (Enter to submit)" rows="2" aria-label="New task title"></textarea>
    <div class="quick-add-controls">
      <select id="quick-add-tag" aria-label="Task tag">
        <option value="feature">Feature</option><option value="bug">Bug</option>
        <option value="refactor">Refactor</option><option value="note">Note</option>
      </select>
      <select id="quick-add-priority" aria-label="Task priority">
        <option value="medium">Medium</option><option value="high">High</option><option value="low">Low</option>
      </select>
      <select id="quick-add-col" aria-label="Target column">
        <option value="up-next">Up Next</option><option value="backlog">Backlog</option><option value="notes">Notes</option>
      </select>
      <button class="icon-btn ai-suggest-btn" id="btn-ai-rewrite" title="AI improve task" aria-label="AI improve task">&#10024;</button>
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

  return `<div class="task-card ${prioClass}" draggable="true" data-task-id="${task.id}" role="listitem" tabindex="0" aria-label="${escapeAttr(task.title)}${task.priority === 'high' ? ' - High Priority' : ''}${task.carriedFromSessionId ? ' - Carried over' : ''}" oncontextmenu="return false;">
    <div class="task-header">
      <input type="checkbox" class="task-checkbox" data-complete="${task.id}" ${isCompleted ? 'checked' : ''} title="Mark complete" aria-label="Mark ${escapeAttr(task.title)} complete" />
      ${carriedBadge}<span class="${titleClass}" data-edit-title="${task.id}" title="Double-click to edit">${escapeHtml(task.title)}</span>
      <div class="task-actions">
        <button class="icon-btn timer-btn ${timerActive ? 'active' : ''}" data-timer="${task.id}" title="${timerActive ? 'Stop timer' : 'Start timer'}" aria-label="Toggle timer">${timerIcon}</button>
        <button class="icon-btn" data-edit="${task.id}" title="Edit" aria-label="Edit task">&#9998;</button>
        <button class="icon-btn" data-context="${task.id}" title="More" aria-label="More actions">&#8943;</button>
      </div>
    </div>
    ${task.description ? `<div class="task-description">${escapeHtml(task.description)}</div>` : ''}
    <div class="task-meta">
      <span class="task-priority-badge ${prioClass}" aria-label="Priority: ${task.priority || 'medium'}">${(task.priority || 'medium')[0].toUpperCase()}</span>
      <span class="task-tag ${task.tag}">${TAG_LABELS[task.tag]}</span>
      ${timeStr ? `<span class="task-timer-display ${timerActive ? 'active' : ''}" data-timer-display="${task.id}">${timeStr}</span>` : ''}
      <span class="task-time" title="${new Date(task.createdAt).toLocaleString()}">${timeAgo}</span>
    </div>
  </div>`;
}

// ============================================================
// Task Edit Card
// ============================================================

function renderTaskEditCard(task: VBTask): string {
  const tagOpts = TAG_OPTIONS.map((t) => `<option value="${t}" ${task.tag === t ? 'selected' : ''}>${TAG_LABELS[t]}</option>`).join('');
  const prioOpts = PRIORITY_OPTIONS.map((p) => `<option value="${p}" ${task.priority === p ? 'selected' : ''}>${PRIORITY_LABELS[p]}</option>`).join('');

  return `<div class="task-card editing" data-task-id="${task.id}" role="listitem">
    <input type="text" class="edit-title-input" data-save-title="${task.id}" value="${escapeAttr(task.title)}" placeholder="Task title" aria-label="Edit title" />
    <textarea class="edit-desc-input" data-save-desc="${task.id}" placeholder="Description (optional)" rows="3" aria-label="Edit description">${escapeHtml(task.description)}</textarea>
    <div class="edit-controls">
      <select data-save-tag="${task.id}" aria-label="Tag">${tagOpts}</select>
      <select data-save-priority="${task.id}" aria-label="Priority">${prioOpts}</select>
      <div class="edit-buttons">
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
  let html = `<div class="start-page">
    <div class="start-hero">
      <div class="empty-icon">&#128161;</div>
      <h2>Ready to think?</h2>
      <p>Start a session to capture ideas, organize prompts, and track your AI workflow.</p>
      <button class="btn-start-session">Start Session</button>
    </div>`;

  if (state && state.sessions.length > 0) {
    // Export (always visible at top)
    html += `<div class="start-section"><div class="start-section-header"><h3>&#128230; Export / Import</h3></div>
      <div class="start-export-actions">
        <button class="secondary" id="btn-export-json" title="Full data backup — all sessions, tasks, and settings in machine-readable format">JSON</button>
        <button class="secondary" id="btn-export-csv" title="Spreadsheet-ready table — all tasks with session info, plus summary totals">CSV</button>
        <button class="secondary" id="btn-export-md" title="Human-readable report — summary stats, session history, and all tasks">Markdown</button>
      </div>
      <div class="start-export-hints">
        <span>JSON: Full backup</span>
        <span>CSV: Spreadsheet</span>
        <span>MD: Report</span>
      </div>
      <div class="start-import-actions">
        <button class="secondary" id="btn-import-data" title="Import data from a Vibe Board JSON export or data.json backup">&#128229; Import JSON</button>
      </div></div>`;

    // Session history
    const endedSessions = state.sessions
      .filter((s) => s.status === 'ended')
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    const SESSION_PREVIEW = 5;
    if (endedSessions.length > 0) {
      const showAllSessions = endedSessions.length > SESSION_PREVIEW;
      html += `<div class="start-section"><div class="start-section-header"><h3>&#128218; Session History <span class="start-section-count">(${endedSessions.length})</span></h3></div><div class="start-section-list start-section-scrollable" id="session-history-list">`;
      for (let i = 0; i < endedSessions.length; i++) {
        const s = endedSessions[i];
        const date = new Date(s.startedAt).toLocaleDateString();
        const time = new Date(s.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const endMs = s.endedAt ? new Date(s.endedAt).getTime() : Date.now();
        const dur = formatDuration(endMs - new Date(s.startedAt).getTime());
        const sessionTasks = state!.tasks.filter((t) => t.sessionId === s.id);
        const completed = sessionTasks.filter((t) => t.status === 'completed').length;
        const carried = sessionTasks.filter((t) => t.carriedFromSessionId).length;
        const carriedStr = carried > 0 ? `<span>&#8634; ${carried} carried over</span>` : '';
        const hiddenClass = showAllSessions && i >= SESSION_PREVIEW ? ' start-hidden-item' : '';
        html += `<div class="start-history-item${hiddenClass}">
          <div class="start-history-row"><span class="start-history-date">${date} ${time}</span><span class="start-history-dur">${dur}</span></div>
          <div class="start-history-stats"><span>&#10003; ${completed}/${sessionTasks.length} tasks</span>${carriedStr}</div>
        </div>`;
      }
      html += '</div>';
      if (showAllSessions) {
        html += `<button class="start-toggle-btn" data-target="session-history-list" data-count="${endedSessions.length}">Show all ${endedSessions.length} sessions</button>`;
      }
      html += '</div>';
    }

    // Completed tasks
    const completedTasks = state.tasks
      .filter((t) => t.status === 'completed')
      .sort((a, b) => new Date(b.completedAt ?? b.createdAt).getTime() - new Date(a.completedAt ?? a.createdAt).getTime());

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

  // Undo
  document.getElementById('btn-undo')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'undo', payload: {} });
  });

  // Redo
  document.getElementById('btn-redo')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'redo', payload: {} });
  });

  // View toggle
  document.getElementById('btn-toggle-view')?.addEventListener('click', () => toggleView());

  // Help
  document.getElementById('btn-help')?.addEventListener('click', () => showHelp());

  // Carried-over banner toggle
  document.getElementById('carried-over-toggle')?.addEventListener('click', () => {
    const details = document.getElementById('carried-over-details');
    const expandBtn = document.querySelector('.carried-over-expand');
    if (details) {
      const isHidden = details.style.display === 'none';
      details.style.display = isHidden ? 'block' : 'none';
      if (expandBtn) { expandBtn.innerHTML = isHidden ? '&#9650;' : '&#9660;'; }
    }
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
  document.getElementById('btn-export-json')?.addEventListener('click', () => vscode.postMessage({ type: 'exportData', payload: { format: 'json' } }));
  document.getElementById('btn-export-csv')?.addEventListener('click', () => showExportTimePicker('csv'));
  document.getElementById('btn-export-md')?.addEventListener('click', () => showExportTimePicker('markdown'));
  document.getElementById('btn-import-data')?.addEventListener('click', () => vscode.postMessage({ type: 'importData', payload: {} }));

  // Clear all data
  document.getElementById('btn-clear-all-data')?.addEventListener('click', () => vscode.postMessage({ type: 'clearAllData', payload: {} }));

  // Templates
  document.querySelectorAll<HTMLElement>('[data-template]').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.template!, 10);
      vscode.postMessage({ type: 'addFromTemplate', payload: { templateIndex: idx } });
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

    vscode.postMessage({
      type: 'addTask',
      payload: {
        title,
        tag: addTag.value as TaskTag,
        priority: (addPriority?.value ?? 'medium') as TaskPriority,
        status: addCol.value as TaskStatus,
        description,
      },
    });
    addInput.value = '';
    pendingAIDescription = '';
    addInput.focus();
  };

  addBtn?.addEventListener('click', doAdd);
  addInput?.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doAdd(); }
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
    <div class="ctx-separator" role="separator"></div>
    <div class="ctx-item danger" data-ctx-delete role="menuitem">&#128465; Delete</div>`;

  const x = Math.min(mouseEvent.clientX, window.innerWidth - 160);
  const y = Math.min(mouseEvent.clientY, window.innerHeight - 250);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);

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
    else if (target.hasAttribute('data-ctx-delete')) { showDeleteConfirm(taskId, task.title); }
    else if (target.dataset.ctxMove) { vscode.postMessage({ type: 'moveTask', payload: { id: taskId, newStatus: target.dataset.ctxMove as TaskStatus, newOrder: 0 } }); }
    menu.remove();
    contextMenuTaskId = null;
  });
}

// ============================================================
// Start Session Dialog
// ============================================================

function showStartSessionDialog(): void {
  const sessionNumber = state ? state.sessions.length + 1 : 1;
  const defaultName = `Session ${sessionNumber}`;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Start New Session');
  overlay.innerHTML = `<div class="modal-card">
    <h3>Start New Session</h3>
    <input type="text" id="session-name-input" placeholder="Session name..." value="${escapeAttr(defaultName)}" style="width:100%;padding:6px;margin:8px 0;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:2px;" />
    <div class="modal-actions">
      <button class="secondary" id="modal-cancel">Cancel</button>
      <button id="modal-confirm">Start</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  const input = document.getElementById('session-name-input') as HTMLInputElement;
  input?.focus();
  input?.select();

  const doStart = () => {
    const name = input?.value.trim() || defaultName;
    vscode.postMessage({ type: 'startSession', payload: { name } });
    overlay.remove();
  };

  document.getElementById('modal-confirm')!.addEventListener('click', doStart);
  input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { doStart(); } });
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

  // If only one board, confirm directly with board name
  if (boards.length === 1) {
    const b = boards[0];
    showConfirmDialog(`End "${b.name}"?`, 'This board and its tasks will be closed and the session will end.', () => {
      vscode.postMessage({ type: 'closeBoards', payload: { boardIds: [b.id] } });
    });
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Close Projects');

  const boardRows = boards.map((b) => {
    const isActive = b.id === activeBoardId;
    const boardTasks = state!.tasks.filter((t) => (t.boardId || 'default') === b.id && t.sessionId === state!.activeSessionId);
    const completed = boardTasks.filter((t) => t.status === 'completed').length;

    return `<label class="session-pick-row ${isActive ? 'active' : ''}" data-session-pick="${b.id}">
      <input type="checkbox" class="session-pick-cb" value="${b.id}" />
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

  overlay.innerHTML = `<div class="modal-card session-picker-card">
    <h3>Close Projects</h3>
    <p class="session-pick-desc">Select which projects to close. If all are closed, the session will end.</p>
    <div class="session-pick-list">${boardRows}</div>
    <div class="session-pick-actions">
      <button class="secondary" id="session-pick-select-all">Select All</button>
      <div class="modal-actions">
        <button class="secondary" id="session-pick-cancel">Cancel</button>
        <button class="danger" id="session-pick-confirm" disabled>Close Selected</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  const checkboxes = overlay.querySelectorAll<HTMLInputElement>('.session-pick-cb');
  const confirmBtn = document.getElementById('session-pick-confirm') as HTMLButtonElement;

  // Update confirm button state when selections change
  const updateConfirm = () => {
    const anyChecked = Array.from(checkboxes).some((cb) => cb.checked);
    confirmBtn.disabled = !anyChecked;
  };
  checkboxes.forEach((cb) => cb.addEventListener('change', updateConfirm));

  // Select all
  document.getElementById('session-pick-select-all')!.addEventListener('click', () => {
    const allChecked = Array.from(checkboxes).every((cb) => cb.checked);
    checkboxes.forEach((cb) => { cb.checked = !allChecked; });
    updateConfirm();
  });

  // Confirm
  confirmBtn.addEventListener('click', () => {
    const selected = Array.from(checkboxes).filter((cb) => cb.checked).map((cb) => cb.value);
    if (selected.length > 0) {
      vscode.postMessage({ type: 'closeBoards', payload: { boardIds: selected } });
    }
    overlay.remove();
  });

  // Cancel
  document.getElementById('session-pick-cancel')!.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); } });
  overlay.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Escape') { overlay.remove(); } });
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
// Export Time Period Picker
// ============================================================

function showExportTimePicker(format: 'csv' | 'markdown'): void {
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

  document.getElementById('export-time-confirm')!.addEventListener('click', () => {
    const selected = overlay.querySelector<HTMLInputElement>('input[name="export-time"]:checked')!.value;
    const payload: Record<string, string> = { format, timePeriod: selected };
    if (selected === 'custom') {
      payload.customStart = (document.getElementById('export-custom-start') as HTMLInputElement).value;
      payload.customEnd = (document.getElementById('export-custom-end') as HTMLInputElement).value;
    }
    vscode.postMessage({ type: 'exportData', payload });
    overlay.remove();
  });

  document.getElementById('export-time-cancel')!.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); } });
  (document.getElementById('export-time-cancel') as HTMLElement)?.focus();
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
      <button class="icon-btn help-btn" id="btn-help" title="Help (F1)" aria-label="Open help">&#63;</button>
      <button class="icon-btn view-toggle active" id="btn-toggle-view" title="Back to Board (Ctrl+H)" aria-label="Back to board">&#128218;</button>
      ${getActiveSession()
    ? '<button class="secondary" id="btn-end-session">End Session</button>'
    : '<button class="btn-start-session">Start Session</button>'}
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
        </div>
      </div>`;
    }
    html += '</div>';
  }

  app.innerHTML = html;
  document.getElementById('btn-toggle-view')?.addEventListener('click', () => toggleView());
  document.getElementById('btn-help')?.addEventListener('click', () => showHelp());
  document.querySelectorAll<HTMLElement>('.btn-start-session').forEach((el) => {
    el.addEventListener('click', () => { showStartSessionDialog(); activeView = 'board'; });
  });
  document.getElementById('btn-end-session')?.addEventListener('click', () => vscode.postMessage({ type: 'endSession', payload: {} }));
}

// ============================================================
// Timers
// ============================================================

function startTimer(session: VBSession | null): void {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  if (!session || session.status !== 'active') { return; }
  const startTime = new Date(session.startedAt).getTime();
  const update = () => {
    const el = document.getElementById('session-timer');
    if (el) { el.textContent = formatDuration(Date.now() - startTime); }
  };
  update();
  timerInterval = setInterval(update, 1000);
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
    <div class="help-body">
      <nav class="help-nav" role="tablist" aria-label="Help sections">
        <button class="help-tab active" data-help-tab="getting-started" role="tab" aria-selected="true">Getting Started</button>
        <button class="help-tab" data-help-tab="tasks" role="tab" aria-selected="false">Tasks</button>
        <button class="help-tab" data-help-tab="board" role="tab" aria-selected="false">Board</button>
        <button class="help-tab" data-help-tab="sessions" role="tab" aria-selected="false">Sessions</button>
        <button class="help-tab" data-help-tab="timers" role="tab" aria-selected="false">Timers</button>
        <button class="help-tab" data-help-tab="templates" role="tab" aria-selected="false">Templates</button>
        <button class="help-tab" data-help-tab="ai" role="tab" aria-selected="false">AI Features</button>
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
  overlay.querySelectorAll<HTMLElement>('[data-help-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      overlay.querySelectorAll('.help-tab').forEach((t) => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      const content = overlay.querySelector('.help-content');
      if (content) { content.innerHTML = renderHelpContent(tab.dataset.helpTab!); }
    });
  });

  // Close handlers
  document.getElementById('btn-help-close')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); } });
  overlay.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Escape') { overlay.remove(); } });

  // Focus management
  (document.getElementById('btn-help-close') as HTMLElement)?.focus();
}

function renderHelpContent(section: string): string {
  switch (section) {
    case 'getting-started':
      return `
        <h3>Welcome to Vibe Board</h3>
        <p>Vibe Board is a Kanban-style task board built right into VS Code. It's designed for AI-assisted workflows, brainstorming sessions, and prompt engineering.</p>
        <h4>Quick Start</h4>
        <ol>
          <li><strong>Start a Session</strong> &mdash; Click the <em>Start Session</em> button to begin tracking your work. Sessions time your overall workflow.</li>
          <li><strong>Add Tasks</strong> &mdash; Use the text area at the top to type a task title, pick a tag, priority, and target column, then press <kbd>Enter</kbd> or click <em>Add</em>.</li>
          <li><strong>Organize</strong> &mdash; Drag tasks between columns, edit inline, set priorities, and use timers to track time on each task.</li>
          <li><strong>End Session</strong> &mdash; When you're done, click <em>End Session</em> to see your summary. Unfinished tasks from all previous sessions automatically carry over to the next one.</li>
        </ol>
        <h4>Interface Overview</h4>
        <ul>
          <li><strong>Session Bar</strong> &mdash; Top bar showing session timer and action buttons (undo, redo, AI summary, help, history, end session).</li>
          <li><strong>Board Tabs</strong> &mdash; Below the session bar. Click to switch boards, <strong>&times;</strong> to close, double-click to rename, <strong>+</strong> to create a new board.</li>
          <li><strong>Stats Bar</strong> &mdash; Displays live counts for total tasks, completed, up next, and high-priority items.</li>
          <li><strong>Search &amp; Filter</strong> &mdash; Filter tasks by text, tag, or priority.</li>
          <li><strong>Quick Add</strong> &mdash; Fast task creation with tag, priority, and column selectors plus template buttons and AI task improvement.</li>
          <li><strong>Columns</strong> &mdash; Four columns: <em>Up Next</em>, <em>Backlog</em>, <em>Completed</em>, and <em>Notes</em>. Click headers to collapse.</li>
        </ul>
        <h4>AI Features</h4>
        <p>Vibe Board integrates with <strong>GitHub Copilot Chat</strong> for AI-powered summaries, task breakdowns, and tag suggestions. See the <em>AI Features</em> tab for setup details.</p>`;

    case 'tasks':
      return `
        <h3>Working with Tasks</h3>
        <h4>Creating Tasks</h4>
        <ul>
          <li>Type in the quick-add area and press <kbd>Enter</kbd> (or click <em>Add</em>).</li>
          <li>Select a <strong>tag</strong> (Feature, Bug, Refactor, Note), <strong>priority</strong> (High, Medium, Low), and <strong>column</strong> before adding.</li>
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
        <p>Each board has four columns, each representing a stage:</p>
        <ul>
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
        <h4>Session History</h4>
        <ul>
          <li>Click the <strong>book icon</strong> (&#128218;) or press <kbd>Ctrl+H</kbd> to toggle the history view.</li>
          <li>History shows all past sessions with duration, completion count, and tag breakdown.</li>
          <li>The start page also shows recent session history and completed tasks.</li>
        </ul>
        <h4>Undo / Redo</h4>
        <ul>
          <li>Press <kbd>Ctrl+Z</kbd> or click the <strong>undo button</strong> (&#8630;) to undo the last action.</li>
          <li>Press <kbd>Ctrl+Y</kbd> or click the <strong>redo button</strong> (&#8631;) to redo the last undone action.</li>
          <li>Supports undoing/redoing edits, moves, completions, deletions, task creation, and timer toggles.</li>
          <li>Up to <strong>20 actions</strong> are stored in the undo stack per session.</li>
          <li>Performing a new action clears the redo history.</li>
        </ul>`;

    case 'timers':
      return `
        <h3>Time Tracking</h3>
        <h4>Session Timer</h4>
        <p>The timer in the top-left of the session bar tracks total session duration. It starts automatically when you begin a session.</p>
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
        <h4>AI Improve Task</h4>
        <ul>
          <li>Type a rough idea in the quick-add input, then click the <strong>sparkle icon</strong> (&#10024;) next to the Add button.</li>
          <li>AI automatically <strong>classifies</strong> your input into the right category (Feature, Bug, Refactor, or Note) and sets the tag, priority, and column dropdowns accordingly.</li>
          <li>AI then <strong>formats</strong> the task using the matching template structure:
            <ul>
              <li><strong>Bug</strong> &mdash; Title prefixed with "Bug:", description with Steps to reproduce, Expected, Actual</li>
              <li><strong>Feature</strong> &mdash; Title prefixed with "Spike:", description with Goal, Approach, Questions</li>
              <li><strong>Refactor</strong> &mdash; Title prefixed with "Refactor:", description with Current state, Desired state, Risks</li>
              <li><strong>Note</strong> &mdash; Clear note text</li>
            </ul>
          </li>
          <li>The full result (title on the first line, structured description below) appears in the <strong>quick-add textarea</strong> for you to review and edit. The tag, priority, and column dropdowns are set automatically.</li>
          <li>Click <em>Add</em> to create the task. The first line becomes the title; remaining lines become the description.</li>
        </ul>`;

    case 'export':
      return `
        <h3>Exporting &amp; Importing Data</h3>
        <p>Vibe Board supports three export formats. All formats include comprehensive data with summary totals.</p>
        <h4>Export Formats</h4>
        <ul>
          <li><strong>JSON</strong> &mdash; Full data backup with summary totals, all sessions (with per-session stats), active session details, and every task. Best for backups or programmatic use. Exports all data regardless of time period.</li>
          <li><strong>CSV</strong> &mdash; Spreadsheet-ready table of tasks with columns: Session, Session Date, Session Duration, Task Title, Description, Tag, Priority, Status, Board, Time Spent, Carried Over, Created, Completed. Includes a summary section at the bottom with totals by status, tag, and priority.</li>
          <li><strong>Markdown</strong> &mdash; Human-readable report with summary statistics table, active session details, session history table (with session name, task counts), and all tasks grouped by status. Includes breakdowns by tag and priority. Ideal for documentation and sharing.</li>
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
        <h4>Clear All Data</h4>
        <ul>
          <li>The <strong>Danger Zone</strong> section on the start page lets you permanently delete all sessions, tasks, and boards.</li>
          <li>A confirmation dialog prevents accidental deletion.</li>
          <li>Consider exporting your data first as a backup &mdash; this action cannot be undone.</li>
        </ul>`;

    case 'shortcuts':
      return `
        <h3>Keyboard Shortcuts</h3>
        <table class="help-shortcuts-table">
          <thead><tr><th>Shortcut</th><th>Action</th></tr></thead>
          <tbody>
            <tr><td><kbd>F1</kbd></td><td>Toggle this help panel</td></tr>
            <tr><td><kbd>Ctrl+N</kbd></td><td>Focus the quick-add input</td></tr>
            <tr><td><kbd>Ctrl+H</kbd></td><td>Toggle session history view</td></tr>
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
          <li><strong>Delete</strong> &mdash; Remove task (with confirmation).</li>
        </ul>
        <h4>VS Code Commands</h4>
        <ul>
          <li><code>Vibe Board: Start Session</code></li>
          <li><code>Vibe Board: End Session</code></li>
          <li><code>Vibe Board: Quick Add Task</code></li>
          <li><code>Vibe Board: Export Session as Markdown</code></li>
        </ul>
        <h4>Settings</h4>
        <ul>
          <li><code>vibeboard.autoPromptSession</code> &mdash; Prompt to start a session when VS Code opens (default: true).</li>
          <li><code>vibeboard.carryOverTasks</code> &mdash; Carry over unfinished tasks to the next session (default: true).</li>
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
          if (tagSelect && parsed.tag) { tagSelect.value = parsed.tag; }
          if (prioSelect && parsed.priority) { prioSelect.value = parsed.priority; }
          if (colSelect && parsed.status) { colSelect.value = parsed.status; }

          const tagLabel = parsed.tag ? TAG_LABELS[parsed.tag as TaskTag] || parsed.tag : '';
          showAIToast(`Classified as ${tagLabel} — review & edit, then click Add`, false);
        }
      } catch {
        // Fallback if not JSON
        const input = document.getElementById('quick-add-input') as HTMLTextAreaElement | null;
        if (input && raw) {
          input.value = raw;
          input.focus();
          showAIToast('Title improved by AI', false);
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
