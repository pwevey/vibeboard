/**
 * Vibe Board - Data Models
 * Single source of truth for all TypeScript interfaces.
 */

// === Tag & Status Types ===

export type TaskTag = 'feature' | 'bug' | 'refactor' | 'note' | 'plan' | 'todo';

export type TaskStatus = 'in-progress' | 'up-next' | 'backlog' | 'completed' | 'notes';

export type TaskPriority = 'high' | 'medium' | 'low';

export type SessionStatus = 'active' | 'ended';

// === Attachments ===

export interface VBAttachment {
  id: string;
  filename: string;
  mimeType: string;
  dataUri: string;         // base64 data URI (data:image/png;base64,...)
  addedAt: string;         // ISO 8601
}

// === Projects ===

export interface VBProject {
  id: string;
  name: string;
  createdAt: string;       // ISO 8601
  color?: string;          // optional hex color for visual distinction
  workspace?: string;      // workspace/folder label for grouping on the start page
  copilotContext?: string; // project-level instructions passed to Copilot with every prompt
  copilotContextEnabled?: boolean; // whether project context is active (default true)
}

// === Core Models ===

export interface VBTask {
  id: string;
  title: string;
  description: string;
  tag: TaskTag;
  priority: TaskPriority;
  status: TaskStatus;
  createdAt: string;       // ISO 8601
  completedAt: string | null;
  order: number;
  sessionId: string;
  boardId: string;         // which board this task belongs to
  timeSpentMs: number;     // accumulated time tracking
  timerStartedAt: string | null; // ISO 8601 when timer was last started
  carriedFromSessionId?: string; // set when a task was carried over from another session
  attachments?: VBAttachment[]; // image/file attachments
  copilotLog?: { prompt: string; timestamp: string }[]; // log of follow-up prompts sent to Copilot
  sentToCopilot?: boolean; // true while awaiting Copilot completion
  jiraIssueKey?: string;    // Jira issue key (e.g. SAM-123) — last exported key (legacy)
  jiraExportedAt?: string;  // ISO 8601 when task was last exported to Jira (legacy)
  jiraExports?: Record<string, { issueKey: string; exportedAt: string }>; // per-Jira-project export tracking (projectKey → info)
}

export interface VBSession {
  id: string;
  name: string;            // user-assigned session name
  projectPath: string;
  projectId?: string;      // optional project grouping
  startedAt: string;       // ISO 8601
  endedAt: string | null;
  status: SessionStatus;
  pausedAt?: string | null;      // ISO 8601 when session was paused
  totalPausedMs?: number;        // accumulated paused milliseconds
}

export interface VBSessionSummary {
  sessionId: string;
  duration: number;          // milliseconds
  tasksCompleted: number;
  tasksByTag: Record<TaskTag, number>;
  tasksCarriedOver: number;
}

// === Undo System ===

export interface UndoEntry {
  action: string;
  taskSnapshot: VBTask;
  timestamp: string;
}

// === Storage Envelope ===

export interface VBWorkspaceData {
  version: 1;
  activeSessionId: string | null;
  sessions: VBSession[];
  tasks: VBTask[];
  undoStack?: UndoEntry[];
  redoStack?: UndoEntry[];
  activeBoardId?: string;
  boards?: VBBoard[];
  projects?: VBProject[];
  activeProjectId?: string | null;
  jiraProjectMapping?: Record<string, string>; // VB projectId → Jira project key
  jiraEpicMapping?: Record<string, string>; // VB projectId → Jira epic key
  jiraStatusMapping?: Record<string, { export: Record<string, string>; import: Record<string, string> }>; // Jira project key → { export: VB→Jira, import: Jira→VB }
  jiraPromptDismissed?: boolean; // true if user dismissed the end-session Jira export prompt
}

// === Multi-Board ===

export interface VBBoard {
  id: string;
  name: string;
  createdAt: string;
  pausedAt?: string | null;
  totalPausedMs?: number;
}

// === Task Templates ===

export interface TaskTemplate {
  name: string;
  title: string;
  description: string;
  tag: TaskTag;
  priority: TaskPriority;
  status: TaskStatus;
}

export type ExportTimePeriod = 'all' | 'day' | 'week' | 'month' | 'year' | 'current-month' | 'last-month' | 'custom';

// === Automation Types ===

export type AutomationState = 'idle' | 'running' | 'paused' | 'reviewing';

export type AutomationStepStatus = 'pending' | 'sending' | 'waiting' | 'verifying' | 'checkpoint' | 'done' | 'skipped' | 'failed';

export interface AutomationQueueItem {
  taskId: string;
  status: AutomationStepStatus;
  result?: string;           // verification result from LM API
  diffSummary?: string;      // git diff summary
  changedFiles?: string[];   // files modified during this step
  startedAt?: string;        // ISO 8601
  completedAt?: string;      // ISO 8601
  retryCount?: number;       // how many times this task has been retried (max 3)
}

