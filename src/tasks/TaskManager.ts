import { VBTask, TaskTag, TaskStatus, TaskPriority, UndoEntry } from '../storage/models';
import { StorageProvider } from '../storage/StorageProvider';
import { generateId } from '../utils/uuid';

const MAX_UNDO = 20;

/**
 * TaskManager handles CRUD operations, column moves, reordering, undo, and timers.
 */
export class TaskManager {
  constructor(private storage: StorageProvider) {}

  /**
   * Push a snapshot onto the undo stack before mutating.
   * Clears the redo stack since new actions invalidate the redo history.
   */
  private pushUndo(action: string, task: VBTask): void {
    const data = this.storage.getData();
    if (!data.undoStack) { data.undoStack = []; }
    data.undoStack.push({
      action,
      taskSnapshot: { ...task },
      timestamp: new Date().toISOString(),
    });
    if (data.undoStack.length > MAX_UNDO) {
      data.undoStack.shift();
    }
    // New action invalidates redo history
    data.redoStack = [];
  }

  /**
   * Undo the last action (restore task snapshot or reverse add).
   * Pushes the current state onto the redo stack so it can be re-applied.
   */
  undo(): string | null {
    const data = this.storage.getData();
    if (!data.undoStack || data.undoStack.length === 0) { return null; }
    const entry = data.undoStack.pop()!;
    if (!data.redoStack) { data.redoStack = []; }

    if (entry.action === 'add') {
      // Reverse of adding a task — remove it
      const idx = data.tasks.findIndex((t) => t.id === entry.taskSnapshot.id);
      if (idx >= 0) {
        // Save current state to redo before removing
        data.redoStack.push({
          action: 'add',
          taskSnapshot: { ...data.tasks[idx] },
          timestamp: new Date().toISOString(),
        });
        data.tasks.splice(idx, 1);
      }
    } else {
      const idx = data.tasks.findIndex((t) => t.id === entry.taskSnapshot.id);
      if (idx >= 0) {
        const currentTask = data.tasks[idx];

        // Save current state to redo before restoring
        data.redoStack.push({
          action: entry.action,
          taskSnapshot: { ...currentTask },
          timestamp: new Date().toISOString(),
        });

        // If the task was moved to a different column, fix sibling orders in that column
        if (entry.action === 'move' && currentTask.status !== entry.taskSnapshot.status) {
          const movedToColumn = currentTask.status;
          const movedToOrder = currentTask.order;
          // Decrement siblings that were shifted up when the task was inserted
          for (const t of data.tasks) {
            if (t.status === movedToColumn && t.id !== currentTask.id && t.order > movedToOrder) {
              t.order -= 1;
            }
          }
        }

        data.tasks[idx] = { ...entry.taskSnapshot };
      } else {
        // Task was deleted — re-add it; save a 'delete' redo entry so redo removes it again
        data.redoStack.push({
          action: 'delete',
          taskSnapshot: { ...entry.taskSnapshot },
          timestamp: new Date().toISOString(),
        });
        data.tasks.push({ ...entry.taskSnapshot });
      }
    }

    if (data.redoStack.length > MAX_UNDO) {
      data.redoStack.shift();
    }

    this.storage.setData(data);
    return entry.action;
  }

