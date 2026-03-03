/**
 * Vibe Board - Data Models
 * Single source of truth for all TypeScript interfaces.
 */

// === Tag & Status Types ===

export type TaskTag = 'feature' | 'bug' | 'refactor' | 'note';

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
}

export interface VBSession {
  id: string;
  name: string;            // user-assigned session name
  projectPath: string;
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
}

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
  | { type: 'exportData'; payload: { format: 'json' | 'csv' | 'markdown'; timePeriod?: ExportTimePeriod; customStart?: string; customEnd?: string } }
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
  | { type: 'startAutomation'; payload: { taskIds: string[] } }
  | { type: 'pauseAutomation'; payload: Record<string, never> }
  | { type: 'resumeAutomation'; payload: Record<string, never> }
  | { type: 'cancelAutomation'; payload: Record<string, never> }
  | { type: 'skipAutomationTask'; payload: Record<string, never> }
  | { type: 'approveAutomationTask'; payload: Record<string, never> }
  | { type: 'rejectAutomationTask'; payload: Record<string, never> }
  | { type: 'ready'; payload: Record<string, never> };

export type ExtensionToWebviewMessage =
  | { type: 'stateUpdate'; payload: VBWorkspaceData }
  | { type: 'sessionSummary'; payload: VBSessionSummary }
  | { type: 'sessionHistory'; payload: { sessions: VBSession[]; summaries: VBSessionSummary[] } }
  | { type: 'aiResult'; payload: { action: string; result: string | string[]; taskId?: string } }
  | { type: 'quickAddFiles'; payload: { files: VBAttachment[] } }
  | { type: 'showFollowUp'; payload: { taskId: string } }
  | { type: 'followUpFiles'; payload: { taskId: string; files: VBAttachment[] } }
  | { type: 'automationProgress'; payload: AutomationProgress };

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
  };
}

// === Built-in Templates ===

export const TASK_TEMPLATES: TaskTemplate[] = [
  { name: 'Bug Report', title: 'Bug: ', description: 'Steps to reproduce:\n1. \n\nExpected:\nActual:', tag: 'bug', priority: 'high', status: 'up-next' },
  { name: 'Feature Spike', title: 'Spike: ', description: 'Goal:\n\nApproach:\n\nQuestions:', tag: 'feature', priority: 'medium', status: 'up-next' },
  { name: 'Refactor Plan', title: 'Refactor: ', description: 'Current state:\n\nDesired state:\n\nRisks:', tag: 'refactor', priority: 'medium', status: 'backlog' },
  { name: 'Quick Note', title: '', description: '', tag: 'note', priority: 'low', status: 'notes' },
  { name: 'AI Prompt Idea', title: 'Prompt: ', description: 'Context:\n\nPrompt:\n\nExpected output:', tag: 'note', priority: 'medium', status: 'notes' },
];
