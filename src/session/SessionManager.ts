import { VBSession, VBSessionSummary, VBWorkspaceData, VBTask } from '../storage/models';
import { StorageProvider } from '../storage/StorageProvider';
import { generateId } from '../utils/uuid';

/**
 * SessionManager handles session lifecycle: start, end, summary computation.
 */
export class SessionManager {
  constructor(private storage: StorageProvider) {}

  /**
   * Check if there's an active session.
   */
  hasActiveSession(): boolean {
    const data = this.storage.getData();
    return data.activeSessionId !== null;
  }

  /**
   * Get the active session, if any.
   */
  getActiveSession(): VBSession | null {
    const data = this.storage.getData();
    if (!data.activeSessionId) {
      return null;
    }
    return data.sessions.find((s) => s.id === data.activeSessionId) ?? null;
  }

  /**
   * Start a new session. Ends any currently active session first.
   */
  startSession(projectPath: string, name?: string): VBSession {
    const data = this.storage.getData();

    // End active session if one exists
    if (data.activeSessionId) {
      this.endSessionInternal(data);
    }

    const sessionNumber = data.sessions.length + 1;
    const session: VBSession = {
      id: generateId(),
      name: name || `Session ${sessionNumber}`,
      projectPath,
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: 'active',
    };

    data.sessions.push(session);
    data.activeSessionId = session.id;

    // Clear undo/redo stacks — each session starts with a clean history
    data.undoStack = [];
    data.redoStack = [];

    this.storage.setData(data);

    return session;
  }

  /**
   * End the active session and compute summary.
   * Returns the summary, or null if no active session.
   */
  endSession(): VBSessionSummary | null {
    const data = this.storage.getData();

    if (!data.activeSessionId) {
      return null;
    }

    // If session is paused, resume it first so totalPausedMs is accurate
    const session = data.sessions.find((s) => s.id === data.activeSessionId);
    if (session?.pausedAt) {
      const pauseDuration = Date.now() - new Date(session.pausedAt).getTime();
      session.totalPausedMs = (session.totalPausedMs || 0) + pauseDuration;
      session.pausedAt = null;
    }

    const summary = this.computeSummary(data, data.activeSessionId);
    this.endSessionInternal(data);
    this.storage.setData(data);

    return summary;
  }

  /**
   * Pause the active session. Sets pausedAt timestamp.
   */
  pauseSession(): boolean {
    const data = this.storage.getData();
    if (!data.activeSessionId) { return false; }
    const session = data.sessions.find((s) => s.id === data.activeSessionId);
    if (!session || session.pausedAt) { return false; } // already paused or no session
    session.pausedAt = new Date().toISOString();
    this.storage.setData(data);
    return true;
  }

  /**
   * Resume a paused session. Accumulates pause duration.
   */
  resumeSession(): boolean {
    const data = this.storage.getData();
    if (!data.activeSessionId) { return false; }
    const session = data.sessions.find((s) => s.id === data.activeSessionId);
    if (!session || !session.pausedAt) { return false; } // not paused
    const pauseDuration = Date.now() - new Date(session.pausedAt).getTime();
    session.totalPausedMs = (session.totalPausedMs || 0) + pauseDuration;
    session.pausedAt = null;
    this.storage.setData(data);
    return true;
  }

  /**
   * Internal: mark the active session as ended.
   */
  private endSessionInternal(data: VBWorkspaceData): void {
    const session = data.sessions.find((s) => s.id === data.activeSessionId);
    if (session) {
      session.endedAt = new Date().toISOString();
      session.status = 'ended';
    }
    data.activeSessionId = null;
  }

  /**
   * Compute a summary for the given session.
   */
  computeSummary(data: VBWorkspaceData, sessionId: string): VBSessionSummary {
    const session = data.sessions.find((s) => s.id === sessionId);
    const tasks = data.tasks.filter((t) => t.sessionId === sessionId);

    const startTime = session ? new Date(session.startedAt).getTime() : Date.now();
    const endTime = session?.endedAt ? new Date(session.endedAt).getTime() : Date.now();
    const totalPaused = session?.totalPausedMs || 0;
    // If currently paused, include the current pause duration
    let currentPause = 0;
    if (session?.pausedAt) {
      currentPause = endTime - new Date(session.pausedAt).getTime();
    }
    const duration = Math.max(0, endTime - startTime - totalPaused - currentPause);

    const completedTasks = tasks.filter((t) => t.status === 'completed');
    const carriedOver = tasks.filter((t) => t.status !== 'completed');

    const tasksByTag = this.countTasksByTag(completedTasks);

    return {
      sessionId,
      duration,
      tasksCompleted: completedTasks.length,
      tasksByTag,
      tasksCarriedOver: carriedOver.length,
    };
  }

  /**
   * End a specific session by ID. If it's the active session, end it.
   * If it's a past session, remove it and its tasks.
   * Returns summary only if the active session was ended.
   */
  endSessionById(sessionId: string): VBSessionSummary | null {
    const data = this.storage.getData();
    let summary: VBSessionSummary | null = null;

    if (sessionId === data.activeSessionId) {
      // Ending the currently active session
      summary = this.computeSummary(data, sessionId);
      this.endSessionInternal(data);
    } else {
      // Removing a past/ended session — delete session + its tasks
      const idx = data.sessions.findIndex((s) => s.id === sessionId);
      if (idx !== -1) {
        data.sessions.splice(idx, 1);
        data.tasks = data.tasks.filter((t) => t.sessionId !== sessionId);
      }
    }

    this.storage.setData(data);
    return summary;
  }

  /**
   * Get all ended sessions with their summaries, most recent first.
   */
  getSessionHistory(): { sessions: VBSession[]; summaries: VBSessionSummary[] } {
    const data = this.storage.getData();
    const endedSessions = data.sessions
      .filter((s) => s.status === 'ended')
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    const summaries = endedSessions.map((s) => this.computeSummary(data, s.id));

    return { sessions: endedSessions, summaries };
  }

  /**
   * Count completed tasks grouped by tag.
   */
  private countTasksByTag(tasks: VBTask[]): Record<string, number> {
    const counts: Record<string, number> = {
      feature: 0,
      bug: 0,
      refactor: 0,
      note: 0,
    };

    for (const task of tasks) {
      counts[task.tag] = (counts[task.tag] || 0) + 1;
    }

    return counts;
  }
}