  /**
   * Redo the last undone action.
   */
  redo(): string | null {
    const data = this.storage.getData();
    if (!data.redoStack || data.redoStack.length === 0) { return null; }
    const entry = data.redoStack.pop()!;
    if (!data.undoStack) { data.undoStack = []; }

    if (entry.action === 'add') {
      // Re-add the task that was removed by undo
      data.undoStack.push({
        action: 'add',
        taskSnapshot: { ...entry.taskSnapshot },
        timestamp: new Date().toISOString(),
      });
      data.tasks.push({ ...entry.taskSnapshot });
    } else if (entry.action === 'delete') {
      // Re-delete the task that was restored by undo
      const idx = data.tasks.findIndex((t) => t.id === entry.taskSnapshot.id);
      if (idx >= 0) {
        data.undoStack.push({
          action: 'delete',
          taskSnapshot: { ...data.tasks[idx] },
          timestamp: new Date().toISOString(),
        });
        data.tasks.splice(idx, 1);
      }
    } else {
      // For edit, move, complete, timer — restore the post-action snapshot
      const idx = data.tasks.findIndex((t) => t.id === entry.taskSnapshot.id);
      if (idx >= 0) {
        const currentTask = data.tasks[idx];
        data.undoStack.push({
          action: entry.action,
          taskSnapshot: { ...currentTask },
          timestamp: new Date().toISOString(),
        });

        // If redoing a move to a different column, shift siblings in the target column
        if (entry.action === 'move' && currentTask.status !== entry.taskSnapshot.status) {
          const targetColumn = entry.taskSnapshot.status;
          const targetOrder = entry.taskSnapshot.order;
          for (const t of data.tasks) {
            if (t.status === targetColumn && t.id !== currentTask.id && t.order >= targetOrder) {
              t.order += 1;
            }
          }
        }

        data.tasks[idx] = { ...entry.taskSnapshot };
      }
    }

    if (data.undoStack.length > MAX_UNDO) {
      data.undoStack.shift();
    }

    this.storage.setData(data);
    return entry.action;
  }

  /**
   * Add a new task to the board.
   */
  addTask(params: {
    title: string;
    tag: TaskTag;
    status: TaskStatus;
    sessionId: string;
    description?: string;
    priority?: TaskPriority;
    boardId?: string;
  }): VBTask {
    const data = this.storage.getData();
    const boardId = params.boardId ?? data.activeBoardId ?? 'default';

    // Calculate the next order value for the target column
    const columnTasks = data.tasks.filter((t) => t.status === params.status);
    const maxOrder = columnTasks.reduce((max, t) => Math.max(max, t.order), -1);

    const task: VBTask = {
      id: generateId(),
      title: params.title,
      description: params.description ?? '',
      tag: params.tag,
      priority: params.priority ?? 'medium',
      status: params.status,
      createdAt: new Date().toISOString(),
      completedAt: null,
      order: maxOrder + 1,
      sessionId: params.sessionId,
      boardId: boardId,
      timeSpentMs: 0,
      timerStartedAt: null,
    };

    data.tasks.push(task);

    // Push undo so the user can undo task creation (removes the task)
    if (!data.undoStack) { data.undoStack = []; }
    data.undoStack.push({
      action: 'add',
      taskSnapshot: { ...task },
      timestamp: new Date().toISOString(),
    });
    if (data.undoStack.length > MAX_UNDO) {
      data.undoStack.shift();
    }
    // New action invalidates redo history
    data.redoStack = [];

    this.storage.setData(data);

    return task;
  }

  /**
   * Update a task's editable fields.
   */
  updateTask(
    taskId: string,
    changes: Partial<Pick<VBTask, 'title' | 'description' | 'tag' | 'priority'>>
  ): VBTask | null {
    const data = this.storage.getData();
    const task = data.tasks.find((t) => t.id === taskId);

    if (!task) {
      return null;
    }

    this.pushUndo('edit', task);

    if (changes.title !== undefined) {
      task.title = changes.title;
    }
    if (changes.description !== undefined) {
      task.description = changes.description;
    }
    if (changes.tag !== undefined) {
      task.tag = changes.tag;
    }
    if (changes.priority !== undefined) {
      task.priority = changes.priority;
    }

    this.storage.setData(data);
    return task;
  }

  /**
   * Move a task to a different column and/or reorder within a column.
   */
  moveTask(taskId: string, newStatus: TaskStatus, newOrder: number): VBTask | null {
    const data = this.storage.getData();
    const task = data.tasks.find((t) => t.id === taskId);

    if (!task) {
      return null;
    }

    this.pushUndo('move', task);

    const oldStatus = task.status;

    // Update task status and order
    task.status = newStatus;
    task.order = newOrder;

    // If moving to completed, set completedAt and stop timer
    if (newStatus === 'completed' && oldStatus !== 'completed') {
      task.completedAt = new Date().toISOString();
      if (task.timerStartedAt) {
        task.timeSpentMs += Date.now() - new Date(task.timerStartedAt).getTime();
        task.timerStartedAt = null;
      }
    }

    // If moving out of completed, clear completedAt
    if (newStatus !== 'completed' && oldStatus === 'completed') {
      task.completedAt = null;
    }

    // Reorder siblings: shift tasks at or after newOrder
    const siblings = data.tasks.filter(
      (t) => t.status === newStatus && t.id !== taskId && t.order >= newOrder
    );
    for (const sibling of siblings) {
      sibling.order += 1;
    }

    this.storage.setData(data);
    return task;
  }