/** Maximum number of retry attempts per task. */
export const MAX_RETRY_COUNT = 3;

export interface AutomationProgress {
  state: AutomationState;
  queue: AutomationQueueItem[];
  currentIndex: number;      // index of the task currently being processed
  totalTasks: number;
  completedTasks: number;
  startedAt?: string;
}

// === Webview Message Types ===

export type WebviewToExtensionMessage =
  | { type: 'addTask'; payload: { title: string; tag: TaskTag; status: TaskStatus; priority?: TaskPriority; description?: string; attachments?: VBAttachment[] } }
  | { type: 'updateTask'; payload: { id: string; changes: Partial<Pick<VBTask, 'title' | 'description' | 'tag' | 'priority'>> } }
  | { type: 'moveTask'; payload: { id: string; newStatus: TaskStatus; newOrder: number } }
  | { type: 'deleteTask'; payload: { id: string } }
  | { type: 'completeTask'; payload: { id: string } }
  | { type: 'startSession'; payload: { name?: string } }
  | { type: 'endSession'; payload: Record<string, never> }
  | { type: 'pauseSession'; payload: Record<string, never> }
  | { type: 'resumeSession'; payload: Record<string, never> }
  | { type: 'endSessions'; payload: { sessionIds: string[] } }
  | { type: 'requestHistory'; payload: Record<string, never> }
  | { type: 'exportData'; payload: { format: 'json' | 'csv' | 'markdown'; timePeriod?: ExportTimePeriod; customStart?: string; customEnd?: string; projectId?: string; projectIds?: string[] } }
  | { type: 'importData'; payload: Record<string, never> }
  | { type: 'clearAllData'; payload: Record<string, never> }
  | { type: 'undo'; payload: Record<string, never> }
  | { type: 'redo'; payload: Record<string, never> }
  | { type: 'toggleTimer'; payload: { id: string } }
  | { type: 'addFromTemplate'; payload: { templateIndex: number } }
  | { type: 'createBoard'; payload: { name: string } }
  | { type: 'switchBoard'; payload: { boardId: string } }
  | { type: 'deleteBoard'; payload: { boardId: string } }
  | { type: 'closeBoards'; payload: { boardIds: string[] } }
  | { type: 'renameBoard'; payload: { boardId: string; name: string } }
  | { type: 'aiSummarize'; payload: Record<string, never> }
  | { type: 'aiBreakdown'; payload: { taskId: string } }
  | { type: 'aiRewriteTitle'; payload: { title: string } }
  | { type: 'sendToCopilot'; payload: { taskId: string } }
  | { type: 'addAttachment'; payload: { taskId: string } }
  | { type: 'removeAttachment'; payload: { taskId: string; attachmentId: string } }
  | { type: 'pasteAttachment'; payload: { taskId: string; dataUri: string; filename: string } }
  | { type: 'pickFilesForQuickAdd'; payload: Record<string, never> }
  | { type: 'sendFollowUp'; payload: { taskId: string; prompt: string; attachments?: VBAttachment[] } }
  | { type: 'pickFilesForFollowUp'; payload: { taskId: string } }
  | { type: 'copilotDismiss'; payload: { taskId: string } }
  | { type: 'startAutomation'; payload: { taskIds: string[]; threshold?: number } }
  | { type: 'pauseAutomation'; payload: Record<string, never> }
  | { type: 'resumeAutomation'; payload: Record<string, never> }
  | { type: 'cancelAutomation'; payload: Record<string, never> }
  | { type: 'skipAutomationTask'; payload: Record<string, never> }
  | { type: 'approveAutomationTask'; payload: Record<string, never> }
  | { type: 'rejectAutomationTask'; payload: Record<string, never> }
  | { type: 'retryAutomationTask'; payload: { queueIndex: number } }
  | { type: 'createProject'; payload: { id?: string; name: string; color?: string; workspace?: string; copilotContext?: string } }
  | { type: 'renameProject'; payload: { projectId: string; name: string } }
  | { type: 'updateProject'; payload: { projectId: string; changes: Partial<Pick<VBProject, 'name' | 'color' | 'workspace' | 'copilotContext' | 'copilotContextEnabled'>> } }
  | { type: 'deleteProject'; payload: { projectId: string } }
  | { type: 'setActiveProject'; payload: { projectId: string | null } }
  | { type: 'updateSetting'; payload: { key: string; value: unknown } }
  | { type: 'saveJiraCredentials'; payload: { baseUrl: string; email: string; token: string } }
  | { type: 'clearJiraCredentials'; payload: Record<string, never> }
  | { type: 'setJiraProjectMapping'; payload: { vbProjectId: string; jiraProjectKey: string } }
  | { type: 'setJiraEpicMapping'; payload: { vbProjectId: string; epicKey: string } }
  | { type: 'setJiraStatusMapping'; payload: { jiraProjectKey: string; direction: 'export' | 'import'; mapping: Record<string, string> } }
  | { type: 'setJiraPromptDismissed'; payload: { dismissed: boolean } }
  | { type: 'getJiraProjects'; payload: Record<string, never> }
  | { type: 'getJiraEpics'; payload: { projectKey: string } }
  | { type: 'createJiraEpic'; payload: { projectKey: string; epicName: string } }
  | { type: 'getJiraStatuses'; payload: { projectKey: string } }
  | { type: 'testJiraConnection'; payload: Record<string, never> }
  | { type: 'exportToJira'; payload: { projectKey: string; taskIds?: string[]; issueType?: string; statusMapping?: Record<string, string>; epicKey?: string } }
  | { type: 'searchJiraIssues'; payload: { projectKey: string; jql?: string; maxResults?: number } }
  | { type: 'importFromJira'; payload: { issues: JiraImportIssue[]; targetStatus?: TaskStatus; statusMapping?: Record<string, string> } }
  | { type: 'ready'; payload: Record<string, never> };

