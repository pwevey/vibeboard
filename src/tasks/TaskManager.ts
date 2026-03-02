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
  }

  /**
   * Undo the last action (restore task snapshot).
   */
  undo(): string | null {
    const data = this.storage.getData();
    if (!data.undoStack || data.undoStack.length === 0) { return null; }
    const entry = data.undoStack.pop()!;
    const idx = data.tasks.findIndex((t) => t.id === entry.taskSnapshot.id);
    if (idx >= 0) {
      data.tasks[idx] = { ...entry.taskSnapshot };
    } else {
      // Task was deleted — re-add it
      data.tasks.push({ ...entry.taskSnapshot });
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
   * Carry over unfinished tasks to a new session.
   */
  carryOverTasks(oldSessionId: string, newSessionId: string): number {
    const data = this.storage.getData();
    let carried = 0;

    for (const task of data.tasks) {
      if (
        task.sessionId === oldSessionId &&
        task.status !== 'completed'
      ) {
        task.sessionId = newSessionId;
        carried++;
      }
    }

    if (carried > 0) {
      this.storage.setData(data);
    }

    return carried;
  }
}