  /**
   * Mark a task as completed.
   */
  completeTask(taskId: string): VBTask | null {
    const data = this.storage.getData();
    const task = data.tasks.find((t) => t.id === taskId);

    if (!task) {
      return null;
    }

    this.pushUndo('complete', task);

    task.status = 'completed';
    task.completedAt = new Date().toISOString();
    // Stop timer
    if (task.timerStartedAt) {
      task.timeSpentMs += Date.now() - new Date(task.timerStartedAt).getTime();
      task.timerStartedAt = null;
    }
    // Place at the end of the completed column
    const completedTasks = data.tasks.filter((t) => t.status === 'completed' && t.id !== taskId);
    task.order = completedTasks.reduce((max, t) => Math.max(max, t.order), -1) + 1;

    this.storage.setData(data);
    return task;
  }

  /**
   * Delete a task.
   */
  deleteTask(taskId: string): boolean {
    const data = this.storage.getData();
    const task = data.tasks.find((t) => t.id === taskId);

    if (!task) {
      return false;
    }

    this.pushUndo('delete', task);

    const index = data.tasks.indexOf(task);
    data.tasks.splice(index, 1);
    this.storage.setData(data);
    return true;
  }

  /**
   * Toggle timer on a task.
   */
  toggleTimer(taskId: string): VBTask | null {
    const data = this.storage.getData();
    const task = data.tasks.find((t) => t.id === taskId);
    if (!task) { return null; }

    this.pushUndo('timer', task);

    if (task.timerStartedAt) {
      // Stop timer — accumulate elapsed
      task.timeSpentMs += Date.now() - new Date(task.timerStartedAt).getTime();
      task.timerStartedAt = null;
    } else {
      // Start timer
      task.timerStartedAt = new Date().toISOString();
    }

    this.storage.setData(data);
    return task;
  }

  /**
   * Carry over unfinished tasks from ALL ended sessions to the new session.
   * When projectId is provided, only carry over tasks from sessions in that project.
   * Updates sessionId and boardId so tasks appear on the new session's active board.
   */
  carryOverAllTasks(newSessionId: string, projectId?: string): number {
    const data = this.storage.getData();
    const newBoardId = data.activeBoardId || 'default';

    // Find ended session IDs, optionally scoped to a project
    const endedSessionIds = new Set(
      data.sessions
        .filter((s) => s.status === 'ended' && (!projectId || s.projectId === projectId))
        .map((s) => s.id)
    );

    let carried = 0;

    for (const task of data.tasks) {
      if (
        endedSessionIds.has(task.sessionId) &&
        task.status !== 'completed'
      ) {
        task.carriedFromSessionId = task.sessionId;
        task.sessionId = newSessionId;
        task.boardId = newBoardId;
        carried++;
      }
    }

    if (carried > 0) {
      this.storage.setData(data);
    }

    return carried;
  }

  /**
   * Carry over unfinished tasks from a specific session to the new session.
   * Updates sessionId and boardId so tasks appear on the new session's active board.
   */
  carryOverTasks(oldSessionId: string, newSessionId: string): number {
    const data = this.storage.getData();
    const newBoardId = data.activeBoardId || 'default';
    let carried = 0;

    for (const task of data.tasks) {
      if (
        task.sessionId === oldSessionId &&
        task.status !== 'completed'
      ) {
        task.carriedFromSessionId = task.sessionId;
        task.sessionId = newSessionId;
        task.boardId = newBoardId;
        carried++;
      }
    }

    if (carried > 0) {
      this.storage.setData(data);
    }

    return carried;
  }
}