export type ExtensionToWebviewMessage =
  | { type: 'stateUpdate'; payload: VBWorkspaceData }
  | { type: 'sessionSummary'; payload: VBSessionSummary }
  | { type: 'sessionHistory'; payload: { sessions: VBSession[]; summaries: VBSessionSummary[] } }
  | { type: 'aiResult'; payload: { action: string; result: string | string[]; taskId?: string } }
  | { type: 'quickAddFiles'; payload: { files: VBAttachment[] } }
  | { type: 'showFollowUp'; payload: { taskId: string } }
  | { type: 'followUpFiles'; payload: { taskId: string; files: VBAttachment[] } }
  | { type: 'automationProgress'; payload: AutomationProgress }
  | { type: 'settingsUpdate'; payload: Record<string, unknown> }
  | { type: 'jiraProjects'; payload: { projects: JiraProject[]; error?: string } }
  | { type: 'jiraEpics'; payload: { epics: { key: string; name: string }[]; error?: string; newEpicKey?: string } }
  | { type: 'jiraStatuses'; payload: { statuses: JiraStatus[]; error?: string } }
  | { type: 'jiraConnectionTest'; payload: { success: boolean; displayName?: string; error?: string } }
  | { type: 'jiraExportResult'; payload: { success: boolean; created: number; failed: number; issues: JiraCreatedIssue[]; errors: string[] } }
  | { type: 'jiraSearchResults'; payload: { issues: JiraImportIssue[]; total: number; error?: string } }
  | { type: 'jiraImportResult'; payload: { success: boolean; imported: number; error?: string } };

// === Jira Types ===

export interface JiraProject {
  id: string;
  key: string;
  name: string;
}

export interface JiraStatus {
  id: string;
  name: string;
}

export interface JiraCreatedIssue {
  taskId: string;
  taskTitle: string;
  issueKey: string;
  issueUrl: string;
}

export interface JiraImportIssue {
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

// === Factory Functions ===

export function createDefaultWorkspaceData(): VBWorkspaceData {
  return {
    version: 1,
    activeSessionId: null,
    sessions: [],
    tasks: [],
    undoStack: [],
    redoStack: [],
    activeBoardId: 'default',
    boards: [{ id: 'default', name: 'Main Board', createdAt: new Date().toISOString(), pausedAt: null, totalPausedMs: 0 }],
    projects: [],
    activeProjectId: null,
    jiraProjectMapping: {},
    jiraEpicMapping: {},
    jiraStatusMapping: {},
    jiraPromptDismissed: false,
  };
}

// === Built-in Templates ===

export const TASK_TEMPLATES: TaskTemplate[] = [
  { name: 'Bug Report', title: 'Bug: ', description: 'Steps to reproduce:\n1. \n\nExpected:\nActual:', tag: 'bug', priority: 'high', status: 'up-next' },
  { name: 'Feature Spike', title: 'Spike: ', description: 'Goal:\n\nApproach:\n\nQuestions:', tag: 'feature', priority: 'medium', status: 'up-next' },
  { name: 'Refactor Plan', title: 'Refactor: ', description: 'Current state:\n\nDesired state:\n\nRisks:', tag: 'refactor', priority: 'medium', status: 'backlog' },
  { name: 'Quick Note', title: '', description: '', tag: 'note', priority: 'low', status: 'notes' },
  { name: 'AI Prompt Idea', title: 'Prompt: ', description: 'Context:\n\nPrompt:\n\nExpected output:', tag: 'note', priority: 'medium', status: 'notes' },
  { name: 'Plan', title: 'Plan: ', description: 'Objective:\n\nSteps:\n1. \n2. \n3. \n\nSuccess criteria:', tag: 'plan', priority: 'medium', status: 'up-next' },
  { name: 'Todo List', title: 'Todo: ', description: '1. \n2. \n3. ', tag: 'todo', priority: 'medium', status: 'up-next' },
];
